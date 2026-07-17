import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	visit,
	type EmbedTag,
	type Expression,
	type HashLiteral,
	type IncludeTag,
	type SourceRange,
} from '@twig-toolbox/parser';
import type { DocumentStore, ParsedDocument } from './document-store';
import type { TwigToolboxSettings } from './settings';
import type { TwigSymbol } from './symbols';
import type { TemplateResolver, TemplateRoot } from './template-resolver';
import type { TemplateSymbolResolver } from './template-symbols';
import { filePathToUri, uriToFilePath } from './workspace';

/**
 * Where a template's variables come from when they come from its includers.
 *
 * `{% set title = entry.title %}{% include "_partials/hero" %}` puts `title` in
 * the partial's context, and the partial has no way to say so — its own symbol
 * table is file-local. The only place the answer exists is the other direction:
 * every template that includes this one, and what each of them passes. So this
 * builds that edge list once, reversed, and walks it on demand.
 *
 * The index is lazy for a reason the perf budgets care about: nothing here runs
 * until a lookup fails locally, so a session that never hovers an inherited
 * variable never scans the workspace. Parsing itself is the document store's
 * mtime-keyed cache, which every other cross-file feature already populates.
 */

/** How far up the inclusion chain a variable is worth chasing. */
const MAX_DEPTH = 8;

/** A ceiling for pathological workspaces; a real template tree is far under it. */
const MAX_INDEXED_TEMPLATES = 5000;

const SKIPPED_DIRECTORIES = new Set([
	'node_modules',
	'vendor',
	'.git',
	'dist',
	'build',
	'out',
	'storage',
	'cpresources',
	'.cache',
]);

export type InheritedVariableKind = 'variable' | 'loop-variable' | 'with-key';

export interface InheritedVariable {
	readonly name: string;
	readonly kind: InheritedVariableKind;
	/** The template that defines it. */
	readonly uri: string;
	/** That template's name relative to its root, for display. */
	readonly templateName: string;
	readonly definitionRange: SourceRange;
	/** The defining template's full text, so hover can quote the line. */
	readonly source: string;
	/** Right-hand summary, e.g. `= entry.title`. */
	readonly detail?: string;
}

interface WithKey {
	readonly name: string;
	readonly range: SourceRange;
	readonly detail?: string;
}

/**
 * One `{% include %}`/`{% embed %}`, from the side that matters here: what it
 * hands the included template.
 */
interface IncludeSite {
	readonly includerUri: string;
	readonly targetUri: string;
	/** Offset in the includer where the tag sits — the context is read here. */
	readonly offset: number;
	readonly only: boolean;
	/**
	 * `with { … }` keys. Undefined covers both no `with` at all and a `with`
	 * whose keys are not a literal hash (`with someExpression`) — the two behave
	 * alike here, since an unreadable `with` tells us nothing either way.
	 */
	readonly withKeys: readonly WithKey[] | undefined;
}

interface Index {
	/** Target template URI → the sites that include it. */
	readonly sitesByTarget: ReadonlyMap<string, readonly IncludeSite[]>;
	readonly roots: readonly TemplateRoot[];
}

export class TemplateContextIndex {
	private readonly indexes = new Map<string, Index>();

	constructor(
		private readonly documents: DocumentStore,
		private readonly templates: TemplateResolver,
	) {}

	/**
	 * Definitions of `name` reachable from templates that include `targetUri`.
	 *
	 * Empty when nothing resolves — an inferred answer that might be wrong is
	 * worse than no answer, so every rule below fails closed.
	 */
	resolve(
		targetUri: string,
		name: string,
		symbolResolver: TemplateSymbolResolver,
		settings: TwigToolboxSettings,
	): InheritedVariable[] {
		const index = this.indexFor(targetUri, settings);
		if (index === undefined) {
			return [];
		}

		const found = new Map<string, InheritedVariable>();
		const visited = new Set<string>();
		this.walk(index, targetUri, name, symbolResolver, found, visited, 0);
		return [...found.values()];
	}

