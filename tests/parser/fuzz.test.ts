import { describe, expect, it } from 'vitest';
import { parse } from '../../packages/parser/src/index';
import { CORPUS_FILES, corpusSource } from './corpus';

/**
 * Truncation fuzzer.
 *
 * Every prefix of a valid template is a state some user's editor passes through
 * on the way to typing it, so the parser has to survive all of them. Cutting the
 * corpus at every offset is a cheap, exhaustive stand-in for "every keystroke".
 *
 * Deterministic by construction: the exhaustive pass has no randomness at all,
 * and the mutation pass draws from a seeded PRNG, so a CI failure reproduces
 * locally from the seed alone.
 */

const SEED = 0x5eed_1234;

/** mulberry32 — small, fast, and identical on every platform and Node version. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Parses and asserts the invariants that must hold for *any* input. */
function expectSurvives(source: string, label: string): void {
	let result;
	try {
		result = parse(source);
	} catch (error) {
		throw new Error(`parse threw on ${label}: ${String(error)}`);
	}
	expect(result.template.start, label).toBe(0);
	expect(result.template.end, label).toBe(source.length);
	for (const error of result.errors) {
		// A range outside the document would crash the LSP layer downstream.
		expect(error.start, `${label}: ${error.code} start`).toBeGreaterThanOrEqual(0);
		expect(error.end, `${label}: ${error.code} end`).toBeLessThanOrEqual(source.length);
		expect(error.end, `${label}: ${error.code} range`).toBeGreaterThanOrEqual(error.start);
	}
}

describe('truncation fuzzer', () => {
	for (const file of CORPUS_FILES) {
		it(`survives every prefix of ${file}`, () => {
			const source = corpusSource(file);
			for (let at = 0; at <= source.length; at++) {
				expectSurvives(source.slice(0, at), `${file} truncated at ${at}`);
			}
		});

		it(`survives every suffix of ${file}`, () => {
			// Suffixes start mid-construct, which exercises the "delimiter with no
			// opener" paths that prefixes never reach.
			const source = corpusSource(file);
			for (let at = 0; at <= source.length; at++) {
				expectSurvives(source.slice(at), `${file} tail from ${at}`);
			}
		});
	}
});

describe('mutation fuzzer', () => {
	const MUTATIONS_PER_FILE = 400;

	for (const file of CORPUS_FILES) {
		it(`survives seeded mutations of ${file}`, () => {
			const source = corpusSource(file);
			// Seeded per file so one file's failure cannot shift another's stream.
			const next = random(SEED + file.length);
			for (let round = 0; round < MUTATIONS_PER_FILE; round++) {
				const mutated = mutate(source, next);
				expectSurvives(mutated, `${file} mutation ${round} (seed ${SEED})`);
			}
		});
	}
});

const NASTY = [
	'{{',
	'}}',
	'{%',
	'%}',
	'{#',
	'#}',
	'"',
	"'",
	'|',
	'.',
	'(',
	')',
	'[',
	']',
	'{',
	'}',
	'#{',
	'\\',
];

/** Applies one random edit: delete a slice, duplicate a slice, or inject a delimiter. */
function mutate(source: string, next: () => number): string {
	const kind = Math.floor(next() * 3);
	const at = Math.floor(next() * source.length);
	const length = Math.min(1 + Math.floor(next() * 20), source.length - at);

	if (kind === 0) {
		return source.slice(0, at) + source.slice(at + length);
	}
	if (kind === 1) {
		return source.slice(0, at) + source.slice(at, at + length) + source.slice(at);
	}
	const token = NASTY[Math.floor(next() * NASTY.length)] as string;
	return source.slice(0, at) + token + source.slice(at);
}

describe('performance budget', () => {
	it('parses a 2,000-line template well inside 20 ms', () => {
		const source = buildLargeTemplate(2000);
		expect(source.split('\n')).toHaveLength(2000);

		// Warm up so the measurement is not dominated by first-call JIT.
		for (let round = 0; round < 5; round++) {
			parse(source);
		}
		const runs: number[] = [];
		for (let round = 0; round < 20; round++) {
			const started = performance.now();
			parse(source);
			runs.push(performance.now() - started);
		}
		runs.sort((a, b) => a - b);
		const median = runs[Math.floor(runs.length / 2)] as number;
		expect(median).toBeLessThan(20);
	});

	it('does not degrade quadratically on many unknown tags', () => {
		// Unknown tags scan ahead for a matching `end<name>`; a template full of
		// them is the pathological case for that scan.
		const measure = (count: number): number => {
			const source = Array.from(
				{ length: count },
				(_, i) => `{% plugin_tag_${i % 7} arg %}<p>{{ x }}</p>`,
			).join('\n');
			for (let round = 0; round < 3; round++) {
				parse(source);
			}
			const started = performance.now();
			parse(source);
			return performance.now() - started;
		};

		measure(200);
		const small = Math.max(measure(500), 0.05);
		const large = measure(2000);
		// 4x the input should cost well under 16x (the quadratic result).
		expect(large / small).toBeLessThan(12);
	});
});

function buildLargeTemplate(lines: number): string {
	const block = [
		'{% block section_INDEX %}',
		'\t{% set items_INDEX = craft.entries().section("news").limit(10).all() %}',
		'\t{% for item in items_INDEX %}',
		'\t\t{% if item.enabled and item.title is not empty %}',
		'\t\t\t<a href="{{ item.url }}" class="{{ loop.first ? \'is-first\' : \'\' }}">',
		'\t\t\t\t{{ item.title|striptags|trim|default("Untitled") }}',
		'\t\t\t\t{{ "id-#{item.id}"|upper }}',
		'\t\t\t</a>',
		'\t\t{% else %}',
		'\t\t\t{# nothing to render #}',
		'\t\t{% endif %}',
		'\t{% endfor %}',
		'{% endblock %}',
	];

	const out: string[] = [];
	for (let index = 0; out.length + block.length <= lines; index++) {
		out.push(...block.map((line) => line.replace(/INDEX/g, String(index))));
	}
	while (out.length < lines) {
		out.push('<hr>');
	}
	return out.join('\n');
}
