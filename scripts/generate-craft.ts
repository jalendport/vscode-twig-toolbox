import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
	CatalogEntry,
	CatalogEntryKind,
	CatalogMember,
	CatalogObject,
	CatalogParameter,
	DialectPack,
} from '../packages/language-server/src/catalog';
import { cacheRoot, ensureCheckout, repoRoot } from './lib/checkout';
import {
	buildSignature,
	deepMerge,
	normalizeType,
	parsePhpParameters,
	pruneUndefined,
} from './lib/php';

/**
 * Builds `catalogs/craft.json` from pinned `craftcms/cms` and `craftcms/docs`
 * checkouts.
 *
 * Two sources, two jobs. Craft's docs own the *list* — the reference pages are
 * the definition of "Craft's Twig layer", and the element-query pages carry
 * tables Craft itself generates from its source, so they are complete in a way
 * scraping method-by-method is not. Craft's source owns the *shapes*: parameter
 * names, defaults, and the return types that decide whether `.section()` keeps
 * a query chain open.
 *
 * Version metadata is a diff, not a guess. The generator scrapes Craft 4 and
 * Craft 5 side by side: what only 5 has is `sinceVersion: 5.0.0`, what only 4
 * has is `removedVersion: 5.0.0`, and a `<Since ver="5.6.0" />` marker in the
 * docs overrides the diff whenever the docs know something more precise.
 */

const CMS_REPOSITORY = 'https://github.com/craftcms/cms.git';
const DOCS_REPOSITORY = 'https://github.com/craftcms/docs.git';

/** craftcms/docs @ main. */
const DOCS_REF = 'c21b31983e901b6c9d1b79052eb115c9325f58f3';
/** craftcms/cms @ 5.10.11. */
const CRAFT_5_REF = '9dece66d9d35f9f2615f5f2107c98d2334c71cfc';
/** craftcms/cms @ 4.18.5. */
const CRAFT_4_REF = '3f51275df56f897829213d23f6f16d269a65ec55';

const CMS_SPARSE_PATHS = ['src/web/twig', 'src/elements/db', 'src/helpers'];
const DOCS_SPARSE_PATHS = [
	'docs/5.x/reference/twig',
	'docs/5.x/development',
	'docs/4.x/dev',
	'docs/.artifacts/cms/5.x',
	'docs/.artifacts/cms/4.x',
];

const docsCheckout = join(cacheRoot, 'craft-docs');
const outputPath = join(repoRoot, 'catalogs', 'craft.json');
const docsIndexPath = join(repoRoot, 'catalogs', 'craft.docs-index.json');
const overridesPath = join(repoRoot, 'catalogs', 'overrides', 'craft.json');

/** The major that a name's presence or absence is measured against. */
const CRAFT_5_BASELINE = '5.0.0';

/**
 * Where each Craft major keeps the same information.
 *
 * Craft 4's docs live under `dev/`, Craft 5's under `reference/twig/`, and the
 * element-type pages moved too — the paths are the only thing that differs, so
 * one scraper runs twice over this.
 */
interface CraftSource {
	readonly major: 4 | 5;
	readonly ref: string;
	readonly checkout: string;
	readonly twigDocsDir: string;
	readonly twigDocsBaseUrl: string;
	readonly artifactsDir: string;
	readonly elementQueriesDoc: string;
	readonly elementQueriesUrl: string;
	readonly elementTypeUrl: (slug: string) => string;
}

const craft5: CraftSource = {
	major: 5,
	ref: CRAFT_5_REF,
	checkout: join(cacheRoot, 'craft-cms-5'),
	twigDocsDir: 'docs/5.x/reference/twig',
	twigDocsBaseUrl: 'https://craftcms.com/docs/5.x/reference/twig',
	artifactsDir: 'docs/.artifacts/cms/5.x',
	elementQueriesDoc: 'docs/5.x/development/element-queries.md',
	elementQueriesUrl: 'https://craftcms.com/docs/5.x/development/element-queries.html',
	elementTypeUrl: (slug) => `https://craftcms.com/docs/5.x/reference/element-types/${slug}.html`,
};

const craft4: CraftSource = {
	major: 4,
	ref: CRAFT_4_REF,
	checkout: join(cacheRoot, 'craft-cms-4'),
	twigDocsDir: 'docs/4.x/dev',
	twigDocsBaseUrl: 'https://craftcms.com/docs/4.x/dev',
	artifactsDir: 'docs/.artifacts/cms/4.x',
	elementQueriesDoc: 'docs/4.x/element-queries.md',
	elementQueriesUrl: 'https://craftcms.com/docs/4.x/element-queries.html',
	elementTypeUrl: (slug) => `https://craftcms.com/docs/4.x/${slug}.html`,
};

/**
 * Extensions Craft loads for front-end templates. `CpExtension` is deliberately
 * absent: its functions only exist in control-panel requests, and offering them
 * in a site template would be a completion that cannot work.
 */
const TWIG_EXTENSION_FILES = [
	'src/web/twig/Extension.php',
	'src/web/twig/FeExtension.php',
] as const;