	/**
	 * Drops the graph when a template changes.
	 *
	 * A rebuild re-reads the tree but re-parses only what actually changed, so
	 * whole-index invalidation stays cheaper than tracking per-file edges — and
	 * it cannot go subtly stale, which is the failure that would matter.
	 */
	invalidate(uri: string): void {
		if (uri.endsWith('.twig')) {
			this.indexes.clear();
		}
	}

	private walk(
		index: Index,
		targetUri: string,
		name: string,
		symbolResolver: TemplateSymbolResolver,
		found: Map<string, InheritedVariable>,
		visited: Set<string>,
		depth: number,
	): void {
		if (depth >= MAX_DEPTH || visited.has(targetUri)) {
			return;
		}
		visited.add(targetUri);

		for (const site of index.sitesByTarget.get(targetUri) ?? []) {
			const key = site.withKeys?.find((candidate) => candidate.name === name);
			if (key !== undefined) {
				// A `with` key is the definition: whatever the includer's own
				// context holds under this name, the callee sees this instead.
				this.record(found, index, site.includerUri, {
					name,
					kind: 'with-key',
					range: key.range,
					...(key.detail === undefined ? {} : { detail: key.detail }),
				});
				continue;
			}
			if (site.only) {
				// `only` replaces the context wholesale, so a name the `with`
				// does not carry does not reach the callee at all. A `with`
				// whose keys we cannot read (`with someHash only`) lands here
				// too: the name might be in there, and might not.
				continue;
			}
			// Without `only` the outer context passes whole, so the search goes
			// on — including past a `with someHash` whose keys we cannot read.
			this.fromIncluder(index, site, name, symbolResolver, found, visited, depth);
		}
	}

	private fromIncluder(
		index: Index,
		site: IncludeSite,
		name: string,
		symbolResolver: TemplateSymbolResolver,
		found: Map<string, InheritedVariable>,
		visited: Set<string>,
		depth: number,
	): void {
		const parsed = this.documents.getParsedFile(site.includerUri);
		if (parsed === undefined) {
			return;
		}

		const symbol = symbolResolver.collect(parsed).resolve(name, site.offset);
		if (symbol !== undefined) {
			// The includer's own definition wins, and ends this branch whether or
			// not it is one worth reporting: an imported macro namespace shadows
			// an inherited variable of the same name just as a `{% set %}` does.
			const kind = inheritedKind(symbol);
			if (kind !== undefined && symbol.definitionRange !== undefined) {
				this.record(found, index, site.includerUri, {
					name,
					kind,
					range: symbol.definitionRange,
					...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
				});
			}
			return;
		}

		// Nothing local to the includer: it may be passing on context it was
		// handed itself. `{% set %}` in A, A includes B, B includes C.
		this.walk(index, site.includerUri, name, symbolResolver, found, visited, depth + 1);
	}

	private record(
		found: Map<string, InheritedVariable>,
		index: Index,
		uri: string,
		definition: {
			readonly name: string;
			readonly kind: InheritedVariableKind;
			readonly range: SourceRange;
			readonly detail?: string;
		},
	): void {
		const parsed = this.documents.getParsedFile(uri);
		if (parsed === undefined) {
			return;
		}
		const key = `${uri}:${definition.range.start}:${definition.range.end}`;
		if (found.has(key)) {
			return;
		}
		found.set(key, {
			name: definition.name,
			kind: definition.kind,
			uri,
			templateName: this.displayName(uri, index.roots),
			definitionRange: definition.range,
			source: parsed.result.source,
			...(definition.detail === undefined ? {} : { detail: definition.detail }),
		});
	}

	private displayName(uri: string, roots: readonly TemplateRoot[]): string {
		const filePath = uriToFilePath(uri);
		if (filePath === undefined) {
			return uri;
		}
		for (const root of roots) {
			const name = this.templates.templateNameForPath(filePath, root);
			if (name !== undefined) {
				return name;
			}
		}
		return filePath;
	}

