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

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize((params: InitializeParams): InitializeResult => {
	const client = params.clientInfo?.name ?? 'unknown client';
	connection.console.info(`Twig Toolbox language server starting (client: ${client})`);
	connection.console.info(`Twig dialect: ${TWIG_VERSION}`);

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
