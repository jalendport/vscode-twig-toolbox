import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CompletionItem, Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { CatalogRegistry } from './catalog';
import { TwigServerCore } from './core';
import { createCraftMemberProvider } from './craft-members';
import { CraftProjectConfigResolver } from './craft-project-config';
import { BUILTIN_MEMBER_PROVIDERS } from './members';
import { ProjectContextResolver } from './project-context';
import { DEFAULT_SETTINGS } from './settings';
import { TemplateResolver } from './template-resolver';
import { createWorkspaceContextResolver, filePathToUri } from './workspace';

interface Fixture {
	readonly root: string;
	readonly write: (relativePath: string, text: string) => string;
	readonly dispose: () => void;
}

describe('Craft project config introspection', () => {
	it('completes section handles and scopes entry fields to that section', async () => {
		await withFixture(craft5Fixture(), async (fixture) => {
			const server = createServer(fixture);

			const sectionItems = await itemsAt(server, fixture, "{{ craft.entries.section('‸') }}");
			expect(sectionItems.map((item) => item.label)).toEqual(
				expect.arrayContaining(['news', 'landingPages']),
			);
			expect(
				contents(sectionItems.find((item) => item.label === 'news')?.documentation),
			).toContain('News');

			const entryItems = await itemsAt(
				server,
				fixture,
				"{% for entry in craft.entries.section('news').all() %}{{ entry.‸ }}{% endfor %}",
			);
			const labels = entryItems.map((item) => item.label);
			expect(labels).toEqual(expect.arrayContaining(['title', 'summary', 'contentBlocks']));
			expect(labels).not.toContain('heroImage');
			expect(
				contents(entryItems.find((item) => item.label === 'summary')?.documentation),
			).toContain('Summary (PlainText)');
		});
	});

	/**
	 * The two halves of the model on one object.
	 *
	 * The class model knows what an entry is; the project config knows what this
	 * project's entries have. Neither is the answer on its own — a completion list
	 * with `title` but not `summary` describes a Craft that nobody installed, and
	 * one with `summary` but not `title` describes a project with no Craft in it.
	 */
	it('merges this project’s field handles with the native element members', async () => {
		await withFixture(craft5Fixture(), async (fixture) => {
			const items = await itemsAt(
				createServer(fixture),
				fixture,
				"{% for entry in craft.entries.section('news').all() %}{{ entry.‸ }}{% endfor %}",
			);
			const labels = items.map((item) => item.label);

			// This project's, from the YAML...
			expect(labels).toContain('summary');
			// ...and Craft's own, from the class model.
			expect(labels).toContain('postDate');
			expect(labels).toContain('author');
			expect(items.find((item) => item.label === 'postDate')?.labelDetails?.description).toBe(
				'Craft CMS',
			);
			expect(items.find((item) => item.label === 'summary')?.labelDetails?.description).toBe(
				'Craft CMS project',
			);
		});
	});

	/**
	 * A field handle that collides with a member Craft already has.
	 *
	 * `title` is both: `craft\base\ElementTrait` declares it, and this fixture has
	 * a field called `title` too. There is one `entry.title` in the template, and
	 * in this project it is the field — so the field wins the detail line. What it
	 * does not win is the documentation: the handle has no link of its own, and
	 * Craft's is still the right one for a name that is, underneath, still Craft's.
	 */
	it('lets a field handle win a collision without losing the native docs link', async () => {
		await withFixture(craft5Fixture(), async (fixture) => {
			const server = createServer(fixture);
			const items = await itemsAt(
				server,
				fixture,
				"{% for entry in craft.entries.section('news').all() %}{{ entry.‸ }}{% endfor %}",
			);

			const title = items.filter((item) => item.label === 'title');
			// One member, not two: the collision is merged rather than duplicated.
			expect(title).toHaveLength(1);
			expect(title[0]?.labelDetails?.description).toBe('Craft CMS project');
			expect(contents(title[0]?.documentation)).toContain('Marketing Title (PlainText)');

			const hover = await hoverAt(
				server,
				fixture,
				"{% for entry in craft.entries.section('news').all() %}{{ entry.ti‸tle }}{% endfor %}",
			);
			expect(hover).toContain('Marketing Title (PlainText)');
			expect(hover).toContain(
				'https://docs.craftcms.com/api/v5/craft-base-elementtrait.html#property-title',
			);
		});
	});

	/**
	 * The chain the two halves exist to make work.
	 *
	 * `heroImage` is a field only this project has; `AssetQuery` is what an Assets
	 * field yields; `one()` is an `Asset`; `dataUrl` is Craft's. Four segments,
	 * and no single source of truth can answer more than two of them.
	 */
	it('chains a project field into the class model and back out', async () => {
		await withFixture(craft5Fixture(), async (fixture) => {
			const server = createServer(fixture);
			const probe =
				"{% for entry in craft.entries.section('landingPages').all() %}{{ entry.heroImage.one().‸ }}{% endfor %}";

			const labels = await labelsAt(server, fixture, probe);
			expect(labels).toContain('dataUrl');
			expect(labels).toContain('getDataUrl');
			expect(labels).toContain('filename');

			const hover = await hoverAt(
				server,
				fixture,
				"{% for entry in craft.entries.section('landingPages').all() %}{{ entry.heroImage.one().data‸Url }}{% endfor %}",
			);
			expect(hover).toContain(
				'https://docs.craftcms.com/api/v5/craft-elements-asset.html#property-dataurl',
			);
		});
	});

	it('completes matrix sub-fields inside matrix block iteration', async () => {
		await withFixture(craft5Fixture(), async (fixture) => {
			const labels = await labelsAt(
				createServer(fixture),
				fixture,
				'{% for block in entry.contentBlocks.all() %}{{ block.‸ }}{% endfor %}',
			);

			expect(labels).toEqual(expect.arrayContaining(['blockText', 'imageAsset']));
			expect(labels).not.toContain('summary');
		});
	});

	it('updates field handles after project-config YAML changes are invalidated', async () => {
		await withFixture(craft5Fixture(), async (fixture) => {
			const server = createServer(fixture);
			expect(await entryLabels(server, fixture)).toContain('summary');

			const fieldUri = fixture.write(
				'config/project/fields/field-summary.yaml',
				fieldYaml('summaryTeaser', 'Summary Teaser', 'craft\\fields\\PlainText'),
			);
			server.invalidateFile(fieldUri);

			const labels = await entryLabels(server, fixture);
			expect(labels).toContain('summaryTeaser');
			expect(labels).not.toContain('summary');
		});
	});

	it('degrades to level-1 Craft behavior when YAML is malformed', async () => {
		await withFixture(craft5Fixture(), async (fixture) => {
			const diagnostics = new Map<string, Diagnostic[]>();
			const server = createServer(fixture, diagnostics);
			expect(await labelsAt(server, fixture, "{{ craft.entries.section('‸') }}")).toContain(
				'news',
			);

			const brokenUri = fixture.write(
				'config/project/fields/field-summary.yaml',
				'handle: [\n',
			);
			server.invalidateFile(brokenUri);

			expect(await labelsAt(server, fixture, "{{ craft.entries.section('‸') }}")).toEqual([]);
			expect(await labelsAt(server, fixture, '{{ craft.entries.‸ }}')).toContain('section');
			const { uri } = open(server, fixture, '{{ craft.entries.section("news").all() }}‸');
			await server.refreshDiagnostics(uri);
			expect(diagnostics.get(uri)).toEqual([]);
		});
	});

	it('hovers and defines Craft handle strings from their YAML source', async () => {
		await withFixture(craft5Fixture(), async (fixture) => {
			const server = createServer(fixture);
			const hover = await hoverAt(
				server,
				fixture,
				"{{ craft.entries.section('ne‸ws').all() }}",
			);
			expect(hover).toContain('section news');
			expect(hover).toContain('News');
			expect(hover).toContain('config/project/sections/section-news.yaml');

			const { uri, position } = open(
				server,
				fixture,
				"{{ craft.entries.section('ne‸ws').all() }}",
			);
			const definition = await server.definition(uri, position);
			expect(definition).toEqual([
				expect.objectContaining({
					uri: filePathToUri(
						join(fixture.root, 'config/project/sections/section-news.yaml'),
					),
				}),
			]);
		});
	});

	it('parses Craft 4 inline entry types and matrix block fields', async () => {
		await withFixture(craft4Fixture(), async (fixture) => {
			const server = createServer(fixture);

			expect(
				await labelsAt(
					server,
					fixture,
					"{% for entry in craft.entries.section('news').all() %}{{ entry.‸ }}{% endfor %}",
				),
			).toContain('legacyBody');
			expect(
				await labelsAt(
					server,
					fixture,
					'{% for block in entry.legacyBlocks.all() %}{{ block.‸ }}{% endfor %}',
				),
			).toContain('legacyBlockText');
		});
	});

	it('stays inert in non-Craft projects', async () => {
		await withFixture(plainFixture(), async (fixture) => {
			const server = createServer(fixture);

			expect(await labelsAt(server, fixture, "{{ craft.entries.section('‸') }}")).toEqual([]);
			expect(await labelsAt(server, fixture, '{{ entry.‸ }}')).toEqual([]);
		});
	});
});

