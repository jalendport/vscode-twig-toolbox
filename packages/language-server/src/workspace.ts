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
	const file = normalizeSeparators(filePath);
	const normalizedRoot = normalizeSeparators(root);
	const base = normalizedRoot.endsWith('/') ? normalizedRoot.slice(0, -1) : normalizedRoot;
	return file === base || file.startsWith(`${base}/`);
}

/**
 * Path separators collapsed to `/`. Windows paths use `\`, and comparing them
 * against a root that only ever gets a `/`-terminated suffix (the case before
 * this normalization existed) silently classified every nested file on
 * Windows as outside its workspace root — this has to work the same way
 * regardless of which platform produced the paths being compared.
 */
function normalizeSeparators(path: string): string {
	return path.replace(/\\/g, '/');
}
