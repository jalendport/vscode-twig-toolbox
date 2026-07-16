const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

module.exports.run = async function run() {
	const extension = vscode.extensions.getExtension('jalendport.twig-toolbox');
	assert.ok(extension, 'Twig Toolbox extension is installed in the test host');
	await extension.activate();

	// `executeCompletionItemProvider` returns every provider's items merged,
	// and VS Code's word-based suggestions contribute every word already in the
	// document. Left on, they make `div` appear in a list our server never
	// touched — an assertion that can only pass. Off, what comes back is ours.
	await vscode.workspace
		.getConfiguration('editor')
		.update('wordBasedSuggestions', 'off', vscode.ConfigurationTarget.Global);

	const uri = vscode.Uri.file(path.join(__dirname, 'fixtures', 'broken.twig'));
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);

	const diagnostic = await waitForDiagnostic(uri, 'missing-end-tag');
	assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
	assert.deepEqual(diagnostic.range.start, new vscode.Position(0, 0));
	assert.deepEqual(diagnostic.range.end, new vscode.Position(0, 12));

	await testCompletions();
	await testCraftPack();
	await testTemplateNavigation();
	await testEmbedded();
	await testEmmet();
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

/**
 * The Craft pack, through the real client and the real catalog load.
 *
 * The fixture workspace is a Craft project — `composer.json` requires
 * `craftcms/cms` and `composer.lock` pins 5.10.11 — so this is the one test
 * that shows detection, the shipped `craft.json`, and the member provider all
 * reaching a real editor together.
 */
async function testCraftPack() {
	const uri = vscode.Uri.file(path.join(__dirname, 'fixtures', 'templates', 'craft.twig'));
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);

	// `{% cache %}` — a tag only the Craft pack has an opinion about here.
	const tags = await completionsAt(uri, new vscode.Position(0, 3));
	const nav = find(tags, 'nav');
	assert.ok(nav, 'expected the Craft `nav` tag');
	assert.equal(labelOf(nav).description, 'CraftCMS', 'Craft provenance reaches the client');

	// `{{ craft.‸entries }}` — the member provider, over the shipped catalog.
	const members = await completionsAt(uri, new vscode.Position(1, 10));
	const entries = find(members, 'entries');
	assert.ok(entries, 'expected `craft.entries`');
	assert.equal(entries.kind, vscode.CompletionItemKind.Property);
	assert.ok(!find(members, 'matrixBlocks'), 'Craft 4 members stay out of a Craft 5 project');

	// `{{ entry.summary|mark‸down }}` — hover with Craft provenance and docs.
	const hovers = await vscode.commands.executeCommand(
		'vscode.executeHoverProvider',
		uri,
		new vscode.Position(2, 21),
	);
	const markdown = hovers
		.flatMap((hover) => hover.contents.map((content) => content.value ?? String(content)))
		.join('\n');
	assert.match(markdown, /Processes a string as Markdown/, 'expected the Craft docs on hover');
	assert.match(markdown, /\*\*Source:\*\* CraftCMS/, 'expected Craft provenance on hover');
}

async function testTemplateNavigation() {
	const uri = vscode.Uri.file(path.join(__dirname, 'fixtures', 'templates', 'navigation.twig'));
	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);

	const pathItems = await completionsAt(uri, new vscode.Position(0, 22));
	assert.ok(find(pathItems, 'card.twig'), 'expected template path completion under _partials/');

	const definitions = await vscode.commands.executeCommand(
		'vscode.executeDefinitionProvider',
		uri,
		new vscode.Position(1, 14),
	);
	assert.ok(
		definitions.some((definition) =>
			definition.uri.fsPath.endsWith(path.join('templates', '_layout.twig')),
		),
		'expected extends definition to land on _layout.twig',
	);

	const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', uri);
	assert.ok(
		links.some((link) => link.target.fsPath.endsWith(path.join('templates', '_layout.twig'))),
		'expected document link for _layout.twig',
	);
}

/**
 * Embedded HTML and CSS through the real client and server.
 *
 * The unit tests call the html service directly; only this proves it survived
 * esbuild's bundle and that the merged provider is the one VS Code actually
 * asks. Edits are made and undone so the fixture on disk stays a fixture.
 */
