import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { WorkspaceFolder } from 'vscode-languageserver/node';
import type { WorkspaceCatalogContext } from './catalog';
import { isInside, uriToFilePath } from './workspace';

/**
 * What kind of project a workspace folder is, and which version of it.
 *
 * One detector, three consumers: dialect-pack activation, template-root
 * discovery, and (milestone 10) project-config introspection. They ask the same
 * question — "is this Craft, and which Craft?" — and an answer that differed
 * between them would show up as a pack that activates in a project whose
 * template roots it cannot find.
 *
 * `craftVersion` is the version actually installed, read from `composer.lock`.
 * The `composer.json` constraint is the fallback: a checkout with no lockfile
 * still deserves an answer, and `^5.0` narrows to a major even when it cannot
 * name a patch.
 */

export interface ProjectContext {
	readonly kind: 'craft' | 'unknown';
	readonly root: string;
	readonly composerPackages: readonly string[];
	/** Exact installed version, or the constraint's floor when only a constraint is known. */
	readonly craftVersion?: string;
	/** True when the version came from a constraint rather than the lockfile. */
	readonly craftVersionApproximate?: boolean;
}

const CRAFT_PACKAGE = 'craftcms/cms';

/** Files whose contents decide the answer, and so invalidate it when they change. */
const WATCHED_FILES = ['composer.json', 'composer.lock', '.env'];

export class ProjectContextResolver {
	private readonly roots: readonly string[];
	private readonly cache = new Map<string, ProjectContext>();

	constructor(workspaceFolders: readonly WorkspaceFolder[]) {
		this.roots = workspaceFolders
			.map((folder) => uriToFilePath(folder.uri))
			.filter((path): path is string => path !== undefined)
			// Longest first: a nested folder is a better answer than its parent.
			.sort((a, b) => b.length - a.length);
	}

	forUri(uri: string): ProjectContext | undefined {
		const filePath = uriToFilePath(uri);
		const root =
			filePath === undefined
				? undefined
				: this.roots.find((candidate) => isInside(filePath, candidate));
		return root === undefined ? undefined : this.forRoot(root);
	}

	forRoot(root: string): ProjectContext {
		let cached = this.cache.get(root);
		if (cached === undefined) {
			cached = detectProject(root);
			this.cache.set(root, cached);
		}
		return cached;
	}

	/** Drops the cached answer for whichever workspace `uri` belongs to. */
	invalidate(uri: string): void {
		const filePath = uriToFilePath(uri);
		if (filePath === undefined || !WATCHED_FILES.includes(basename(filePath))) {
			return;
		}
		for (const root of this.roots) {
			if (isInside(filePath, root)) {
				this.cache.delete(root);
			}
		}
	}
}

export function detectProject(root: string): ProjectContext {
	const { packages, constraints } = readComposerJson(root);
	if (!packages.includes(CRAFT_PACKAGE)) {
		return { kind: 'unknown', root, composerPackages: packages };
	}

	const locked = readLockedVersion(root, CRAFT_PACKAGE);
	if (locked !== undefined) {
		return { kind: 'craft', root, composerPackages: packages, craftVersion: locked };
	}

	const fromConstraint = versionFromConstraint(constraints[CRAFT_PACKAGE]);
	return {
		kind: 'craft',
		root,
		composerPackages: packages,
		...(fromConstraint === undefined
			? {}
			: { craftVersion: fromConstraint, craftVersionApproximate: true }),
	};
}

/** The shape dialect-pack detection and version gating consume. */
export function toCatalogContext(context: ProjectContext | undefined): WorkspaceCatalogContext {
	if (context === undefined) {
		return {};
	}
	return {
		composerPackages: [...context.composerPackages],
		...(context.craftVersion === undefined
			? {}
			: { packageVersions: { [CRAFT_PACKAGE]: context.craftVersion } }),
	};
}

function readComposerJson(root: string): {
	packages: string[];
	constraints: Record<string, string>;
} {
	try {
		const composer = JSON.parse(readFileSync(resolve(root, 'composer.json'), 'utf8')) as {
			require?: Record<string, unknown>;
			'require-dev'?: Record<string, unknown>;
		};
		const constraints: Record<string, string> = {};
		for (const section of [composer.require, composer['require-dev']]) {
			for (const [name, constraint] of Object.entries(section ?? {})) {
				if (typeof constraint === 'string') {
					constraints[name] = constraint;
				}
			}
		}
		return {
			packages: [
				...Object.keys(composer.require ?? {}),
				...Object.keys(composer['require-dev'] ?? {}),
			],
			constraints,
		};
	} catch {
		return { packages: [], constraints: {} };
	}
}

function readLockedVersion(root: string, packageName: string): string | undefined {
	try {
		const lock = JSON.parse(readFileSync(resolve(root, 'composer.lock'), 'utf8')) as {
			packages?: { name?: unknown; version?: unknown }[];
			'packages-dev'?: { name?: unknown; version?: unknown }[];
		};
		for (const section of [lock.packages, lock['packages-dev']]) {
			for (const entry of section ?? []) {
				if (entry.name === packageName && typeof entry.version === 'string') {
					return normalizeVersion(entry.version);
				}
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * The lowest version a constraint admits — `^5.0` and `~5.2.1` and `>=5.0 <6`
 * all pin a major, which is all the gating needs. Unparseable constraints
 * (`dev-main`, a VCS ref) get no version at all rather than a guess.
 */
function versionFromConstraint(constraint: string | undefined): string | undefined {
	if (constraint === undefined) {
		return undefined;
	}
	const match = /(\d+(?:\.\d+)*)/.exec(constraint);
	return match?.[1] === undefined ? undefined : normalizeVersion(match[1]);
}

function normalizeVersion(version: string): string {
	return version.trim().replace(/^v/i, '');
}
