import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkspaceCatalogContext } from './catalog';
import { toCatalogContext, type ProjectContextResolver } from './project-context';

export interface WorkspaceContextResolver {
	resolve(uri: string): WorkspaceCatalogContext;
}

/**
 * Dialect-pack activation, in the shape the catalog wants it.
 *
 * The detection itself belongs to `ProjectContextResolver` — template roots and
 * project introspection ask the same question, and one cache answering all of
 * them is the only way they cannot disagree.
 */
export function createWorkspaceContextResolver(
	projects: ProjectContextResolver,
): WorkspaceContextResolver {
	return {
		resolve: (uri) => toCatalogContext(projects.forUri(uri)),
	};
}

export function uriToFilePath(uri: string): string | undefined {
	if (!uri.startsWith('file:')) {
		return undefined;
	}

	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

export function filePathToUri(filePath: string): string {
	return pathToFileURL(filePath).toString();
}

export function isInside(filePath: string, root: string): boolean {
	const parent = dirname(filePath);
	const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
	return filePath === root || parent === root || parent.startsWith(normalizedRoot);
}