function createServer(
	fixture: Fixture,
	diagnostics: Map<string, Diagnostic[]> = new Map(),
): TwigServerCore {
	const registry = CatalogRegistry.loadDefault();
	const projects = new ProjectContextResolver(folders(fixture));
	const workspaceContext = createWorkspaceContextResolver(projects);
	const craftProjectConfig = new CraftProjectConfigResolver(projects);

	return new TwigServerCore({
		catalogRegistry: registry,
		getSettings: () => Promise.resolve(DEFAULT_SETTINGS),
		publishDiagnostics: (uri, items) => diagnostics.set(uri, items),
		resolveWorkspaceContext: (uri) => workspaceContext.resolve(uri),
		templateResolver: new TemplateResolver(folders(fixture), projects),
		craftProjectConfig,
		memberProviders: [
			...BUILTIN_MEMBER_PROVIDERS,
			createCraftMemberProvider(registry, craftProjectConfig),
		],
		parseDelayMs: 1,
	});
}

function craft5Fixture(): Fixture {
	const fixture = craftFixture('5.10.11', '^5.0');
	fixture.write(
		'config/project/fields/field-summary.yaml',
		fieldYaml('summary', 'Summary', 'craft\\fields\\PlainText'),
	);
	fixture.write(
		'config/project/fields/field-content-blocks.yaml',
		[
			'handle: contentBlocks',
			'name: Content Blocks',
			'type: craft\\fields\\Matrix',
			'settings:',
			'  entryTypes:',
			'    - entry-text-block',
			'    - entry-image-block',
		].join('\n'),
	);
	fixture.write(
		'config/project/fields/field-hero-image.yaml',
		fieldYaml('heroImage', 'Hero Image', 'craft\\fields\\Assets'),
	);
	fixture.write(
		'config/project/fields/field-block-text.yaml',
		fieldYaml('blockText', 'Block Text', 'craft\\fields\\PlainText'),
	);
	fixture.write(
		'config/project/fields/field-image-asset.yaml',
		fieldYaml('imageAsset', 'Image Asset', 'craft\\fields\\Assets'),
	);
	// A handle that collides with a member Craft's own `Entry` already has. Real
	// projects do this, and it is the case the merge has to get right.
	fixture.write(
		'config/project/fields/field-title.yaml',
		fieldYaml('title', 'Marketing Title', 'craft\\fields\\PlainText'),
	);
	fixture.write(
		'config/project/entryTypes/entry-article.yaml',
		entryTypeYaml('article', 'Article', [
			'field-summary',
			'field-content-blocks',
			'field-title',
		]),
	);
	fixture.write(
		'config/project/entryTypes/entry-page.yaml',
		entryTypeYaml('page', 'Page', ['field-hero-image']),
	);
	fixture.write(
		'config/project/entryTypes/entry-text-block.yaml',
		entryTypeYaml('textBlock', 'Text Block', ['field-block-text']),
	);
	fixture.write(
		'config/project/entryTypes/entry-image-block.yaml',
		entryTypeYaml('imageBlock', 'Image Block', ['field-image-asset']),
	);
	fixture.write(
		'config/project/sections/section-news.yaml',
		['handle: news', 'name: News', 'type: channel', 'entryTypes:', '  - entry-article'].join(
			'\n',
		),
	);
	fixture.write(
		'config/project/sections/section-landing.yaml',
		[
			'handle: landingPages',
			'name: Landing Pages',
			'type: channel',
			'entryTypes:',
			'  - entry-page',
		].join('\n'),
	);
	fixture.write(
		'config/project/volumes/volume-images.yaml',
		['handle: images', 'name: Images'].join('\n'),
	);
	fixture.write(
		'config/project/globalSets/global-site-info.yaml',
		[
			'handle: siteInfo',
			'name: Site Info',
			'fieldLayouts:',
			'  layout:',
			'    tabs:',
			'      - elements:',
			'          - type: craft\\fieldlayoutelements\\CustomField',
			'            fieldUid: field-summary',
		].join('\n'),
	);
	return fixture;
}

