/**
 * Runs the TextMate grammar snapshot tests.
 *
 * `text.html.twig` includes `text.html.basic`, which in turn delegates <script>/<style> bodies to
 * `source.js` / `source.css`. vscode-tmgrammar-snap only knows about grammars it is handed on the
 * command line, so the snapshots would be meaningless without those three. Rather than vendoring
 * copies of someone else's grammars we borrow them from @shikijs/langs (a dev dependency) and dump
 * them to a gitignored scratch directory for the runner to pick up.
 *
 * Usage: node scripts/grammar-test.mjs [--update]
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { repoRoot } from './assets.mjs';

const grammarDir = join(repoRoot, 'tests', 'grammar', '.grammars');
const fixtures = 'tests/grammar/fixtures/**/*.twig';

/** Writes the grammars text.html.twig depends on to disk and returns their paths. */
async function writeDependencyGrammars() {
	await rm(grammarDir, { recursive: true, force: true });
	await mkdir(grammarDir, { recursive: true });

	// @shikijs/langs/html bundles text.html.basic plus the source.js and source.css it embeds.
	const { default: grammars } = await import('@shikijs/langs/html');

	const paths = [];
	for (const grammar of grammars) {
		const path = join(grammarDir, `${grammar.scopeName}.json`);
		await writeFile(path, JSON.stringify(grammar));
		paths.push(path);
	}
	return paths;
}

async function main() {
	const update = process.argv.includes('--update');
	const dependencies = await writeDependencyGrammars();

	const args = [
		'vscode-tmgrammar-snap',
		'--scope',
		'text.html.twig',
		'--grammar',
		join(repoRoot, 'syntaxes', 'twig.tmLanguage.json'),
		...dependencies.flatMap((path) => ['--grammar', path]),
		...(update ? ['--updateSnapshot'] : []),
		fixtures,
	];

	const child = spawn('npx', args, { cwd: repoRoot, stdio: 'inherit' });
	child.on('exit', (code) => process.exit(code ?? 1));
}

await main();
