import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogRegistry, type DialectPack } from './catalog';
import { TwigServerCore } from './core';
import { DEFAULT_SETTINGS, type TwigToolboxSettings } from './settings';

const corePack = createPack('twig-core', 'Twig', { kind: 'always' });

afterEach(() => {
	vi.useRealTimers();
});

describe('TwigServerCore diagnostics', () => {
	it('publishes syntax diagnostics with visible opening-tag ranges', async () => {
		const published = createPublishedDiagnostics();
		const server = createServer(published);
		const document = createDocument('{% if foo %}');

		server.openDocument(document);
		await vi.waitFor(() => expect(published.current()).toHaveLength(1));

		expect(published.current()[0]).toMatchObject({
			code: 'missing-end-tag',
			severity: DiagnosticSeverity.Error,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 12 },
			},
		});
	});

	it('publishes one primary diagnostic for a malformed expression', async () => {
		const published = createPublishedDiagnostics();
		const server = createServer(published);

		server.openDocument(createDocument('{{ user. }}'));
		await vi.waitFor(() => expect(published.current()).toHaveLength(1));

		expect(published.current().map((diagnostic) => diagnostic.code)).toEqual([
			'missing-property',
		]);
	});

	it('keeps unknown-name diagnostics off by default', async () => {
		const published = createPublishedDiagnostics();
		const server = createServer(published);

		server.openDocument(createDocument('{{ x|umarkdown }}{% paginate query as pageInfo %}'));
		await vi.waitFor(() => expect(published.current()).toEqual([]));
	});

	it('updates unknown-name diagnostics when settings change', async () => {
		const published = createPublishedDiagnostics();
		let settings: TwigToolboxSettings = {
			templateRoots: [],
			diagnostics: {
				unknownNames: 'warning',
				ignoredNames: [],
			},
		};
		const server = createServer(published, {
			getSettings: () => Promise.resolve(settings),
		});

		const document = createDocument('{{ x|umarkdown }}');
		server.openDocument(document);
		await vi.waitFor(() => expect(published.current()).toHaveLength(1));
		expect(published.current()[0]).toMatchObject({
			code: 'unknown-filter',
			severity: DiagnosticSeverity.Warning,
		});

		settings = {
			templateRoots: [],
			diagnostics: {
				unknownNames: 'warning',
				ignoredNames: ['umarkdown'],
			},
		};
		await server.refreshAllDiagnostics();

		expect(published.current()).toEqual([]);
	});

	it('debounces change diagnostics and reparses stale documents on demand', async () => {
		vi.useFakeTimers();
		const published = createPublishedDiagnostics();
		const server = createServer(published, { parseDelayMs: 200 });
		const uri = 'file:///project/templates/index.twig';

		server.openDocument(createDocument('{% if foo %}{% endif %}', 1, uri));
		expect(published.current()).toEqual([]);

		server.updateDocument(createDocument('{% if foo %}', 2, uri));
		expect(published.current()).toEqual([]);

		const parsed = server.getParsedDocument(uri);
		expect(parsed?.version).toBe(2);
		expect(parsed?.result.errors.map((error) => error.code)).toEqual(['missing-end-tag']);
		await vi.waitFor(() => expect(published.current()).toHaveLength(1));

		server.updateDocument(createDocument('{% if foo %}{% endif %}', 3, uri));
		expect(published.current()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(199);
		expect(published.current()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		await vi.waitFor(() => expect(published.current()).toEqual([]));
	});

	it('drops a stale parse’s diagnostics once a newer edit already published its own', async () => {
		const uri = 'file:///project/templates/index.twig';
		const byUri = new Map<string, Diagnostic[]>();
		let publishCount = 0;
		const published = {
			publish: (publishUri: string, diagnostics: Diagnostic[]) => {
				publishCount += 1;
				byUri.set(publishUri, diagnostics);
			},
			current: () => byUri.get(uri) ?? [],
		};

		let resolveSettings: (() => void) | undefined;
		const settingsGate = new Promise<void>((resolve) => {
			resolveSettings = resolve;
		});
		let settingsCalls = 0;
		const server = createServer(published, {
			parseDelayMs: 5,
			getSettings: async () => {
				settingsCalls += 1;
				if (settingsCalls === 1) {
					await settingsGate;
				}
				return DEFAULT_SETTINGS;
			},
		});

		// Version 1's diagnostics publish is now stuck awaiting settings.
		server.openDocument(createDocument('{% if foo %}', 1, uri));
		expect(published.current()).toEqual([]);

		// A second, newer edit lands. Its own debounced parse does not share
		// version 1's stuck settings lookup, so it publishes first.
		server.updateDocument(createDocument('{{ user. }}', 2, uri));
		await vi.waitFor(() =>
			expect(published.current().map((diagnostic) => diagnostic.code)).toEqual([
				'missing-property',
			]),
		);
		expect(publishCount).toBe(1);

		// Version 1's settings lookup finally resolves. Its diagnostics describe
		// a document nobody can see anymore, so this must not clobber version 2's.
		resolveSettings?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(publishCount).toBe(1);
		expect(published.current().map((diagnostic) => diagnostic.code)).toEqual([
			'missing-property',
		]);
	});
});

