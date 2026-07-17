import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
	CatalogEntry,
	CatalogEntryKind,
	CatalogMember,
	CatalogObject,
	CatalogParameter,
	ClassPack,
	DialectPack,
} from '../packages/language-server/src/catalog';
import { type ChangelogVersions, parseCraftChangelog } from './lib/changelog';
import { cacheRoot, ensureCheckout, repoRoot } from './lib/checkout';
import {
	buildSignature,
	deepMerge,
	firstSentence,
	normalizeType,
	parsePhpParameters,
	pruneUndefined,
} from './lib/php';
import { PhpClassIndex, type PhpClassMember } from './lib/php-class';

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
 *
 * The diff is a blunt instrument, though: it dates everything Craft added during
 * a major to that major's `.0`, because presence in one checkout is all it can
 * see. Each major's changelog can see the rest — it says which release added
 * each name — so it fills in underneath the docs and above the diff. Its claims
 * are deliberately hard to make (see `lib/changelog.ts`); a name it cannot be
 * sure of keeps the coarser answer, which is wrong only about precision.
 */

const CMS_REPOSITORY = 'https://github.com/craftcms/cms.git';
const DOCS_REPOSITORY = 'https://github.com/craftcms/docs.git';
const YII_REPOSITORY = 'https://github.com/yiisoft/yii2.git';

/** craftcms/docs @ main. */
const DOCS_REF = 'c21b31983e901b6c9d1b79052eb115c9325f58f3';
/** craftcms/cms @ 5.10.11. */
const CRAFT_5_REF = '9dece66d9d35f9f2615f5f2107c98d2334c71cfc';
/** craftcms/cms @ 4.18.5. */
const CRAFT_4_REF = '3f51275df56f897829213d23f6f16d269a65ec55';
/**
 * yiisoft/yii2 @ 2.0.55.
 *
 * One ref for both majors, because both pin the same one: Craft 4.18.5 and
 * 5.10.11 each require `~2.0.55.0`. Craft is half of `craft.app.*` and Yii is
 * the other half — `craft.app.request.queryString` is Yii's property on Craft's
 * class — so without this checkout the model would stop at the class Craft
 * happens to declare, which is not where a template's chain stops.
 */
const YII_REF = 'babee66def599432735a1ed39c9cf0bc5163a775';

const CMS_SPARSE_PATHS = [
	'src/base',
	'src/behaviors',
	'src/config',
	'src/db',
	'src/elements',
	'src/fields',
	'src/fs',
	'src/helpers',
	'src/i18n',
	'src/models',
	'src/services',
	'src/web',
];
const YII_SPARSE_PATHS = ['framework/base', 'framework/i18n', 'framework/web'];
const DOCS_SPARSE_PATHS = [
	'docs/5.x/reference/twig',
	'docs/5.x/development',
	'docs/4.x/dev',
	'docs/.artifacts/cms/5.x',
	'docs/.artifacts/cms/4.x',
];

const docsCheckout = join(cacheRoot, 'craft-docs');
const yiiCheckout = join(cacheRoot, 'yii2');
const outputPath = join(repoRoot, 'catalogs', 'craft.json');
const classesOutputPath = join(repoRoot, 'catalogs', 'craft-classes.json');
const docsIndexPath = join(repoRoot, 'catalogs', 'craft.docs-index.json');
const overridesPath = join(repoRoot, 'catalogs', 'overrides', 'craft.json');
const classOverridesPath = join(repoRoot, 'catalogs', 'overrides', 'craft-classes.json');

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

/** What `craft.app` is. Every modelled application class is reached from here. */
const APPLICATION_CLASS = 'craft\\web\\Application';