/** Docs page per entry kind, and the tables to read from it. */
const DOCS_PAGES = {
	tags: { file: 'tags.md', sections: undefined },
	filters: { file: 'filters.md', sections: undefined },
	functions: { file: 'functions.md', sections: undefined },
	tests: { file: 'tests.md', sections: undefined },
	// The page also lists Twig's own globals and request-loaded elements
	// (`entry`, `category`), which are neither Craft's nor always present.
	globals: {
		file: 'global-variables.md',
		sections: ['Craft', 'PHP Constants + Equivalents'],
	},
} satisfies Record<CatalogEntryKind, { file: string; sections: string[] | undefined }>;

/**
 * Element query classes, and the docs artifact holding their parameter table.
 * The two names diverge often enough (`GlobalSetQuery` → `globals`) that a map
 * is honest where a transform would be a lie.
 */
const QUERY_ARTIFACTS: Record<string, string> = {
	AddressQuery: 'addresses',
	AssetQuery: 'assets',
	CategoryQuery: 'categories',
	EntryQuery: 'entries',
	GlobalSetQuery: 'globals',
	MatrixBlockQuery: 'matrix-blocks',
	TagQuery: 'tags',
	UserQuery: 'users',
};

/** The object every element query inherits its execution methods from. */
const ELEMENT_QUERY_OBJECT = 'ElementQuery';

/**
 * Query-method arguments a template never passes: `$db` is a connection, and
 * `$q` is the count expression `count()` defaults to `'*'`. Both are Yii's, and
 * offering them as arguments would be offering PHP in a Twig file.
 */
const INTERNAL_QUERY_PARAMETERS = new Set(['db', 'q']);

const entryKinds: CatalogEntryKind[] = ['tags', 'filters', 'functions', 'tests', 'globals'];

interface DocsRow {
	readonly name: string;
	readonly description: string;
	readonly anchor?: string;
	readonly sinceVersion?: string;
	/** True when the docs point at twig.symfony.com — Twig's, not Craft's. */
	readonly twigCore: boolean;
}

interface Scrape {
	readonly entries: Record<CatalogEntryKind, Map<string, CatalogEntry>>;
	readonly objects: Map<string, CatalogObject>;
}

main();

function main(): void {
	ensureCheckout({
		directory: docsCheckout,
		repository: DOCS_REPOSITORY,
		ref: DOCS_REF,
		sparsePaths: DOCS_SPARSE_PATHS,
	});
	for (const source of [craft4, craft5]) {
		ensureCheckout({
			directory: source.checkout,
			repository: CMS_REPOSITORY,
			ref: source.ref,
			sparsePaths: CMS_SPARSE_PATHS,
		});
	}

	const pack = applyOverrides(mergeMajors(scrape(craft4), scrape(craft5)));
	writeFileSync(outputPath, `${JSON.stringify(pack, null, 2)}\n`);
	writeFileSync(docsIndexPath, `${JSON.stringify(buildDocsIndex(craft5), null, 2)}\n`);
}

/**
 * Every name the current docs attribute to Craft, committed beside the pack.
 *
 * This is what the completeness test measures the pack against, and it is a
 * file rather than a read of `.cache/` because a test that needs a checkout to
 * run is a test CI skips. It comes off the docs tables directly, so it still
 * catches the pack losing a documented name on its way through the union,
 * aliasing and version merge — which is the part that can quietly drop one.
 */
function buildDocsIndex(source: CraftSource): {
	source: { repository: string; ref: string; path: string };
	names: Record<CatalogEntryKind, string[]>;
} {
	const names = {} as Record<CatalogEntryKind, string[]>;
	for (const kind of entryKinds) {
		names[kind] = [...readDocsTable(source, kind).values()]
			.filter((row) => !row.twigCore)
			.map((row) => row.name)
			.sort((a, b) => a.localeCompare(b));
	}

	return {
		source: { repository: DOCS_REPOSITORY, ref: DOCS_REF, path: source.twigDocsDir },
		names,
	};
}

// ---------------------------------------------------------------------------
// Scraping one Craft major
// ---------------------------------------------------------------------------

function scrape(source: CraftSource): Scrape {
	const entries = createEntryMaps<CatalogEntry>();

	for (const kind of entryKinds) {
		for (const entry of buildEntries(source, kind)) {
			entries[kind].set(entry.name, entry);
		}
	}

	return { entries, objects: buildObjects(source, entries) };
}

function buildEntries(source: CraftSource, kind: CatalogEntryKind): CatalogEntry[] {
	const docs = readDocsTable(source, kind);
	const registered = kind === 'tags' ? readTags(source) : readRegistered(source, kind);

	// The docs decide membership. A name Craft registers only to re-implement
	// Twig's own (`{% deprecated %}`) is Twig's in every way that matters to a
	// template author, and shadowing the core pack's entry with a thinner one
	// would lose its documentation for nothing.
	const names = [...new Set([...docs.keys(), ...registered.keys()])]
		.filter((name) => docs.get(name)?.twigCore !== true)
		.sort((a, b) => a.localeCompare(b));

	const aliases = findAliases(registered, docs);

	return names
		.filter((name) => !aliases.has(name))
		.map((name) => {
			const documented = docs.get(name);
			const sourced = registered.get(name);
			const parameters = sourced?.parameters ?? [];
			const ownAliases = [...aliases.entries()]
				.filter(([, canonical]) => canonical === name)
				.map(([alias]) => alias)
				.sort((a, b) => a.localeCompare(b));

			return pruneUndefined({
				name,
				...(ownAliases.length > 0 ? { aliases: ownAliases } : {}),
				signature: kind === 'globals' ? name : buildSignature(name, parameters),
				parameters,
				description: documented?.description ?? `${name} is provided by Craft.`,
				docsUrl: docsUrl(source, kind, documented),
				sinceVersion: documented?.sinceVersion,
				completionSnippet: buildCompletionSnippet(kind, name, parameters),
				...(kind === 'globals' && name === 'craft' ? { objectType: 'craft' } : {}),
				source: pruneUndefined({
					extension: sourced?.extension,
					phpClass: sourced?.phpClass,
					docsPath: documented === undefined ? undefined : docsPath(source, kind),
				}),
			});
		});
}

