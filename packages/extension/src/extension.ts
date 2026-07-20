import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	LanguageClient,
	TransportKind,
	type LanguageClientOptions,
	type ServerOptions,
} from 'vscode-languageclient/node';
import { registerAutoInsert } from './auto-insert';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] },
		},
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'twig' },
			{ scheme: 'untitled', language: 'twig' },
		],
		outputChannel: vscode.window.createOutputChannel('Twig Toolbox', { log: true }),
	};

	client = new LanguageClient('twigToolbox', 'Twig Toolbox', serverOptions, clientOptions);
	context.subscriptions.push(client);

	await client.start();
	context.subscriptions.push(registerAutoInsert(client));
}

export async function deactivate(): Promise<void> {
	await client?.stop();
	client = undefined;
}
