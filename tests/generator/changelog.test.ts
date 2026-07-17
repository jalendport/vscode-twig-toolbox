import { describe, expect, it } from 'vitest';

import { parseCraftChangelog, parseTwigChangelog } from '../../scripts/lib/changelog';

/**
 * The changelog parser, as tests.
 *
 * Every line quoted below is a real line from the file it claims to come from,
 * copied rather than composed. That is the point: this parser reads prose, and
 * prose is only as parseable as the people writing it were consistent. A test
 * over invented lines would prove the regexes match themselves.
 *
 * The rejections carry more weight than the claims. A missed version costs
 * precision the pack survives without — the docs badge, the 4-vs-5 diff, or no
 * gating at all is waiting underneath. A wrong one gates a name out of the
 * projects that have it, which is a completion that silently stops appearing.
 */

describe('Craft changelog', () => {
	it('reads the release each Twig name was added in', () => {
		const versions = parseCraftChangelog(
			[
				'# Release Notes for Craft CMS 4',
				'',
				'## 4.3.0 - 2022-08-09',
				'',
				'- Added the `|boolean` Twig filter. ([#11792](https://github.com/craftcms/cms/pull/11792))',
				'',
				'## 4.0.0 - 2022-05-04',
				'',
				'- Added the `|money` Twig filter.',
				'- Added the `collect()` Twig function.',
			].join('\n'),
			4,
		);

		expect(versions.filters.get('boolean')).toBe('4.3.0');
		expect(versions.filters.get('money')).toBe('4.0.0');
		expect(versions.functions.get('collect')).toBe('4.0.0');
	});

	it('reads every name a release added in one line', () => {
		const versions = parseCraftChangelog(
			[
				'## 5.0.0 - 2024-03-26',
				'',
				'- Added the `entryType()` and `fieldValueSql()` Twig functions. ([#14557](https://github.com/craftcms/cms/discussions/14557))',
				'- Added the `|firstWhere` and `|flatten` Twig filters.',
			].join('\n'),
			5,
		);

		expect(versions.functions.get('entryType')).toBe('5.0.0');
		expect(versions.functions.get('fieldValueSql')).toBe('5.0.0');
		expect(versions.filters.get('firstWhere')).toBe('5.0.0');
		expect(versions.filters.get('flatten')).toBe('5.0.0');
	});

	// Craft calls its globals "global Twig variables", and calls its
	// control-panel helpers "global Twig functions" — the word `global` is not
	// what makes a name a global, the word `variable` is.
	it('tells a global variable from a global function', () => {
		const versions = parseCraftChangelog(
			[
				'## 5.6.0 - 2025-02-04',
				'',
				'- Added the `primarySite` global Twig variable. ([#16370](https://github.com/craftcms/cms/discussions/16370))',
				'- Added a new `_globals` global Twig variable for front-end templates, which can be used to store custom values in a global scope.',
				'- Added the `fieldLayoutDesigner()` and `cardViewDesigner()` global Twig functions for control panel templates.',
			].join('\n'),
			5,
		);

		expect(versions.globals.get('primarySite')).toBe('5.6.0');
		expect(versions.globals.get('_globals')).toBe('5.6.0');
		expect(versions.globals.get('fieldLayoutDesigner')).toBeUndefined();
		expect(versions.functions.get('fieldLayoutDesigner')).toBe('5.6.0');
	});

	it('strips the sigils Craft writes names with', () => {
		const versions = parseCraftChangelog(
			['## 4.4.0 - 2022-11-01', '', '- Added the `{% dd %}` Twig tag.'].join('\n'),
			4,
		);

		expect(versions.tags.get('dd')).toBe('4.4.0');
	});

	/**
	 * The lines that name a Twig thing and are not about adding one. Every one of
	 * these puts a real name next to a real kind word, which is exactly what a
	 * looser parser would key on.
	 */
	it('claims nothing from a line that is not an addition', () => {
		const versions = parseCraftChangelog(
			[
				'## 5.1.0 - 2024-04-30',
				'',
				'- The `|number` Twig filter now has a `locale` argument. ([#18823](https://github.com/craftcms/cms/issues/18823))',
				'- Deprecated the `ucfirst` Twig filter. `capitalize` should be used instead.',
				'- Fixed a PHP deprecation error that could occur when applying the `replace` Twig filter to a `null` variable.',
				'- Removed the `craft.matrixBlocks()` Twig function. `craft.entries()` should be used instead.',
				'- The `|default` Twig filter and `is empty` Twig test now treat all `yii\\base\\Model` instances as not empty.',
			].join('\n'),
			5,
		);

		expect(versions.filters.get('number')).toBeUndefined();
		expect(versions.filters.get('ucfirst')).toBeUndefined();
		expect(versions.filters.get('replace')).toBeUndefined();
		expect(versions.functions.get('matrixBlocks')).toBeUndefined();
		expect(versions.filters.get('default')).toBeUndefined();
	});

	it('claims nothing from an addition that is not a Twig name', () => {
		const versions = parseCraftChangelog(
			[
				'## 5.7.0 - 2025-04-15',
				'',
				'- Added the `enableTwigSandbox` config setting. ([#18208](https://github.com/craftcms/cms/pull/18208))',
				'- Added `craft\\web\\View::setTwig()`.',
				'- Added the `preloadSingles` config setting, which causes front-end Twig templates to automatically preload Single section entries which are referenced in the template.',
				'- Added `craft\\web\\twig\\SafeHtml`, which can be implemented by classes whose `__toString()` method should be considered HTML-safe by Twig.',
			].join('\n'),
			5,
		);

		for (const kind of ['tags', 'filters', 'functions', 'tests', 'globals'] as const) {
			expect([...versions[kind].keys()]).toEqual([]);
		}
	});

	/**
	 * `h1()`…`h6()` is a range written for a human. Reading it literally claims
	 * two of the six names and invents nothing — but a parser that treats `…` as
	 * punctuation it can skip is a parser guessing at a sentence it does not
	 * understand, so the line goes untouched, `heading()` and `h()` with it.
	 */
	it('claims nothing from a line that abbreviates its names', () => {
		const versions = parseCraftChangelog(
			[
				'## 5.9.0 - 2025-11-18',
				'',
				'- Added the `heading()`/`h()` and `h1()`…`h6()` Twig functions. ([#18524](https://github.com/craftcms/cms/pull/18524))',
			].join('\n'),
			5,
		);

		expect([...versions.functions.keys()]).toEqual([]);
	});

	/**
	 * Craft 5.9.0 announced `uuid()` twice, once per changelog entry, and 4.17.0
	 * backported it. Within one major the earliest claim is the true one; across
	 * the two, the generator decides which major may speak at all.
	 */
	it('takes the earliest release that claims a name', () => {
		const versions = parseCraftChangelog(
			[
				'## 5.9.1 - 2025-11-25',
				'',
				'- Added the `uuid()` Twig function.',
				'',
				'## 5.9.0 - 2025-11-18',
				'',
				'- Added the `uuid()` Twig function.',
			].join('\n'),
			5,
		);

		expect(versions.functions.get('uuid')).toBe('5.9.0');
	});

	it('ignores releases of another major', () => {
		const versions = parseCraftChangelog(
			[
				'## 5.0.0 - 2024-03-26',
				'',
				'- Added the `|flatten` Twig filter.',
				'',
				'## 4.9.0 - 2023-06-01',
				'',
				'- Added the `|address` Twig filter.',
			].join('\n'),
			5,
		);

		expect(versions.filters.get('flatten')).toBe('5.0.0');
		expect(versions.filters.get('address')).toBeUndefined();
	});
});

