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
};

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
