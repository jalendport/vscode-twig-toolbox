import {
	createConnection,
	DidChangeConfigurationNotification,
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
import { DEFAULT_SETTINGS, normalizeSettings, type TwigToolboxSettings } from './settings';
import { createWorkspaceContextResolver } from './workspace';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let catalogRegistry = CatalogRegistry.fromPacks([]);
let workspaceFolders: WorkspaceFolder[] = [];
let hasConfigurationCapability = false;
let settingsCache = new Map<string, TwigToolboxSettings>();
let server: TwigServerCore | undefined;

connection.onInitialize((params: InitializeParams): InitializeResult => {
	const client = params.clientInfo?.name ?? 'unknown client';
	hasConfigurationCapability = params.capabilities.workspace?.configuration === true;
	workspaceFolders = params.workspaceFolders ?? [];
	catalogRegistry = CatalogRegistry.loadDefault();
	const workspaceContextResolver = createWorkspaceContextResolver(workspaceFolders);
	server = new TwigServerCore({
		catalogRegistry,
		getSettings,
		publishDiagnostics: (uri, diagnostics) => {
			void connection.sendDiagnostics({ uri, diagnostics });
		},
		resolveWorkspaceContext: (uri) => workspaceContextResolver.resolve(uri),
	});

	connection.console.info(`Twig Toolbox language server starting (client: ${client})`);
	connection.console.info(`Twig dialect: ${TWIG_VERSION}`);
	connection.console.info(`Loaded ${catalogRegistry.packs.length} dialect catalog pack(s)`);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				// Space is deliberately absent: it would fire on every word of
				// every HTML attribute. `{` and `%` catch a region being
				// opened, `<` and `/` an HTML tag, `:` a CSS declaration, the
				// rest a slot being created.
				triggerCharacters: ['{', '%', '|', '.', '"', "'", '<', '/', ':', '&'],
				resolveProvider: false,
			},
			hoverProvider: true,
			documentHighlightProvider: true,
			signatureHelpProvider: {
				triggerCharacters: ['(', ','],
			},
		},
		serverInfo: {
			name: 'Twig Toolbox Language Server',
			version: '0.1.0',
		},
	};
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		void connection.client.register(DidChangeConfigurationNotification.type);
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
	({ textDocument, position }) => server?.complete(textDocument.uri, position) ?? [],
);

connection.onHover(({ textDocument, position }) => server?.hover(textDocument.uri, position));

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

connection.onSignatureHelp(({ textDocument, position }) =>
	server?.signatureHelp(textDocument.uri, position),
);

connection.onDidChangeConfiguration(() => {
	settingsCache = new Map();
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
		section: 'twigToolbox.diagnostics',
	});
	const settings = normalizeSettings(rawSettings);
	settingsCache.set(uri, settings);
	return settings;
}
