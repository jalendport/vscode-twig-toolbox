import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompletionItemKind, type CompletionItem } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { CatalogRegistry, type DialectPack } from './catalog';
import { TwigServerCore } from './core';
import { createCraftMemberProvider } from './craft-members';
import { BUILTIN_MEMBER_PROVIDERS } from './members';
import { ProjectContextResolver } from './project-context';
import { DEFAULT_SETTINGS } from './settings';
import { TemplateResolver } from './template-resolver';
import { createWorkspaceContextResolver, filePathToUri } from './workspace';

/**
 * The Craft pack, end to end.
 *
 * Everything here runs the shipped catalogs against a real workspace on disk —
 * a real `composer.json`, a real `composer.lock`, a real `TwigServerCore`. The
 * pack's whole job is to behave differently in two projects, and a test that
 * hand-fed it its own context could not tell whether it does.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const craftPack = JSON.parse(
	readFileSync(resolve(repoRoot, 'catalogs', 'craft.json'), 'utf8'),
) as DialectPack;

interface Fixture {
	readonly root: string;
	readonly write: (relativePath: string, text: string) => string;
	readonly dispose: () => void;
}

describe('Craft pack activation', () => {
	it('offers Craft tags, filters, functions and globals in a Craft project', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);

			expect(await labelsAt(server, fixture, '{% ‸ %}')).toContain('nav');
			expect(await labelsAt(server, fixture, '{% ‸ %}')).toContain('paginate');
			expect(await labelsAt(server, fixture, '{{ x|‸ }}')).toContain('markdown');
			expect(await labelsAt(server, fixture, '{{ ‸ }}')).toContain('siteUrl');
			expect(await labelsAt(server, fixture, '{{ ‸ }}')).toContain('currentUser');
		});
	});

	// The other half of the same claim: a pack that activates everywhere is not
	// a dialect pack, it is a bug in every plain Twig project.
	it('offers none of them in a plain Twig project', async () => {
		await withFixture(plainFixture(), async (fixture) => {
			const server = createServer(fixture);

			const tags = await labelsAt(server, fixture, '{% ‸ %}');
			expect(tags).toContain('for');
			expect(tags).not.toContain('nav');
			expect(tags).not.toContain('paginate');

			expect(await labelsAt(server, fixture, '{{ x|‸ }}')).not.toContain('markdown');
			expect(await labelsAt(server, fixture, '{{ ‸ }}')).not.toContain('siteUrl');
			expect(await labelsAt(server, fixture, '{{ ‸ }}')).not.toContain('craft');
			expect(await labelsAt(server, fixture, '{{ craft.‸ }}')).toEqual([]);
		});
	});

	it('hovers a Craft filter with Craft provenance and a docs link', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);
			const hover = await hoverAt(server, fixture, '{{ text|mark‸down }}');

			expect(hover).toContain('Processes a string as Markdown.');
			expect(hover).toContain('**Source:** CraftCMS');
			expect(hover).toContain(
				'https://craftcms.com/docs/5.x/reference/twig/filters.html#markdown-or-md',
			);
		});
	});

	// `|t` is an alias of `|translate`, and the alias is the name Craft projects
	// actually type.
	it('offers an aliased filter under the name templates use', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);

			expect(await labelsAt(server, fixture, '{{ x|‸ }}')).toContain('t');
			expect(await hoverAt(server, fixture, '{{ x|‸t }}')).toContain('Translates a message.');
		});
	});

	it('keeps a Craft-named filter out of a plain project’s hover', async () => {
		await withFixture(plainFixture(), async (fixture) => {
			expect(await hoverAt(createServer(fixture), fixture, '{{ text|mark‸down }}')).toBe(
				undefined,
			);
		});
	});
});

describe('craft.* API completions', () => {
	it('completes element query factories on craft.', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const items = await itemsAt(createServer(fixture), fixture, '{{ craft.‸ }}');
			const labels = items.map((item) => item.label);

			expect(labels).toEqual(
				expect.arrayContaining(['entries', 'assets', 'categories', 'tags', 'users', 'app']),
			);
			const entries = items.find((item) => item.label === 'entries');
			expect(entries?.kind).toBe(CompletionItemKind.Property);
			expect(entries?.detail).toBe('entries(criteria? = [])');
			expect(entries?.labelDetails?.description).toBe('CraftCMS');
		});
	});

	it('completes element query params and execution methods on craft.entries.', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const labels = await labelsAt(createServer(fixture), fixture, '{{ craft.entries.‸ }}');

			// Narrowing params from the query type itself...
			expect(labels).toEqual(
				expect.arrayContaining(['section', 'type', 'limit', 'orderBy', 'with']),
			);
			// ...and execution methods inherited from ElementQuery.
			expect(labels).toEqual(expect.arrayContaining(['all', 'one', 'count', 'ids']));
			// A section is not an asset volume.
			expect(labels).not.toContain('volume');
		});
	});

	it('keeps chaining through a query param call', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const labels = await labelsAt(
				createServer(fixture),
				fixture,
				"{{ craft.entries.section('news').‸ }}",
			);

			expect(labels).toEqual(expect.arrayContaining(['limit', 'all', 'one']));
		});
	});

	// `all()` returns rows, not a query. Offering `.section()` on it would be
	// inventing a chain Craft does not have.
	it('stops chaining where the query stops returning itself', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			expect(
				await labelsAt(createServer(fixture), fixture, '{{ craft.entries.all().‸ }}'),
			).toEqual([]);
		});
	});

	it('completes each element type with its own params', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);

			expect(await labelsAt(server, fixture, '{{ craft.assets.‸ }}')).toContain('volume');
			expect(await labelsAt(server, fixture, '{{ craft.assets.‸ }}')).not.toContain(
				'section',
			);
			expect(await labelsAt(server, fixture, '{{ craft.users.‸ }}')).toContain('group');
		});
	});

	it('declines a receiver the template bound itself', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const labels = await labelsAt(
				createServer(fixture),
				fixture,
				"{% set craft = 'nope' %}{{ craft.‸ }}",
			);

			expect(labels).toEqual([]);
		});
	});

	it('gives signature help inside craft.entries.section(', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);
			const { uri, position } = open(server, fixture, '{{ craft.entries.section(‸) }}');
			const help = await server.signatureHelp(uri, position);

			expect(help?.signatures[0]?.label).toBe('section(value)');
			expect(help?.signatures[0]?.parameters?.[0]?.label).toEqual([8, 13]);
			expect(help?.activeParameter).toBe(0);
			expect(contents(help?.signatures[0]?.documentation)).toContain(
				'Narrows the query results based on the sections the entries belong to.',
			);
		});
	});

	it('hovers a query param with its docs', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const hover = await hoverAt(
				createServer(fixture),
				fixture,
				"{{ craft.entries.sec‸tion('news').all() }}",
			);

			expect(hover).toContain('Narrows the query results based on the sections');
			expect(hover).toContain('**Source:** CraftCMS');
		});
	});
});

describe('Craft version gating', () => {
	it('offers a Craft 5 member in a Craft 5 project and a Craft 4 member in a Craft 4 project', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const labels = await labelsAt(createServer(fixture), fixture, '{{ craft.‸ }}');
			expect(labels).toContain('entries');
			expect(labels).not.toContain('matrixBlocks');
		});

		await withFixture(craftFixture({ version: '4.18.5' }), async (fixture) => {
			const labels = await labelsAt(createServer(fixture), fixture, '{{ craft.‸ }}');
			expect(labels).toContain('entries');
			expect(labels).toContain('matrixBlocks');
		});
	});

	// The same fixture, the same server, one edited lockfile: this is the flip a
	// developer performs by running `composer update`.
	it('follows the lockfile when the installed version changes', async () => {
		await withFixture(craftFixture({ version: '4.18.5' }), async (fixture) => {
			const server = createServer(fixture);
			expect(await labelsAt(server, fixture, '{{ craft.‸ }}')).toContain('matrixBlocks');

			const lockUri = writeLock(fixture, '5.10.11');
			server.invalidateFile(lockUri);

			expect(await labelsAt(server, fixture, '{{ craft.‸ }}')).not.toContain('matrixBlocks');
		});
	});

	it('gates entries as well as members', async () => {
		await withFixture(craftFixture({ version: '4.18.5' }), async (fixture) => {
			// `flatten` is a Craft 5 filter; `find` a Craft 4 one.
			const filters = await labelsAt(createServer(fixture), fixture, '{{ x|‸ }}');
			expect(filters).not.toContain('flatten');
			expect(filters).toContain('find');
		});

		await withFixture(craftFixture(), async (fixture) => {
			const filters = await labelsAt(createServer(fixture), fixture, '{{ x|‸ }}');
			expect(filters).toContain('flatten');
		});
	});

	// A completion cannot explain itself; hover can. Someone reading
	// `craft.matrixBlocks` in a Craft 5 project is looking at a template that no
	// longer works, and needs to be told why.
	it('still hovers a member the detected version does not have', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const hover = await hoverAt(
				createServer(fixture),
				fixture,
				'{{ craft.matrix‸Blocks.all() }}',
			);

			expect(hover).toContain('Removed in CraftCMS 5.0.0.');
		});
	});

	it('says which version a too-new entry arrived in', async () => {
		await withFixture(craftFixture({ version: '5.0.0' }), async (fixture) => {
			const hover = await hoverAt(createServer(fixture), fixture, '{{ primary‸Site }}');

			expect(hover).toContain('Available since CraftCMS 5.6.0.');
		});
	});

	it('gates nothing when composer.lock cannot name a version', async () => {
		// `^5.0` still pins a major, so a lockless checkout gates on that...
		await withFixture(craftFixture({ version: null }), async (fixture) => {
			expect(await labelsAt(createServer(fixture), fixture, '{{ craft.‸ }}')).not.toContain(
				'matrixBlocks',
			);
		});

		// ...but a constraint naming no version at all must not hide anything.
		await withFixture(
			craftFixture({ version: null, constraint: 'dev-main' }),
			async (fixture) => {
				const labels = await labelsAt(createServer(fixture), fixture, '{{ craft.‸ }}');
				expect(labels).toContain('matrixBlocks');
				expect(labels).toContain('entries');
			},
		);
	});
});

describe('Craft pack detection', () => {
	it('reads the installed version out of composer.lock', () => {
		return withFixture(craftFixture(), (fixture) => {
			const projects = new ProjectContextResolver(folders(fixture));

			expect(projects.forRoot(fixture.root)).toEqual({
				kind: 'craft',
				root: fixture.root,
				composerPackages: ['craftcms/cms'],
				craftVersion: '5.10.11',
			});
		});
	});

	it('falls back to the composer.json constraint with no lockfile', () => {
		return withFixture(craftFixture({ version: null, constraint: '^4.5' }), (fixture) => {
			const projects = new ProjectContextResolver(folders(fixture));

			expect(projects.forRoot(fixture.root)).toMatchObject({
				kind: 'craft',
				craftVersion: '4.5',
				craftVersionApproximate: true,
			});
		});
	});

	it('is not fooled by a project that merely mentions Craft', () => {
		return withFixture(plainFixture(), (fixture) => {
			const projects = new ProjectContextResolver(folders(fixture));

			expect(projects.forRoot(fixture.root).kind).toBe('unknown');
		});
	});

	// Template roots and pack activation must not be able to disagree about
	// whether a project is Craft — they are the same answer, read twice.
	it('shares one detection with template-root discovery', () => {
		return withFixture(craftFixture(), (fixture) => {
			const projects = new ProjectContextResolver(folders(fixture));
			const resolver = new TemplateResolver(folders(fixture), projects);
			const templateUri = fixture.write('templates/index.twig', '');

			expect(resolver.getTemplateRoots(templateUri, DEFAULT_SETTINGS)).toEqual([
				{ path: join(fixture.root, 'templates'), source: 'craft' },
			]);
			expect(createWorkspaceContextResolver(projects).resolve(templateUri)).toEqual({
				composerPackages: ['craftcms/cms'],
				packageVersions: { 'craftcms/cms': '5.10.11' },
			});
		});
	});
});

/**
 * Every Craft-specific name the docs publish is in the pack.
 *
 * This is the completeness claim the milestone rests on, and it is checked
 * against the docs rather than against a list written here: a list written here
 * would only ever prove that the generator and the test agree.
 */
