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
