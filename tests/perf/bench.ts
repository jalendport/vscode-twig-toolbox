/**
 * Prints the perf report recorded in `docs/perf-notes.md`.
 *
 * `npm run bench` — run it with `--expose-gc` (the script does) so the memory
 * figure is of retained heap rather than whatever had not been collected yet.
 */

import {
	measureBulkEditStalls,
	measureCompletions,
	measureLargeParse,
	measureProjectMemory,
	max,
	median,
	p95,
} from './measure';

const ms = (value: number): string => `${value.toFixed(2)} ms`;

function verdict(actual: number, budget: number): string {
	return actual <= budget ? 'PASS' : 'FAIL';
}

function heading(title: string): void {
	console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

console.log(`Twig Toolbox performance report`);
console.log(`node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`gc exposed: ${globalThis.gc ? 'yes' : 'no (memory figure will be noisy)'}`);

heading('Completion latency (budget: p95 < 100 ms)');
const completions = measureCompletions();
for (const probe of completions.perProbe) {
	const items = completions.itemCounts.get(probe.label) ?? 0;
	console.log(
		`  ${probe.label.padEnd(24)} median ${ms(median(probe.samples)).padStart(9)}` +
			`  p95 ${ms(p95(probe.samples)).padStart(9)}` +
			`  ${String(items).padStart(4)} items${items === 0 ? '  <- TIMED NOTHING' : ''}`,
	);
}
console.log(
	`  ${'ALL PROBES'.padEnd(24)} median ${ms(median(completions.all)).padStart(9)}` +
		`  p95 ${ms(p95(completions.all)).padStart(9)}  ${verdict(p95(completions.all), 100)}`,
);

heading('Parse of a 2,000-line template (budget: < 20 ms)');
const parses = measureLargeParse();
console.log(
	`  median ${ms(median(parses))}  p95 ${ms(p95(parses))}  max ${ms(max(parses))}  ` +
		`${verdict(p95(parses), 20)}`,
);

heading('Project memory, 500 templates parsed and retained (budget: < 150 MB)');
const memory = measureProjectMemory();
console.log(
	`  ${memory.templateCount} templates  heap retained ${memory.heapUsedMb.toFixed(1)} MB  ` +
		`rss delta ${memory.rssDeltaMb.toFixed(1)} MB  ${verdict(memory.heapUsedMb, 150)}`,
);
console.log(
	`  (harness rss baseline ${memory.rssBaselineMb.toFixed(1)} MB — tsx's compiler, not the server)`,
);

heading('Event-loop stalls during bulk edits (budget: no stall > 250 ms)');
const stalls = measureBulkEditStalls();
console.log(
	`  ${stalls.length} edits  median ${ms(median(stalls))}  p95 ${ms(p95(stalls))}  ` +
		`worst ${ms(max(stalls))}  ${verdict(max(stalls), 250)}`,
);

console.log('');