/**
 * `md` for `markdown`, `ns` for `namespace`: Craft registers both names against
 * one PHP callable and documents only one. An undocumented name sharing a
 * callable with exactly one documented name is that name's alias — anything
 * less certain stays its own entry.
 */
function findAliases(
	registered: ReadonlyMap<string, RegisteredCallable>,
	docs: ReadonlyMap<string, DocsRow>,
): Map<string, string> {
	const byCallable = new Map<string, string[]>();
	for (const [name, callable] of registered) {
		if (callable.callable === undefined) {
			continue;
		}
		byCallable.set(callable.callable, [...(byCallable.get(callable.callable) ?? []), name]);
	}

	const aliases = new Map<string, string>();
	for (const names of byCallable.values()) {
		const documented = names.filter((name) => docs.has(name));
		if (documented.length !== 1) {
			continue;
		}
		const canonical = documented[0] as string;
		for (const name of names) {
			if (name !== canonical && !docs.has(name)) {
				aliases.set(name, canonical);
			}
		}
	}
	return aliases;
}

interface RegisteredCallable {
	readonly name: string;
	readonly parameters: CatalogParameter[];
	readonly extension?: string;
	readonly phpClass?: string;
	/** Raw PHP callable, used only to spot two names sharing an implementation. */
	readonly callable?: string;
}

function readTags(source: CraftSource): Map<string, RegisteredCallable> {
	const extensionPath = join(source.checkout, 'src/web/twig/Extension.php');
	const body = methodBody(readFileSync(extensionPath, 'utf8'), 'getTokenParsers');
	const tags = new Map<string, RegisteredCallable>();

	for (const match of body.matchAll(/new\s+([A-Za-z]+TokenParser)\s*\(([^\n]*)/g)) {
		const [, className = '', rest = ''] = match;

		// `new RegisterResourceTokenParser('css', …)` registers the tag it is
		// given; every other parser hard-codes its own in `getTag()`.
		const literal = rest.match(/^\s*'([^']+)'/)?.[1];
		const name = literal ?? tagNameFor(source, className);
		if (name === undefined) {
			throw new Error(`Unable to resolve tag name for ${className}`);
		}

		tags.set(name, {
			name,
			parameters: [],
			extension: 'Extension',
			phpClass: `craft\\web\\twig\\tokenparsers\\${className}`,
		});
	}

	return tags;
}

function tagNameFor(source: CraftSource, className: string): string | undefined {
	const parserPath = join(source.checkout, 'src/web/twig/tokenparsers', `${className}.php`);
	if (!existsSync(parserPath)) {
		return undefined;
	}
	return readFileSync(parserPath, 'utf8').match(
		/function\s+getTag\(\)\s*:\s*string\s*\{\s*return\s+'([^']+)'/s,
	)?.[1];
}

function readRegistered(
	source: CraftSource,
	kind: Exclude<CatalogEntryKind, 'tags'>,
): Map<string, RegisteredCallable> {
	if (kind === 'globals') {
		return readGlobals(source);
	}

	const className = { filters: 'TwigFilter', functions: 'TwigFunction', tests: 'TwigTest' }[kind];
	const registered = new Map<string, RegisteredCallable>();

	for (const relativePath of TWIG_EXTENSION_FILES) {
		const extensionPath = join(source.checkout, relativePath);
		if (!existsSync(extensionPath)) {
			continue;
		}
		const php = readFileSync(extensionPath, 'utf8');
		const extension = relativePath.match(/([^/]+)\.php$/)?.[1] ?? 'Extension';

		for (const match of php.matchAll(
			new RegExp(`new\\s+${className}\\('([^']+)'\\s*,\\s*([^\\n]*)`, 'g'),
		)) {
			const [, name = '', rest = ''] = match;
			const callable = readCallable(rest);
			const options = readOptions(rest);
			const parameters = resolveParameters(source, php, callable, kind, options);
			const phpClass = qualify(extension, callable);

			registered.set(name, {
				name,
				parameters,
				extension,
				...(callable === undefined ? {} : { callable: callable.raw }),
				...(phpClass === undefined ? {} : { phpClass }),
			});
		}
	}

	return registered;
}

function readGlobals(source: CraftSource): Map<string, RegisteredCallable> {
	const globals = new Map<string, RegisteredCallable>();

	for (const relativePath of TWIG_EXTENSION_FILES) {
		const extensionPath = join(source.checkout, relativePath);
		if (!existsSync(extensionPath)) {
			continue;
		}
		const body = methodBody(readFileSync(extensionPath, 'utf8'), 'getGlobals');
		const extension = relativePath.match(/([^/]+)\.php$/)?.[1] ?? 'Extension';

		// The array literal `getGlobals()` returns, whose keys are the names.
		for (const match of body.matchAll(/^\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*=>/gm)) {
			const name = match[1] as string;
			globals.set(name, { name, parameters: [], extension });
		}
	}

	return globals;
}