	private indexFor(fromUri: string, settings: TwigToolboxSettings): Index | undefined {
		const roots = this.templates.getTemplateRoots(fromUri, settings);
		if (roots.length === 0) {
			return undefined;
		}

		const key = roots.map((root) => root.path).join('\0');
		const cached = this.indexes.get(key);
		if (cached !== undefined) {
			return cached;
		}

		const index = this.build(roots, settings);
		this.indexes.set(key, index);
		return index;
	}

	private build(roots: readonly TemplateRoot[], settings: TwigToolboxSettings): Index {
		const sitesByTarget = new Map<string, IncludeSite[]>();
		const seen = new Set<string>();
		for (const root of roots) {
			for (const filePath of templateFiles(root.path, seen)) {
				const uri = filePathToUri(filePath);
				const parsed = this.documents.getParsedFile(uri);
				if (parsed === undefined) {
					continue;
				}
				for (const site of this.sitesIn(parsed, settings)) {
					const existing = sitesByTarget.get(site.targetUri);
					if (existing === undefined) {
						sitesByTarget.set(site.targetUri, [site]);
					} else {
						existing.push(site);
					}
				}
			}
		}
		return { sitesByTarget, roots };
	}

	private sitesIn(parsed: ParsedDocument, settings: TwigToolboxSettings): IncludeSite[] {
		const includerUri = parsed.uri;
		const sites: IncludeSite[] = [];
		visit(parsed.result.template, (node) => {
			if (node.type !== 'IncludeTag' && node.type !== 'EmbedTag') {
				return;
			}
			const tag: IncludeTag | EmbedTag = node;
			if (tag.template?.type !== 'StringLiteral' || tag.template.parts.length > 1) {
				// A computed template name is a template we cannot name, and a
				// guess here would be an edge in the graph that is not real.
				return;
			}
			const hash = tag.variables?.type === 'HashLiteral' ? tag.variables : undefined;
			const withKeys = hash === undefined ? undefined : hashKeys(hash, parsed.result.source);
			for (const target of this.templates.resolve(
				includerUri,
				tag.template.value,
				settings,
			)) {
				sites.push({
					includerUri,
					targetUri: target.uri,
					offset: tag.start,
					only: tag.only,
					withKeys,
				});
			}
		});
		return sites;
	}
}

/** Only `{% set %}` and loop targets travel; a macro's own scope never does. */
function inheritedKind(symbol: TwigSymbol): InheritedVariableKind | undefined {
	switch (symbol.kind) {
		case 'variable':
			return 'variable';
		case 'loop-variable':
			return 'loop-variable';
		default:
			return undefined;
	}
}

function hashKeys(hash: HashLiteral, source: string): WithKey[] {
	const keys: WithKey[] = [];
	for (const entry of hash.entries) {
		if (entry.type !== 'HashEntry') {
			continue;
		}
		const name = hashKeyName(entry.key);
		if (name === undefined) {
			continue;
		}
		const value = entry.value;
		const detail =
			value === undefined ? undefined : `= ${source.slice(value.start, value.end)}`;
		keys.push({
			name,
			range: { start: entry.start, end: entry.end },
			...(detail === undefined ? {} : { detail }),
		});
	}
	return keys;
}

function hashKeyName(key: Expression | undefined): string | undefined {
	if (key?.type === 'Identifier') {
		return key.name;
	}
	return key?.type === 'StringLiteral' && key.parts.length <= 1 ? key.value : undefined;
}

function templateFiles(root: string, seen: Set<string>): string[] {
	const files: string[] = [];
	const walk = (directory: string): void => {
		if (files.length >= MAX_INDEXED_TEMPLATES) {
			return;
		}
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
					walk(path);
				}
			} else if (entry.isFile() && entry.name.endsWith('.twig') && !seen.has(path)) {
				seen.add(path);
				files.push(path);
			}
		}
	};
	walk(root);
	return files;
}