async function testEmbedded() {
	const uri = vscode.Uri.file(path.join(__dirname, 'fixtures', 'embedded.twig'));
	const document = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(document);

	// Hover on the `<a>` element, inside a `{% for %}` body and next to Twig.
	const hovers = await vscode.commands.executeCommand(
		'vscode.executeHoverProvider',
		uri,
		new vscode.Position(2, 3),
	);
	assert.ok(
		hovers.some((hover) => text(hover).includes('anchor') || text(hover).includes('<a>')),
		'expected HTML element hover on `<a>`',
	);

	// `style="color: ‸red"` — the css service, reached through the html shadow.
	const cssHovers = await vscode.commands.executeCommand(
		'vscode.executeHoverProvider',
		uri,
		new vscode.Position(0, 26),
	);
	assert.ok(
		cssHovers.some((hover) => text(hover).includes('color')),
		'expected CSS property hover inside an inline style attribute',
	);

	// `<sec‸` on a fresh line, Twig above and below — the milestone's headline
	// case. `section` is deliberately a word the fixture does not contain, so
	// nothing but the html service could be offering it.
	await withEdit(editor, new vscode.Position(5, 0), '<sec', async (position) => {
		const items = await completionsAt(uri, position);
		assert.ok(find(items, 'section'), 'expected a `section` completion in a .twig file');
	});

	// `<div cl‸` — attribute names.
	await withEdit(editor, new vscode.Position(5, 0), '<div hidd', async (position) => {
		const items = await completionsAt(uri, position);
		assert.ok(find(items, 'hidden'), 'expected a `hidden` attribute completion');
	});

	// Inline `style=""` reaches the css service.
	await withEdit(editor, new vscode.Position(5, 0), '<p style="vis', async (position) => {
		const items = await completionsAt(uri, position);
		assert.ok(find(items, 'visibility'), 'expected CSS properties inside style=""');
	});

	// `<a href="{{ item.url|‸upper }}">` — Twig still owns the inside of `{{ }}`
	// even in an attribute, and no html tag has any business being there.
	const inAttribute = await completionsAt(uri, new vscode.Position(2, 23));
	const upper = find(inAttribute, 'upper');
	assert.ok(upper, 'expected Twig filters inside `{{ }}` in an attribute');
	assert.equal(labelOf(upper).description, 'Twig', 'the filter must come from our server');
	assert.ok(!find(inAttribute, 'div'), 'HTML completions must not fire inside `{{ }}`');
	assert.ok(!find(inAttribute, 'section'), 'HTML completions must not fire inside `{{ }}`');

	// `{% ‸for … %}` — nor inside a tag header.
	const inBlock = await completionsAt(uri, new vscode.Position(1, 4));
	assert.equal(labelOf(find(inBlock, 'for')).description, 'Twig', 'expected the `for` tag');
	assert.ok(!find(inBlock, 'div'), 'HTML completions must not fire inside `{% %}`');
	assert.ok(!find(inBlock, 'section'), 'HTML completions must not fire inside `{% %}`');

	await testAutoClose(editor);
	await testTagHighlights(uri);
}

/**
 * Auto-closing tags and quotes, driven the only way they can be: by typing.
 *
 * These are not completions — nothing appears in a list — so the client watches
 * for the trigger character and asks the server over `html/tag`. That round trip
 * only exists at runtime, which makes this the one place it is exercised.
 */
async function testAutoClose(editor) {
	// Typing the `>` of `<section` owes a `</section>`.
	await typeTrigger(editor, 5, '<section', '>');
	await waitForLine(editor.document, 5, '<section></section>');
	await clearLine(editor, 5);

	// Typing the `=` of an attribute owes a pair of quotes.
	await typeTrigger(editor, 5, '<section class', '=');
	await waitForLine(editor.document, 5, '<section class=""');
	await clearLine(editor, 5);

	// Twig is not HTML: a `>` inside `{{ }}` is a comparison, not a tag.
	await typeTrigger(editor, 5, '{{ a <b ', '>');
	await sleep(500);
	assert.equal(
		editor.document.lineAt(5).text,
		'{{ a <b >',
		'auto-close must not fire inside `{{ }}`',
	);
	await clearLine(editor, 5);
}

/**
 * Puts `prefix` on an empty line, then *types* `trigger` at the caret.
 *
 * The prefix goes in as a bulk edit, but the trigger has to arrive through the
 * `type` command: auto-insertion deliberately only fires when the caret is where
 * the change left it, and a programmatic edit does not move the caret the way a
 * keystroke does.
 */
async function typeTrigger(editor, line, prefix, trigger) {
	await editor.edit((builder) => builder.insert(new vscode.Position(line, 0), prefix));
	const at = new vscode.Position(line, prefix.length);
	editor.selection = new vscode.Selection(at, at);
	await vscode.commands.executeCommand('type', { text: trigger });
}

async function clearLine(editor, line) {
	const text = editor.document.lineAt(line).text;
	await editor.edit((builder) =>
		builder.delete(
			new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, text.length)),
		),
	);
}