describe('Twig changelog', () => {
	it('reads the release each name was added in', () => {
		const versions = parseTwigChangelog(
			[
				'# 3.19.0 (2024-12-29)',
				'',
				' * Add the `invoke` filter',
				' * Add the `enum` function',
				'',
				'# 3.13.0 (2024-09-17)',
				'',
				' * Add the `types` tag (experimental)',
			].join('\n'),
			3,
		);

		expect(versions.filters.get('invoke')).toBe('3.19.0');
		expect(versions.functions.get('enum')).toBe('3.19.0');
		expect(versions.tags.get('types')).toBe('3.13.0');
	});

	// Twig drops the article as often as it keeps it, and writes in the
	// imperative where Craft writes in the past tense.
	it('reads a claim with or without an article', () => {
		const versions = parseTwigChangelog(
			[
				'# 3.11.0 (2024-08-08)',
				'',
				' * Add `sequence` and `mapping` tests',
				' * Add a new `guard` tag that allows to test if some Twig callables are available at compilation time',
				" * Add a `format_list` filter to `IntlExtension` to format a list of strings using PHP 8.5's `IntlListFormatter`",
				' * Add the `singular` and `plural` filters in `StringExtension`',
			].join('\n'),
			3,
		);

		expect(versions.tests.get('sequence')).toBe('3.11.0');
		expect(versions.tests.get('mapping')).toBe('3.11.0');
		expect(versions.tags.get('guard')).toBe('3.11.0');
		expect(versions.filters.get('format_list')).toBe('3.11.0');
		expect(versions.filters.get('singular')).toBe('3.11.0');
		expect(versions.filters.get('plural')).toBe('3.11.0');
	});

	/**
	 * One line, three names, two kinds — and the grammar only reaches the first
	 * name, because only the first is followed by the word that says what it is.
	 * `html_attr_merge` and `html_attr_type` keep no version rather than
	 * inheriting a kind from a name beside them.
	 */
	it('claims only the names its grammar reaches', () => {
		const versions = parseTwigChangelog(
			[
				'# 3.24.0 (2025-05-14)',
				'',
				' * Add the `html_attr` function and `html_attr_merge` as well as `html_attr_type` filters',
			].join('\n'),
			3,
		);

		expect(versions.functions.get('html_attr')).toBe('3.24.0');
		expect(versions.filters.get('html_attr_merge')).toBeUndefined();
		expect(versions.filters.get('html_attr_type')).toBeUndefined();
	});

	/**
	 * The line this parser exists to refuse. `defined` is a test, it is named in
	 * backticks, the word `test` is right after it, and it has been in Twig since
	 * 2011 — the sentence is about an interface. Anything that searched for a
	 * name near a kind word would date `defined` to 3.21 and hide it from every
	 * project on an older Twig.
	 */
	it('claims nothing from a line that merely mentions a name', () => {
		const versions = parseTwigChangelog(
			[
				'# 3.21.0 (2025-02-13)',
				'',
				' * Add `SupportDefinedTestInterface` for expression nodes supporting the `defined` test',
				' * Add support for named arguments to the `block` and `attribute` functions',
				' * Add a `needs_is_sandboxed` option for filters, functions, and tests',
				' * Add `needs_charset` option for filters and functions',
				' * Add `===` and `!==` operators (equivalent to the `same as` and `not same as` tests)',
				' * Add missing `twig_escape_filter_is_safe` deprecated function',
				' * Add attributes `AsTwigFilter`, `AsTwigFunction`, and `AsTwigTest` to ease extension development',
				' * Add Spanish inflector support for the `plural` and `singular` filters in the String extension',
			].join('\n'),
			3,
		);

		for (const kind of ['tags', 'filters', 'functions', 'tests', 'globals'] as const) {
			expect([...versions[kind].keys()]).toEqual([]);
		}
	});

	// `Add the slug filter` is an addition, and the version it carries is right.
	// It is also indistinguishable, to this grammar, from prose — so it is
	// declined, and `slug` keeps no version rather than a parsed English word.
	it('claims nothing from a name written without backticks', () => {
		const versions = parseTwigChangelog(
			['# 3.5.0 (2021-09-17)', '', ' * Add the slug filter'].join('\n'),
			3,
		);

		expect(versions.filters.get('slug')).toBeUndefined();
	});

	it('ignores a pre-release suffix on a heading', () => {
		const versions = parseTwigChangelog(
			['# 3.0.0-BETA1 (2019-11-11)', '', ' * Add the `column` filter'].join('\n'),
			3,
		);

		expect(versions.filters.get('column')).toBe('3.0.0');
	});
});
