import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

await runTests({
	extensionDevelopmentPath: resolve(repoRoot, 'packages', 'extension'),
	extensionTestsPath: resolve(repoRoot, 'tests', 'electron', 'suite.cjs'),
	launchArgs: [resolve(repoRoot, 'tests', 'electron', 'fixtures')],
});