/**
 * How far the class walk *discovers* new classes from a root.
 *
 * Two is not a round number, it is the shape of the thing: the application, its
 * services, and what a service hands back. `craft.app.config.general.devMode`
 * and `craft.app.sites.currentSite.handle` are both exactly that deep, and past
 * it the return types stop being a template's vocabulary and start being
 * Craft's internals.
 *
 * It bounds discovery only, not typing. A member pointing at a class the model
 * already has keeps its type however deep it was found, because the cost of
 * saying so is a name the file already carries: `craft.app.user.identity` is
 * three deep and yields a `User`, which is a root in its own right. Typing is
 * decided afterwards, by whether the target was modelled at all — see
 * `pruneUnresolvableTypes`.
 */
const MAX_CLASS_DEPTH = 2;

/**
 * The element classes, which are the content half of the model.
 *
 * These are roots rather than discoveries because nothing in `craft.app` points
 * at them within the depth bound, and they are what a template spends its day
 * dotting into: `entry.title`, `currentUser.photo`, `asset.getDataUrl`. Every
 * one of them inherits the bulk of its surface from `craft\base\Element`, which
 * is why the base is a root too — modelled once, named by the rest.
 *
 * `MatrixBlock` is Craft 4's and absent from 5; a root the checkout does not
 * have is skipped, and the version merge is what turns that into
 * `removedVersion: 5.0.0`.
 */
const ELEMENT_CLASSES = [
	'craft\\base\\Element',
	'craft\\elements\\Address',
	'craft\\elements\\Asset',
	'craft\\elements\\Category',
	'craft\\elements\\Entry',
	'craft\\elements\\GlobalSet',
	'craft\\elements\\MatrixBlock',
	'craft\\elements\\Tag',
	'craft\\elements\\User',
];

/**
 * Globals whose type the model can name, and what they are.
 *
 * A list rather than a scrape, for the same reason `APP_SERVICES` is one:
 * `Extension::getGlobals()` builds these by calling into Craft
 * (`Craft::$app->getUser()->getIdentity()`), and a return type is not something
 * that expression has. The names are few, stable, and documented.
 */
const GLOBAL_OBJECT_TYPES: Record<string, string> = {
	craft: 'craft',
	currentUser: 'craft\\elements\\User',
	currentSite: 'craft\\models\\Site',
};

/**
 * The `craft.app` services worth modelling.
 *
 * `ApplicationTrait` declares 68, and a completion list with `composer`, `gc`,
 * `mutex` and `migrator` in it is a worse list than one without them: those
 * services exist for Craft's own console commands, and nothing a template can
 * write reaches them. This is the front-end runtime — the request and response,
 * the session and the user, the view, URLs, config, sites, i18n — and it is a
 * list rather than a rule because "would a template author type this?" is not a
 * property of the source.
 *
 * The content services (`elements`, `fields`, `entries`, `assets`, `categories`,
 * `users`) were the deliberate omission, on the grounds that milestone 10
 * answers the same questions with the project's own handles. That was half
 * right and half a dead end: milestone 10 knows `entry.myAssetsField` is an
 * Assets field, and knew nothing about what an Assets field *is*. The two are
 * complements rather than competitors — the project config names the fields, the
 * class model types them — so the services are in, and the merge happens where
 * both are known, in the member provider.
 */
const APP_SERVICES = new Set([
	'assets',
	'categories',
	'config',
	'elements',
	'entries',
	'fields',
	'formatter',
	'formattingLocale',
	'globals',
	'locale',
	'plugins',
	'request',
	'response',
	'security',
	'session',
	'sites',
	'urlManager',
	'user',
	'users',
	'view',
]);

/**
 * Where the inheritance walk stops.
 *
 * Yii's object plumbing is public and inherited by everything: `init()`,
 * `trigger()`, `attachBehavior()`, `canGetProperty()`. It is real API and it is
 * not the API anyone is looking for in a Twig file, so the walk takes the class
 * and its meaningful parents and leaves the framework's base classes alone.
 */
const STOP_CLASSES = new Set([
	'yii\\base\\BaseObject',
	'yii\\base\\Behavior',
	'yii\\base\\Component',
	'yii\\base\\Module',
	'yii\\base\\ServiceLocator',
	'yii\\di\\ServiceLocator',
]);

