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
	/**
	 * Absent when the link is derived rather than carried — every member of the
	 * class model, whose URL is a function of its declaring class, its kind, its
	 * name and the project's Craft major. See `craft-api.ts`.
	 */
	docsUrl?: string;
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
	/** Absent for a class, whose reference page is derived from its name. */
	docsUrl?: string;
	members: CatalogMember[];
}

/**
 * The deep class model, shipped beside its dialect pack rather than inside it.
 *
 * Same objects, same `extends`, same version gating — the split is about *when*,
 * not about shape. `craft.json` is what a Craft project needs to answer its
 * first completion; this is ~10× the size and answers nothing until someone
 * types a `.`, so it is a file the registry opens on the first member lookup and
 * never before.
 *
 * `pack` names the dialect pack it belongs to. That is what ties it to an
 * activation rule and a `versionFrom`: these classes exist for a project that
 * has `craftcms/cms`, and which of their members exist depends on which version.
 */
export interface ClassPack {
	schemaVersion: 1;
	pack: string;
	classes: CatalogObject[];
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
	/**
	 * The object this member was reached through — the one being dotted into,
	 * which is not the one it was stored on once `extends` is flattened.
	 */
	owner: string;
	/**
	 * The object that declares it, which is where its documentation lives. Comes
	 * off `source.phpClass` when a trait or a framework parent declared it, and
	 * is otherwise the catalog object it was stored on.
	 */
	declaredOn: string;
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

/**
 * Loads a pack's class model, if it has one. Called at most once per pack.
 *
 * A function rather than the pack itself, because the whole point of the split
 * is that the file is not read until something asks a question that needs it.
 */
export type ClassPackLoader = () => ClassPack | undefined;

export class CatalogRegistry {
	readonly packs: DialectPack[];
	private readonly objectCache = new Map<string, Map<string, CatalogObjectWithProvenance>>();
	private readonly classPackLoaders: ReadonlyMap<string, ClassPackLoader>;
	private readonly classPacks = new Map<string, ClassPack | undefined>();

	private constructor(
		packs: DialectPack[],
		classPackLoaders: ReadonlyMap<string, ClassPackLoader> = new Map(),
	) {
		this.packs = packs;
		this.classPackLoaders = classPackLoaders;
	}

	static fromPacks(
		packs: DialectPack[],
		classPackLoaders?: ReadonlyMap<string, ClassPackLoader>,
	): CatalogRegistry {
		return new CatalogRegistry(packs, classPackLoaders);
	}

	static fromFiles(
		paths: string[],
		classPackPaths: Record<string, string> = {},
	): CatalogRegistry {
		const loaders = new Map<string, ClassPackLoader>(
			Object.entries(classPackPaths).map(([pack, path]) => [
				pack,
				() => JSON.parse(readFileSync(path, 'utf8')) as ClassPack,
			]),
		);

		return new CatalogRegistry(
			paths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as DialectPack),
			loaders,
		);
	}

	static loadDefault(): CatalogRegistry {
		const moduleDir = typeof __dirname === 'string' ? __dirname : undefined;
		const paths = SHIPPED_PACK_FILES.map((file) =>
			resolveCatalogPath(moduleDir, process.cwd(), file),
		).filter((path): path is string => path !== undefined);

		// The path is resolved inside the thunk on purpose: `existsSync` on a file
		// nothing has asked for yet is exactly the startup cost the split exists
		// to avoid.
		const loaders = new Map<string, ClassPackLoader>(
			Object.entries(SHIPPED_CLASS_PACK_FILES).map(([pack, file]) => [
				pack,
				() => {
					const path = resolveCatalogPath(moduleDir, process.cwd(), file);
					return path === undefined
						? undefined
						: (JSON.parse(readFileSync(path, 'utf8')) as ClassPack);
				},
			]),
		);

		return new CatalogRegistry(
			paths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as DialectPack),
			loaders,
		);
	}

	/**
	 * A pack's class model, read on first use and remembered — including the
	 * answer "there isn't one", which is worth remembering just as much.
	 */
	private classPackFor(packName: string): ClassPack | undefined {
		if (this.classPacks.has(packName)) {
			return this.classPacks.get(packName);
		}
		const loaded = this.classPackLoaders.get(packName)?.();
		this.classPacks.set(packName, loaded);
		return loaded;
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
			// Only an active pack's classes are read. A plain Twig project never
			// opens the Craft class model, and never pays for it.
			for (const object of this.classPackFor(pack.name)?.classes ?? []) {
				byName.set(object.name, { object, pack });
			}
		}

		const flattened = new Map<string, CatalogObjectWithProvenance>();
		for (const [name, { object, pack }] of byName) {
			const version = detectedVersion(pack, context);
			flattened.set(name, {
				...object,
				pack: provenance(pack),
				members: flattenMembers(object, byName).map(({ member, declaredOn }) => ({
					...member,
					pack: provenance(pack),
					available: isAvailable(member, version),
					owner: name,
					declaredOn: member.source?.phpClass ?? declaredOn,
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
 *
 * This is the read side of the pack's inheritance factoring. `craft\base\Element`
 * is stored once and named by every element type; walking the chain here is what
 * turns that back into the ~250 members `entry.` should offer, and it costs a
 * pointer-chase down a chain three or four links long.
 *
 * Each member is returned with the object it was stored on, because that is not
 * recoverable afterwards and it is what decides where the member is documented:
 * `entry.hasErrors` is declared by `yii\base\Model`, and by the time it is
 * sitting on the flattened `craft\elements\Entry` it looks exactly like a member
 * Entry declared itself.
 */
interface FlattenedMember {
	readonly member: CatalogMember;
	/** Catalog object the member was stored on. */
	readonly declaredOn: string;
}

function flattenMembers(
	object: CatalogObject,
	byName: ReadonlyMap<string, { object: CatalogObject; pack: DialectPack }>,
): FlattenedMember[] {
	const members: FlattenedMember[] = [];
	const seen = new Set<string>();
	let current: CatalogObject | undefined = object;
	const visited = new Set<string>();

	while (current !== undefined && !visited.has(current.name)) {
		visited.add(current.name);
		for (const member of current.members) {
			if (!seen.has(member.name)) {
				seen.add(member.name);
				members.push({ member, declaredOn: current.name });
			}
		}
		current = current.extends === undefined ? undefined : byName.get(current.extends)?.object;
	}

	return members.sort((a, b) => a.member.name.localeCompare(b.member.name));
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
 * Class-model files shipped in `catalogs/`, by the pack that owns each.
 *
 * Keyed by pack name so the registry can decide whether it needs a file without
 * opening it: the Craft class model is only ever relevant to a project that
 * activated the Craft pack, and that is knowable from `composer.json` alone.
 */
export const SHIPPED_CLASS_PACK_FILES: Record<string, string> = {
	craft: 'craft-classes.json',
};

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
