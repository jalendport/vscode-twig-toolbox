import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CompletionItemKind,
	DiagnosticSeverity,
	type Diagnostic,
	type Location,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogRegistry, type DialectPack } from './catalog';
import { TwigServerCore } from './core';
import { DEFAULT_SETTINGS, type TwigToolboxSettings } from './settings';
import { TemplateResolver } from './template-resolver';
import { filePathToUri } from './workspace';

interface Fixture {
	readonly root: string;
	readonly templates: string;
	readonly uri: (relativePath: string) => string;
	readonly write: (relativePath: string, text: string) => string;
	readonly dispose: () => void;
}

afterEach(() => {
	vi.useRealTimers();
});

describe('template navigation', () => {
	it('detects Craft templates roots and completes partials', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write('templates/_partials/card.twig', '<article></article>');
			const server = createServer(fixture);
			const uri = fixture.write('templates/index.twig', '{% include "_partials/‸" %}');
			const document = openMarked(server, uri);

			const items = await server.complete(document.uri, document.position);
			expect(items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						label: 'card.twig',
						kind: CompletionItemKind.File,
					}),
				]),
			);

			const links = await linksFor(
				server,
				fixture.write('templates/page.twig', '{% include "_partials/card.twig" %}'),
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.target).toBe(fixture.uri('templates/_partials/card.twig'));
		} finally {
			fixture.dispose();
		}
	});

	it('honors a CRAFT_TEMPLATES_PATH define in the bootstrap', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'web/index.php',
				"<?php\ndefine('CRAFT_BASE_PATH', dirname(__DIR__));\ndefine('CRAFT_TEMPLATES_PATH', CRAFT_BASE_PATH . '/src/templates');\nrequire CRAFT_BASE_PATH . '/vendor/autoload.php';\n",
			);
			fixture.write('src/templates/_partials/card.twig', '<article></article>');
			const server = createServer(fixture);

			const links = await linksFor(
				server,
				fixture.write('src/templates/page.twig', '{% include "_partials/card.twig" %}'),
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.target).toBe(fixture.uri('src/templates/_partials/card.twig'));
		} finally {
			fixture.dispose();
		}
	});

	it('finds the define through a required bootstrap in a custom location', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'craft',
				"#!/usr/bin/env php\n<?php\nrequire __DIR__ . '/config/craft/bootstrap.php';\n",
			);
			fixture.write(
				'config/craft/bootstrap.php',
				"<?php\ndefine('CRAFT_BASE_PATH', dirname(__DIR__, 2));\ndefine('CRAFT_TEMPLATES_PATH', CRAFT_BASE_PATH . '/src/templates');\n",
			);
			fixture.write('src/templates/card.twig', '<article></article>');
			const server = createServer(fixture);

			const links = await linksFor(
				server,
				fixture.write('src/templates/page.twig', '{% include "card.twig" %}'),
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.target).toBe(fixture.uri('src/templates/card.twig'));
		} finally {
			fixture.dispose();
		}
	});

	it('reads the define from index.php under a public web root', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'public/index.php',
				"<?php\ndefine('CRAFT_TEMPLATES_PATH', dirname(__DIR__) . '/src/templates');\n",
			);
			fixture.write('src/templates/card.twig', '<article></article>');
			const server = createServer(fixture);

			const links = await linksFor(
				server,
				fixture.write('src/templates/page.twig', '{% include "card.twig" %}'),
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.target).toBe(fixture.uri('src/templates/card.twig'));
		} finally {
			fixture.dispose();
		}
	});

	it('honors dirname(__DIR__) and literal define forms', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'web/index.php',
				"<?php\ndefine('CRAFT_TEMPLATES_PATH', dirname(__DIR__) . '/resources/views');\n",
			);
			fixture.write('resources/views/card.twig', '<article></article>');
			const server = createServer(fixture);

			const links = await linksFor(
				server,
				fixture.write('resources/views/page.twig', '{% include "card.twig" %}'),
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.target).toBe(fixture.uri('resources/views/card.twig'));
		} finally {
			fixture.dispose();
		}
	});

	it('falls back to templates/ when the define names a missing directory', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'bootstrap.php',
				"<?php\ndefine('CRAFT_TEMPLATES_PATH', CRAFT_BASE_PATH . '/nowhere');\n",
			);
			fixture.write('templates/card.twig', '<article></article>');
			const server = createServer(fixture);

			const links = await linksFor(
				server,
				fixture.write('templates/page.twig', '{% include "card.twig" %}'),
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.target).toBe(fixture.uri('templates/card.twig'));
		} finally {
			fixture.dispose();
		}
	});

	it('resolves extensionless extends and jumps from child blocks to parent blocks', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'templates/_layout.twig',
				'<main>{% block content %}{% endblock %}</main>',
			);
			const server = createServer(fixture);
			const uri = fixture.write(
				'templates/child.twig',
				'{% extends "_layout" %}{% block cont‸ent %}{% endblock %}',
			);
			const document = openMarked(server, uri);

			const labels = (await server.complete(document.uri, document.position)).map(
				(item) => item.label,
			);
			expect(labels).toContain('content');

			const definition = (await server.definition(
				document.uri,
				document.position,
			)) as Location[];
			expect(definition[0]?.uri).toBe(fixture.uri('templates/_layout.twig'));
			expect(definition[0]?.range.start).toEqual({ line: 0, character: 6 });
		} finally {
			fixture.dispose();
		}
	});

	it('uses real signatures and definitions for imported macros', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'templates/macros.twig',
				'{% macro button(label, url = \'#\') %}<a href="{{ url }}">{{ label }}</a>{% endmacro %}',
			);
			const server = createServer(fixture);
			const uri = fixture.write(
				'templates/index.twig',
				'{% from "macros" import button %}{{ but‸ton("Read") }}',
			);
			const document = openMarked(server, uri);

			const hover = await server.hover(document.uri, document.position);
			expect(hoverText(hover)).toContain("button(label, url = '#')");

			const definition = (await server.definition(
				document.uri,
				document.position,
			)) as Location[];
			expect(definition[0]?.uri).toBe(fixture.uri('templates/macros.twig'));
			expect(definition[0]?.range.start).toEqual({ line: 0, character: 0 });

			const signature = await server.signatureHelp(
				document.uri,
				document.document.positionAt(document.document.getText().indexOf('"Read"')),
			);
			expect(signature?.signatures[0]?.label).toBe("button(label, url = '#')");
		} finally {
			fixture.dispose();
		}
	});

	it('resolves the alias in a {% from %} import to the original macro', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'templates/macros.twig',
				'{% macro button(label) %}<a>{{ label }}</a>{% endmacro %}',
			);
			const server = createServer(fixture);
			const uri = fixture.write(
				'templates/index.twig',
				'{% from "macros" import button as b‸tn %}',
			);
			const document = openMarked(server, uri);

			const definition = (await server.definition(
				document.uri,
				document.position,
			)) as Location[];
			expect(definition[0]?.uri).toBe(fixture.uri('templates/macros.twig'));
			expect(definition[0]?.range.start).toEqual({ line: 0, character: 0 });
		} finally {
			fixture.dispose();
		}
	});

	it('resolves a {% from _self import %} to the macro in the same document', async () => {
		const fixture = createCraftFixture();
		try {
			const server = createServer(fixture);
			const uri = fixture.write(
				'templates/index.twig',
				'{% macro button(label) %}<a>{{ label }}</a>{% endmacro %}' +
					'{% from _self import bu‸tton %}',
			);
			const document = openMarked(server, uri);

			const definition = (await server.definition(
				document.uri,
				document.position,
			)) as Location[];
			expect(definition[0]?.uri).toBe(uri);
			expect(definition[0]?.range.start).toEqual({ line: 0, character: 0 });
		} finally {
			fixture.dispose();
		}
	});

	it('updates parent block completions after the parent template changes', async () => {
		const fixture = createCraftFixture();
		try {
			const parentUri = fixture.write(
				'templates/_layout.twig',
				'{% block content %}{% endblock %}',
			);
			const server = createServer(fixture);
			server.openDocument(
				TextDocument.create(parentUri, 'twig', 1, '{% block content %}{% endblock %}'),
			);
			const childUri = fixture.write(
				'templates/child.twig',
				'{% extends "_layout" %}{% block ‸ %}{% endblock %}',
			);
			const child = openMarked(server, childUri);

			expect(
				(await server.complete(child.uri, child.position)).map((item) => item.label),
			).not.toContain('sidebar');

			const updatedParent =
				'{% block content %}{% endblock %}{% block sidebar %}{% endblock %}';
			writeFileSync(join(fixture.templates, '_layout.twig'), updatedParent);
			server.updateDocument(TextDocument.create(parentUri, 'twig', 2, updatedParent));

			expect(
				(await server.complete(child.uri, child.position)).map((item) => item.label),
			).toContain('sidebar');
		} finally {
			fixture.dispose();
		}
	});

	it('does not create diagnostics or links for dynamic include calls', async () => {
		const fixture = createCraftFixture();
		try {
			const published = createPublishedDiagnostics();
			const server = createServer(fixture, { published });
			const uri = fixture.write('templates/index.twig', '{{ include(someVar) }}');
			server.openDocument(TextDocument.create(uri, 'twig', 1, '{{ include(someVar) }}'));

			await vi.waitFor(() => expect(published.current(uri)).toEqual([]));
			expect(await server.documentLinks(uri)).toEqual([]);
		} finally {
			fixture.dispose();
		}
	});

	it('falls back to a bare workspace root when no templates directory exists', () => {
		const fixture = createBareFixture();
		try {
			fixture.write('plain.twig', 'Plain');
			const resolver = new TemplateResolver([
				{ uri: filePathToUri(fixture.root), name: 'bare' },
			]);
			expect(
				resolver.resolve(fixture.uri('index.twig'), 'plain', DEFAULT_SETTINGS)[0]?.uri,
			).toBe(fixture.uri('plain.twig'));
		} finally {
			fixture.dispose();
		}
	});

	it('resolves a variable set in the including template', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'templates/index.twig',
				'{% set heading = entry.title %}{% include "_partials/card" %}',
			);
			const server = createServer(fixture);
			const uri = fixture.write('templates/_partials/card.twig', '<h1>{{ head‸ing }}</h1>');
			const card = openMarked(server, uri);

			const definition = (await server.definition(card.uri, card.position)) as Location[];
			expect(definition).toHaveLength(1);
			expect(definition[0]?.uri).toBe(fixture.uri('templates/index.twig'));
			expect(definition[0]?.range.start).toEqual({ line: 0, character: 0 });

			const hover = await server.hover(card.uri, card.position);
			expect(hoverText(hover)).toContain('heading = entry.title');
			expect(hoverText(hover)).toContain('index');
		} finally {
			fixture.dispose();
		}
	});

	it('walks context transitively through a chain of includes', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write('templates/a.twig', '{% set banner = "hello" %}{% include "b" %}');
			fixture.write('templates/b.twig', '{% include "c" %}');
			const server = createServer(fixture);
			const uri = fixture.write('templates/c.twig', '{{ ban‸ner }}');
			const c = openMarked(server, uri);

			const definition = (await server.definition(c.uri, c.position)) as Location[];
			expect(definition).toHaveLength(1);
			expect(definition[0]?.uri).toBe(fixture.uri('templates/a.twig'));
		} finally {
			fixture.dispose();
		}
	});

	it('stops at `only`, which replaces the context wholesale', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write('templates/index.twig', '{% set heading = "hi" %}{% include "b" only %}');
			const server = createServer(fixture);
			const uri = fixture.write('templates/b.twig', '{{ head‸ing }}');
			const b = openMarked(server, uri);

			expect(await server.definition(b.uri, b.position)).toEqual([]);
			expect(await server.hover(b.uri, b.position)).toBeUndefined();
		} finally {
			fixture.dispose();
		}
	});

	it('treats a `with` key as the definition site', async () => {
		const fixture = createCraftFixture();
		try {
			const includerUri = fixture.write(
				'templates/index.twig',
				'{% include "b" with { heading: entry.title } only %}',
			);
			const server = createServer(fixture);
			const uri = fixture.write('templates/b.twig', '{{ head‸ing }}');
			const b = openMarked(server, uri);

			const definition = (await server.definition(b.uri, b.position)) as Location[];
			expect(definition).toHaveLength(1);
			expect(definition[0]?.uri).toBe(includerUri);
			expect(definition[0]?.range.start).toEqual({ line: 0, character: 22 });

			expect(hoverText(await server.hover(b.uri, b.position))).toContain(
				'heading = entry.title',
			);
		} finally {
			fixture.dispose();
		}
	});

	it('resolves a variable through an include function call', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'templates/index.twig',
				'{% set heading = entry.title %}{{ include("_partials/card") }}',
			);
			const server = createServer(fixture);
			const uri = fixture.write('templates/_partials/card.twig', '<h1>{{ head‸ing }}</h1>');
			const card = openMarked(server, uri);

			const definition = (await server.definition(card.uri, card.position)) as Location[];
			expect(definition).toHaveLength(1);
			expect(definition[0]?.uri).toBe(fixture.uri('templates/index.twig'));
			expect(definition[0]?.range.start).toEqual({ line: 0, character: 0 });

			const hover = await server.hover(card.uri, card.position);
			expect(hoverText(hover)).toContain('heading = entry.title');
			expect(hoverText(hover)).toContain('index');
		} finally {
			fixture.dispose();
		}
	});

	it('treats an include function variables key as the definition site', async () => {
		const fixture = createCraftFixture();
		try {
			const includerUri = fixture.write(
				'templates/index.twig',
				'{{ include("b", variables = { heading: entry.title }) }}',
			);
			const server = createServer(fixture);
			const uri = fixture.write('templates/b.twig', '{{ head‸ing }}');
			const b = openMarked(server, uri);

			const definition = (await server.definition(b.uri, b.position)) as Location[];
			expect(definition).toHaveLength(1);
			expect(definition[0]?.uri).toBe(includerUri);

			expect(hoverText(await server.hover(b.uri, b.position))).toContain(
				'heading = entry.title',
			);
		} finally {
			fixture.dispose();
		}
	});

	it('treats include function with_context false like only', async () => {
		const fixture = createCraftFixture();
		try {
			const includerUri = fixture.write(
				'templates/index.twig',
				'{% set heading = "hi" %}{{ include("b", { badge: "New" }, false) }}',
			);
			const server = createServer(fixture);
			const headingUri = fixture.write('templates/b.twig', '{{ head‸ing }}');
			const heading = openMarked(server, headingUri);

			expect(await server.definition(heading.uri, heading.position)).toEqual([]);
			expect(await server.hover(heading.uri, heading.position)).toBeUndefined();

			const badgeUri = fixture.write('templates/b.twig', '{{ bad‸ge }}');
			const badge = openMarked(server, badgeUri);
			const definition = (await server.definition(badge.uri, badge.position)) as Location[];
			expect(definition).toHaveLength(1);
			expect(definition[0]?.uri).toBe(includerUri);
			expect(hoverText(await server.hover(badge.uri, badge.position))).toContain(
				'badge = "New"',
			);
		} finally {
			fixture.dispose();
		}
	});

	it('treats named include function with_context false like only', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'templates/index.twig',
				'{% set heading = "hi" %}{{ include("b", with_context = false) }}',
			);
			const server = createServer(fixture);
			const uri = fixture.write('templates/b.twig', '{{ head‸ing }}');
			const b = openMarked(server, uri);

			expect(await server.definition(b.uri, b.position)).toEqual([]);
			expect(await server.hover(b.uri, b.position)).toBeUndefined();
		} finally {
			fixture.dispose();
		}
	});

	it('does not inherit through dynamic include function targets', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'templates/index.twig',
				'{% set heading = "hi" %}{{ include(templateName) }}',
			);
			const server = createServer(fixture);
			const uri = fixture.write('templates/b.twig', '{{ head‸ing }}');
			const b = openMarked(server, uri);

			expect(await server.definition(b.uri, b.position)).toEqual([]);
			expect(await server.hover(b.uri, b.position)).toBeUndefined();
		} finally {
			fixture.dispose();
		}
	});

	it('resolves include function array candidates', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write(
				'templates/index.twig',
				'{% set heading = "hi" %}{{ include(["b", dynamicTemplate, "c"]) }}',
			);
			fixture.write('templates/b.twig', '{{ head‸ing }}');
			fixture.write('templates/c.twig', '{{ head‸ing }}');
			const server = createServer(fixture);

			for (const template of ['b', 'c']) {
				const uri = fixture.uri(`templates/${template}.twig`);
				const included = openMarked(server, uri);
				const definition = (await server.definition(
					included.uri,
					included.position,
				)) as Location[];
				expect(definition).toHaveLength(1);
				expect(definition[0]?.uri).toBe(fixture.uri('templates/index.twig'));
			}
		} finally {
			fixture.dispose();
		}
	});

	it('returns every includer that defines the name', async () => {
		const fixture = createCraftFixture();
		try {
			fixture.write('templates/one.twig', '{% set heading = "one" %}{% include "b" %}');
			fixture.write('templates/two.twig', '{% set heading = "two" %}{% include "b" %}');
			const server = createServer(fixture);
			const uri = fixture.write('templates/b.twig', '{{ head‸ing }}');
			const b = openMarked(server, uri);

			const definition = (await server.definition(b.uri, b.position)) as Location[];
			expect(definition.map((location) => location.uri).sort()).toEqual(
				[fixture.uri('templates/one.twig'), fixture.uri('templates/two.twig')].sort(),
			);
		} finally {
			fixture.dispose();
		}
	});

	it('picks up an edit to the including template', async () => {
		const fixture = createCraftFixture();
		try {
			const includerUri = fixture.write('templates/index.twig', '{% include "b" %}');
			const server = createServer(fixture);
			server.openDocument(TextDocument.create(includerUri, 'twig', 1, '{% include "b" %}'));
			const uri = fixture.write('templates/b.twig', '{{ head‸ing }}');
			const b = openMarked(server, uri);

			expect(await server.definition(b.uri, b.position)).toEqual([]);

			const updated = '{% set heading = "hi" %}{% include "b" %}';
			writeFileSync(join(fixture.templates, 'index.twig'), updated);
			server.updateDocument(TextDocument.create(includerUri, 'twig', 2, updated));

			const definition = (await server.definition(b.uri, b.position)) as Location[];
			expect(definition).toHaveLength(1);
			expect(definition[0]?.uri).toBe(includerUri);
		} finally {
			fixture.dispose();
		}
	});

	it('resolves inherited variables in a bare, non-Craft workspace', async () => {
		const fixture = createBareFixture();
		try {
			fixture.write('a.twig', '{% for item in items %}{% include "b" %}{% endfor %}');
			const server = createServer(fixture);
			const uri = fixture.write('b.twig', '{{ it‸em }}');
			const b = openMarked(server, uri);

			const definition = (await server.definition(b.uri, b.position)) as Location[];
			expect(definition).toHaveLength(1);
			expect(definition[0]?.uri).toBe(fixture.uri('a.twig'));
			expect(hoverText(await server.hover(b.uri, b.position))).toContain('for … in items');
		} finally {
			fixture.dispose();
		}
	});

	it('reports missing static templates only when unknown names are enabled', async () => {
		const fixture = createCraftFixture();
		try {
			const published = createPublishedDiagnostics();
			const settings: TwigToolboxSettings = {
				...DEFAULT_SETTINGS,
				diagnostics: { unknownNames: 'hint', ignoredNames: [] },
			};
			const server = createServer(fixture, { published, settings });
			const uri = fixture.write('templates/index.twig', '{% include "missing" %}');
			server.openDocument(TextDocument.create(uri, 'twig', 1, '{% include "missing" %}'));

			await vi.waitFor(() =>
				expect(published.current(uri)).toEqual([
					expect.objectContaining({
						code: 'template-not-found',
						severity: DiagnosticSeverity.Hint,
					}),
				]),
			);
		} finally {
			fixture.dispose();
		}
	});
});