/**
 * Framework hooks a class overrides rather than offers. `init()` is Yii's
 * lifecycle and `rules()`/`fields()` are its model plumbing; a class redeclaring
 * one puts it back in reach of the walk, and it is noise wherever it lands.
 */
const DENIED_METHODS = new Set([
	'attributeLabels',
	'attributes',
	'behaviors',
	'extraFields',
	'fields',
	'init',
	'rules',
]);

/**
 * Classes a member's type is allowed to name.
 *
 * Only Craft's own, and that falls out of the link policy rather than taste:
 * Craft's reference has no `yii-*` pages, so a chain that carried on into
 * `yii\web\Response` would be offering members it cannot document. The chain
 * ends where the documentation does.
 *
 * Yii's classes still reach the model, as *parents* rather than as types:
 * `craft\web\Request extends yii\web\Request`, and half of what
 * `craft.app.request.*` offers is declared up there. A parent is a place members
 * are stored, not a place a chain arrives at, so nothing links to its page — the
 * members it lends are documented against the Craft class doing the extending.
 */
const MODELLED_PREFIX = 'craft\\';

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
	/** The deep class model, shipped separately and loaded on demand. */
	readonly classes: Map<string, CatalogObject>;
	/** When this major's releases added each name, where its changelog says so. */
	readonly changelog: ChangelogVersions;
}

main();

function main(): void {
	ensureCheckout({
		directory: docsCheckout,
		repository: DOCS_REPOSITORY,
		ref: DOCS_REF,
		sparsePaths: DOCS_SPARSE_PATHS,
	});
	ensureCheckout({
		directory: yiiCheckout,
		repository: YII_REPOSITORY,
		ref: YII_REF,
		sparsePaths: YII_SPARSE_PATHS,
	});
	for (const source of [craft4, craft5]) {
		ensureCheckout({
			directory: source.checkout,
			repository: CMS_REPOSITORY,
			ref: source.ref,
			sparsePaths: CMS_SPARSE_PATHS,
		});
	}

	const four = scrape(craft4);
	const five = scrape(craft5);

	const pack = applyOverrides(mergeMajors(four, five));
	const classPack = applyClassOverrides(mergeClassPack(four, five));
	assertObjectTypesResolve(pack, classPack);

	writeFileSync(outputPath, `${JSON.stringify(pack, null, 2)}\n`);
	writeFileSync(classesOutputPath, `${JSON.stringify(classPack, null, 2)}\n`);
	writeFileSync(docsIndexPath, `${JSON.stringify(buildDocsIndex(craft5), null, 2)}\n`);
}

/**
 * The class model, as its own pack.
 *
 * It is a separate file because of what it costs to have around: it is the
 * larger half of Craft's surface by an order of magnitude, and nothing needs it
 * until someone types a `.`. The server reads it on the first member lookup and
 * not before, so a project that never dots into anything never pays for it —
 * which is every project, for the first few seconds of every session.
 */
function mergeClassPack(four: Scrape, five: Scrape): ClassPack {
	return {
		schemaVersion: 1,
		pack: 'craft',
		classes: [...mergeObjects(four.classes, five.classes).values()],
	};
}

/**
 * Every `objectType` and every member `type` names something the model has.
 *
 * The two files are generated together and read apart, so a name that resolves
 * here and not at runtime is exactly the bug this catches: `currentUser` is a
 * global in one file whose type is a class in the other, and nothing but this
 * checks that the two agree. A chain resolver handed a type it cannot find
 * silently stops, which looks identical to a template the model knows nothing
 * about — a false negative that would never show up as a failure.
 */
