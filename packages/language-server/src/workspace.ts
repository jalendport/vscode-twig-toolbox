import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceFolder } from 'vscode-languageserver/node';
import type { WorkspaceCatalogContext } from './catalog';

export interface WorkspaceContextResolver {
	resolve(uri: string): WorkspaceCatalogContext;
}

export function createWorkspaceContextResolver(
	workspaceFolders: readonly WorkspaceFolder[],
): WorkspaceContextResolver {
	const roots = workspaceFolders
		.map((folder) => uriToFilePath(folder.uri))
		.filter((path) => path !== undefined)
		.sort((a, b) => b.length - a.length);

	const packageCache = new Map<string, string[]>();

	return {
		resolve(uri) {
			const filePath = uriToFilePath(uri);
			const root =
				filePath === undefined
					? undefined
					: roots.find((candidate) => isInside(filePath, candidate));
			if (root === undefined) {
				return {};
			}

			let composerPackages = packageCache.get(root);
			if (composerPackages === undefined) {
				composerPackages = readComposerPackages(root);
				packageCache.set(root, composerPackages);
			}

			return { composerPackages };
		},
	};
}

function readComposerPackages(root: string): string[] {
	try {
		const composerPath = resolve(root, 'composer.json');
		const composer = JSON.parse(readFileSync(composerPath, 'utf8')) as {
			require?: Record<string, unknown>;
			'require-dev'?: Record<string, unknown>;
		};
		return [
			...Object.keys(composer.require ?? {}),
			...Object.keys(composer['require-dev'] ?? {}),
		];
	} catch {
		return [];
	}
}

function uriToFilePath(uri: string): string | undefined {
	if (!uri.startsWith('file:')) {
		return undefined;
	}

	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

function isInside(filePath: string, root: string): boolean {
	const parent = dirname(filePath);
	const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
	return filePath === root || parent === root || parent.startsWith(normalizedRoot);
}
