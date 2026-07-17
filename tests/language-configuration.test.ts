import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * VS Code compiles the patterns in language-configuration.json with JS RegExp, so the indentation
 * and folding behaviour they drive can be checked here rather than by hand in the dev host.
 */
interface LanguageConfiguration {
	comments: { blockComment: [string, string] };
	brackets: [string, string][];
	autoClosingPairs: { open: string; close: string; notIn?: string[] }[];
	surroundingPairs: [string, string][];
	folding: { markers: { start: string; end: string } };
	indentationRules: { increaseIndentPattern: string; decreaseIndentPattern: string };
	onEnterRules: {
		beforeText: string;
		afterText?: string;
		action: { indent: string };
	}[];
}

const config = JSON.parse(
	readFileSync(fileURLToPath(new URL('../language-configuration.json', import.meta.url)), 'utf8'),
) as LanguageConfiguration;

const increase = new RegExp(config.indentationRules.increaseIndentPattern);
const decrease = new RegExp(config.indentationRules.decreaseIndentPattern);
const foldStart = new RegExp(config.folding.markers.start);
const foldEnd = new RegExp(config.folding.markers.end);

describe('comments', () => {
	it('toggles with the Twig block comment', () => {
		expect(config.comments.blockComment).toEqual(['{#', '#}']);
	});

	it('declares no line comment, because Twig has none', () => {
		expect(config.comments).not.toHaveProperty('lineComment');
	});
});

describe('auto-closing pairs', () => {
	const pairs = () => config.autoClosingPairs.map((p) => [p.open, p.close]);

	it('closes the Twig delimiters with the house-style inner spaces', () => {
		expect(pairs()).toEqual(
			expect.arrayContaining([
				['{# ', ' #}'],
				['{{ ', ' }}'],
				['{% ', ' %}'],
			]),
		);
	});

	it('has no bare `{` pair — it stacks closers under the delimiter pairs', () => {
		expect(pairs()).not.toEqual(expect.arrayContaining([['{', '}']]));
	});

	it('has no tight delimiter pairs — they orphan the closing space', () => {
		expect(pairs()).not.toEqual(
			expect.arrayContaining([
				['{{', '}}'],
				['{%', '%}'],
				['{#', '#}'],
			]),
		);
	});

	it('closes string interpolation, quotes and HTML comments', () => {
		expect(pairs()).toEqual(
			expect.arrayContaining([
				['#{', '}'],
				['"', '"'],
				["'", "'"],
				['<!--', ' -->'],
			]),
		);
	});
});

describe('increaseIndentPattern', () => {
	it.each([
		'{% if user %}',
		'{%- if user -%}',
		'{% for item in items %}',
		'{% block body %}',
		'{% else %}',
		'{% elseif x %}',
		'{% embed "card.twig" %}',
		'{% macro field(name) %}',
		'{% apply upper %}',
		'{% autoescape "js" %}',
		'{% with { a: 1 } %}',
		'{% nav item in entries %}',
		'{% switch handle %}',
		'{% case "a" %}',
		'{% ifchildren %}',
		'<div class="wrap">',
	])('indents after %j', (line) => {
		expect(increase.test(line)).toBe(true);
	});

	it.each([
		'{% if user %}yes{% endif %}',
		'{% for i in x %}{{ i }}{% endfor %}',
		'{% endif %}',
		'{% extends "base.twig" %}',
		'{% set count = 0 %}',
		'{{ user.name }}',
		'<img src="x.png">',
		'<br>',
		'<div class="wrap"></div>',
		'plain text',
	])('does not indent after %j', (line) => {
		expect(increase.test(line)).toBe(false);
	});
});

describe('decreaseIndentPattern', () => {
	it.each([
		'{% endif %}',
		'{% endfor %}',
		'{% endblock %}',
		'{%- endverbatim -%}',
		'\t{% endif %}',
		'{% else %}',
		'{% elseif x %}',
		'{% case "b" %}',
		'{% default %}',
		'</div>',
	])('outdents %j', (line) => {
		expect(decrease.test(line)).toBe(true);
	});

	it.each(['{% if user %}', '{{ user.name }}', '<div>', 'plain text'])(
		'does not outdent %j',
		(line) => {
			expect(decrease.test(line)).toBe(false);
		},
	);
});

describe('folding markers', () => {
	it.each([
		'{% block body %}',
		'{% for item in items %}',
		'{# region nav #}',
		'<!-- #region -->',
	])('starts a fold at %j', (line) => {
		expect(foldStart.test(line)).toBe(true);
	});

	it.each(['{% endblock %}', '{% endfor %}', '{# endregion #}', '<!-- #endregion -->'])(
		'ends a fold at %j',
		(line) => {
			expect(foldEnd.test(line)).toBe(true);
		},
	);

	it.each(['{% if a %}one-liner{% endif %}', '{% set x = 1 %}', '{{ x }}'])(
		'does not start a fold at %j',
		(line) => {
			expect(foldStart.test(line)).toBe(false);
		},
	);
});

describe('onEnterRules', () => {
	const rule = config.onEnterRules[0];
	if (!rule?.afterText) throw new Error('expected a Twig block onEnterRule with afterText');
	const beforeText = new RegExp(rule.beforeText);
	const afterText = new RegExp(rule.afterText);

	it('opens an indented body between a block tag and its end tag', () => {
		expect(rule.action.indent).toBe('indentOutdent');
		expect(beforeText.test('{% if user %}')).toBe(true);
		expect(afterText.test('{% endif %}')).toBe(true);
	});

	it.each([
		['{% for item in items %}', '{% endfor %}'],
		['{% block body %}', '{% endblock %}'],
		['{%- with { a: 1 } -%}', '\t{%- endwith -%}'],
	])('pairs %j with %j', (before, after) => {
		expect(beforeText.test(before)).toBe(true);
		expect(afterText.test(after)).toBe(true);
	});

	it('every rule compiles', () => {
		for (const r of config.onEnterRules) {
			expect(() => new RegExp(r.beforeText)).not.toThrow();
			const after = r.afterText;
			if (after !== undefined) expect(() => new RegExp(after)).not.toThrow();
		}
	});
});