/**
 * The PHP callable a `new TwigFilter('x', …)` was handed — the second argument,
 * so the match is anchored at the start of what follows the name.
 *
 * `raw` is what tells two names they share an implementation (`markdown` and
 * `md`); the parts are what let the parameters be read out of it.
 */
interface PhpCallable {
	/** Source text of the callable, e.g. `[$this, 'markdownFilter']`. */
	readonly raw: string;
	readonly method?: string;
	/** Class for `[Foo::class, 'bar']`; absent when the method is the extension's own. */
	readonly className?: string;
	/** True for `[$this, 'x']` — the method is defined in the extension itself. */
	readonly onExtension: boolean;
}

function readCallable(rest: string): PhpCallable | undefined {
	const onThis = /^\s*\[\$this,\s*'([^']+)'\]/.exec(rest);
	if (onThis !== null) {
		return { raw: onThis[0].trim(), method: onThis[1] as string, onExtension: true };
	}

	// `[$this->view, 'namespaceInputs']` — a method on one of the extension's
	// collaborators, whose class is not in the paths we check out.
	const onProperty = /^\s*\[\$this->[A-Za-z]+,\s*'([^']+)'\]/.exec(rest);
	if (onProperty !== null) {
		return { raw: onProperty[0].trim(), method: onProperty[1] as string, onExtension: false };
	}

	const onClass = /^\s*\[([A-Za-z]+)::class,\s*'([^']+)'\]/.exec(rest);
	if (onClass !== null) {
		return {
			raw: onClass[0].trim(),
			className: onClass[1] as string,
			method: onClass[2] as string,
			onExtension: false,
		};
	}

	// A PHP builtin, e.g. `new TwigFilter('base64_decode', 'base64_decode')`.
	const builtin = /^\s*'([^']+)'/.exec(rest);
	return builtin === null ? undefined : { raw: builtin[0].trim(), onExtension: false };
}

/**
 * `Extension::markdownFilter`, `StringHelper::toAscii` — provenance for hover.
 *
 * A method reached through one of the extension's collaborators
 * (`[$this->view, 'namespaceInputs']`) belongs to a class this cannot name, and
 * naming the extension instead would be provenance pointing at the wrong file.
 */
function qualify(extension: string, callable: PhpCallable | undefined): string | undefined {
	if (callable?.method === undefined) {
		return undefined;
	}
	if (callable.className !== undefined) {
		return `${callable.className}::${callable.method}`;
	}
	return callable.onExtension ? `${extension}::${callable.method}` : undefined;
}

function readOptions(rest: string): string {
	return rest.match(/\[(.*)\]\)?[,]?$/)?.[1] ?? rest;
}

/**
 * Parameters for a registered callable, from wherever its implementation lives:
 * a method on the extension, a static helper, or a PHP builtin we cannot read
 * and do not pretend to.
 */
function resolveParameters(
	source: CraftSource,
	extensionPhp: string,
	callable: PhpCallable | undefined,
	kind: Exclude<CatalogEntryKind, 'tags' | 'globals'>,
	options: string,
): CatalogParameter[] {
	const methodName = callable?.method;
	const php =
		methodName === undefined
			? undefined
			: callable?.onExtension === true
				? extensionPhp
				: callable?.className === undefined
					? undefined
					: readHelper(source, callable.className);

	if (php === undefined || methodName === undefined) {
		return [];
	}

	const signature = php.match(new RegExp(`function\\s+${methodName}\\s*\\(([^)]*)\\)`, 's'))?.[1];
	if (signature === undefined) {
		return [];
	}

	const parameters = stripHiddenParameters(parsePhpParameters(signature), options);

	// A filter's and a test's first argument is the value being piped in, which
	// the template never writes as an argument.
	if (kind === 'filters' || kind === 'tests') {
		parameters.shift();
	}

	return parameters.map((parameter) =>
		pruneUndefined({ ...parameter, type: normalizeType(parameter.type) }),
	);
}

function readHelper(source: CraftSource, className: string): string | undefined {
	for (const directory of ['src/helpers', 'src/web/twig/variables', 'src/elements/db']) {
		const path = join(source.checkout, directory, `${className}.php`);
		if (existsSync(path)) {
			return readFileSync(path, 'utf8');
		}
	}
	return undefined;
}

/** Arguments Twig injects rather than the template passing them. */
function stripHiddenParameters(
	parameters: CatalogParameter[],
	options: string,
): CatalogParameter[] {
	const stripped = [...parameters];
	const hidden = [
		['needs_environment', 'env'],
		['needs_context', 'context'],
		['needs_charset', 'charset'],
	] as const;

	for (const [option, parameterName] of hidden) {
		if (options.includes(option) && stripped[0]?.name === parameterName) {
			stripped.shift();
		}
	}

	return stripped;
}

// ---------------------------------------------------------------------------
// The craft.* object model
// ---------------------------------------------------------------------------