describe('Craft catalog completeness', () => {
	const docsRoot = resolve(repoRoot, '.cache', 'craft-docs', 'docs', '5.x', 'reference', 'twig');

	const pages = {
		tags: 'tags.md',
		filters: 'filters.md',
		functions: 'functions.md',
		tests: 'tests.md',
	} as const;

	for (const [kind, page] of Object.entries(pages) as [keyof typeof pages, string][]) {
		it(`covers every documented Craft ${kind.replace(/s$/, '')}`, () => {
			const documented = craftNamesIn(join(docsRoot, page));
			expect(documented.length).toBeGreaterThan(5);

			const known = new Set(
				craftPack.entries[kind].flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]),
			);
			expect(documented.filter((name) => !known.has(name))).toEqual([]);
		});
	}

	it('covers every documented Craft global', () => {
		const documented = craftNamesIn(join(docsRoot, 'global-variables.md'));
		const known = new Set(craftPack.entries.globals.map((entry) => entry.name));

		// The page also documents Twig's own globals and the elements Craft loads
		// per route, neither of which the pack claims.
		const notOurs = new Set(['_self', '_context', '_charset', 'entry', 'category', 'product']);

		expect(documented.filter((name) => !known.has(name) && !notOurs.has(name))).toEqual([]);
	});

	// The names milestone 09 was specified around, checked by name. The docs
	// sweep above is the real completeness claim; this one pins the handful a
	// reader of the spec would look for first, aliases included.
	it('has the Craft surface the milestone names', () => {
		const named = {
			tags: [
				'cache',
				'nav',
				'switch',
				'paginate',
				'js',
				'css',
				'html',
				'redirect',
				'exit',
				'requirePermission',
				'requireLogin',
				'hook',
				'tag',
				'expires',
				'dd',
			],
			filters: ['markdown', 'money', 't', 'purify', 'json_decode'],
			functions: ['alias', 'siteUrl', 'svg', 'gql', 'collect'],
			globals: ['craft', 'currentUser', 'currentSite', 'siteName', 'now', 'view', 'devMode'],
		};

		for (const [kind, names] of Object.entries(named) as [keyof typeof named, string[]][]) {
			const known = new Set(
				craftPack.entries[kind].flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]),
			);
			expect(names.filter((name) => !known.has(name))).toEqual([]);
		}
	});

	it('describes and links every entry it ships', () => {
		for (const entries of Object.values(craftPack.entries)) {
			for (const entry of entries) {
				expect(entry.description.length).toBeGreaterThan(7);
				expect(entry.docsUrl).toMatch(/^https:\/\/craftcms\.com\/docs\//);
				expect(entry.signature.length).toBeGreaterThan(0);
				expect(entry.completionSnippet.length).toBeGreaterThan(0);
			}
		}
	});
});

