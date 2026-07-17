/**
 * The measurements behind milestone 11's perf budgets.
 *
 * Shared by `bench.ts` (prints a report) and `perf.test.ts` (asserts budgets),
 * so the numbers in `docs/perf-notes.md` and the numbers CI enforces come from
 * one implementation rather than two that drift.
 */

import { parse } from '@twig-toolbox/parser';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
	CatalogRegistry,
	SHIPPED_CLASS_PACK_FILES,
	SHIPPED_PACK_FILES,
	resolveCatalogPath,
} from '../../packages/language-server/src/catalog';
import { createCraftMemberProvider } from '../../packages/language-server/src/craft-members';
import { createParsedDocument } from '../../packages/language-server/src/document-store';
import { getMergedCompletions } from '../../packages/language-server/src/merge';
import { generateLargeTemplate, generateProject } from './fixture';

export interface Sample {
	readonly label: string;
	readonly samples: readonly number[];
}

export function percentile(samples: readonly number[], fraction: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
	return sorted[Math.max(0, index)] ?? 0;
}

export const median = (samples: readonly number[]): number => percentile(samples, 0.5);
export const p95 = (samples: readonly number[]): number => percentile(samples, 0.95);
export const max = (samples: readonly number[]): number => Math.max(...samples);

/** Real shipped catalogs — a stub pack would measure the wrong thing entirely. */
export function loadRealRegistry(): CatalogRegistry {
	const paths = SHIPPED_PACK_FILES.map((file) =>
		resolveCatalogPath(undefined, process.cwd(), file),
	).filter((path): path is string => path !== undefined);

	if (paths.length !== SHIPPED_PACK_FILES.length) {
		throw new Error('Shipped catalogs not found — run `npm run build` first');
	}

	// The class models too, and lazily, exactly as the server wires them: they are
	// the larger half of what a member completion touches, and a registry without
	// them would post a flattering number for work the real one does.
	const classPackPaths: Record<string, string> = {};
	for (const [pack, file] of Object.entries(SHIPPED_CLASS_PACK_FILES)) {
		const path = resolveCatalogPath(undefined, process.cwd(), file);
		if (path === undefined) {
			throw new Error(`Shipped class catalog "${file}" not found`);
		}
		classPackPaths[pack] = path;
	}

	return CatalogRegistry.fromFiles(paths, classPackPaths);
}

export interface CatalogLoadMeasurement {
	/** Reading and parsing the eagerly-shipped packs — what startup pays. */
	readonly startupMs: number;
	/** The first member lookup: reads the class model, then flattens it. */
	readonly firstLookupMs: number;
	/** Every lookup after that, which is served from the flatten cache. */
	readonly warmLookupMs: number;
	/** Heap the eager packs retain. */
	readonly startupHeapMb: number;
	/** Heap the class model adds on top, once something needs it. */
	readonly classModelHeapMb: number;
}

/**
 * What the catalogs cost to load, split at the lazy boundary.
 *
 * Two numbers rather than one, because the split is the point. Startup pays for
 * `twig-core.json` and `craft.json` and nothing else; the class model — the
 * larger half — is not read until a member lookup asks for it, and a session
 * that never dots into anything never pays it at all.
 *
 * Measured on a Craft context, which is the expensive case: a plain Twig project
 * never activates the Craft pack and so never opens either Craft file.
 */
export function measureCatalogLoad(): CatalogLoadMeasurement {
	globalThis.gc?.();
	const before = process.memoryUsage();

	const startedLoad = performance.now();
	const registry = loadRealRegistry();
	registry.getMergedEntries(CRAFT_CONTEXT);
	const startupMs = performance.now() - startedLoad;

	globalThis.gc?.();
	const loaded = process.memoryUsage();

	const startedFirst = performance.now();
	const objects = registry.getMergedObjects(CRAFT_CONTEXT);
	const firstLookupMs = performance.now() - startedFirst;

	const startedWarm = performance.now();
	registry.getMergedObjects(CRAFT_CONTEXT);
	const warmLookupMs = performance.now() - startedWarm;

	globalThis.gc?.();
	const after = process.memoryUsage();

	// Keep it reachable, or the heap reading is of a model already collected.
	if (objects.size === 0) {
		throw new Error('no objects — the Craft pack did not activate');
	}

	return {
		startupMs,
		firstLookupMs,
		warmLookupMs,
		startupHeapMb: (loaded.heapUsed - before.heapUsed) / 1024 / 1024,
		classModelHeapMb: (after.heapUsed - loaded.heapUsed) / 1024 / 1024,
	};
}

/** A Craft project context, so the Craft pack activates and gets measured too. */
const CRAFT_CONTEXT = {
	composerPackages: ['craftcms/cms'],
	packageVersions: { 'craftcms/cms': '5.0.0' },
};

/** Cursor positions that exercise each completion path a user actually hits. */
const COMPLETION_PROBES: readonly { label: string; text: string }[] = [
	{ label: 'tag name', text: `{% ‸ %}` },
	{ label: 'filter after pipe', text: `{{ entry.title|‸ }}` },
	{ label: 'function name', text: `{{ ‸ }}` },
	{ label: 'test after is', text: `{{ entry is ‸ }}` },
	{ label: 'craft.* member', text: `{{ craft.‸ }}` },
	{ label: 'query chain member', text: `{{ craft.entries.section('news').‸ }}` },
	{ label: 'html tag', text: `<sec‸` },
	{ label: 'html attribute', text: `<div cla‸>` },
];

