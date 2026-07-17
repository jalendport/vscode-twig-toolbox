import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import {
	CatalogRegistry,
	resolveCatalogPath,
	type DialectPack,
	type WorkspaceCatalogContext,
} from './catalog';
import { catalogMarkdown } from './markdown';
import { detectProject, toCatalogContext } from './project-context';

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
	it('loads every shipped catalog', () => {
		const registry = CatalogRegistry.loadDefault();
		const entries = registry.getMergedEntries();

		expect(registry.packs.map((pack) => pack.name)).toEqual(['twig-core', 'craft']);
		expect(entries.tags.get('for')?.pack.displayName).toBe('Twig');
		expect(entries.filters.get('date')?.source?.docsPath).toBe('doc/filters/date.rst');
	});

	// Shipped is not activated: the Craft pack is on disk in every install, and
	// stays out of a plain Twig project's completions until composer says
	// otherwise.
	it('leaves the shipped Craft pack inactive outside a Craft project', () => {
		const registry = CatalogRegistry.loadDefault();

		expect(registry.getActivePacks().map((pack) => pack.name)).toEqual(['twig-core']);
		expect(registry.getMergedEntries().tags.get('cache')?.pack.name).toBe('twig-core');
		expect(registry.getMergedObjects().size).toBe(0);
	});

	it('activates composer-gated packs only when matching packages are present', () => {
		const craftPack = createPack('craft', 'Craft CMS', {
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
		const craftPack = createPack('craft', 'Craft CMS', {
			kind: 'composer',
			composerPackages: ['craftcms/cms'],
		});
		const registry = CatalogRegistry.fromPacks([corePack, craftPack]);
		const entries = registry.getMergedEntries({ composerPackages: ['craftcms/cms'] });

		expect(entries.functions.get('craft')?.pack.displayName).toBe('Craft CMS');
		expect(entries.functions.get('include')?.pack.displayName).toBe('Twig');
	});

	it('indexes aliases as the same catalog entry', () => {
		const registry = CatalogRegistry.fromPacks([corePack]);
		const entries = registry.getMergedEntries();

		expect(entries.filters.get('e')?.name).toBe('escape');
		expect(entries.filters.get('e')?.pack.displayName).toBe('Twig');
	});
});

/**
 * The core pack gates on the Twig the project locked.
 *
 * Craft 4 pins `twig/twig ~3.19.0` and Craft 5 pins `~3.27.0`, so a Craft 4
 * project offered the filters Twig added in 3.24 is offering three names that
 * cannot work — which is what the pack did until it had a version to gate on.
 *
 * Everything here goes through a real `composer.lock` on disk, because the
 * lockfile is the whole mechanism: a context built by hand would test that
 * `isAvailable` can compare two strings, which `compareVersions` already covers.
 */
describe('Twig core pack version gating', () => {
	const registry = CatalogRegistry.fromPacks([corePack]);

	/** `html_attr_merge` arrived in Twig 3.24; `invoke` in 3.19 exactly. */
	function filtersFor(context: WorkspaceCatalogContext): string[] {
		return [...registry.getMergedEntries(context, { availableOnly: true }).filters.keys()];
	}

	it('hides an entry the locked Twig is too old for', () => {
		const filters = filtersFor(projectWith(lockPinning('3.19.0')));

		expect(filters).not.toContain('html_attr_merge');
		expect(filters).not.toContain('html_attr_type');
		// The version an entry arrived in is a version that has it.
		expect(filters).toContain('invoke');
		// The pack is still the pack: gating trims a handful, not the language.
		expect(filters).toContain('escape');
		expect(filters).toContain('date');
	});

	it('offers it once the locked Twig is new enough', () => {
		const filters = filtersFor(projectWith(lockPinning('3.27.0')));

		expect(filters).toContain('html_attr_merge');
		expect(filters).toContain('html_attr_type');
		expect(filters).toContain('invoke');
	});

	/**
	 * The graceful default, and the one that must not be got wrong: an unknown
	 * Twig gates nothing at all. A project with no lockfile is a checkout someone
	 * has not run `composer install` in yet, and it gets the whole catalog rather
	 * than a version this guessed.
	 */
	it('gates nothing without a lockfile', () => {
		const filters = filtersFor(projectWith(undefined));

		expect(filters).toContain('html_attr_merge');
		expect(filters).toContain('format_list');
	});

	it('gates nothing when the lockfile does not pin Twig at all', () => {
		const filters = filtersFor(
			projectWith({ packages: [{ name: 'craftcms/cms', version: '5.10.11' }] }),
		);

		expect(filters).toContain('html_attr_merge');
		expect(filters).toContain('format_list');
	});

	// Version detection must not become activation by the back door: the core
	// pack describes the language, and a `.twig` file has no Twig in composer.
	it('stays active whatever the lockfile says', () => {
		expect(registry.getActivePacks(projectWith(undefined)).map((pack) => pack.name)).toEqual([
			'twig-core',
		]);
		expect(
			registry.getActivePacks(projectWith(lockPinning('3.19.0'))).map((pack) => pack.name),
		).toEqual(['twig-core']);
	});

	/**
	 * A completion that never appears cannot explain itself. Someone who typed
	 * `|html_attr_merge` in a Craft 4 project is reading a template that does not
	 * work, and the hover is where they find out why.
	 */
	it('still hovers an entry it gated out, and says which Twig has it', () => {
		const entry = registry
			.getMergedEntries(projectWith(lockPinning('3.19.0')))
			.filters.get('html_attr_merge');

		expect(entry?.available).toBe(false);
		expect(catalogMarkdown(entry as NonNullable<typeof entry>)).toContain(
			'Available since Twig 3.24.',
		);
	});
});

/** What `detectProject` makes of a project whose lockfile is `lock`. */
function projectWith(lock: object | undefined): WorkspaceCatalogContext {
	const root = mkdtempSync(join(tmpdir(), 'twig-toolbox-lock-'));
	try {
		writeFileSync(
			join(root, 'composer.json'),
			JSON.stringify({ require: { 'twig/twig': '^3.0' } }),
		);
		if (lock !== undefined) {
			writeFileSync(join(root, 'composer.lock'), JSON.stringify(lock));
		}
		return toCatalogContext(detectProject(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function lockPinning(version: string): object {
	return {
		packages: [
			{ name: 'symfony/polyfill-ctype', version: 'v1.31.0' },
			{ name: 'twig/twig', version: `v${version}` },
		],
		'packages-dev': [],
	};
}

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