/**
 * Names the docs mark as Craft's own — a local `#anchor` rather than a link out
 * to twig.symfony.com, which is how the pages distinguish what Craft adds from
 * what it merely inherits.
 */
function craftNamesIn(path: string): string[] {
	const rows = readFileSync(path, 'utf8').matchAll(/^\[([^\]]+)\]\((#[^)]+)\)[^|]*\|/gm);
	return [...rows]
		.map(([, name]) => name as string)
		.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^[a-z]+( [a-z]+)+$/.test(name))
		.sort((a, b) => a.localeCompare(b));
}

function createServer(fixture: Fixture): TwigServerCore {
	// The shipped catalogs, loaded the way the real server loads them.
	const registry = CatalogRegistry.loadDefault();
	const projects = new ProjectContextResolver(folders(fixture));
	const workspaceContext = createWorkspaceContextResolver(projects);

	return new TwigServerCore({
		catalogRegistry: registry,
		getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
		publishDiagnostics: () => {},
		resolveWorkspaceContext: (uri) => workspaceContext.resolve(uri),
		templateResolver: new TemplateResolver(folders(fixture), projects),
		memberProviders: [...BUILTIN_MEMBER_PROVIDERS, createCraftMemberProvider(registry)],
		parseDelayMs: 1,
	});
}

function folders(fixture: Fixture): { uri: string; name: string }[] {
	return [{ uri: filePathToUri(fixture.root), name: 'fixture' }];
}

interface CraftFixtureOptions {
	/** Installed version for composer.lock, or `null` for a project with none. */
	readonly version?: string | null;
	readonly constraint?: string;
}

/** A Craft project: composer.json, a lockfile, templates, project config. */
function craftFixture({
	version = '5.10.11',
	constraint = '^5.0',
}: CraftFixtureOptions = {}): Fixture {
	const fixture = createFixture();
	fixture.write('composer.json', JSON.stringify({ require: { 'craftcms/cms': constraint } }));
	if (version !== null) {
		writeLock(fixture, version);
	}
	// Milestone 10 reads this; here it only has to not change the answer.
	fixture.write('config/project/project.yaml', 'dateModified: 1700000000\n');
	mkdirSync(join(fixture.root, 'templates'), { recursive: true });
	return fixture;
}

function plainFixture(): Fixture {
	const fixture = createFixture();
	fixture.write(
		'composer.json',
		JSON.stringify({
			require: { 'twig/twig': '^3.0' },
			// Prose mentioning Craft is not a dependency on it.
			description: 'A plain Twig project, not craftcms/cms',
		}),
	);
	mkdirSync(join(fixture.root, 'templates'), { recursive: true });
	return fixture;
}

function writeLock(fixture: Fixture, version: string): string {
	return fixture.write(
		'composer.lock',
		JSON.stringify({
			packages: [
				{ name: 'yiisoft/yii2', version: '2.0.49' },
				{ name: 'craftcms/cms', version: version },
			],
			'packages-dev': [],
		}),
	);
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), 'twig-toolbox-craft-'));
	return {
		root,
		write: (relativePath, text) => {
			const path = join(root, relativePath);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
			return filePathToUri(path);
		},
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

async function withFixture(
	fixture: Fixture,
	body: (fixture: Fixture) => void | Promise<void>,
): Promise<void> {
	try {
		await body(fixture);
	} finally {
		fixture.dispose();
	}
}

/** Opens `source` as a template, with `‸` marking the cursor. */
function open(
	server: TwigServerCore,
	fixture: Fixture,
	source: string,
): { uri: string; position: { line: number; character: number } } {
	const offset = source.indexOf('‸');
	if (offset === -1) {
		throw new Error('Fixture source needs a ‸ cursor marker');
	}
	const text = source.replace('‸', '');
	// A fresh name per open: the store keys documents by URI, and a stale parse
	// would answer for the wrong source.
	const uri = fixture.write(`templates/case-${nextCase++}.twig`, text);
	const document = TextDocument.create(uri, 'twig', 1, text);
	server.openDocument(document);
	return { uri, position: document.positionAt(offset) };
}

let nextCase = 0;

async function itemsAt(
	server: TwigServerCore,
	fixture: Fixture,
	source: string,
): Promise<CompletionItem[]> {
	const { uri, position } = open(server, fixture, source);
	return server.complete(uri, position);
}

async function labelsAt(
	server: TwigServerCore,
	fixture: Fixture,
	source: string,
): Promise<string[]> {
	return (await itemsAt(server, fixture, source)).map((item) => item.label);
}

async function hoverAt(
	server: TwigServerCore,
	fixture: Fixture,
	source: string,
): Promise<string | undefined> {
	const { uri, position } = open(server, fixture, source);
	const hover = await server.hover(uri, position);
	return hover === undefined ? undefined : contents(hover.contents);
}

function contents(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value !== null && typeof value === 'object' && 'value' in value) {
		return String(value.value);
	}
	return '';
}