function createServer(
	fixture: Fixture,
	options: {
		readonly settings?: TwigToolboxSettings;
		readonly published?: ReturnType<typeof createPublishedDiagnostics>;
	} = {},
): TwigServerCore {
	const published = options.published ?? createPublishedDiagnostics();
	return new TwigServerCore({
		catalogRegistry: CatalogRegistry.fromPacks([corePack]),
		getSettings: () => Promise.resolve(options.settings ?? DEFAULT_SETTINGS),
		publishDiagnostics: published.publish,
		templateResolver: new TemplateResolver([
			{ uri: filePathToUri(fixture.root), name: 'fixture' },
		]),
		parseDelayMs: 1,
	});
}

function createCraftFixture(): Fixture {
	const fixture = createFixture();
	fixture.write('composer.json', JSON.stringify({ require: { 'craftcms/cms': '^5.0' } }));
	mkdirSync(fixture.templates, { recursive: true });
	mkdirSync(join(fixture.templates, '_partials'), { recursive: true });
	return fixture;
}

function createBareFixture(): Fixture {
	return createFixture();
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), 'twig-toolbox-'));
	const templates = join(root, 'templates');
	const write = (relativePath: string, text: string): string => {
		const path = join(root, relativePath);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, text);
		return filePathToUri(path);
	};
	return {
		root,
		templates,
		uri: (relativePath) => filePathToUri(join(root, relativePath)),
		write,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function openMarked(
	server: TwigServerCore,
	uri: string,
): {
	readonly uri: string;
	readonly document: TextDocument;
	readonly position: { line: number; character: number };
} {
	const source = readFixtureText(uri);
	const offset = source.indexOf('‸');
	if (offset === -1) {
		throw new Error(`fixture has no marker: ${uri}`);
	}
	const clean = source.slice(0, offset) + source.slice(offset + 1);
	const document = TextDocument.create(uri, 'twig', 1, clean);
	server.openDocument(document);
	return { uri, document, position: document.positionAt(offset) };
}

function readFixtureText(uri: string): string {
	const path = decodeURIComponent(uri.replace(/^file:\/\//, ''));
	return readFileSync(path, 'utf8');
}

async function linksFor(server: TwigServerCore, uri: string) {
	server.openDocument(TextDocument.create(uri, 'twig', 1, readFixtureText(uri)));
	return server.documentLinks(uri);
}

function createPublishedDiagnostics(): {
	readonly publish: (uri: string, diagnostics: Diagnostic[]) => void;
	readonly current: (uri: string) => Diagnostic[];
} {
	const byUri = new Map<string, Diagnostic[]>();
	return {
		publish(uri, diagnostics) {
			byUri.set(uri, diagnostics);
		},
		current(uri) {
			return byUri.get(uri) ?? [];
		},
	};
}

function hoverText(hover: Awaited<ReturnType<TwigServerCore['hover']>>): string {
	const contents = hover?.contents;
	if (typeof contents === 'string') {
		return contents;
	}
	return Array.isArray(contents) || contents === undefined ? '' : contents.value;
}

const corePack: DialectPack = {
	schemaVersion: 1,
	name: 'twig-core',
	displayName: 'Twig',
	version: '1.0.0',
	sources: {
		twig: { repository: 'twig/twig', ref: 'v3.22.0' },
		docs: { repository: 'twigphp/Twig-Doc', ref: '3.x' },
	},
	detect: { kind: 'always' },
	entries: {
		tags: ['include', 'extends', 'block', 'from'].map(entry),
		filters: [],
		functions: ['include', 'block', 'parent'].map(entry),
		tests: [],
		globals: [],
	},
};

function entry(name: string) {
	return {
		name,
		signature: name,
		parameters: [],
		description: `${name} entry`,
		docsUrl: `https://twig.symfony.com/doc/3.x/${name}.html`,
		completionSnippet: name,
	};
}
