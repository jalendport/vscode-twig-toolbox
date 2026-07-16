import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { extensionRoot, repoRoot } from './assets.mjs';

const vsce = join(repoRoot, 'node_modules', '@vscode', 'vsce', 'vsce');

// Everything the extension needs is bundled into dist/ by esbuild, so vsce must not try to walk
// the workspace dependencies (which are symlinks into packages/).
const result = spawnSync(
	process.execPath,
	[vsce, 'package', '--no-dependencies', '--out', repoRoot],
	{ cwd: extensionRoot, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
