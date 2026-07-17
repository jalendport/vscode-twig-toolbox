import {
	createConnection,
	DidChangeConfigurationNotification,
	DidChangeWatchedFilesNotification,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
	type InitializeParams,
	type InitializeResult,
	type Position,
	type TextDocumentIdentifier,
	type WorkspaceFolder,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TWIG_VERSION } from '@twig-toolbox/parser';
import { CatalogRegistry } from './catalog';
import { TwigServerCore } from './core';
import { createCraftMemberProvider } from './craft-members';
import { CraftProjectConfigResolver } from './craft-project-config';
import { BUILTIN_MEMBER_PROVIDERS } from './members';
import { ProjectContextResolver } from './project-context';
import { DEFAULT_SETTINGS, normalizeSettings, type TwigToolboxSettings } from './settings';
import { createWorkspaceContextResolver } from './workspace';
import { TemplateResolver } from './template-resolver';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let catalogRegistry = CatalogRegistry.fromPacks([]);
let workspaceFolders: WorkspaceFolder[] = [];
let hasConfigurationCapability = false;
let hasWatchedFilesCapability = false;
let settingsCache = new Map<string, TwigToolboxSettings>();
let server: TwigServerCore | undefined;

connection.onInitialize((params: InitializeParams): InitializeResult => {
	const client = params.clientInfo?.name ?? 'unknown client';
	hasConfigurationCapability = params.capabilities.workspace?.configuration === true;
	hasWatchedFilesCapability =
		params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
	workspaceFolders = params.workspaceFolders ?? [];
	catalogRegistry = CatalogRegistry.loadDefault();
	// One detector behind all three: pack activation, template roots, and the
	// project introspection milestone 10 hangs off the same context.
	const projects = new ProjectContextResolver(workspaceFolders);
	const craftProjectConfig = new CraftProjectConfigResolver(projects, (message) => {
		connection.console.info(message);
	});
	const workspaceContextResolver = createWorkspaceContextResolver(projects);
	const templateResolver = new TemplateResolver(workspaceFolders, projects);
	server = new TwigServerCore({
		catalogRegistry,
		getSettings,
		publishDiagnostics: (uri, diagnostics) => {
			void connection.sendDiagnostics({ uri, diagnostics });
		},
		resolveWorkspaceContext: (uri) => workspaceContextResolver.resolve(uri),
		templateResolver,
		craftProjectConfig,
		memberProviders: [
			...BUILTIN_MEMBER_PROVIDERS,
			createCraftMemberProvider(catalogRegistry, craftProjectConfig),
		],
	});

	connection.console.info(`Twig Toolbox language server starting (client: ${client})`);
	connection.console.info(`Twig dialect: ${TWIG_VERSION}`);
	connection.console.info(`Loaded ${catalogRegistry.packs.length} dialect catalog pack(s)`);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				// `{` and `%` catch a region being opened, `<` and `/` an HTML
				// tag, `:` a CSS declaration, the rest a slot being created.
				// Space is registered but answered only immediately after an
				// opening delimiter (`{{ `, `{% `) — the house style puts a
				// space inside the braces, and without this the popup `{{`
				// opened dies the moment the space lands. Everywhere else a
				// space-triggered request returns nothing before any provider
				// runs.
				triggerCharacters: ['{', '%', '|', '.', '"', "'", '<', '/', ':', '&', ' '],
				resolveProvider: false,
			},
			hoverProvider: true,
			definitionProvider: true,
			documentLinkProvider: {
				resolveProvider: false,
			},
			documentHighlightProvider: true,
			signatureHelpProvider: {
				triggerCharacters: ['(', ','],
			},
		},
		serverInfo: {
			name: 'Twig Toolbox Language Server',
			version: '1.0.0',
		},
	};
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		void connection.client.register(DidChangeConfigurationNotification.type);
	}
	if (hasWatchedFilesCapability) {
		void connection.client.register(DidChangeWatchedFilesNotification.type, {
			watchers: [
				{ globPattern: '**/*.twig' },
				{ globPattern: '**/*.html.twig' },
				{ globPattern: '**/composer.json' },
				{ globPattern: '**/composer.lock' },
				{ globPattern: '**/.env' },
				{ globPattern: '**/config/project/**/*.yaml' },
				{ globPattern: '**/config/project/**/*.yml' },
			],
		});
	}
	connection.console.info('Twig Toolbox language server ready');
});

documents.onDidOpen(({ document }) => {
	connection.console.info(`Opened ${document.uri} (${document.lineCount} lines)`);
	server?.openDocument(document);
});

documents.onDidChangeContent(({ document }) => {
	server?.updateDocument(document);
});

documents.onDidClose(({ document }) => {
	connection.console.info(`Closed ${document.uri}`);
	server?.closeDocument(document.uri);
	settingsCache.delete(document.uri);
});

connection.onCompletion(
	({ textDocument, position, context }) =>
		server?.complete(textDocument.uri, position, context?.triggerCharacter) ?? [],
);

connection.onHover(({ textDocument, position }) => server?.hover(textDocument.uri, position));

connection.onDefinition(({ textDocument, position }) =>
	server?.definition(textDocument.uri, position),
);

connection.onDocumentLinks(({ textDocument }) => server?.documentLinks(textDocument.uri) ?? []);

connection.onDocumentHighlight(
	({ textDocument, position }) => server?.documentHighlights(textDocument.uri, position) ?? [],
);

/**
 * `html/tag` — the same custom request VS Code's built-in HTML support uses.
 *
 * Auto-closing a tag is an edit the user did not ask for by name, so it cannot
 * come back as a completion item; the client watches for the trigger character
 * and applies whatever this returns as a snippet.
 */
connection.onRequest(
	'html/tag',
	(params: { textDocument: TextDocumentIdentifier; position: Position; trigger: string }) =>
		server?.tagCompletion(params.textDocument.uri, params.position, params.trigger) ?? null,
);

/**
 * `twig/autoCloseBrace` — the same shape as `html/tag`, for Twig's own brackets.
 *
 * `{` and `[` cannot be closed by the language config: whether they owe a closer
 * depends on the region the cursor is in, which only a parse knows. See
 * `getBraceCompletion` for the rules and for the stacking bug they prevent.
 */
connection.onRequest(
	'twig/autoCloseBrace',
	(params: { textDocument: TextDocumentIdentifier; position: Position; trigger: string }) =>
		server?.braceCompletion(params.textDocument.uri, params.position, params.trigger) ?? null,
);

connection.onSignatureHelp(({ textDocument, position }) =>
	server?.signatureHelp(textDocument.uri, position),
);

connection.onDidChangeConfiguration(() => {
	settingsCache = new Map();
	void server?.refreshAllDiagnostics();
});

connection.onDidChangeWatchedFiles(({ changes }) => {
	for (const change of changes) {
		server?.invalidateFile(change.uri);
	}
	void server?.refreshAllDiagnostics();
});

documents.listen(connection);
connection.listen();

async function getSettings(uri: string): Promise<TwigToolboxSettings> {
	if (!hasConfigurationCapability) {
		return DEFAULT_SETTINGS;
	}

	const cached = settingsCache.get(uri);
	if (cached !== undefined) {
		return cached;
	}

	const rawSettings: unknown = await connection.workspace.getConfiguration({
		scopeUri: uri,
		section: 'twigToolbox',
	});
	const settings = normalizeSettings(rawSettings);
	settingsCache.set(uri, settings);
	return settings;
}
