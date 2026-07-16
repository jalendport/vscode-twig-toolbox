import {
	createConnection,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
	type InitializeParams,
	type InitializeResult,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TWIG_VERSION } from '@twig-toolbox/parser';
import { CatalogRegistry } from './catalog';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let catalogRegistry = CatalogRegistry.fromPacks([]);

connection.onInitialize((params: InitializeParams): InitializeResult => {
	const client = params.clientInfo?.name ?? 'unknown client';
	catalogRegistry = CatalogRegistry.loadDefault();

	connection.console.info(`Twig Toolbox language server starting (client: ${client})`);
	connection.console.info(`Twig dialect: ${TWIG_VERSION}`);
	connection.console.info(`Loaded ${catalogRegistry.packs.length} dialect catalog pack(s)`);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
		},
		serverInfo: {
			name: 'Twig Toolbox Language Server',
			version: '0.1.0',
		},
	};
});

connection.onInitialized(() => {
	connection.console.info('Twig Toolbox language server ready');
});

documents.onDidOpen(({ document }) => {
	connection.console.info(`Opened ${document.uri} (${document.lineCount} lines)`);
});

documents.onDidClose(({ document }) => {
	connection.console.info(`Closed ${document.uri}`);
});

documents.listen(connection);
connection.listen();
