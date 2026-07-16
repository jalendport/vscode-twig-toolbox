import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { CatalogRegistry, resolveCatalogPath, type DialectPack } from './catalog';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const schema = JSON.parse(
	readFileSync(resolve(repoRoot, 'catalogs', 'schema.json'), 'utf8'),
) as object;
const corePack = JSON.parse(
	readFileSync(resolve(repoRoot, 'catalogs', 'twig-core.json'), 'utf8'),
) as DialectPack;

const expectedDocsIndexNames = {
	tags: [
		'apply',
		'autoescape',
		'block',
		'cache',
		'deprecated',
		'do',
		'embed',
		'extends',
		'flush',
		'for',
		'from',
		'guard',
		'if',
		'import',
		'include',
		'macro',
		'sandbox',
		'set',
		'types',
		'use',
		'verbatim',
		'with',
	],
	filters: [
		'abs',
		'batch',
		'capitalize',
		'column',
		'convert_encoding',
		'country_name',
		'currency_name',
		'currency_symbol',
		'data_uri',
		'date',
		'date_modify',
		'default',
		'escape',
		'filter',
		'find',
		'first',
		'format',
		'format_currency',
		'format_date',
		'format_datetime',
		'format_list',
		'format_number',
		'format_time',
		'html_attr_merge',
		'html_attr_type',
		'html_to_markdown',
		'inky_to_html',
		'inline_css',
		'invoke',
		'join',
		'json_encode',
		'keys',
		'language_name',
		'last',
		'length',
		'locale_name',
		'lower',
		'map',
		'markdown_to_html',
		'merge',
		'nl2br',
		'number_format',
		'plural',
		'raw',
		'reduce',
		'replace',
		'reverse',
		'round',
		'shuffle',
		'singular',
		'slice',
		'slug',
		'sort',
		'spaceless',
		'split',
		'striptags',
		'timezone_name',
		'title',
		'trim',
		'u',
		'upper',
		'url_encode',
	],
	functions: [
		'attribute',
		'block',
		'constant',
		'country_names',
		'country_timezones',
		'currency_names',
		'cycle',
		'date',
		'dump',
		'enum',
		'enum_cases',
		'html_attr',
		'html_classes',
		'html_cva',
		'include',
		'language_names',
		'locale_names',
		'max',
		'min',
		'parent',
		'random',
		'range',
		'script_names',
		'source',
		'template_from_string',
		'timezone_names',
	],
	tests: [
		'constant',
		'defined',
		'divisible by',
		'empty',
		'even',
		'iterable',
		'mapping',
		'null',
		'odd',
		'same as',
		'sequence',
	],
} as const;

describe('Twig catalog pack', () => {
	it('matches the dialect-pack schema', () => {
		const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
		const validate = ajv.compile(schema);

		expect(validate(corePack), JSON.stringify(validate.errors, null, 2)).toBe(true);
	});

	it('contains every Twig 3 docs index entry', () => {
		for (const [kind, expectedNames] of Object.entries(expectedDocsIndexNames)) {
			const entries = corePack.entries[kind as keyof typeof expectedDocsIndexNames];
			const docsBackedNames = entries
				.filter((entry) => entry.source?.docsPath)
				.map((entry) => entry.name)
				.sort((a, b) => a.localeCompare(b));

			expect(docsBackedNames).toEqual([...expectedNames].sort((a, b) => a.localeCompare(b)));
		}
	});

	it('keeps descriptions, docs URLs, signatures, and snippets on every entry', () => {
		for (const entries of Object.values(corePack.entries)) {
			for (const entry of entries) {
				expect(entry.description.length).toBeGreaterThan(7);
				expect(entry.docsUrl).toMatch(/^https:\/\/twig\.symfony\.com\//);
				expect(entry.signature.length).toBeGreaterThan(0);
				expect(entry.completionSnippet.length).toBeGreaterThan(0);
			}
		}
	});
});

describe('resolveCatalogPath', () => {
	/** The packaged extension: `dist/server.js` beside `catalogs/`. */
	function createInstall(): { moduleDir: string; catalog: string } {
		const root = mkdtempSync(join(tmpdir(), 'twig-toolbox-'));
		const moduleDir = join(root, 'dist');
		mkdirSync(moduleDir);
		mkdirSync(join(root, 'catalogs'));
		const catalog = join(root, 'catalogs', 'twig-core.json');
		writeFileSync(catalog, '{}');
		return { moduleDir, catalog };
	}

	// The server is a child of the extension host, so its working directory is
	// VS Code's. Resolving the catalog from `cwd` alone finds nothing at all in
	// an installed extension, and every completion comes up empty.
	it('finds the packaged catalog from the module, whatever the cwd is', () => {
		const { moduleDir, catalog } = createInstall();
		expect(resolveCatalogPath(moduleDir, tmpdir())).toBe(catalog);
	});

	it('falls back to the working directory when running from the repo', () => {
		expect(resolveCatalogPath(undefined, repoRoot)).toBe(
			resolve(repoRoot, 'catalogs', 'twig-core.json'),
		);
	});

	it('gives up rather than guessing when there is no catalog anywhere', () => {
		expect(
			resolveCatalogPath(join(tmpdir(), 'nope', 'dist'), join(tmpdir(), 'nope')),
		).toBeUndefined();
	});
});

describe('CatalogRegistry', () => {
	it('loads the default core catalog', () => {
		const registry = CatalogRegistry.loadDefault();
		const entries = registry.getMergedEntries();

		expect(registry.packs).toHaveLength(1);
		expect(entries.tags.get('for')?.pack.displayName).toBe('Twig');
		expect(entries.filters.get('date')?.source?.docsPath).toBe('doc/filters/date.rst');
	});

	it('activates composer-gated packs only when matching packages are present', () => {
		const craftPack = createPack('craft', 'CraftCMS', {
			kind: 'composer',
			composerPackages: ['craftcms/cms'],
		});
		const registry = CatalogRegistry.fromPacks([corePack, craftPack]);

		expect(registry.getActivePacks().map((pack) => pack.name)).toEqual(['twig-core']);
		expect(
			registry
				.getActivePacks({ composerPackages: ['craftcms/cms'] })
				.map((pack) => pack.name),
		).toEqual(['twig-core', 'craft']);
	});

	it('merges active entries with pack provenance retained', () => {
		const craftPack = createPack('craft', 'CraftCMS', {
			kind: 'composer',
			composerPackages: ['craftcms/cms'],
		});
		const registry = CatalogRegistry.fromPacks([corePack, craftPack]);
		const entries = registry.getMergedEntries({ composerPackages: ['craftcms/cms'] });

		expect(entries.functions.get('craft')?.pack.displayName).toBe('CraftCMS');
		expect(entries.functions.get('include')?.pack.displayName).toBe('Twig');
	});

	it('indexes aliases as the same catalog entry', () => {
		const registry = CatalogRegistry.fromPacks([corePack]);
		const entries = registry.getMergedEntries();

		expect(entries.filters.get('e')?.name).toBe('escape');
		expect(entries.filters.get('e')?.pack.displayName).toBe('Twig');
	});
});

function createPack(name: string, displayName: string, detect: DialectPack['detect']): DialectPack {
	return {
		schemaVersion: 1,
		name,
		displayName,
		version: '1.0.0',
		sources: corePack.sources,
		detect,
		entries: {
			tags: [],
			filters: [],
			functions: [
				{
					name,
					signature: `${name}()`,
					parameters: [],
					description: `${displayName} project helper.`,
					docsUrl: 'https://example.com/docs',
					completionSnippet: `${name}()`,
				},
			],
			tests: [],
			globals: [],
		},
	};
}
