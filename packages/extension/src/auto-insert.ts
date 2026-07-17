import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/**
 * Auto-closing HTML tags, attribute quotes and Twig brackets, on type.
 *
 * A port of what `html-language-features` does for `.html`, because a Twig file
 * is an HTML file and users notice the moment `</div` stops finishing itself.
 * The language config's auto-closing pairs cover brackets and quotes typed in
 * isolation; only the server knows that the `>` just typed closed a `<div` and
 * therefore owes a `</div>`, or that the `{` just typed opened a hash rather
 * than a `{{ ` delimiter.
 *
 * The work is deliberately deferred to a microtask-after-selection-change: the
 * document has to settle and the cursor has to be where the change left it,
 * otherwise a fast typist gets a tag closed around the wrong text. Any further
 * edit before the server answers cancels the insertion.
 */

interface Settings {
	readonly closeTags: boolean;
	readonly createQuotes: boolean;
	readonly closeBraces: boolean;
}

/**
 * What each trigger character owes, and the setting that can excuse it.
 *
 * `>` and `/` finish a tag, `=` opens a pair of quotes, and `{` and `[` may owe
 * a Twig closer. The settings are read per keystroke — which is also what makes
 * them live — but only once a character has matched here, so ordinary typing
 * costs one map lookup and nothing else.
 */
const TRIGGERS: Record<string, { readonly request: string; readonly setting: keyof Settings }> = {
	'>': { request: 'html/tag', setting: 'closeTags' },
	'/': { request: 'html/tag', setting: 'closeTags' },
	'=': { request: 'html/tag', setting: 'createQuotes' },
	'{': { request: 'twig/autoCloseBrace', setting: 'closeBraces' },
	'[': { request: 'twig/autoCloseBrace', setting: 'closeBraces' },
};

export function registerAutoInsert(client: LanguageClient): vscode.Disposable {
	let pending = 0;

	const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
		const editor = vscode.window.activeTextEditor;
		if (
			editor === undefined ||
			event.document !== editor.document ||
			event.contentChanges.length !== 1 ||
			event.document.languageId !== 'twig'
		) {
			return;
		}

		const change = event.contentChanges[0];
		const trigger = change === undefined ? undefined : TRIGGERS[change.text];
		if (change === undefined || trigger === undefined) {
			return;
		}

		if (!readSettings(event.document.uri)[trigger.setting]) {
			return;
		}

		// The change's own range is pre-edit; the caret ends up after the
		// character that was typed.
		const position = event.document.positionAt(
			event.document.offsetAt(change.range.start) + change.text.length,
		);
		void insert(
			client,
			editor,
			event.document,
			position,
			change.text,
			trigger.request,
			++pending,
			() => pending,
		);
	});

	return disposable;
}

async function insert(
	client: LanguageClient,
	editor: vscode.TextEditor,
	document: vscode.TextDocument,
	position: vscode.Position,
	trigger: string,
	request: string,
	token: number,
	current: () => number,
): Promise<void> {
	const version = document.version;
	const snippet = await client.sendRequest<string | null>(request, {
		textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document),
		position: client.code2ProtocolConverter.asPosition(position),
		trigger,
	});

	// Anything typed while the server was thinking wins: inserting now would
	// drop a `</div>` into the middle of whatever came next.
	if (
		snippet === null ||
		snippet === undefined ||
		token !== current() ||
		document.version !== version ||
		vscode.window.activeTextEditor !== editor ||
		!editor.selection.isEmpty ||
		!editor.selection.active.isEqual(position)
	) {
		return;
	}

	await editor.insertSnippet(new vscode.SnippetString(snippet), position);
}

function readSettings(uri: vscode.Uri): Settings {
	const config = vscode.workspace.getConfiguration('twigToolbox', uri);
	return {
		closeTags: config.get<boolean>('autoClosingTags', true),
		createQuotes: config.get<boolean>('autoCreateQuotes', true),
		closeBraces: config.get<boolean>('autoClosingBraces', true),
	};
}
