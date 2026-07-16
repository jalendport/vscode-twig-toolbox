import * as esbuild from 'esbuild';
import { join } from 'node:path';
import { copyAssets, extensionRoot, repoRoot } from './assets.mjs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const shared = {
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	sourcemap: !production,
	minify: production,
	// Provided by the VS Code extension host, never bundled.
	external: ['vscode'],
	logLevel: 'info',
};

const targets = [
	{
		...shared,
		entryPoints: [join(repoRoot, 'packages/extension/src/extension.ts')],
		outfile: join(extensionRoot, 'dist/extension.js'),
	},
	{
		...shared,
		entryPoints: [join(repoRoot, 'packages/language-server/src/server.ts')],
		outfile: join(extensionRoot, 'dist/server.js'),
	},
];

await copyAssets();

if (watch) {
	const contexts = await Promise.all(targets.map((target) => esbuild.context(target)));
	await Promise.all(contexts.map((context) => context.watch()));
	console.log('Watching for changes...');
} else {
	await Promise.all(targets.map((target) => esbuild.build(target)));
}