export interface CompletionMeasurement {
	readonly perProbe: readonly Sample[];
	readonly all: readonly number[];
	/** Items each probe returned — a probe that returns none timed nothing. */
	readonly itemCounts: ReadonlyMap<string, number>;
}

/**
 * Completion latency with a large document already open.
 *
 * The probe text is appended to a real 2,000-line template rather than measured
 * alone: a completion in an empty file is not the completion anyone waits on.
 */
export function measureCompletions(iterations = 60): CompletionMeasurement {
	const registry = loadRealRegistry();
	const memberProviders = [createCraftMemberProvider(registry)];
	const prefix = `${generateLargeTemplate(2000)}\n{% block extra %}\n`;
	const perProbe: Sample[] = [];
	const all: number[] = [];
	const itemCounts = new Map<string, number>();

	for (const probe of COMPLETION_PROBES) {
		const marked = prefix + probe.text;
		const offset = marked.indexOf('‸');
		const text = marked.slice(0, offset) + marked.slice(offset + 1);
		const samples: number[] = [];

		for (let iteration = 0; iteration < iterations; iteration += 1) {
			// A fresh document each time: the user's next keystroke invalidates
			// the parse, so a warm cache is not the case worth defending.
			const parsed = createParsedDocument(
				TextDocument.create(
					'file:///project/templates/index.twig',
					'twig',
					iteration,
					text,
				),
				CRAFT_CONTEXT,
			);
			const started = performance.now();
			const items = getMergedCompletions(parsed, offset, {
				catalogRegistry: registry,
				memberProviders,
			});
			const elapsed = performance.now() - started;

			// Discard a short warmup: JIT tiering, not the steady state a user sees.
			if (iteration >= 10) {
				samples.push(elapsed);
				all.push(elapsed);
				itemCounts.set(probe.label, items.length);
			}
		}

		perProbe.push({ label: probe.label, samples });
	}

	return { perProbe, all, itemCounts };
}

/** Parse time for a 2,000-line template, cold each iteration. */
export function measureLargeParse(iterations = 60): number[] {
	const source = generateLargeTemplate(2000);
	const samples: number[] = [];

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const started = performance.now();
		parse(source);
		const elapsed = performance.now() - started;
		if (iteration >= 10) {
			samples.push(elapsed);
		}
	}

	return samples;
}

export interface MemoryMeasurement {
	/** Heap the project's parses retain — the figure the budget is about. */
	readonly heapUsedMb: number;
	/** RSS growth across the same span, which tracks the heap plus allocator slack. */
	readonly rssDeltaMb: number;
	/**
	 * RSS before any template is parsed. Under `tsx` this carries the TypeScript
	 * compiler, which the shipped server (a single esbuild bundle) never loads —
	 * so absolute RSS here measures the harness, and only the deltas transfer.
	 */
	readonly rssBaselineMb: number;
	readonly templateCount: number;
}

/**
 * Heap held by a whole project's parses at once.
 *
 * The worst case the budget is about: every template parsed and retained, which
 * is what a project-wide feature (go-to-definition across roots) can reach.
 */
export function measureProjectMemory(templateCount = 500): MemoryMeasurement {
	const project = generateProject(templateCount);
	const registry = loadRealRegistry();
	globalThis.gc?.();
	const before = process.memoryUsage();

	const parsed = [...project.templates].map(([path, source]) =>
		createParsedDocument(
			TextDocument.create(`file:///project/templates/${path}`, 'twig', 1, source),
			CRAFT_CONTEXT,
		),
	);
	// Touch the registry the way a real session does, so its caches are counted.
	registry.getMergedEntries(CRAFT_CONTEXT);

	globalThis.gc?.();
	const after = process.memoryUsage();
	// Keep the parses reachable across the measurement, or the heap reading is
	// of a project that has already been collected.
	if (parsed.length !== project.templates.size) {
		throw new Error('lost a parse');
	}

	return {
		heapUsedMb: (after.heapUsed - before.heapUsed) / 1024 / 1024,
		rssDeltaMb: (after.rss - before.rss) / 1024 / 1024,
		rssBaselineMb: before.rss / 1024 / 1024,
		templateCount: parsed.length,
	};
}

/**
 * The longest single synchronous parse during a burst of edits.
 *
 * The server parses on a debounce timer on the main thread, so one parse is
 * exactly the span the event loop cannot service anything else. Measuring the
 * parse the debounce would run is measuring the stall it would cause.
 */
export function measureBulkEditStalls(edits = 120): number[] {
	const base = generateLargeTemplate(2000);
	const stalls: number[] = [];
	let source = base;

	for (let edit = 0; edit < edits; edit += 1) {
		// Type into the middle: shifts every later offset, worst case for reuse.
		const midpoint = Math.floor(source.length / 2);
		source = `${source.slice(0, midpoint)}x${source.slice(midpoint)}`;
		const document = TextDocument.create(
			'file:///project/templates/edit.twig',
			'twig',
			edit,
			source,
		);

		const started = performance.now();
		createParsedDocument(document, CRAFT_CONTEXT);
		stalls.push(performance.now() - started);
	}

	return stalls;
}
