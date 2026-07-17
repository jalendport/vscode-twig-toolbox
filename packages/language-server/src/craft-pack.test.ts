import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CompletionItemKind,
	type CompletionItem,
	type Diagnostic,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it, vi } from 'vitest';
import { CatalogRegistry, type ClassPack, type DialectPack } from './catalog';
import { TwigServerCore } from './core';
import { createCraftMemberProvider } from './craft-members';
import { BUILTIN_MEMBER_PROVIDERS } from './members';
import { ProjectContextResolver } from './project-context';
import { DEFAULT_SETTINGS, type TwigToolboxSettings } from './settings';
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
const classPack = JSON.parse(
	readFileSync(resolve(repoRoot, 'catalogs', 'craft-classes.json'), 'utf8'),
) as ClassPack;
/** Both halves of the model — what a chain resolver actually sees. */
const allObjects = [...(craftPack.objects ?? []), ...classPack.classes];

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
			expect(hover).toContain('**Source:** Craft CMS');
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
			expect(entries?.labelDetails?.description).toBe('Craft CMS');
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
			expect(hover).toContain('**Source:** Craft CMS');
		});
	});
});

/**
 * `craft.app.*`, which is a chain rather than a list.
 *
 * The claim being tested is that every segment of `craft.app.request.queryString`
 * is a thing the server knows — not just the last one — and that each links to
 * the reference page that actually documents it. The chain is the feature; a
 * test that only checked the leaf would pass on a model that resolved by luck.
 */
