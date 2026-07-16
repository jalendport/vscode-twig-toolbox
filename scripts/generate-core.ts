import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
	CatalogEntry,
	CatalogEntryKind,
	CatalogParameter,
	DialectPack,
} from '../packages/language-server/src/catalog';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = join(repoRoot, '.cache');
const twigCheckout = join(cacheRoot, 'twig');
const outputPath = join(repoRoot, 'catalogs', 'twig-core.json');
const overridesPath = join(repoRoot, 'catalogs', 'overrides', 'twig-core.json');

const twigRepository = 'https://github.com/twigphp/Twig.git';
const pinnedTwigRef = 'da8bd407000b6ef1adfce829ac9921f12b544617';
const docsBaseUrl = 'https://twig.symfony.com/doc/3.x';

const entryKinds: CatalogEntryKind[] = ['tags', 'filters', 'functions', 'tests', 'globals'];
const docsDirectories = {
	tags: 'tags',
	filters: 'filters',
	functions: 'functions',
	tests: 'tests',
} satisfies Partial<Record<CatalogEntryKind, string>>;

type SourceEntry = Partial<CatalogEntry> & Pick<CatalogEntry, 'name'>;
type OverrideCatalog = {
	entries?: Partial<Record<CatalogEntryKind, SourceEntry[]>>;
};

interface PhpParameter {
	name: string;
	type?: string;
	optional: boolean;
	default?: string;
}

interface DocumentationEntry {
	name: string;
	slug: string;
	description: string;
	docsUrl: string;
	docsPath: string;
	parameters: CatalogParameter[];
	sinceVersion?: string;
	deprecated?: {
		sinceVersion: string;
		message?: string;
	};
}

interface RegisteredCallable {
	name: string;
	extension: string;
	phpClass: string;
	method?: string;
	parameters: CatalogParameter[];
	deprecated?: {
		sinceVersion: string;
		message?: string;
	};
}

ensureTwigCheckout();

const sourceEntries = readSourceEntries();
const documentationEntries = readDocumentationEntries();
const generatedPack = applyOverrides({
	schemaVersion: 1,
	name: 'twig-core',
	displayName: 'Twig',
	version: '3.x',
	sources: {
		twig: {
			repository: twigRepository,
			ref: pinnedTwigRef,
		},
		docs: {
			repository: twigRepository,
			ref: pinnedTwigRef,
			path: 'doc',
		},
	},
	detect: {
		kind: 'always',
	},
	entries: {
		tags: buildEntries('tags'),
		filters: buildEntries('filters'),
		functions: buildEntries('functions'),
		tests: buildEntries('tests'),
		globals: [],
	},
});

writeFileSync(outputPath, `${JSON.stringify(generatedPack, null, 2)}\n`);

function ensureTwigCheckout(): void {
	mkdirSync(cacheRoot, { recursive: true });

	if (!existsSync(join(twigCheckout, '.git'))) {
		execFileSync('git', ['clone', '--no-checkout', twigRepository, twigCheckout], {
			stdio: 'inherit',
		});
	}

	execFileSync('git', ['fetch', '--depth', '1', 'origin', pinnedTwigRef], {
		cwd: twigCheckout,
		stdio: 'inherit',
	});
	execFileSync('git', ['checkout', '--detach', pinnedTwigRef], {
		cwd: twigCheckout,
		stdio: 'inherit',
	});
}

function readSourceEntries(): Record<CatalogEntryKind, Map<string, SourceEntry>> {
	const entries = createEntryMaps<SourceEntry>();
	const tokenParsers = readTokenParsers();

	for (const parser of tokenParsers) {
		entries.tags.set(parser.name, parser);
	}

	for (const callable of readRegisteredCallables('filters', 'TwigFilter')) {
		entries.filters.set(callable.name, callable);
	}

	for (const callable of readRegisteredCallables('functions', 'TwigFunction')) {
		entries.functions.set(callable.name, callable);
	}

	for (const callable of readRegisteredCallables('tests', 'TwigTest')) {
		entries.tests.set(callable.name, callable);
	}

	return entries;
}

