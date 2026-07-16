import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CatalogEntryKind = 'tags' | 'filters' | 'functions' | 'tests' | 'globals';

export interface CatalogSourceRef {
	repository: string;
	ref: string;
	path?: string;
}

export type CatalogDetection =
	{ kind: 'always' } | { kind: 'composer'; composerPackages: string[] };

export interface CatalogParameter {
	name: string;
	type?: string;
	optional: boolean;
	default?: string;
	description?: string;
}

export interface CatalogEntry {
	name: string;
	aliases?: string[];
	signature: string;
	parameters: CatalogParameter[];
	description: string;
	docsUrl: string;
	sinceVersion?: string;
	deprecated?: {
		sinceVersion: string;
		message?: string;
	};
	completionSnippet: string;
	source?: {
		extension?: string;
		phpClass?: string;
		docsPath?: string;
	};
}

export interface DialectPack {
	schemaVersion: 1;
	name: string;
	displayName: string;
	version: string;
	sources: {
		twig: CatalogSourceRef;
		docs: CatalogSourceRef;
	};
	detect: CatalogDetection;
	entries: Record<CatalogEntryKind, CatalogEntry[]>;
}

export interface WorkspaceCatalogContext {
	composerPackages?: string[];
}

export interface CatalogEntryWithProvenance extends CatalogEntry {
	pack: {
		name: string;
		displayName: string;
		version: string;
	};
}

export type CatalogEntryMap = Record<CatalogEntryKind, Map<string, CatalogEntryWithProvenance>>;

const entryKinds: CatalogEntryKind[] = ['tags', 'filters', 'functions', 'tests', 'globals'];

export class CatalogRegistry {
	readonly packs: DialectPack[];

	private constructor(packs: DialectPack[]) {
		this.packs = packs;
	}

	static fromPacks(packs: DialectPack[]): CatalogRegistry {
		return new CatalogRegistry(packs);
	}

	static fromFiles(paths: string[]): CatalogRegistry {
		return new CatalogRegistry(
			paths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as DialectPack),
		);
	}

	static loadDefault(): CatalogRegistry {
		const catalogPath = resolveCatalogPath(
			typeof __dirname === 'string' ? __dirname : undefined,
			process.cwd(),
		);
		if (!catalogPath) {
			return new CatalogRegistry([]);
		}

		return CatalogRegistry.fromFiles([catalogPath]);
	}

	getActivePacks(context: WorkspaceCatalogContext = {}): DialectPack[] {
		const composerPackages = new Set(context.composerPackages ?? []);

		return this.packs.filter((pack) => {
			if (pack.detect.kind === 'always') {
				return true;
			}

			return pack.detect.composerPackages.some((packageName) =>
				composerPackages.has(packageName),
			);
		});
	}

	getMergedEntries(context: WorkspaceCatalogContext = {}): CatalogEntryMap {
		const merged = createEmptyEntryMap();

		for (const pack of this.getActivePacks(context)) {
			for (const kind of entryKinds) {
				for (const entry of pack.entries[kind]) {
					const entryWithProvenance = {
						...entry,
						pack: {
							name: pack.name,
							displayName: pack.displayName,
							version: pack.version,
						},
					};
					merged[kind].set(entry.name, entryWithProvenance);
					for (const alias of entry.aliases ?? []) {
						merged[kind].set(alias, entryWithProvenance);
					}
				}
			}
		}

		return merged;
	}
}

function createEmptyEntryMap(): CatalogEntryMap {
	return {
		tags: new Map(),
		filters: new Map(),
		functions: new Map(),
		tests: new Map(),
		globals: new Map(),
	};
}

/**
 * Where the shipped `twig-core.json` lives.
 *
 * `moduleDir` is tried before `cwd` because it is the only anchor that holds up
 * in a real install: the server runs as a child of the extension host, whose
 * working directory belongs to VS Code, not to the extension. The `cwd`
 * candidates are for running out of the repo — tests and `tsx`.
 *
 * Exported for tests: the layout that matters is the packaged one, which no
 * in-repo run reproduces.
 */
export function resolveCatalogPath(moduleDir: string | undefined, cwd: string): string | undefined {
	const candidates = [
		process.env.TWIG_TOOLBOX_CATALOG_ROOT
			? resolve(process.env.TWIG_TOOLBOX_CATALOG_ROOT, 'twig-core.json')
			: undefined,
		// The packaged layout: dist/server.js next to catalogs/twig-core.json.
		moduleDir ? resolve(moduleDir, '..', 'catalogs', 'twig-core.json') : undefined,
		moduleDir ? resolve(moduleDir, 'catalogs', 'twig-core.json') : undefined,
		resolve(cwd, 'catalogs', 'twig-core.json'),
		resolve(cwd, 'packages', 'extension', 'catalogs', 'twig-core.json'),
	].filter((path) => path !== undefined);

	return candidates.find((path) => existsSync(path));
}