describe('craft.app.* API awareness', () => {
	it('completes the application services on craft.app.', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const items = await itemsAt(createServer(fixture), fixture, '{{ craft.app.‸ }}');
			const labels = items.map((item) => item.label);

			expect(labels).toEqual(
				expect.arrayContaining([
					'request',
					'config',
					'sites',
					'security',
					'session',
					'user',
					'view',
					'urlManager',
				]),
			);
			expect(items.find((item) => item.label === 'request')?.labelDetails?.description).toBe(
				'Craft CMS',
			);
			// Craft's own console-side services are not a template's vocabulary.
			expect(labels).not.toContain('mutex');
			expect(labels).not.toContain('migrator');
		});
	});

	it('completes a service’s members, Craft’s own and Yii’s alike', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const labels = await labelsAt(
				createServer(fixture),
				fixture,
				'{{ craft.app.request.‸ }}',
			);

			// Craft declares this one...
			expect(labels).toContain('queryStringWithoutPath');
			expect(labels).toContain('isSiteRequest');
			// ...and inherits this one from yii\web\Request, which a template
			// reaches through Craft's class and cannot tell apart.
			expect(labels).toContain('queryString');
			expect(labels).toContain('isSecureConnection');
		});
	});

	/**
	 * The whole feature in one line of Twig.
	 *
	 * `queryString` is declared by `yii\web\Request`, so it takes the section
	 * anchor: there is no `#property-querystring` on Craft's page, and no
	 * `yii-web-request.html` to send anyone to.
	 */
	it('resolves craft.app.request.queryString end to end', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const hover = await hoverAt(
				createServer(fixture),
				fixture,
				'{{ craft.app.request.query‸String }}',
			);

			expect(hover).toContain('Part of the request URL that is after the question mark.');
			expect(hover).toContain('**Source:** Craft CMS');
			expect(hover).toContain(
				'https://docs.craftcms.com/api/v5/craft-web-request.html#public-properties',
			);
		});
	});

	it('anchors a Craft-declared member at the member itself', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const hover = await hoverAt(
				createServer(fixture),
				fixture,
				'{{ craft.app.request.queryString‸WithoutPath }}',
			);

			expect(hover).toContain(
				'https://docs.craftcms.com/api/v5/craft-web-request.html#property-querystringwithoutpath',
			);
		});
	});

	// A member declared on `ApplicationTrait` is anchored on the trait's page,
	// because that is the page the reference put the anchor on.
	it('follows a trait-declared service to the trait’s page', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const hover = await hoverAt(createServer(fixture), fixture, '{{ craft.app.si‸tes }}');

			expect(hover).toContain(
				'https://docs.craftcms.com/api/v5/craft-base-applicationtrait.html#property-sites',
			);
		});
	});

	it('hovers every segment of the chain, not just the last', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);
			const chain = '{{ craft.app.request.queryString }}';

			for (const cursor of ['cr‸aft', 'a‸pp', 'requ‸est', 'query‸String']) {
				const source = chain.replace(cursor.replace('‸', ''), cursor);
				const hover = await hoverAt(server, fixture, source);

				expect(hover, `no hover for ${cursor}`).toBeDefined();
				expect(hover, `no docs link for ${cursor}`).toContain('[Documentation ↗](https://');
			}
		});
	});

	it('keeps chaining through a service into what it returns', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);

			expect(await labelsAt(server, fixture, '{{ craft.app.config.‸ }}')).toContain(
				'general',
			);
			// craft.app.config.general.devMode — three classes deep, and the one
			// chain every Craft template has typed at least once.
			const labels = await labelsAt(server, fixture, '{{ craft.app.config.general.‸ }}');
			expect(labels).toContain('devMode');
			expect(labels).toContain('siteToken');
		});
	});

	// The depth cap is a promise the pack keeps: past it, members name no type,
	// and a receiver with no type gets no completions rather than a guess.
	it('stops chaining at the modelled depth', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			expect(
				await labelsAt(
					createServer(fixture),
					fixture,
					'{{ craft.app.config.general.devMode.‸ }}',
				),
			).toEqual([]);
		});
	});

	it('offers nothing for a class it does not model', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);

			// `db` is a real service; it is not one this pack models, so the chain
			// ends at `craft.app` rather than guessing.
			expect(await labelsAt(server, fixture, '{{ craft.app.db.‸ }}')).toEqual([]);
			expect(await hoverAt(server, fixture, '{{ craft.app.d‸b }}')).toBe(undefined);
			expect(await labelsAt(server, fixture, '{{ craft.app.request.nonsense.‸ }}')).toEqual(
				[],
			);
			expect(await hoverAt(server, fixture, '{{ craft.app.request.non‸sense }}')).toBe(
				undefined,
			);
		});
	});

	/**
	 * The pack must not turn "I don't model this" into "this is wrong".
	 *
	 * Diagnostics are checked with unknown-name reporting turned all the way up,
	 * because the setting that would expose a false positive is the one nobody
	 * has on by default.
	 */
	it('never diagnoses a chain, modelled or not', async () => {
		await withFixture(craftFixture(), async (fixture) => {
			const byUri = new Map<string, Diagnostic[]>();
			const server = createServer(fixture, {
				publishDiagnostics: (uri, diagnostics) => byUri.set(uri, diagnostics),
				settings: {
					templateRoots: [],
					diagnostics: { unknownNames: 'warning', ignoredNames: [] },
				},
			});

			const { uri } = open(
				server,
				fixture,
				'{{ craft.app.request.queryString }}{{ craft.app.db.tablePrefix }}{{ craft.app.nope.at.all }}‸',
			);

			await vi.waitFor(() => expect(byUri.has(uri)).toBe(true));
			expect(byUri.get(uri)).toEqual([]);
		});
	});

	it('declines the whole chain outside a Craft project', async () => {
		await withFixture(plainFixture(), async (fixture) => {
			const server = createServer(fixture);

			expect(await labelsAt(server, fixture, '{{ craft.app.‸ }}')).toEqual([]);
			expect(await hoverAt(server, fixture, '{{ craft.app.request.query‸String }}')).toBe(
				undefined,
			);
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

			expect(hover).toContain('Removed in Craft CMS 5.0.0.');
		});
	});

	it('says which version a too-new entry arrived in', async () => {
		await withFixture(craftFixture({ version: '5.0.0' }), async (fixture) => {
			const hover = await hoverAt(createServer(fixture), fixture, '{{ random‸String(10) }}');

			expect(hover).toContain('Available since Craft CMS 5.9.0.');
		});
	});

	/**
	 * `startElevatedSession()` is Craft 4's; Craft 5 renamed it. The class walk
	 * runs over both majors and diffs them, so an application member carries the
	 * same version metadata as a filter does — and gates the same way.
	 */
	it('gates an application member by the detected version', async () => {
		await withFixture(craftFixture({ version: '4.18.5' }), async (fixture) => {
			expect(
				await labelsAt(createServer(fixture), fixture, '{{ craft.app.user.‸ }}'),
			).toContain('startElevatedSession');
		});

		await withFixture(craftFixture(), async (fixture) => {
			const server = createServer(fixture);
			expect(await labelsAt(server, fixture, '{{ craft.app.user.‸ }}')).not.toContain(
				'startElevatedSession',
			);
			// Still explains itself to whoever is reading the broken template.
			expect(
				await hoverAt(server, fixture, '{{ craft.app.user.startElevated‸Session() }}'),
			).toContain('Removed in Craft CMS 5.0.0.');
		});
	});

	// Craft publishes a reference per major, and a Craft 4 project reading Craft
	// 5's page is being shown a class it does not have.
	it('links a Craft 4 project at the Craft 4 reference', async () => {
		await withFixture(craftFixture({ version: '4.18.5' }), async (fixture) => {
			const hover = await hoverAt(
				createServer(fixture),
				fixture,
				'{{ craft.app.request.query‸String }}',
			);

			expect(hover).toContain(
				'https://docs.craftcms.com/api/v4/craft-web-request.html#public-properties',
			);
			expect(hover).not.toContain('/api/v5/');
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
 * The names come from `craft.docs-index.json`, which the generator writes
 * straight off Craft's docs tables — so this is not the pack being compared
 * against a list this file made up, and it does not need a `.cache/` checkout
 * to run. What it catches is a documented name lost on its way through the
 * union, aliasing and version merge that build the pack.
 */
describe('Craft catalog completeness', () => {
	const docsIndex = JSON.parse(
		readFileSync(resolve(repoRoot, 'catalogs', 'craft.docs-index.json'), 'utf8'),
	) as { source: { ref: string }; names: Record<string, string[]> };

	it('was indexed from the docs the pack was generated from', () => {
		expect(docsIndex.source.ref).toBe(craftPack.sources.docs.ref);
	});

	for (const kind of ['tags', 'filters', 'functions', 'tests', 'globals'] as const) {
		it(`covers every documented Craft ${kind.replace(/s$/, '')}`, () => {
			const documented = docsIndex.names[kind] ?? [];
			expect(documented.length).toBeGreaterThan(5);

			const known = new Set(
				craftPack.entries[kind].flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]),
			);
			expect(documented.filter((name) => !known.has(name))).toEqual([]);
		});
	}

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

	/**
	 * A `type` is the model promising the chain continues. Every one of them has
	 * to name an object that actually ships, or the promise is broken at the one
	 * moment it matters — someone typing the next dot.
	 *
	 * The union of both files is the bar, because the two reference each other
	 * across the split: `craft.entries` is an `EntryQuery` in the pack, and
	 * `EntryQuery.one()` is a `craft\elements\Entry` in the class model. Checking
	 * either alone would call the other's names broken.
	 */
	it('points every member type at an object it ships', () => {
		const names = new Set(allObjects.map((object) => object.name));

		for (const object of allObjects) {
			for (const member of object.members) {
				if (member.type !== undefined) {
					expect(names, `${object.name}.${member.name}`).toContain(member.type);
				}
			}
		}
	});

	it('resolves every `extends` to an object it ships', () => {
		const names = new Set(allObjects.map((object) => object.name));

		for (const object of allObjects) {
			if (object.extends !== undefined) {
				expect(names, `${object.name} extends`).toContain(object.extends);
			}
		}
	});

	it('types every global it claims an object for', () => {
		const names = new Set(allObjects.map((object) => object.name));

		for (const entry of craftPack.entries.globals) {
			if (entry.objectType !== undefined) {
				expect(names, `global ${entry.name}`).toContain(entry.objectType);
			}
		}
	});

	it('describes and links every member it ships', () => {
		for (const object of craftPack.objects ?? []) {
			for (const member of object.members) {
				expect(member.description.length, `${object.name}.${member.name}`).toBeGreaterThan(
					7,
				);
				expect(member.docsUrl, `${object.name}.${member.name}`).toMatch(/^https:\/\//);
			}
		}
	});

	/**
	 * The class model carries no links at all — that is the point of it. A URL
	 * that crept back in would be one major's answer baked in for both, which is
	 * the bug the derivation exists to prevent, and it would be invisible.
	 */
	it('stores no docs URL anywhere in the class model', () => {
		for (const object of classPack.classes) {
			expect(object.docsUrl, object.name).toBeUndefined();
			for (const member of object.members) {
				expect(member.docsUrl, `${object.name}.${member.name}`).toBeUndefined();
				expect(member.description.length, `${object.name}.${member.name}`).toBeGreaterThan(
					7,
				);
			}
		}
	});

	/**
	 * Inheritance factoring, measured at the place it pays off.
	 *
	 * Every element type inherits the bulk of its surface from `craft\base\Element`.
	 * If any of them ever stores those members itself, the file has quietly gone
	 * back to being a flatten — which is what made this model too expensive to
	 * ship the first time.
	 */
	it('stores inherited element members once, on the class that declares them', () => {
		const element = classPack.classes.find((object) => object.name === 'craft\\base\\Element');
		const entry = classPack.classes.find((object) => object.name === 'craft\\elements\\Entry');

		expect(element).toBeDefined();
		expect(entry?.extends).toBe('craft\\base\\Element');

		const elementOwn = new Set((element?.members ?? []).map((member) => member.name));
		const entryOwn = (entry?.members ?? []).map((member) => member.name);
		const restated = entryOwn.filter((name) => elementOwn.has(name));

		// Entry may narrow a member of Element's — that is a real declaration and
		// it keeps its own. What it must not do is restate the whole surface.
		expect(restated.length).toBeLessThan(elementOwn.size / 4);
		expect(entryOwn).not.toContain('hasErrors');
	});
});

/**
 * Where each entry's `sinceVersion` came from, checked at the seams.
 *
 * Four sources answer this question and they disagree, so the order they
 * disagree in is the feature: a hand override beats Craft's docs, which beat
 * Craft's changelog, which beats the 4-vs-5 diff. Each case below is one rung of
 * that ladder, named because the value is only right if it came from the right
 * place — `uuid()` at `4.17.0` and `uuid()` at `5.9.0` are both defensible
 * readings of the changelog, and only one of them is this pack's.
 */
describe('Craft catalog version metadata', () => {
	function entry(kind: 'filters' | 'functions' | 'globals', name: string) {
		return craftPack.entries[kind].find((candidate) => candidate.name === name);
	}

	/**
	 * `primarySite` is in Craft 4.14's changelog and Craft 5's docs carry
	 * `<Since ver="5.6.0" />`. Both are true — 5.6.0 added it, 4.14.0 backported
	 * it — but a single sinceVersion of 5.6.0 hides it from the Craft 4.14–4.18
	 * projects that have it, so a hand override pins the backport version. This
	 * asserts the override outranks the badge, which the unit suite shows
	 * outranks the mining.
	 */
	it('lets a hand override outrank the docs Since badge', () => {
		expect(entry('globals', 'primarySite')?.sinceVersion).toBe('4.14.0');
	});

	/**
	 * Neither of these has a badge. The diff can only see that Craft 5 has them
	 * and say `5.0.0`; the changelog says which release, and it is right.
	 */
	it('lets the changelog outrank the 4-vs-5 diff', () => {
		expect(entry('functions', 'randomString')?.sinceVersion).toBe('5.9.0');
		expect(entry('globals', 'PHP_INT_MAX')?.sinceVersion).toBe('5.6.0');
	});

	/**
	 * The rule that keeps the mining honest. `uuid()` is in both majors' sources,
	 * and both majors' changelogs claim it — 4.17.0 backported what 5.9.0 added.
	 * Taking Craft 5's answer would gate `uuid()` out of the Craft 4 projects that
	 * have had it since 4.17, so a major the name is present in is the only one
	 * allowed to date it.
	 */
	it('does not let Craft 5 date a name Craft 4 already has', () => {
		expect(entry('functions', 'uuid')?.sinceVersion).toBe('4.17.0');
	});

	// Nothing mined may contradict the diff it refines: a name Craft 4 lacks
	// cannot predate Craft 5, and a name Craft 5 lacks is still gone in 5.
	it('keeps every mined version inside the major that could have added it', () => {
		for (const entries of Object.values(craftPack.entries)) {
			for (const candidate of entries) {
				if (candidate.sinceVersion === undefined) {
					continue;
				}
				expect(candidate.sinceVersion, candidate.name).toMatch(/^[45]\./);
			}
		}
	});

	it('still marks what Craft 5 removed', () => {
		const object = craftPack.objects?.find((candidate) => candidate.name === 'craft');
		expect(
			object?.members.find((member) => member.name === 'matrixBlocks')?.removedVersion,
		).toBe('5.0.0');
	});
});

interface ServerOptions {
	readonly publishDiagnostics?: (uri: string, diagnostics: Diagnostic[]) => void;
	readonly settings?: TwigToolboxSettings;
}

function createServer(fixture: Fixture, options: ServerOptions = {}): TwigServerCore {
	// The shipped catalogs, loaded the way the real server loads them.
	const registry = CatalogRegistry.loadDefault();
	const projects = new ProjectContextResolver(folders(fixture));
	const workspaceContext = createWorkspaceContextResolver(projects);

	return new TwigServerCore({
		catalogRegistry: registry,
		getSettings: () => Promise.resolve(options.settings ?? DEFAULT_SETTINGS),
		publishDiagnostics: options.publishDiagnostics ?? (() => {}),
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