function readDocumentationEntries(): Record<CatalogEntryKind, Map<string, DocumentationEntry>> {
	const entries = createEntryMaps<DocumentationEntry>();

	for (const [kind, docsDirectory] of Object.entries(docsDirectories) as [
		CatalogEntryKind,
		string,
	][]) {
		const slugs = readDocsIndex(docsDirectory);

		for (const slug of slugs) {
			const docsPath = join(twigCheckout, 'doc', docsDirectory, `${slug}.rst`);
			const documentation = parseDocumentationFile(docsPath, kind, slug);
			entries[kind].set(documentation.name, documentation);
		}
	}

	return entries;
}

function buildEntries(kind: Exclude<CatalogEntryKind, 'globals'>): CatalogEntry[] {
	const docs = documentationEntries[kind];
	const source = sourceEntries[kind];
	const names = [...new Set([...docs.keys(), ...source.keys()])].sort((a, b) =>
		a.localeCompare(b),
	);

	return names.map((name) => {
		const documented = docs.get(name);
		const sourced = source.get(name);
		const parameters = mergeParameters(sourced?.parameters, documented?.parameters);
		const docsUrl =
			documented?.docsUrl ??
			`${docsBaseUrl}/${docsDirectories[kind]}/${slugifyName(name)}.html`;
		const description = documented?.description ?? `${name} is registered by Twig.`;
		const signature = sourced?.signature ?? buildSignature(name, parameters);

		return pruneUndefined({
			name,
			aliases: sourced?.aliases,
			signature,
			parameters,
			description,
			docsUrl,
			sinceVersion: documented?.sinceVersion ?? sourced?.sinceVersion,
			deprecated: documented?.deprecated ?? sourced?.deprecated,
			completionSnippet:
				sourced?.completionSnippet ?? buildCompletionSnippet(kind, name, parameters),
			source: pruneUndefined({
				extension: sourced?.source?.extension,
				phpClass: sourced?.source?.phpClass,
				docsPath: documented?.docsPath,
			}),
		});
	});
}

