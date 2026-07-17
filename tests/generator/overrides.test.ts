import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { DialectPack } from '../../packages/language-server/src/catalog';
import { deepMerge } from '../../scripts/lib/php';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The top rung of the `sinceVersion` ladder: a hand override beats everything
 * the generators worked out for themselves.
 *
 * `catalogs/overrides/` exists because scraping has a floor — Craft's docs are
 * written by people, its changelog too, and where both are wrong about a name
 * the only fix is to say so by hand. That fix is worth nothing if a regenerate
 * quietly reverts it, so both generators apply the overrides last, over the
 * merged pack, and this is the two halves of that: the merge itself, and the
 * evidence it happens after everything else.
 */

describe('override layer', () => {
	it('replaces a generated version rather than merging with it', () => {
		const generated = { name: 'uuid', sinceVersion: '4.17.0', description: 'A UUID.' };

		expect(deepMerge(generated, { sinceVersion: '4.16.0' })).toEqual({
			name: 'uuid',
			sinceVersion: '4.16.0',
			description: 'A UUID.',
		});
	});

	// An override says only what it wants to change; everything the scrape got
	// right has to survive it untouched.
	it('leaves the fields an override does not name alone', () => {
		const generated = { name: 'money', sinceVersion: '4.0.0', docsUrl: 'https://example.com' };

		expect(deepMerge(generated, { docsUrl: 'https://craftcms.com/docs' })).toEqual({
			name: 'money',
			sinceVersion: '4.0.0',
			docsUrl: 'https://craftcms.com/docs',
		});
	});

	/**
	 * The generators call `applyOverrides` on the finished pack, so an override
	 * is the last word by construction. This is that construction observed from
	 * outside: a value that exists only in the overrides file, present in the
	 * pack the generator wrote.
	 */
	it('lands in the shipped pack', () => {
		const overrides = JSON.parse(
			readFileSync(resolve(repoRoot, 'catalogs', 'overrides', 'craft.json'), 'utf8'),
		) as { entries: { tags: { name: string; completionSnippet?: string }[] } };
		const pack = JSON.parse(
			readFileSync(resolve(repoRoot, 'catalogs', 'craft.json'), 'utf8'),
		) as DialectPack;

		const overridden = overrides.entries.tags.find(
			(tag) => tag.completionSnippet !== undefined,
		) as { name: string; completionSnippet: string };

		expect(
			pack.entries.tags.find((tag) => tag.name === overridden.name)?.completionSnippet,
		).toBe(overridden.completionSnippet);
	});
});
