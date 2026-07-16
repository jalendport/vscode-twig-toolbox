import { cp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const extensionRoot = join(repoRoot, 'packages', 'extension');

/**
 * Assets that live at the repo root (so milestones can edit them in one place) but must be
 * physically present inside packages/extension for `vsce package` to include them.
 *
 * Entries are [source relative to repoRoot, destination relative to extensionRoot].
 * Missing sources are skipped: catalogs/ and LICENSE do not exist yet.
 */
export const COPIED_ASSETS = [
	['syntaxes', 'syntaxes'],
	['language-configuration.json', 'language-configuration.json'],
	['images', 'images'],
	['catalogs', 'catalogs'],
	['README.md', 'README.md'],
	['CHANGELOG.md', 'CHANGELOG.md'],
	['LICENSE', 'LICENSE'],
];

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Copies the root assets into packages/extension, replacing any previous copies. */
export async function copyAssets() {
	for (const [from, to] of COPIED_ASSETS) {
		const source = join(repoRoot, from);
		const destination = join(extensionRoot, to);

		await rm(destination, { recursive: true, force: true });
		if (await exists(source)) {
			await cp(source, destination, { recursive: true });
		}
	}
}

/** Removes the copied assets and bundler output from packages/extension. */
export async function cleanExtension() {
	for (const [, to] of COPIED_ASSETS) {
		await rm(join(extensionRoot, to), { recursive: true, force: true });
	}
	await rm(join(extensionRoot, 'dist'), { recursive: true, force: true });
}