describe('space-triggered completions', () => {
	it('answers a space typed right after an opening delimiter', async () => {
		const server = createServer(createPublishedDiagnostics());
		const document = createDocument('{{ }}');
		server.openDocument(document);

		const afterOutput = await server.complete(document.uri, { line: 0, character: 3 }, ' ');
		expect(afterOutput.length).toBeGreaterThan(0);

		const tagDocument = createDocument('{% %}', 1, 'file:///project/templates/tag.twig');
		server.openDocument(tagDocument);
		const afterTag = await server.complete(tagDocument.uri, { line: 0, character: 3 }, ' ');
		expect(afterTag.length).toBeGreaterThan(0);
	});

	it('stays silent for a space anywhere else', async () => {
		const server = createServer(createPublishedDiagnostics());
		const document = createDocument('<p>hello {{ user }}</p>');
		server.openDocument(document);

		// In HTML prose.
		expect(await server.complete(document.uri, { line: 0, character: 9 }, ' ')).toEqual([]);
		// Mid-expression, after an identifier.
		expect(await server.complete(document.uri, { line: 0, character: 17 }, ' ')).toEqual([]);
	});

	it('leaves other triggers and manual invokes ungated', async () => {
		const server = createServer(createPublishedDiagnostics());
		const document = createDocument('{{ }}');
		server.openDocument(document);

		const manual = await server.complete(document.uri, { line: 0, character: 3 });
		expect(manual.length).toBeGreaterThan(0);
	});
});

function createServer(
	published: ReturnType<typeof createPublishedDiagnostics>,
	options: {
		getSettings?: (uri: string) => Promise<TwigToolboxSettings>;
		parseDelayMs?: number;
	} = {},
): TwigServerCore {
	const serverOptions: ConstructorParameters<typeof TwigServerCore>[0] = {
		catalogRegistry: CatalogRegistry.fromPacks([corePack]),
		getSettings: options.getSettings ?? (() => Promise.resolve(DEFAULT_SETTINGS)),
		publishDiagnostics: published.publish,
		...(options.parseDelayMs === undefined ? {} : { parseDelayMs: options.parseDelayMs }),
	};
	return new TwigServerCore(serverOptions);
}

function createPublishedDiagnostics(): {
	publish: (uri: string, diagnostics: Diagnostic[]) => void;
	current: () => Diagnostic[];
} {
	const byUri = new Map<string, Diagnostic[]>();
	return {
		publish(uri, diagnostics) {
			byUri.set(uri, diagnostics);
		},
		current() {
			return byUri.get('file:///project/templates/index.twig') ?? [];
		},
	};
}

function createDocument(
	text: string,
	version = 1,
	uri = 'file:///project/templates/index.twig',
): TextDocument {
	return TextDocument.create(uri, 'twig', version, text);
}

function createPack(name: string, displayName: string, detect: DialectPack['detect']): DialectPack {
	const entry = (entryName: string) => ({
		name: entryName,
		signature: entryName,
		parameters: [],
		description: `${entryName} entry`,
		docsUrl: `https://twig.symfony.com/doc/3.x/${entryName}.html`,
		completionSnippet: entryName,
	});

	return {
		schemaVersion: 1,
		name,
		displayName,
		version: '1.0.0',
		sources: {
			twig: { repository: 'twig/twig', ref: 'v3.22.0' },
			docs: { repository: 'twigphp/Twig-Doc', ref: '3.x' },
		},
		detect,
		entries: {
			tags: ['if', 'for', 'set'].map(entry),
			filters: ['escape', 'upper'].map(entry),
			functions: ['include', 'path'].map(entry),
			tests: ['defined', 'same as'].map(entry),
			globals: [],
		},
	};
}