function assertObjectTypesResolve(pack: DialectPack, classPack: ClassPack): void {
	const known = new Set([
		...(pack.objects ?? []).map((object) => object.name),
		...classPack.classes.map((object) => object.name),
	]);

	for (const entry of pack.entries.globals) {
		if (entry.objectType !== undefined && !known.has(entry.objectType)) {
			throw new Error(`Global "${entry.name}" names unmodelled object "${entry.objectType}"`);
		}
	}

	for (const object of [...(pack.objects ?? []), ...classPack.classes]) {
		if (object.extends !== undefined && !known.has(object.extends)) {
			throw new Error(`Object "${object.name}" extends unmodelled "${object.extends}"`);
		}
		for (const member of object.members) {
			if (member.type !== undefined && !known.has(member.type)) {
				throw new Error(
					`Member "${object.name}.${member.name}" names unmodelled type "${member.type}"`,
				);
			}
		}
	}
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

	const objects = buildObjects(source, entries);
	const classes = buildClassObjects(source);
	pruneUnresolvableTypes(objects, classes);
	pruneUnresolvableTypes(classes, objects);

	return { entries, objects, classes, changelog: readChangelog(source) };
}

/**
 * One major's release notes. Each checkout keeps only its own major's, under the
 * name Craft publishes it as (`CHANGELOG-v4.md`), so the file the Craft 4
 * checkout has is the Craft 4 changelog and the parser is told which major to
 * expect rather than trusting that.
 */
