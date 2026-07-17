import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type CatalogEntryKind = 'tags' | 'filters' | 'functions' | 'tests' | 'globals';

export interface CatalogSourceRef {
	repository: string;
	ref: string;
	path?: string;
}

/**
 * `versionFrom` names the package whose installed version gates a pack's
 * entries. Without it — or without a version for it — nothing is gated: an
 * unknown version must not silently hide half the catalog.
 *
 * It is orthogonal to activation, which is why `always` carries it too. Twig
 * core is always the right pack for a `.twig` file; which of its filters exist
 * still depends on the twig/twig the project locked.
 */
export type CatalogDetection =
	| { kind: 'always'; versionFrom?: string }
	| {
			kind: 'composer';
			composerPackages: string[];
			versionFrom?: string;
	  };

export interface CatalogParameter {
	name: string;
	type?: string;
	optional: boolean;
	default?: string;
	description?: string;
}

export interface CatalogSourceInfo {
	extension?: string;
	phpClass?: string;
	docsPath?: string;
}

/** Fields every named, documented, version-gated thing in a pack carries. */
export interface CatalogItem {
	name: string;
	signature: string;
	parameters: CatalogParameter[];
	description: string;
	docsUrl: string;
	/** First version of the pack's subject that has this item. */
	sinceVersion?: string;
	/** First version that no longer has it — exclusive, so `5.0.0` means "gone in 5". */
	removedVersion?: string;
	deprecated?: {
		sinceVersion: string;
		message?: string;
	};
	completionSnippet: string;
	source?: CatalogSourceInfo;
}

export interface CatalogEntry extends CatalogItem {
	aliases?: string[];
	/** For globals: the `objects` entry describing what dotting into this yields. */
	objectType?: string;
}

/**
 * A member of a catalog object: `entries` on `craft`, `section()` on an
 * `EntryQuery`.
 *
 * `type` names the object the member evaluates to, which is what makes chaining
 * work — a method that returns its own query type keeps the chain open, and one
 * that returns rows (`all()`) ends it by naming no type at all.
 */
export interface CatalogMember extends CatalogItem {
	kind: 'property' | 'method';
	type?: string;
}

export interface CatalogObject {
	name: string;
	/** Object whose members this one also has; resolved when members are read. */
	extends?: string;
	description: string;
	docsUrl: string;
	members: CatalogMember[];
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
	objects?: CatalogObject[];
}

export interface WorkspaceCatalogContext {
	composerPackages?: string[];
	/** Installed versions by package name, for `detect.versionFrom` gating. */
	packageVersions?: Record<string, string>;
}

export interface PackProvenance {
	name: string;
	displayName: string;
	version: string;
}

export interface CatalogEntryWithProvenance extends CatalogEntry {
	pack: PackProvenance;
	/** False when the item exists in the pack but not in this project's version. */
	available: boolean;
}

export interface CatalogMemberWithProvenance extends CatalogMember {
	pack: PackProvenance;
	available: boolean;
}

export interface CatalogObjectWithProvenance extends Omit<CatalogObject, 'members'> {
	pack: PackProvenance;
	members: CatalogMemberWithProvenance[];
}

export type CatalogEntryMap = Record<CatalogEntryKind, Map<string, CatalogEntryWithProvenance>>;

export interface MergeOptions {
	/** Drop items the detected version does not have. Off by default. */
	readonly availableOnly?: boolean;
}

const entryKinds: CatalogEntryKind[] = ['tags', 'filters', 'functions', 'tests', 'globals'];

export class CatalogRegistry {
	readonly packs: DialectPack[];
	private readonly objectCache = new Map<string, Map<string, CatalogObjectWithProvenance>>();

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
		const moduleDir = typeof __dirname === 'string' ? __dirname : undefined;
		const paths = SHIPPED_PACK_FILES.map((file) =>
			resolveCatalogPath(moduleDir, process.cwd(), file),
		).filter((path): path is string => path !== undefined);

		return CatalogRegistry.fromFiles(paths);
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

