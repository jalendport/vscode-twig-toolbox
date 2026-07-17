/**
 * Milestone 11's perf budgets, as tests.
 *
 * The budgets are the spec's, not the current numbers: they are a ceiling to
 * notice regressions against, and every one of them currently passes with more
 * than an order of magnitude of headroom (see `docs/perf-notes.md`). That gap
 * is deliberate — a budget pinned to today's measurement would fail on any CI
 * runner having a slow minute and teach everyone to ignore it.
 */

import { describe, expect, it } from 'vitest';
import {
	max,
	measureBulkEditStalls,
	measureCatalogLoad,
	measureCompletions,
	measureLargeParse,
	measureProjectMemory,
	p95,
} from './measure';

describe('completion latency', () => {
	it('answers within 100 ms at p95 in a 2,000-line document', () => {
		const measurement = measureCompletions(30);

		expect(p95(measurement.all)).toBeLessThan(100);
	});

	it('times probes that actually return completions', () => {
		const measurement = measureCompletions(12);

		// A probe returning nothing would post a flattering time for work that
		// never happened, which is the way this suite would lie if it lied.
		for (const [label, count] of measurement.itemCounts) {
			expect(count, `probe "${label}" returned no completions`).toBeGreaterThan(0);
		}
	});
});

describe('parser', () => {
	it('parses a 2,000-line template within 20 ms at p95', () => {
		expect(p95(measureLargeParse(30))).toBeLessThan(20);
	});
});

describe('memory', () => {
	it('retains under 150 MB with a 500-template project parsed', () => {
		const measurement = measureProjectMemory(500);

		expect(measurement.templateCount).toBeGreaterThanOrEqual(500);
		expect(measurement.heapUsedMb).toBeLessThan(150);
	});
});

describe('bulk edits', () => {
	it('never blocks the event loop for more than 250 ms', () => {
		expect(max(measureBulkEditStalls(60))).toBeLessThan(250);
	});
});

/**
 * The catalogs, budgeted either side of the lazy boundary.
 *
 * The Craft class model is the larger half of everything shipped, and the deal
 * that makes it affordable is that startup never touches it. These budgets are
 * that deal written down: if the class model ever ends up loaded eagerly, the
 * startup numbers are where it shows, and nothing else in the suite would
 * notice.
 */
describe('catalog load', () => {
	const measurement = measureCatalogLoad();

	it('loads the eager packs within 50 ms', () => {
		expect(measurement.startupMs).toBeLessThan(50);
	});

	/**
	 * The claim the split is for. Startup reads `twig-core.json` and `craft.json`
	 * and stops; the class model is ~3× their size, so a startup that had loaded
	 * it would not fit in this.
	 */
	it('keeps the eager packs under 10 MB of heap', () => {
		expect(measurement.startupHeapMb).toBeLessThan(10);
	});

	it('reads and flattens the class model within 150 ms of the first lookup', () => {
		expect(measurement.firstLookupMs).toBeLessThan(150);
	});

	it('keeps the class model under 25 MB once it is loaded', () => {
		expect(measurement.classModelHeapMb).toBeLessThan(25);
	});

	/**
	 * The first lookup pays for every one after it. Member completions fire on
	 * every keystroke after a `.`, and re-flattening ten element types per
	 * keystroke is the shape of the bug this guards.
	 */
	it('serves later lookups from cache in under 5 ms', () => {
		expect(measurement.warmLookupMs).toBeLessThan(5);
	});
});