function craft4Fixture(): Fixture {
	const fixture = craftFixture('4.18.5', '^4.0');
	fixture.write(
		'config/project/project.yaml',
		[
			'fields:',
			'  field-legacy-body:',
			'    handle: legacyBody',
			'    name: Legacy Body',
			'    type: craft\\fields\\PlainText',
			'  field-legacy-blocks:',
			'    handle: legacyBlocks',
			'    name: Legacy Blocks',
			'    type: craft\\fields\\Matrix',
			'    settings:',
			'      blockTypes:',
			'        block-text:',
			'          name: Text',
			'          handle: text',
			'          fields:',
			'            field-legacy-block-text:',
			'              handle: legacyBlockText',
			'              name: Legacy Block Text',
			'              type: craft\\fields\\PlainText',
			'sections:',
			'  section-news:',
			'    handle: news',
			'    name: News',
			'    type: channel',
			'    entryTypes:',
			'      entry-article:',
			'        handle: article',
			'        name: Article',
			'        fieldLayouts:',
			'          layout:',
			'            tabs:',
			'              - elements:',
			'                  - type: craft\\fieldlayoutelements\\CustomField',
			'                    fieldUid: field-legacy-body',
			'                  - type: craft\\fieldlayoutelements\\CustomField',
			'                    fieldUid: field-legacy-blocks',
		].join('\n'),
	);
	return fixture;
}

