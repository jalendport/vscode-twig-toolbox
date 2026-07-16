import { describe, expect, it } from 'vitest';
import { parse } from '../../packages/parser/src/index';
import { CORPUS, corpusSource } from './corpus';

describe('parser corpus', () => {
	for (const { file, expected } of CORPUS) {
		describe(file, () => {
			const source = corpusSource(file);
			const result = parse(source);

			it('reports no unexpected errors', () => {
				const unexpected = result.errors
					.filter((error) => !expected.includes(error.code))
					.map(
						(error) =>
							`${error.code} @${error.start}: ${error.message} — ${excerpt(source, error)}`,
					);
				expect(unexpected).toEqual([]);
			});

			it('covers the whole document', () => {
				expect(result.template.start).toBe(0);
				expect(result.template.end).toBe(source.length);
			});

			it('matches its AST snapshot', () => {
				expect(outline(result.template)).toMatchSnapshot();
			});
		});
	}
});

function excerpt(source: string, error: { start: number; end: number }): string {
	const from = Math.max(0, error.start - 25);
	const to = Math.min(source.length, Math.max(error.end, error.start) + 25);
	return JSON.stringify(source.slice(from, to));
}

/**
 * A compact, position-free tree rendering. Snapshotting raw nodes would make
 * every offset a tripwire; this shows structure, which is what the corpus is
 * meant to pin down.
 */
function outline(node: unknown): string {
	const lines: string[] = [];
	walk(node, 0, undefined, lines);
	return lines.join('\n');
}

function walk(value: unknown, depth: number, key: string | undefined, lines: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			walk(item, depth, key, lines);
		}
		return;
	}
	if (typeof value !== 'object' || value === null) {
		return;
	}
	const node = value as Record<string, unknown> & { type?: unknown };
	if (typeof node.type !== 'string') {
		return;
	}

	// Text nodes dominate real templates and say nothing about structure.
	if (node.type === 'Text') {
		return;
	}

	const prefix = key === undefined ? '' : `${key}: `;
	lines.push(`${'  '.repeat(depth)}${prefix}${node.type}${label(node)}`);
	for (const [childKey, child] of Object.entries(node)) {
		if (childKey === 'type' || childKey === 'start' || childKey === 'end') {
			continue;
		}
		walk(child, depth + 1, childKey, lines);
	}
}

function label(node: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of ['name', 'operator', 'value', 'raw']) {
		const value = node[key];
		if (typeof value === 'string' && value !== '') {
			parts.push(
				`${key}=${JSON.stringify(value.length > 30 ? `${value.slice(0, 30)}…` : value)}`,
			);
		} else if (typeof value === 'boolean' || typeof value === 'number') {
			parts.push(`${key}=${String(value)}`);
		}
	}
	return parts.length === 0 ? '' : ` (${parts.join(' ')})`;
}