function buildObjects(
	source: CraftSource,
	entries: Record<CatalogEntryKind, Map<string, CatalogEntry>>,
): Map<string, CatalogObject> {
	const objects = new Map<string, CatalogObject>();
	const craftVariable = buildCraftVariable(source, entries);
	objects.set(craftVariable.name, craftVariable);
	objects.set(ELEMENT_QUERY_OBJECT, buildElementQueryObject(source));

	for (const member of craftVariable.members) {
		if (member.type === undefined || QUERY_ARTIFACTS[member.type] === undefined) {
			continue;
		}
		const query = buildQueryObject(source, member.type);
		if (query !== undefined) {
			objects.set(query.name, query);
		}
	}

	return objects;
}

/**
 * `craft` itself: the element-query factories `CraftVariable` declares, plus the
 * services reachable through it. The factories are read off their PHP return
 * types, which is what ties `craft.entries` to the `EntryQuery` object.
 */
function buildCraftVariable(
	source: CraftSource,
	entries: Record<CatalogEntryKind, Map<string, CatalogEntry>>,
): CatalogObject {
	const php = readFileSync(
		join(source.checkout, 'src/web/twig/variables/CraftVariable.php'),
		'utf8',
	);
	const members: CatalogMember[] = [];
	const docsUrlForCraft = `${source.twigDocsBaseUrl}/global-variables.html#craft`;

	for (const match of php.matchAll(
		/(\/\*\*[\s\S]*?\*\/)\s*public function ([A-Za-z][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:\s*([A-Za-z|\\]+)/g,
	)) {
		const [, docblock = '', name = '', parameterSource = '', returnType = ''] = match;
		const type = normalizeType(returnType);
		if (type === undefined || QUERY_ARTIFACTS[type] === undefined) {
			continue;
		}

		const parameters = parsePhpParameters(parameterSource).map((parameter) =>
			pruneUndefined({ ...parameter, type: normalizeType(parameter.type) }),
		);

		members.push(
			pruneUndefined({
				name,
				kind: 'method',
				type,
				signature: buildSignature(name, parameters),
				parameters,
				description: docblockSummary(docblock) ?? `Returns a new ${type}.`,
				docsUrl: source.elementTypeUrl(QUERY_ARTIFACTS[type]),
				sinceVersion: docblockSince(docblock),
				completionSnippet: `${name}($1)`,
				source: {
					phpClass: 'craft\\web\\twig\\variables\\CraftVariable',
				},
			}) as CatalogMember,
		);
	}

	// `app` is a plain property; the rest are Yii components declared only in the
	// class docblock, so there is no signature to read for them anywhere.
	for (const match of php.matchAll(/@property\s+([A-Za-z]+)\s+\$([A-Za-z]+)/g)) {
		const [, propertyType = '', name = ''] = match;
		members.push({
			name,
			kind: 'property',
			signature: `${name}: ${propertyType}`,
			parameters: [],
			description: `Craft's ${name} variable — a ${propertyType} object.`,
			docsUrl: docsUrlForCraft,
			completionSnippet: name,
			source: { phpClass: 'craft\\web\\twig\\variables\\CraftVariable' },
		});
	}

	if (php.includes('public null|WebApplication|ConsoleApplication $app')) {
		members.push({
			name: 'app',
			kind: 'property',
			signature: 'app: Application',
			parameters: [],
			description:
				'The main Craft application instance — the same object as `Craft::$app` in PHP.',
			docsUrl: `${source.twigDocsBaseUrl}/global-variables.html#craftapp`,
			completionSnippet: 'app',
			source: { phpClass: 'craft\\web\\twig\\variables\\CraftVariable' },
		});
	}

	return {
		name: 'craft',
		description:
			entries.globals.get('craft')?.description ??
			'A CraftVariable object, the entry point to Craft’s template API.',
		docsUrl: docsUrlForCraft,
		members: members.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

/**
 * The methods that run a query rather than narrow it — `all()`, `one()`, and
 * friends. Craft documents exactly this set under "Executing Element Queries",
 * which is a better list than anything a filter over `ElementQuery`'s hundred
 * public methods would produce; their signatures still come from the source.
 */
function buildElementQueryObject(source: CraftSource): CatalogObject {
	const docs = readFileSync(join(docsCheckout, source.elementQueriesDoc), 'utf8');
	const section = sectionBody(docs, 'Executing Element Queries');
	const php = readFileSync(join(source.checkout, 'src/elements/db/ElementQuery.php'), 'utf8');
	const members: CatalogMember[] = [];

	// Split rather than match a body: `$` under /m ends at every line, and a
	// lazy body with a `$` alternative in its lookahead stops at the first one.
	for (const chunk of section.split(/^### /m).slice(1)) {
		const heading = /^`([A-Za-z]+)\(\)`[^\n]*\n([\s\S]*)$/.exec(chunk);
		if (heading === null) {
			continue;
		}
		const [, name = '', body = ''] = heading;
		const signature = php.match(
			new RegExp(`public function ${name}\\s*\\(([^)]*)\\)`, 's'),
		)?.[1];
		const parameters =
			signature === undefined
				? []
				: parsePhpParameters(signature)
						.filter((parameter) => !INTERNAL_QUERY_PARAMETERS.has(parameter.name))
						.map((parameter) =>
							pruneUndefined({ ...parameter, type: normalizeType(parameter.type) }),
						);

		members.push({
			name,
			kind: 'method',
			signature: buildSignature(name, parameters),
			parameters,
			description: markdownSummary(body) ?? `Executes the query.`,
			docsUrl: `${source.elementQueriesUrl}#${name.toLowerCase()}`,
			completionSnippet: `${name}(${parameters.length > 0 ? '$1' : ''})`,
			source: { phpClass: 'craft\\elements\\db\\ElementQuery' },
		});
	}

	return {
		name: ELEMENT_QUERY_OBJECT,
		description: 'Methods that execute an element query and return its results.',
		docsUrl: `${source.elementQueriesUrl}#executing-element-queries`,
		members: members.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

/**
 * One element query type. The parameter list comes from the table Craft
 * generates into its own docs, so it is complete including everything inherited;
 * the source only has to say whether each one returns the query (keeping the
 * chain open) or a result (ending it).
 */
function buildQueryObject(source: CraftSource, className: string): CatalogObject | undefined {
	const slug = QUERY_ARTIFACTS[className];
	if (slug === undefined) {
		return undefined;
	}
	const artifactPath = join(docsCheckout, source.artifactsDir, `${slug}.md`);
	if (!existsSync(artifactPath)) {
		return undefined;
	}

	const artifact = readFileSync(artifactPath, 'utf8');
	const php = readQueryClass(source, className);
	const members: CatalogMember[] = [];

	for (const row of parseTable(artifact)) {
		const declared = findQueryMethod(source, php, row.name);
		const parameters = declared?.parameters ?? [{ name: 'value', optional: false }];

		members.push(
			pruneUndefined({
				name: row.name,
				kind: 'method',
				// Yii's query-builder methods that Craft does not redeclare
				// (`limit`, `offset`, `orderBy`) all return the query too; a
				// param that did not would have shown up as a result method in
				// the executing-queries docs instead.
				type: declared?.chainable === false ? undefined : className,
				signature: buildSignature(row.name, parameters),
				parameters,
				description: row.description,
				docsUrl: `${source.elementTypeUrl(slug)}#${row.anchor ?? row.name.toLowerCase()}`,
				sinceVersion: row.sinceVersion,
				completionSnippet: `${row.name}($1)`,
				source: { phpClass: `craft\\elements\\db\\${className}` },
			}) as CatalogMember,
		);
	}

	return {
		name: className,
		extends: ELEMENT_QUERY_OBJECT,
		description: `Query parameters for ${slug.replace(/-/g, ' ')}.`,
		docsUrl: source.elementTypeUrl(slug),
		members: members.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function readQueryClass(source: CraftSource, className: string): string {
	const path = join(source.checkout, 'src/elements/db', `${className}.php`);
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

interface DeclaredMethod {
	readonly parameters: CatalogParameter[];
	readonly chainable: boolean;
}

/**
 * A query param's PHP declaration, from the query class or the base it inherits
 * from. Params Yii declares are not in either file, and get no answer.
 */
function findQueryMethod(
	source: CraftSource,
	php: string,
	name: string,
): DeclaredMethod | undefined {
	const bases = [php, readQueryClass(source, ELEMENT_QUERY_OBJECT)];

	for (const body of bases) {
		const match = body.match(
			new RegExp(`public function ${name}\\s*\\(([^)]*)\\)\\s*:\\s*([A-Za-z|\\\\ ]+)`, 's'),
		);
		if (match === null) {
			continue;
		}
		const [, parameterSource = '', returnType = ''] = match;
		return {
			parameters: parsePhpParameters(parameterSource)
				.filter((parameter) => !INTERNAL_QUERY_PARAMETERS.has(parameter.name))
				.map((parameter) =>
					pruneUndefined({ ...parameter, type: normalizeType(parameter.type) }),
				),
			chainable: /\b(static|self)\b/.test(returnType),
		};
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Merging the two majors
// ---------------------------------------------------------------------------

function mergeMajors(four: Scrape, five: Scrape): DialectPack {
	const entries = createEntryMaps<CatalogEntry>();

	for (const kind of entryKinds) {
		for (const [name, merged] of mergeItems(four.entries[kind], five.entries[kind])) {
			entries[kind].set(name, merged);
		}
	}

	const objects = new Map<string, CatalogObject>();
	for (const name of [...new Set([...four.objects.keys(), ...five.objects.keys()])].sort((a, b) =>
		a.localeCompare(b),
	)) {
		const inFour = four.objects.get(name);
		const inFive = five.objects.get(name);
		// `name` comes from the union of both majors' keys, so one of these is always set.
		const base = inFive ?? inFour;
		if (!base) {
			throw new Error(`No scraped object for "${name}" in either major`);
		}

		objects.set(name, {
			...base,
			members: [
				...mergeItems(
					new Map((inFour?.members ?? []).map((member) => [member.name, member])),
					new Map((inFive?.members ?? []).map((member) => [member.name, member])),
				).values(),
			].sort((a, b) => a.name.localeCompare(b.name)),
		});
	}

	return {
		schemaVersion: 1,
		name: 'craft',
		displayName: 'CraftCMS',
		version: '4.x–5.x',
		sources: {
			twig: { repository: CMS_REPOSITORY, ref: CRAFT_5_REF },
			twigPrevious: { repository: CMS_REPOSITORY, ref: CRAFT_4_REF },
			docs: { repository: DOCS_REPOSITORY, ref: DOCS_REF, path: 'docs' },
		},
		detect: {
			kind: 'composer',
			composerPackages: ['craftcms/cms'],
			versionFrom: 'craftcms/cms',
		},
		entries: {
			tags: sortedEntries(entries.tags),
			filters: sortedEntries(entries.filters),
			functions: sortedEntries(entries.functions),
			tests: sortedEntries(entries.tests),
			globals: sortedEntries(entries.globals),
		},
		objects: [...objects.values()],
	} as DialectPack;
}

/**
 * One name's item across the two majors.
 *
 * Presence is the evidence: in 5 only means it arrived in 5, in 4 only means it
 * left in 5. A `<Since ver="…" />` marker in the docs beats the diff, because
 * "5.6.0" is a truer answer than "some time in 5" and the diff cannot see it.
 */
function mergeItems<T extends CatalogEntry | CatalogMember>(
	four: ReadonlyMap<string, T>,
	five: ReadonlyMap<string, T>,
): Map<string, T> {
	const merged = new Map<string, T>();

	for (const name of [...new Set([...four.keys(), ...five.keys()])].sort((a, b) =>
		a.localeCompare(b),
	)) {
		const inFour = four.get(name);
		const inFive = five.get(name);

		if (inFive === undefined) {
			merged.set(name, {
				...(inFour as T),
				removedVersion: CRAFT_5_BASELINE,
			});
			continue;
		}

		if (inFour === undefined) {
			merged.set(name, {
				...inFive,
				sinceVersion: inFive.sinceVersion ?? CRAFT_5_BASELINE,
			});
			continue;
		}

		merged.set(
			name,
			pruneUndefined({
				...inFive,
				sinceVersion: inFive.sinceVersion ?? inFour.sinceVersion,
			}) as T,
		);
	}

	return merged;
}

function sortedEntries(entries: ReadonlyMap<string, CatalogEntry>): CatalogEntry[] {
	return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function readDocsTable(source: CraftSource, kind: CatalogEntryKind): Map<string, DocsRow> {
	const page = DOCS_PAGES[kind];
	const path = join(docsCheckout, source.twigDocsDir, page.file);
	if (!existsSync(path)) {
		return new Map();
	}

	const markdown = readFileSync(path, 'utf8');
	const scopes =
		page.sections === undefined
			? [markdown]
			: page.sections.map((section) => sectionBody(markdown, section));

	const rows = new Map<string, DocsRow>();
	for (const scope of scopes) {
		for (const row of parseTable(scope)) {
			rows.set(row.name, row);
		}
	}
	return rows;
}

/**
 * Rows of a `name | description` docs table.
 *
 * Craft writes these by hand for the Twig reference and generates them for
 * element queries, but the shape is the same in both: a linked name, an
 * optional `<Since>` marker, and prose.
 */
function parseTable(markdown: string): DocsRow[] {
	const rows: DocsRow[] = [];

	for (const line of markdown.split('\n')) {
		const match = /^\|?\s*\[([^\]]+)\]\(([^)]+)\)([^|]*)\|\s*(.+?)\s*\|?\s*$/.exec(line);
		if (match === null) {
			continue;
		}
		const [, name = '', link = '', trailing = '', description = ''] = match;

		// Rows like `[Global set variables](#global-set-variables)` point at a
		// docs section rather than naming anything a template can write. Test
		// names are the reason this cannot just require an identifier: `instance
		// of` and `divisible by` are real, and are lowercase where the prose
		// rows are not.
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[a-z]+( [a-z]+)+$/.test(name)) {
			continue;
		}

		rows.push(
			pruneUndefined({
				name,
				description: normalizeMarkdown(description),
				anchor: link.startsWith('#') ? link.slice(1) : undefined,
				sinceVersion: /<Since\s+ver="([^"]+)"/.exec(trailing)?.[1],
				twigCore: link.includes('twig.symfony.com'),
			}),
		);
	}

	return rows;
}

/** A `## Heading` section's body, up to the next heading of the same level. */
function sectionBody(markdown: string, heading: string): string {
	const lines = markdown.split('\n');
	const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
	if (start === -1) {
		return '';
	}

	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^##\s/.test(line));
	return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The first prose paragraph, which is a docs page's own summary of an item. */
function markdownSummary(body: string): string | undefined {
	for (const rawLine of body.split('\n')) {
		const line = rawLine.trim();
		if (
			line === '' ||
			line.startsWith('#') ||
			line.startsWith('```') ||
			line.startsWith(':::') ||
			line.startsWith('|') ||
			line.startsWith('<')
		) {
			continue;
		}
		return normalizeMarkdown(line);
	}
	return undefined;
}

function docblockSummary(docblock: string): string | undefined {
	const lines = docblock
		.split('\n')
		.map((line) => line.replace(/^\s*\/?\*+\/?/, '').trim())
		.filter((line) => line !== '');

	const summary: string[] = [];
	for (const line of lines) {
		if (line.startsWith('@')) {
			break;
		}
		summary.push(line);
		if (/[.!?]$/.test(line)) {
			break;
		}
	}

	const description = normalizeMarkdown(summary.join(' '));
	return description.length >= 8 ? description : undefined;
}

function docblockSince(docblock: string): string | undefined {
	return /@since\s+([0-9][^\s*]*)/.exec(docblock)?.[1];
}

/** Docs-flavoured markdown down to something a hover panel can render. */
function normalizeMarkdown(source: string): string {
	return source
		.replace(/<Since\s+[^>]*\/>/g, '')
		.replace(/<See\s+[^>]*\/>/g, '')
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/\[([^\]]+)\]\((?:craft[45]:|kb:)[^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/<craft[45]:([^>]+)>/g, (_, value: string) => value.split('\\').pop() ?? value)
		.replace(/\s+/g, ' ')
		.trim();
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** The body of a PHP method, matched by brace depth from its `{`. */
function methodBody(php: string, methodName: string): string {
	const start = php.search(new RegExp(`function\\s+${methodName}\\s*\\([^)]*\\)[^{]*\\{`));
	if (start === -1) {
		throw new Error(`No ${methodName}() in source`);
	}

	const open = php.indexOf('{', start);
	let depth = 0;
	for (let at = open; at < php.length; at++) {
		if (php[at] === '{') {
			depth++;
		} else if (php[at] === '}') {
			depth--;
			if (depth === 0) {
				return php.slice(open + 1, at);
			}
		}
	}

	throw new Error(`Unbalanced braces in ${methodName}()`);
}

function buildCompletionSnippet(
	kind: CatalogEntryKind,
	name: string,
	parameters: readonly CatalogParameter[],
): string {
	const placeholders = parameters.map((_, index) => `$${index + 1}`).join(', ');

	switch (kind) {
		case 'tags':
			return `{% ${name} $0 %}`;
		case 'filters':
			return parameters.length > 0 ? `|${name}(${placeholders})` : `|${name}`;
		case 'tests':
			return parameters.length > 0 ? `is ${name}(${placeholders})` : `is ${name}`;
		case 'globals':
			return name;
		case 'functions':
			return parameters.length > 0 ? `${name}(${placeholders})` : `${name}($0)`;
	}
}

function docsUrl(source: CraftSource, kind: CatalogEntryKind, row: DocsRow | undefined): string {
	const page = DOCS_PAGES[kind].file.replace(/\.md$/, '.html');
	const anchor = row?.anchor === undefined ? '' : `#${row.anchor}`;
	return `${source.twigDocsBaseUrl}/${page}${anchor}`;
}

function docsPath(source: CraftSource, kind: CatalogEntryKind): string {
	return `${source.twigDocsDir}/${DOCS_PAGES[kind].file}`;
}

function createEntryMaps<T>(): Record<CatalogEntryKind, Map<string, T>> {
	return {
		tags: new Map(),
		filters: new Map(),
		functions: new Map(),
		tests: new Map(),
		globals: new Map(),
	};
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

type SourceEntry = Partial<CatalogEntry> & Pick<CatalogEntry, 'name'>;
type SourceMember = Partial<CatalogMember> & Pick<CatalogMember, 'name'>;

interface OverrideCatalog {
	entries?: Partial<Record<CatalogEntryKind, SourceEntry[]>>;
	objects?: {
		name: string;
		description?: string;
		docsUrl?: string;
		members?: SourceMember[];
		$comment?: string;
	}[];
}

/**
 * `$comment` keys annotate the overrides file for whoever edits it next; they
 * are notes to a human, and must not survive into the pack.
 */
function withoutComment<T extends Record<string, unknown>>(value: T): Omit<T, '$comment'> {
	const { $comment: _comment, ...rest } = value;
	return rest;
}

/**
 * Hand-tuned corrections, merged over the generated pack.
 *
 * An override that names something the scrape did not produce is an error
 * rather than an insertion: the file exists to fix what the generators get
 * wrong, and a typo in it should not quietly become a catalog entry.
 */
function applyOverrides(pack: DialectPack): DialectPack {
	if (!existsSync(overridesPath)) {
		return pack;
	}

	const overrides = JSON.parse(readFileSync(overridesPath, 'utf8')) as OverrideCatalog;

	for (const kind of entryKinds) {
		const kindOverrides = overrides.entries?.[kind];
		if (kindOverrides === undefined) {
			continue;
		}

		const byName = new Map(pack.entries[kind].map((entry) => [entry.name, entry]));
		for (const override of kindOverrides) {
			const existing = byName.get(override.name);
			if (existing === undefined) {
				throw new Error(`Override references unknown ${kind} entry "${override.name}"`);
			}
			byName.set(override.name, deepMerge(existing, override));
		}
		pack.entries[kind] = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	for (const override of overrides.objects ?? []) {
		const object = pack.objects?.find((candidate) => candidate.name === override.name);
		if (object === undefined) {
			throw new Error(`Override references unknown object "${override.name}"`);
		}

		const { members: memberOverrides, ...objectFields } = override;
		Object.assign(object, deepMerge(object, withoutComment(objectFields)));

		const byName = new Map(object.members.map((member) => [member.name, member]));
		for (const memberOverride of memberOverrides ?? []) {
			const existing = byName.get(memberOverride.name);
			if (existing === undefined) {
				throw new Error(
					`Override references unknown member "${override.name}.${memberOverride.name}"`,
				);
			}
			byName.set(memberOverride.name, deepMerge(existing, memberOverride));
		}
		object.members = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	return pack;
}
