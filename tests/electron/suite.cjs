const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

module.exports.run = async function run() {
	const extension = vscode.extensions.getExtension('jalendport.twig-toolbox');
	assert.ok(extension, 'Twig Toolbox extension is installed in the test host');
	await extension.activate();

	const uri = vscode.Uri.file(path.join(__dirname, 'fixtures', 'broken.twig'));
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);

	const diagnostic = await waitForDiagnostic(uri, 'missing-end-tag');
	assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
	assert.deepEqual(diagnostic.range.start, new vscode.Position(0, 0));
	assert.deepEqual(diagnostic.range.end, new vscode.Position(0, 12));

	await testCompletions();
};

/**
 * Completions through the real client, server and catalog load — the unit tests
 * hand the registry its packs, so only this proves the shipped extension can
 * find them on disk.
 */
async function testCompletions() {
	const uri = vscode.Uri.file(path.join(__dirname, 'fixtures', 'completions.twig'));
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);

	// `{% ‸for item in items %}` — the tag-name slot.
	const tags = await completionsAt(uri, new vscode.Position(0, 3));
	const forTag = find(tags, 'for');
	assert.ok(forTag, 'expected a `for` tag completion');
	assert.equal(forTag.kind, vscode.CompletionItemKind.Keyword);
	assert.equal(labelOf(forTag).description, 'Twig', 'provenance reaches the client');
	// The snippet brings its own delimiters, so the edit replaces the region's
	// interior; only applying it shows the two halves fit together.
	assert.equal(applyToLine(document, 0, forTag), '{% for $1 in $2 %}\n\t$0\n{% endfor %}');

	// `{{ item|‸upper }}` — filters only.
	const filters = await completionsAt(uri, new vscode.Position(1, 10));
	assert.ok(find(filters, 'upper'), 'expected an `upper` filter completion');
	assert.ok(!find(filters, 'for'), 'tags must not leak into a filter slot');

	// `{{ ‸item|upper }}` — the loop variable, from the document itself.
	const expressions = await completionsAt(uri, new vscode.Position(1, 5));
	const item = find(expressions, 'item');
	assert.ok(item, 'expected the loop variable `item`');
	assert.equal(item.kind, vscode.CompletionItemKind.Variable);
}

/** The line as it would read after accepting `item`, snippet syntax and all. */
function applyToLine(document, line, item) {
	const text = document.lineAt(line).text;
	return (
		text.slice(0, item.range.start.character) +
		item.insertText.value +
		text.slice(item.range.end.character)
	);
}

/** `labelDetails` makes VS Code hand back a `CompletionItemLabel`, not a string. */
function labelOf(item) {
	return typeof item.label === 'string' ? { label: item.label } : item.label;
}

function find(items, label) {
	return items.find((item) => labelOf(item).label === label);
}

async function completionsAt(uri, position) {
	const list = await vscode.commands.executeCommand(
		'vscode.executeCompletionItemProvider',
		uri,
		position,
	);
	return list.items;
}

async function waitForDiagnostic(uri, code) {
	const deadline = Date.now() + 10_000;

	while (Date.now() < deadline) {
		const diagnostic = vscode.languages
			.getDiagnostics(uri)
			.find((candidate) => candidate.code === code);
		if (diagnostic !== undefined) {
			return diagnostic;
		}
		await sleep(100);
	}

	throw new Error(`Timed out waiting for diagnostic ${code}`);
}

function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