function readChangelog(source: CraftSource): ChangelogVersions {
	return parseCraftChangelog(
		readFileSync(join(source.checkout, 'CHANGELOG.md'), 'utf8'),
		source.major,
	);
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
				...(kind === 'globals' && GLOBAL_OBJECT_TYPES[name] !== undefined
					? { objectType: GLOBAL_OBJECT_TYPES[name] }
					: {}),
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

/**
 * The docs-driven half of the model: `craft` itself and the element queries.
 *
 * These stay in `craft.json` because they are small, they are what a `craft.*`
 * completion needs immediately, and their documentation lives on hand-written
 * docs pages rather than in the class reference — so unlike the class model,
 * their links cannot be derived and have to be carried.
 */
function buildObjects(
	source: CraftSource,
	entries: Record<CatalogEntryKind, Map<string, CatalogEntry>>,
): Map<string, CatalogObject> {
	const objects = new Map<string, CatalogObject>();
	const craftVariable = buildCraftVariable(source, entries);
	objects.set(craftVariable.name, craftVariable);
	objects.set(ELEMENT_QUERY_OBJECT, buildElementQueryObject(source));

	const elementQuery = objects.get(ELEMENT_QUERY_OBJECT) as CatalogObject;
	for (const member of craftVariable.members) {
		if (member.type === undefined || QUERY_ARTIFACTS[member.type] === undefined) {
			continue;
		}
		const query = buildQueryObject(source, member.type, elementQuery);
		if (query !== undefined) {
			objects.set(query.name, query);
		}
	}

	return objects;
}

/**
 * `craft.entries.one()` is an `Entry`, and this is where the model learns it.
 *
 * `ElementQuery.one()` can only say "an element"; the concrete query knows
 * which. Craft says so itself, in the `@replace {element-class}` marker its docs
 * tooling reads to write "Returns an entry" onto the right page — every query
 * class carries one, in both majors, so this is read rather than mapped.
 *
 * `one()` is the only execution method that gets a type, and the reason is the
 * schema rather than the source: `all()` returns a *list* of entries, `ids()` a
 * list of ints, and a member's `type` names one object. Nothing here can say
 * "many of these", so `all()` names no type and the chain ends — which is
 * correct, because what a template does next is Twig's array access, not ours.
 */
function elementResultMembers(
	source: CraftSource,
	php: string,
	elementQuery: CatalogObject,
): CatalogMember[] {
	const elementClass = /@replace \{element-class\}\s+\\?([\w\\]+)/.exec(php)?.[1];
	const one = elementQuery.members.find((member) => member.name === 'one');
	if (elementClass === undefined || one === undefined) {
		return [];
	}
	if (classIndex(source).read(elementClass) === undefined) {
		return [];
	}

	return [{ ...one, type: elementClass }];
}

// ---------------------------------------------------------------------------
// The craft.app.* class model
// ---------------------------------------------------------------------------

/**
 * The class model: everything reachable from `craft.app` and from the elements.
 *
 * A breadth-first walk out of a set of roots, bounded three ways: it only
 * follows types into Craft's own classes, only discovers to `MAX_CLASS_DEPTH`,
 * and only leaves `craft.app` through the services in `APP_SERVICES`. The bounds
 * are the feature — every class it models is one a template author dots into,
 * and the walk stops where their vocabulary does rather than where the source
 * runs out.
 *
 * Members are stored on the class that declares them and nowhere else. A class
 * names its parent and inherits the rest at load time, which is the difference
 * between modelling `craft\base\Element` once and modelling it once per element
 * type. Parents are walked whether or not they are Craft's, because that is
 * where the members are; they are just never somewhere a chain can arrive.
 *
 * Objects are keyed by fully-qualified name. The names in this map are opaque to
 * everything downstream, and an FQN is the one name that cannot collide:
 * `craft\web\User` (the component) and `craft\elements\User` (the element) are
 * both `User`, and are not the same object.
 */
function buildClassObjects(source: CraftSource): Map<string, CatalogObject> {
	const index = classIndex(source);
	const roots = [APPLICATION_CLASS, ...ELEMENT_CLASSES];

	const objects = new Map<string, CatalogObject>();
	const queued = new Set<string>(roots);
	const queue: { fqn: string; depth: number }[] = roots.map((fqn) => ({ fqn, depth: 0 }));

	while (queue.length > 0) {
		const { fqn, depth } = queue.shift() as { fqn: string; depth: number };
		const object = buildClassObject(index, fqn);
		if (object === undefined) {
			continue;
		}
		objects.set(fqn, object);

		// A parent carries members this class is claiming by name, so it has to
		// be modelled whatever it is and however deep it sits — the alternative
		// is an `extends` pointing at nothing.
		const parent = classParent(index, fqn);
		if (parent !== undefined && !queued.has(parent)) {
			queued.add(parent);
			queue.push({ fqn: parent, depth });
		}

		if (depth >= MAX_CLASS_DEPTH) {
			continue;
		}
		for (const member of object.members) {
			if (member.type === undefined || queued.has(member.type)) {
				continue;
			}
			queued.add(member.type);
			queue.push({ fqn: member.type, depth: depth + 1 });
		}
	}

	return objects;
}

/**
 * The parent a class inherits its catalog members from.
 *
 * The application is deliberately an orphan. Its surface is bounded by name
 * rather than by shape — `APP_SERVICES` is the whole of it — and it extends
 * `yii\web\Application`, so naming that parent would hand the model every
 * component Yii declares and undo the bound at load time. Nothing is lost:
 * `craft.app`'s services are all declared on Craft's own trait.
 */
function classParent(index: PhpClassIndex, fqn: string): string | undefined {
	return fqn === APPLICATION_CLASS ? undefined : index.parentOf(fqn, { stopAt: STOP_CLASSES });
}

function classIndex(source: CraftSource): PhpClassIndex {
	return new PhpClassIndex([
		{ prefix: 'craft\\', directory: join(source.checkout, 'src') },
		{ prefix: 'yii\\', directory: join(yiiCheckout, 'framework') },
	]);
}

/**
 * Drops a `type` that names an object no pack produced.
 *
 * A class can be queued and then decline to be modelled — an enum, an interface
 * with nothing public on it, a class outside the checked-out paths, or one the
 * depth bound stopped short of. The member that pointed at it is still real and
 * still worth completing; what it can no longer claim is that the chain
 * continues through it. Leaving the name in place would make the pack promise an
 * object it does not contain, which is the one thing a chain resolver cannot
 * recover from.
 *
 * `others` is the rest of the model: the two files reference each other across
 * the split — `craft.entries` is an `EntryQuery` in one and `EntryQuery.one()`
 * is a `craft\elements\Entry` in the other — so resolvability is a question
 * about the union, not about either file alone.
 */
function pruneUnresolvableTypes(
	objects: Map<string, CatalogObject>,
	others: ReadonlyMap<string, CatalogObject>,
): Map<string, CatalogObject> {
	for (const object of objects.values()) {
		object.members = object.members.map((member) =>
			member.type !== undefined && !objects.has(member.type) && !others.has(member.type)
				? (pruneUndefined({ ...member, type: undefined }) as CatalogMember)
				: member,
		);
	}
	return objects;
}

/**
 * One class, carrying only what it declares.
 *
 * A class with nothing of its own is still worth emitting when it has a parent:
 * it is the link in the chain that says where the members are, and dropping it
 * would strand `extends` at a name the pack does not contain.
 */
function buildClassObject(index: PhpClassIndex, fqn: string): CatalogObject | undefined {
	const parsed = index.read(fqn);
	if (parsed === undefined) {
		return undefined;
	}

	const parent = classParent(index, fqn);
	const members = templateFacingMembers(index, fqn);
	if (members.length === 0 && parent === undefined) {
		return undefined;
	}

	return pruneUndefined({
		name: fqn,
		extends: parent,
		description: firstSentence(
			docblockSummary(parsed.docblock ?? '') ?? `An instance of \`${fqn}\`.`,
		),
		members: members
			.map((member) => buildClassMember(fqn, member))
			.sort((a, b) => a.name.localeCompare(b.name)),
	});
}

/**
 * What a class itself brings, minus the members no template would write.
 *
 * The accessor rule needs the inherited picture even though the result is only
 * this class's: `Asset` declares `getVolume()` and `craft\base\Element` declares
 * `@property $volume`, and the two are the same member said twice. Deciding that
 * from `Asset`'s own declarations alone would keep both — so the property names
 * come from the full walk, and only the members are this class's.
 *
 * The application is the one class filtered by name rather than by shape: its
 * services are the entry points, and `APP_SERVICES` is the list of them.
 */
function templateFacingMembers(index: PhpClassIndex, fqn: string): PhpClassMember[] {
	const inherited = index.members(fqn, { stopAt: STOP_CLASSES });
	const own = index.ownMembers(fqn, { stopAt: STOP_CLASSES });
	const members = withoutAccessors(own, inherited);

	if (fqn === APPLICATION_CLASS) {
		return members.filter(
			(member) => member.kind === 'property' && APP_SERVICES.has(member.name),
		);
	}

	return members.filter(
		(member) => member.kind === 'property' || !DENIED_METHODS.has(member.name),
	);
}

/**
 * Drops the methods that are not a name a template would ever read through.
 *
 * A read accessor is *kept*. Twig resolves `asset.dataUrl` and `asset.getDataUrl`
 * to the same `getDataUrl()` call, both are written in real templates, and a
 * model that offers only one of them dead-ends a chain that works. It is a
 * second name for one member rather than a second member, so the provider ranks
 * it below the property (see `accessorProperty` in `craft-members.ts`) — that
 * costs a sort key rather than a completion.
 *
 * The two that go are the two that are not that:
 *
 * - `setX()` beside `$x` is a write. Nothing a template does calls it, and it is
 *   not another way to spell reading `x`.
 * - `devMode()` beside `$devMode` is Craft's fluent config setter — the same
 *   name as the property, not a second one. Keeping it would put two members
 *   called `devMode` on the object, and only one of them can survive the flatten.
 */
function withoutAccessors(
	members: readonly PhpClassMember[],
	inherited: readonly PhpClassMember[] = members,
): PhpClassMember[] {
	const properties = new Set(
		inherited.filter((member) => member.kind === 'property').map((member) => member.name),
	);

	return members.filter((member) => {
		if (member.kind === 'property') {
			return true;
		}

		const setter = /^set([A-Z]\w*)$/.exec(member.name)?.[1];
		if (setter !== undefined && properties.has(lowerFirst(setter))) {
			return false;
		}

		return !(member.returnsSelf && properties.has(member.name));
	});
}

/**
 * One member, stored against the class that declares it.
 *
 * No `docsUrl`: the link is a pure function of the declaring class, the kind and
 * the name, and the object it is reached through — all of which are known at
 * lookup time, where the project's Craft major is known too. Storing it would be
 * ~40 bytes a member to bake in one major's answer for both.
 *
 * `source.phpClass` is dropped when the declaring class *is* this class, which
 * is the overwhelming majority: it is the same string as the object's own name,
 * and the reader can see that. What survives is the interesting case — a member
 * a trait or a Yii parent declared, which is exactly the case the link policy
 * turns on.
 */
function buildClassMember(objectClass: string, member: PhpClassMember): CatalogMember {
	const parameters = member.parameters.map((parameter) =>
		pruneUndefined({ ...parameter, type: normalizeType(parameter.type) }),
	);
	// A type is a promise that the chain keeps resolving, so it is only made for
	// a class the model can carry on into. Whether it actually did is settled
	// afterwards by `pruneUnresolvableTypes`.
	const type =
		member.typeClass !== undefined && isModelled(member.typeClass)
			? member.typeClass
			: undefined;

	return pruneUndefined({
		name: member.name,
		kind: member.kind,
		type,
		signature:
			member.kind === 'property'
				? `${member.name}: ${normalizeType(member.type) ?? 'mixed'}`
				: buildSignature(member.name, parameters),
		parameters,
		description: memberDescription(member, objectClass),
		sinceVersion: docblockSince(member.docblock ?? ''),
		completionSnippet:
			member.kind === 'property'
				? member.name
				: `${member.name}(${parameters.length > 0 ? '$1' : ''})`,
		...(member.declaringClass === objectClass
			? {}
			: { source: { phpClass: member.declaringClass } }),
	});
}

function memberDescription(member: PhpClassMember, objectClass: string): string {
	const summary = member.summary === undefined ? undefined : normalizeMarkdown(member.summary);
	if (summary !== undefined && summary.length >= 8) {
		return firstSentence(summary);
	}

	const docblock = member.docblock ?? '';
	return firstSentence(
		docblockSummary(docblock) ??
			docblockVarSummary(docblock) ??
			`The ${member.name} ${member.kind} of ${shortName(objectClass)}.`,
	);
}

function isModelled(fqn: string): boolean {
	return fqn.startsWith(MODELLED_PREFIX);
}

function shortName(fqn: string): string {
	return fqn.split('\\').pop() ?? fqn;
}

function lowerFirst(value: string): string {
	return value.charAt(0).toLowerCase() + value.slice(1);
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
			// The one member whose type is asserted rather than read: `$app` is
			// declared as a union of the web and console applications, and a
			// template only ever runs inside the web one.
			type: APPLICATION_CLASS,
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
function buildQueryObject(
	source: CraftSource,
	className: string,
	elementQuery: CatalogObject,
): CatalogObject | undefined {
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
	const members: CatalogMember[] = elementResultMembers(source, php, elementQuery);
	const claimed = new Set(members.map((member) => member.name));

	for (const row of parseTable(artifact)) {
		if (claimed.has(row.name)) {
			continue;
		}
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
		for (const [name, merged] of mergeEntries(four, five, kind)) {
			entries[kind].set(name, merged);
		}
	}

	const objects = mergeObjects(four.objects, five.objects);

	return {
		schemaVersion: 1,
		name: 'craft',
		displayName: 'Craft CMS',
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
 * One set of objects across the two majors.
 *
 * Craft 5's shape wins wherever both have the name — it is the one the model is
 * generated against — and the members are merged the same way entries are, so a
 * class that gained a member in 5 says `sinceVersion` and one that lost it in 5
 * says `removedVersion`. `extends` comes off the winning major with it, which is
 * what carries Craft 5's re-parenting of a class that moved.
 */
function mergeObjects(
	four: ReadonlyMap<string, CatalogObject>,
	five: ReadonlyMap<string, CatalogObject>,
): Map<string, CatalogObject> {
	const objects = new Map<string, CatalogObject>();

	for (const name of [...new Set([...four.keys(), ...five.keys()])].sort((a, b) =>
		a.localeCompare(b),
	)) {
		const inFour = four.get(name);
		const inFive = five.get(name);
		// `name` comes from the union of both majors' keys, so one is always set.
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

	return objects;
}

/**
 * One kind's entries across the two majors, with the changelog filling in what
 * the docs and the diff between them cannot say.
 *
 * The rule that matters is which major's changelog gets to speak. A name Craft 4
 * has did not arrive in Craft 5, whatever 5's changelog says about the release
 * that carried it: `uuid()` is in 4.18.5's source and 5's notes announce it under
 * 5.9.0, because 5.9.0 is where it landed and 4.17.0 is where it was backported
 * to. Taking 5.9.0 would hide `uuid()` from the Craft 4 projects that have it, so
 * the changelog of a major the name is absent from is not evidence about it, and
 * is not read.
 *
 * That leaves the backport itself imprecise in the other direction — `uuid()`
 * comes out as 4.17.0, which offers it to Craft 5.0 projects that lack it. That
 * is the trade `isAvailable` already makes everywhere: an extra completion costs
 * less than a missing one.
 */
function mergeEntries(
	four: Scrape,
	five: Scrape,
	kind: CatalogEntryKind,
): Map<string, CatalogEntry> {
	const merged = new Map<string, CatalogEntry>();
	const names = [...new Set([...four.entries[kind].keys(), ...five.entries[kind].keys()])].sort(
		(a, b) => a.localeCompare(b),
	);

	for (const name of names) {
		const inFour = four.entries[kind].get(name);
		const inFive = five.entries[kind].get(name);
		const mined = (inFour === undefined ? five : four).changelog[kind].get(name);

		if (inFive === undefined) {
			// `name` comes from the union of both majors' keys, so one is always set.
			const only = inFour as CatalogEntry;
			merged.set(
				name,
				pruneUndefined({
					...only,
					sinceVersion: only.sinceVersion ?? mined,
					removedVersion: CRAFT_5_BASELINE,
				}),
			);
			continue;
		}

		if (inFour === undefined) {
			merged.set(name, {
				...inFive,
				sinceVersion: inFive.sinceVersion ?? mined ?? CRAFT_5_BASELINE,
			});
			continue;
		}

		merged.set(
			name,
			pruneUndefined({
				...inFive,
				sinceVersion: inFive.sinceVersion ?? inFour.sinceVersion ?? mined,
			}),
		);
	}

	return merged;
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

/**
 * The prose in `@var string The URI segment Craft should look for…`.
 *
 * Craft's config classes describe a property inside its `@var` rather than above
 * it, so `docblockSummary` — which stops dead at the first tag — sees nothing at
 * all. That is most of `craft.app.config.general`, which is too much of the
 * front-end surface to hand back undocumented.
 */
function docblockVarSummary(docblock: string): string | undefined {
	const line = /@var\s+\S+\s+([^\n]*)/.exec(docblock)?.[1];
	if (line === undefined) {
		return undefined;
	}

	const description = normalizeMarkdown(line);
	return description.length >= 8 ? description : undefined;
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

/**
 * The same override layer, over the class pack.
 *
 * Separate file, same rule: an override that names a class or a member the walk
 * did not produce is an error, because the file is for correcting the scrape and
 * a typo in it must not become a catalog entry that nothing generated.
 */
function applyClassOverrides(pack: ClassPack): ClassPack {
	if (!existsSync(classOverridesPath)) {
		return pack;
	}

	const overrides = JSON.parse(readFileSync(classOverridesPath, 'utf8')) as OverrideCatalog;

	for (const override of overrides.objects ?? []) {
		const object = pack.classes.find((candidate) => candidate.name === override.name);
		if (object === undefined) {
			throw new Error(`Override references unknown class "${override.name}"`);
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