function readTokenParsers(): SourceEntry[] {
	const sourceFiles = [
		join(twigCheckout, 'src', 'Extension', 'CoreExtension.php'),
		join(twigCheckout, 'src', 'Extension', 'EscaperExtension.php'),
		join(twigCheckout, 'src', 'Extension', 'SandboxExtension.php'),
	];
	const parserClasses = new Set<string>();

	for (const sourceFile of sourceFiles) {
		const source = readFileSync(sourceFile, 'utf8');
		for (const match of source.matchAll(/new\s+([A-Za-z]+TokenParser)\s*\(/g)) {
			parserClasses.add(match[1]);
		}
	}

	parserClasses.add('VerbatimTokenParser');

	return [...parserClasses]
		.map((className) => {
			const parserPath = join(twigCheckout, 'src', 'TokenParser', `${className}.php`);
			const tagName = existsSync(parserPath)
				? readFileSync(parserPath, 'utf8').match(
						/function\s+getTag\(\):\s+string\s*\{\s*return\s+'([^']+)'/s,
					)?.[1]
				: className.replace(/TokenParser$/, '').toLowerCase();

			if (!tagName) {
				throw new Error(`Unable to resolve tag name for ${className}`);
			}

			return {
				name: tagName,
				signature: tagName,
				parameters: [],
				completionSnippet: buildCompletionSnippet('tags', tagName, []),
				source: {
					extension:
						className === 'VerbatimTokenParser'
							? 'Lexer'
							: extensionForParser(className),
					phpClass: className,
				},
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function readRegisteredCallables(
	kind: Extract<CatalogEntryKind, 'filters' | 'functions' | 'tests'>,
	className: 'TwigFilter' | 'TwigFunction' | 'TwigTest',
): RegisteredCallable[] {
	const extensionFiles = [
		join(twigCheckout, 'src', 'Extension', 'CoreExtension.php'),
		join(twigCheckout, 'src', 'Extension', 'DebugExtension.php'),
		join(twigCheckout, 'src', 'Extension', 'EscaperExtension.php'),
		join(twigCheckout, 'src', 'Extension', 'StringLoaderExtension.php'),
	];
	const callables: RegisteredCallable[] = [];

	for (const extensionFile of extensionFiles) {
		const source = readFileSync(extensionFile, 'utf8');
		const extension = extensionFile.match(/([^/]+)\.php$/)?.[1] ?? 'UnknownExtension';
		const constructorPattern = new RegExp(`new\\s+${className}\\('([^']+)'([^\\n]*)`, 'g');

		for (const match of source.matchAll(constructorPattern)) {
			const [, name, constructorRest = ''] = match;
			const method = readCallableMethod(constructorRest);
			const options = readOptions(constructorRest);
			const parameters = method
				? readMethodParameters(source, method, kind, options)
				: readSyntheticParameters(kind, options);
			const aliases = kind === 'filters' && name === 'escape' ? ['e'] : undefined;
			const deprecated = readDeprecation(options);

			callables.push(
				pruneUndefined({
					name,
					aliases,
					signature: buildSignature(name, parameters),
					parameters,
					completionSnippet: buildCompletionSnippet(kind, name, parameters),
					deprecated,
					source: {
						extension,
						phpClass: method ? `CoreExtension::${method}` : extension,
					},
				}) as RegisteredCallable,
			);
		}
	}

	return callables.sort((a, b) => a.name.localeCompare(b.name));
}

function readCallableMethod(constructorRest: string): string | undefined {
	return (
		constructorRest.match(/\[\$this,\s*'([^']+)'\]/)?.[1] ??
		constructorRest.match(/\[self::class,\s*'([^']+)'\]/)?.[1] ??
		constructorRest.match(/\[EscaperRuntime::class,\s*'([^']+)'\]/)?.[1] ??
		constructorRest.match(/\[([A-Za-z]+)::class,\s*'([^']+)'\]/)?.[2]
	);
}

function readOptions(constructorRest: string): string {
	return constructorRest.match(/\[(.*)\]\)?[,]?$/)?.[1] ?? constructorRest;
}

function readMethodParameters(
	source: string,
	method: string,
	kind: Extract<CatalogEntryKind, 'filters' | 'functions' | 'tests'>,
	options: string,
): CatalogParameter[] {
	const match = source.match(new RegExp(`function\\s+${method}\\s*\\(([^)]*)\\)`, 's'));
	if (!match) {
		return readSyntheticParameters(kind, options);
	}

	const parameters = parsePhpParameters(match[1] ?? '');
	const visibleParameters = stripHiddenParameters(parameters, options);

	if (kind === 'filters' || kind === 'tests') {
		visibleParameters.shift();
	}

	return visibleParameters.map((parameter) => ({
		...parameter,
		type: normalizeType(parameter.type),
	}));
}

function readSyntheticParameters(
	kind: Extract<CatalogEntryKind, 'filters' | 'functions' | 'tests'>,
	options: string,
): CatalogParameter[] {
	if (kind === 'tests' && options.includes('one_mandatory_argument')) {
		return [
			{
				name: 'value',
				type: 'mixed',
				optional: false,
			},
		];
	}

	if (options.includes('is_variadic')) {
		return [
			{
				name: 'values',
				type: 'mixed',
				optional: true,
			},
		];
	}

	return [];
}

function parsePhpParameters(parameterSource: string): PhpParameter[] {
	if (!parameterSource.trim()) {
		return [];
	}

	return splitTopLevel(parameterSource, ',').map((rawParameter) => {
		const source = rawParameter.trim();
		const [leftSide, defaultValue] = splitTopLevel(source, '=') as [string, string?];
		const name = leftSide.match(/\$([A-Za-z_][A-Za-z0-9_]*)/)?.[1];

		if (!name) {
			throw new Error(`Unable to parse PHP parameter: ${source}`);
		}

		const type = leftSide
			.replace(/=.*$/, '')
			.replace(/&?\s*\.\.\.\s*/, '')
			.replace(new RegExp(`\\$${name}\\b`), '')
			.trim();

		return pruneUndefined({
			name,
			type: type || undefined,
			optional: defaultValue !== undefined,
			default: defaultValue?.trim(),
		});
	});
}

function stripHiddenParameters(parameters: PhpParameter[], options: string): PhpParameter[] {
	const stripped = [...parameters];
	const hiddenOptions = [
		['needs_environment', 'env'],
		['needs_context', 'context'],
		['needs_charset', 'charset'],
		['needs_is_sandboxed', 'isSandboxed'],
	] as const;

	for (const [option, parameterName] of hiddenOptions) {
		if (options.includes(option) && stripped[0]?.name === parameterName) {
			stripped.shift();
		}
	}

	return stripped;
}

function readDocsIndex(docsDirectory: string): string[] {
	const indexPath = join(twigCheckout, 'doc', docsDirectory, 'index.rst');
	const indexSource = readFileSync(indexPath, 'utf8');
	const toctree = indexSource.split('.. toctree::')[1] ?? '';

	return toctree
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith(':'))
		.sort((a, b) => a.localeCompare(b));
}

function parseDocumentationFile(
	docsPath: string,
	kind: Exclude<CatalogEntryKind, 'globals'>,
	slug: string,
): DocumentationEntry {
	const source = readFileSync(docsPath, 'utf8');
	const name = readDocumentationTitle(source) ?? docsTitleToName(slug);
	const relativeDocsPath = `doc/${docsDirectories[kind]}/${slug}.rst`;

	return pruneUndefined({
		name,
		slug,
		description: readDescription(source, name),
		docsUrl: `${docsBaseUrl}/${docsDirectories[kind]}/${slug}.html`,
		docsPath: relativeDocsPath,
		parameters: readDocumentedParameters(source),
		sinceVersion: source.match(/\.\.\s+versionadded::\s+([^\n]+)/)?.[1]?.trim(),
		deprecated: readDocumentedDeprecation(source),
	});
}

function readDocumentationTitle(source: string): string | undefined {
	return source.match(/^``([^`]+)``\n=+/m)?.[1];
}

function readDescription(source: string, name: string): string {
	const lines = source.split('\n');
	const candidates: string[] = [];
	let inDirectiveBlock = false;

	for (let index = 2; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		const trimmed = line.trim();
		const indent = line.length - line.trimStart().length;

		if (inDirectiveBlock && (!trimmed || indent > 0)) {
			continue;
		}

		inDirectiveBlock = false;

		if (!trimmed) {
			if (candidates.length > 0) {
				break;
			}
			continue;
		}

		if (trimmed.startsWith('.. ')) {
			inDirectiveBlock = true;
			continue;
		}

		if (trimmed.match(/^[-=~^"]+$/) || trimmed.endsWith('::')) {
			continue;
		}

		if (trimmed.startsWith('* ') || trimmed.startsWith('$ ') || trimmed.startsWith('|')) {
			continue;
		}

		candidates.push(trimmed);
		if (/[.!?]$/.test(trimmed)) {
			break;
		}
	}

	const description = normalizeRst(candidates.join(' '));
	if (description.length >= 8) {
		return description;
	}

	return `${name} is documented by Twig.`;
}

function readDocumentedParameters(source: string): CatalogParameter[] {
	const argumentsSection = source.match(
		/Arguments\n[-]+\n(?<body>[\s\S]*?)(?:\n[A-Z][^\n]*\n[-]+\n|\n\.\. _|$)/,
	)?.groups?.body;

	if (!argumentsSection) {
		return [];
	}

	const parameters: CatalogParameter[] = [];
	let currentParameter: CatalogParameter | undefined;

	for (const line of argumentsSection.split('\n')) {
		const bullet = line.match(/^\*\s+``([^`]+)``:\s*(.*)$/);
		if (bullet) {
			currentParameter = {
				name: bullet[1],
				optional: /default|optional|if provided/i.test(bullet[2]),
				description: normalizeRst(bullet[2]),
			};
			parameters.push(currentParameter);
			continue;
		}

		if (currentParameter && line.startsWith('  ') && line.trim()) {
			currentParameter.description = normalizeRst(
				`${currentParameter.description ?? ''} ${line.trim()}`,
			);
		}
	}

	return parameters;
}

function readDeprecation(options: string): RegisteredCallable['deprecated'] | undefined {
	const version = options.match(/DeprecatedCallableInfo\('twig\/twig',\s*'([^']+)'/)?.[1];
	if (!version) {
		return undefined;
	}

	return {
		sinceVersion: version,
		message: `Deprecated as of Twig ${version}.`,
	};
}

function readDocumentedDeprecation(source: string): DocumentationEntry['deprecated'] | undefined {
	const version = source.match(/\.\.\s+deprecated::\s+([^\n]+)/)?.[1]?.trim();
	if (!version) {
		return undefined;
	}

	return {
		sinceVersion: version,
		message: `Deprecated as of Twig ${version}.`,
	};
}

function mergeParameters(
	sourceParameters: CatalogParameter[] | undefined,
	documentedParameters: CatalogParameter[] | undefined,
): CatalogParameter[] {
	if (!sourceParameters?.length) {
		return documentedParameters ?? [];
	}

	const documentedByName = new Map(
		(documentedParameters ?? []).map((parameter) => [parameter.name, parameter]),
	);

	return sourceParameters.map((parameter) => {
		const documented = documentedByName.get(parameter.name);
		return pruneUndefined({
			...parameter,
			description: documented?.description ?? parameter.description,
			type: parameter.type ?? documented?.type,
		});
	});
}

function buildSignature(name: string, parameters: CatalogParameter[]): string {
	if (parameters.length === 0) {
		return name;
	}

	return `${name}(${parameters
		.map((parameter) => {
			const defaultValue = parameter.default ? ` = ${parameter.default}` : '';
			return parameter.optional
				? `${parameter.name}?${defaultValue}`
				: `${parameter.name}${defaultValue}`;
		})
		.join(', ')})`;
}

function buildCompletionSnippet(
	kind: Exclude<CatalogEntryKind, 'globals'>,
	name: string,
	parameters: CatalogParameter[],
): string {
	if (kind === 'tags') {
		return `{% ${name} $0 %}`;
	}

	const placeholders = parameters.map((_, index) => `$${index + 1}`).join(', ');

	if (kind === 'filters') {
		return parameters.length > 0 ? `|${name}(${placeholders})` : `|${name}`;
	}

	if (kind === 'tests') {
		return parameters.length > 0 ? `is ${name}(${placeholders})` : `is ${name}`;
	}

	return parameters.length > 0 ? `${name}(${placeholders})` : `${name}($0)`;
}

function applyOverrides(pack: DialectPack): DialectPack {
	if (!existsSync(overridesPath)) {
		return pack;
	}

	const overrides = JSON.parse(readFileSync(overridesPath, 'utf8')) as OverrideCatalog;

	for (const kind of entryKinds) {
		const entries = overrides.entries?.[kind];
		if (!entries) {
			continue;
		}

		const packEntries = new Map(pack.entries[kind].map((entry) => [entry.name, entry]));

		for (const override of entries) {
			const existing = packEntries.get(override.name);
			if (!existing) {
				throw new Error(`Override references unknown ${kind} entry "${override.name}"`);
			}

			packEntries.set(override.name, deepMerge(existing, override));
		}

		pack.entries[kind] = [...packEntries.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	return pack;
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
	const merged: Record<string, unknown> = { ...base };

	for (const [key, value] of Object.entries(override)) {
		if (
			value &&
			!Array.isArray(value) &&
			typeof value === 'object' &&
			base[key] &&
			!Array.isArray(base[key]) &&
			typeof base[key] === 'object'
		) {
			merged[key] = deepMerge(
				base[key] as Record<string, unknown>,
				value as Record<string, unknown>,
			);
		} else if (value !== undefined) {
			merged[key] = value;
		}
	}

	return merged as T;
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

function splitTopLevel(source: string, separator: string): string[] {
	const parts: string[] = [];
	let current = '';
	let depth = 0;
	let quote: string | undefined;

	for (const character of source) {
		if (quote) {
			current += character;
			if (character === quote) {
				quote = undefined;
			}
			continue;
		}

		if (character === '"' || character === "'") {
			quote = character;
			current += character;
			continue;
		}

		if (character === '[' || character === '(') {
			depth += 1;
		}

		if (character === ']' || character === ')') {
			depth -= 1;
		}

		if (character === separator && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}

		current += character;
	}

	parts.push(current.trim());
	return parts;
}

function normalizeRst(source: string): string {
	return source
		.replace(/``([^`]+)``/g, '`$1`')
		.replace(/:doc:`([^`<]+)\s*<[^`]+>`/g, '$1')
		.replace(/:ref:`([^`]+)`/g, '$1')
		.replace(/`([^`]+)`_/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeType(type: string | undefined): string | undefined {
	if (!type) {
		return undefined;
	}

	return type
		.replace(/^\\/, '')
		.replace(/\\([A-Za-z]+)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

function slugifyName(name: string): string {
	return name.replace(/\s+/g, '').toLowerCase();
}

function docsTitleToName(slug: string): string {
	return slug.replace(/_/g, ' ');
}

function extensionForParser(className: string): string {
	if (className === 'AutoEscapeTokenParser') {
		return 'EscaperExtension';
	}

	if (className === 'SandboxTokenParser') {
		return 'SandboxExtension';
	}

	return 'CoreExtension';
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, propertyValue]) => propertyValue !== undefined),
	) as T;
}