function plainFixture(): Fixture {
	const fixture = createFixture();
	fixture.write('composer.json', JSON.stringify({ require: { 'twig/twig': '^3.0' } }));
	fixture.write(
		'config/project/sections/section-news.yaml',
		['handle: news', 'name: News'].join('\n'),
	);
	mkdirSync(join(fixture.root, 'templates'), { recursive: true });
	return fixture;
}

function craftFixture(version: string, constraint: string): Fixture {
	const fixture = createFixture();
	fixture.write('composer.json', JSON.stringify({ require: { 'craftcms/cms': constraint } }));
	fixture.write(
		'composer.lock',
		JSON.stringify({
			packages: [{ name: 'craftcms/cms', version }],
			'packages-dev': [],
		}),
	);
	mkdirSync(join(fixture.root, 'templates'), { recursive: true });
	return fixture;
}

function fieldYaml(handle: string, name: string, type: string): string {
	return [`handle: ${handle}`, `name: ${name}`, `type: ${type}`].join('\n');
}

function entryTypeYaml(handle: string, name: string, fields: readonly string[]): string {
	return [
		`handle: ${handle}`,
		`name: ${name}`,
		'fieldLayouts:',
		'  layout:',
		'    tabs:',
		'      - name: Content',
		'        elements:',
		...fields.flatMap((fieldUid) => [
			'          - type: craft\\fieldlayoutelements\\CustomField',
			`            fieldUid: ${fieldUid}`,
		]),
	].join('\n');
}

async function entryLabels(server: TwigServerCore, fixture: Fixture): Promise<string[]> {
	return labelsAt(
		server,
		fixture,
		"{% for entry in craft.entries.section('news').all() %}{{ entry.‸ }}{% endfor %}",
	);
}

function folders(fixture: Fixture): { uri: string; name: string }[] {
	return [{ uri: filePathToUri(fixture.root), name: 'fixture' }];
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), 'twig-toolbox-craft-config-'));
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