	getMergedEntries(
		context: WorkspaceCatalogContext = {},
		options: MergeOptions = {},
	): CatalogEntryMap {
		const merged = createEmptyEntryMap();

		for (const pack of this.getActivePacks(context)) {
			const version = detectedVersion(pack, context);
			for (const kind of entryKinds) {
				for (const entry of pack.entries[kind]) {
					const available = isAvailable(entry, version);
					if (!available && options.availableOnly === true) {
						continue;
					}
					const entryWithProvenance = {
						...entry,
						pack: provenance(pack),
						available,
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

	/**
	 * Objects from the active packs, with `extends` chains already flattened —
	 * every caller wants a query's own params and its inherited `all()` in one
	 * list, and none of them should have to walk the chain to get there.
	 *
	 * Members outside the detected version are kept and flagged rather than
	 * dropped, so hover can explain a name completion declined to offer.
	 */
	getMergedObjects(
		context: WorkspaceCatalogContext = {},
	): Map<string, CatalogObjectWithProvenance> {
		// Every member-access completion asks, including the ones that turn out
		// not to be Craft's at all, and flattening ten element queries to answer
		// `{{ foo.‸ }}` with nothing is work worth doing once per project.
		const key = JSON.stringify([context.composerPackages, context.packageVersions]);
		const cached = this.objectCache.get(key);
		if (cached !== undefined) {
			return cached;
		}

		const flattened = this.flattenObjects(context);
		this.objectCache.set(key, flattened);
		return flattened;
	}

	private flattenObjects(
		context: WorkspaceCatalogContext,
	): Map<string, CatalogObjectWithProvenance> {
		const byName = new Map<string, { object: CatalogObject; pack: DialectPack }>();
		for (const pack of this.getActivePacks(context)) {
			for (const object of pack.objects ?? []) {
				byName.set(object.name, { object, pack });
			}
		}

		const flattened = new Map<string, CatalogObjectWithProvenance>();
		for (const [name, { object, pack }] of byName) {
			const version = detectedVersion(pack, context);
			flattened.set(name, {
				...object,
				pack: provenance(pack),
				members: flattenMembers(object, byName).map((member) => ({
					...member,
					pack: provenance(pack),
					available: isAvailable(member, version),
				})),
			});
		}
		return flattened;
	}
}

/**
 * Own members first, then inherited ones an override has not already claimed:
 * `EntryQuery.status()` narrows `ElementQuery.status()`, and the narrower of the
 * two is the one the project actually calls.
 */
function flattenMembers(
	object: CatalogObject,
	byName: ReadonlyMap<string, { object: CatalogObject; pack: DialectPack }>,
): CatalogMember[] {
	const members: CatalogMember[] = [];
	const seen = new Set<string>();
	let current: CatalogObject | undefined = object;
	const visited = new Set<string>();

	while (current !== undefined && !visited.has(current.name)) {
		visited.add(current.name);
		for (const member of current.members) {
			if (!seen.has(member.name)) {
				seen.add(member.name);
				members.push(member);
			}
		}
		current = current.extends === undefined ? undefined : byName.get(current.extends)?.object;
	}

	return members.sort((a, b) => a.name.localeCompare(b.name));
}

function provenance(pack: DialectPack): PackProvenance {
	return { name: pack.name, displayName: pack.displayName, version: pack.version };
}

function detectedVersion(pack: DialectPack, context: WorkspaceCatalogContext): string | undefined {
	if (pack.detect.versionFrom === undefined) {
		return undefined;
	}
	return context.packageVersions?.[pack.detect.versionFrom];
}

/**
 * Whether an item exists in `version`. An unknown version says yes to
 * everything: guessing wrong here costs a real completion, and the cost of
 * guessing the other way is only an extra one.
 */
export function isAvailable(item: CatalogItem, version: string | undefined): boolean {
	if (version === undefined) {
		return true;
	}
	if (item.sinceVersion !== undefined && compareVersions(version, item.sinceVersion) < 0) {
		return false;
	}
	return item.removedVersion === undefined || compareVersions(version, item.removedVersion) < 0;
}

/** Numeric dotted-version compare. Missing parts are zero; suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
	const leftParts = versionParts(left);
	const rightParts = versionParts(right);
	const length = Math.max(leftParts.length, rightParts.length);

	for (let at = 0; at < length; at++) {
		const difference = (leftParts[at] ?? 0) - (rightParts[at] ?? 0);
		if (difference !== 0) {
			return difference < 0 ? -1 : 1;
		}
	}
	return 0;
}

function versionParts(version: string): number[] {
	return version
		.trim()
		.replace(/^v/i, '')
		.split(/[.\-+]/)
		.map((part) => Number.parseInt(part, 10))
		.filter((part) => !Number.isNaN(part));
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

/** Pack files shipped in `catalogs/`, in activation order. */
export const SHIPPED_PACK_FILES = ['twig-core.json', 'craft.json'] as const;

/**
 * Where a shipped pack file lives.
 *
 * `moduleDir` is tried before `cwd` because it is the only anchor that holds up
 * in a real install: the server runs as a child of the extension host, whose
 * working directory belongs to VS Code, not to the extension. The `cwd`
 * candidates are for running out of the repo — tests and `tsx`.
 *
 * Exported for tests: the layout that matters is the packaged one, which no
 * in-repo run reproduces.
 */
export function resolveCatalogPath(
	moduleDir: string | undefined,
	cwd: string,
	fileName = 'twig-core.json',
): string | undefined {
	const candidates = [
		process.env.TWIG_TOOLBOX_CATALOG_ROOT
			? resolve(process.env.TWIG_TOOLBOX_CATALOG_ROOT, fileName)
			: undefined,
		// The packaged layout: dist/server.js next to catalogs/twig-core.json.
		moduleDir ? resolve(moduleDir, '..', 'catalogs', fileName) : undefined,
		moduleDir ? resolve(moduleDir, 'catalogs', fileName) : undefined,
		resolve(cwd, 'catalogs', fileName),
		resolve(cwd, 'packages', 'extension', 'catalogs', fileName),
	].filter((path) => path !== undefined);

	return candidates.find((path) => existsSync(path));
}