/** Matching-tag highlights, which come free with the html service. */
async function testTagHighlights(uri) {
	const highlights = await vscode.commands.executeCommand(
		'vscode.executeDocumentHighlights',
		uri,
		new vscode.Position(0, 2),
	);
	assert.ok(highlights, 'expected document highlights on `<div>`');
	assert.equal(highlights.length, 2, 'expected the `<div>` open and close tags to pair up');
	assert.equal(highlights[1].range.start.line, 4, 'the pair must span the Twig in between');
}

/** Auto-insertion is asynchronous by design; the edit lands a beat later. */
async function waitForLine(document, line, expected) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (document.lineAt(line).text === expected) {
			return;
		}
		await sleep(50);
	}
	throw new Error(
		`Timed out waiting for line ${line} to read ${JSON.stringify(expected)}; ` +
			`it reads ${JSON.stringify(document.lineAt(line).text)}`,
	);
}

/**
 * Emmet, deliverable 4 — decided here rather than by reading the docs.
 *
 * `emmet.includeLanguages` is an object setting the user may own, so the
 * question is whether our `configurationDefaults` contribution lands as a
 * default and whether emmet then registers for `twig`. Both are observable.
 */
async function testEmmet() {
	const included = vscode.workspace.getConfiguration('emmet').get('includeLanguages');
	assert.equal(
		included.twig,
		'html',
		'expected `configurationDefaults` to seed emmet.includeLanguages with twig -> html',
	);

	const inspected = vscode.workspace.getConfiguration('emmet').inspect('includeLanguages');
	assert.equal(
		inspected.defaultValue.twig,
		'html',
		'the twig -> html mapping must arrive as a default, not as a user setting',
	);
	assert.equal(
		inspected.globalValue,
		undefined,
		'contributing the default must not write into the user settings file',
	);

	// Emmet registers a completion provider per included language, so its
	// abbreviation item appearing is the live proof that `ul>li*3` will expand.
	const uri = vscode.Uri.file(path.join(__dirname, 'fixtures', 'embedded.twig'));
	const document = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(document);

	await withEdit(editor, new vscode.Position(5, 0), 'ul>li*3', async (position) => {
		const items = await completionsAt(uri, position);
		const abbreviation = items.find((item) => labelOf(item).label === 'ul>li*3');
		assert.ok(abbreviation, 'expected emmet to offer the `ul>li*3` abbreviation in twig');
		assert.equal(abbreviation.detail, 'Emmet Abbreviation');
		// `insertText` is what tab actually inserts, so this is the expansion
		// itself and not a preview of it.
		const expanded = abbreviation.insertText.value ?? abbreviation.insertText;
		assert.equal(
			expanded,
			'<ul>\n\t<li>${1}</li>\n\t<li>${2}</li>\n\t<li>${0}</li>\n</ul>',
			'expected `ul>li*3` to expand to three list items',
		);
	});

	await testEmmetWithUserSetting(uri, editor);
}

/**
 * The question the spec actually asks: does contributing a default for an object
 * setting survive a user who owns that object?
 *
 * It does. VS Code merges object-typed settings key by key across scopes rather
 * than replacing them wholesale, so a user with their own
 * `emmet.includeLanguages` keeps their mappings *and* gets ours. The mapping
 * only disappears if they set `twig` to something else themselves, which is
 * their call to make.
 *
 * This is the whole reason `configurationDefaults` ships rather than being
 * README-only, so it is pinned: if a VS Code release ever changed object
 * settings back to replacing, this test fails and the README becomes the fix.
 */
async function testEmmetWithUserSetting(uri, editor) {
	const emmet = vscode.workspace.getConfiguration('emmet');
	await emmet.update('includeLanguages', { php: 'html' }, vscode.ConfigurationTarget.Global);
	try {
		const owned = vscode.workspace.getConfiguration('emmet').get('includeLanguages');
		assert.equal(owned.php, 'html', "the user's own mapping survives");
		assert.equal(
			owned.twig,
			'html',
			'our contributed default must merge into a user-owned emmet.includeLanguages',
		);

		await withEdit(editor, new vscode.Position(5, 0), 'ul>li*3', async (position) => {
			const items = await completionsAt(uri, position);
			assert.ok(
				items.some((item) => labelOf(item).label === 'ul>li*3'),
				'emmet must keep firing in twig when the user owns includeLanguages',
			);
		});
	} finally {
		await vscode.workspace
			.getConfiguration('emmet')
			.update('includeLanguages', undefined, vscode.ConfigurationTarget.Global);
	}
}

/** Applies `insert`, runs `check` with the caret after it, then undoes it. */
async function withEdit(editor, at, insert, check) {
	await editor.edit((builder) => builder.insert(at, insert));
	try {
		await check(at.translate(0, insert.length));
	} finally {
		await vscode.commands.executeCommand('undo');
	}
}

function text(hover) {
	return hover.contents.map((part) => (typeof part === 'string' ? part : part.value)).join('\n');
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
