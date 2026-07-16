import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParseErrorCode } from '../../packages/parser/src/index';

const here = dirname(fileURLToPath(import.meta.url));

export interface CorpusEntry {
	readonly file: string;
	/**
	 * Error codes this template is *supposed* to produce. Anything else is a
	 * parser bug; an empty list means the template must parse perfectly clean.
	 */
	readonly expected: readonly ParseErrorCode[];
}

/**
 * The parser corpus.
 *
 * It deliberately shares templates with the grammar snapshots in
 * `tests/grammar/fixtures`: highlighting and parsing should agree about what
 * real Twig looks like, and one set of templates keeps them honest together.
 * `tests/parser/fixtures` adds templates whose *structure* matters but whose
 * highlighting is uninteresting.
 */
export const CORPUS: readonly CorpusEntry[] = [
	{ file: '../grammar/fixtures/smoke.twig', expected: [] },
	{ file: '../grammar/fixtures/delimiters.twig', expected: [] },
	{ file: '../grammar/fixtures/expressions.twig', expected: [] },
	{ file: '../grammar/fixtures/verbatim.twig', expected: [] },
	{ file: '../grammar/fixtures/embedded.twig', expected: [] },
	{ file: '../grammar/fixtures/craft.twig', expected: [] },
	{ file: '../grammar/fixtures/real-world.twig', expected: [] },
	// `{% for … if … %}` was removed in Twig 3; the fixture keeps it so we prove
	// we parse it *and* flag it rather than derailing.
	{ file: '../grammar/fixtures/tags.twig', expected: ['removed-in-twig-3'] },
	{ file: 'fixtures/symfony.twig', expected: [] },
	{ file: 'fixtures/macros.twig', expected: [] },
	{ file: 'fixtures/craft-listing.twig', expected: [] },
	{ file: 'fixtures/whitespace.twig', expected: [] },
];

export const CORPUS_FILES: readonly string[] = CORPUS.map((entry) => entry.file);

export function corpusSource(file: string): string {
	return readFileSync(resolve(here, file), 'utf8');
}
