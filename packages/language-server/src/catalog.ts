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
		const catalogPath = resolveDefaultCatalogPath();
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
					merged[kind].set(entry.name, {
						...entry,
						pack: {
							name: pack.name,
							displayName: pack.displayName,
							version: pack.version,
						},
					});
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

function resolveDefaultCatalogPath(): string | undefined {
	const candidates = [
		process.env.TWIG_TOOLBOX_CATALOG_ROOT
			? resolve(process.env.TWIG_TOOLBOX_CATALOG_ROOT, 'twig-core.json')
			: undefined,
		resolve(process.cwd(), 'catalogs', 'twig-core.json'),
		resolve(process.cwd(), 'packages', 'extension', 'catalogs', 'twig-core.json'),
	].filter((path) => path !== undefined);

	return candidates.find((path) => existsSync(path));
}
