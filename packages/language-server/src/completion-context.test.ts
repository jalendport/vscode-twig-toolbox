import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { classifyCompletion, type CompletionContext } from './completion-context';
import { createParsedDocument } from './document-store';

/**
 * Fixtures mark the cursor with `‸`, which `|` could not do without fighting
 * every filter in the suite.
 */
function at(marked: string): { context: CompletionContext; text: string; offset: number } {
	const offset = marked.indexOf('‸');
	if (offset === -1) {
		throw new Error(`fixture has no ‸ cursor: ${marked}`);
	}
	const text = marked.slice(0, offset) + marked.slice(offset + 1);
	const parsed = createParsedDocument(
		TextDocument.create('file:///project/templates/index.twig', 'twig', 1, text),
	);
	return { context: classifyCompletion(parsed, offset), text, offset };
}

function kindAt(marked: string): string {
	return at(marked).context.kind;
}

/** The source text a chosen item would replace. */
function replacedText(marked: string): string {
	const { context, text } = at(marked);
	if (!('replace' in context)) {
		throw new Error(`context ${context.kind} has no replace range`);
	}
	return text.slice(context.replace.start, context.replace.end);
}

describe.each([
	['{% ‸ %}', 'tag-name'],
	['{% fo‸ %}', 'tag-name'],
	['{% ‸', 'tag-name'],
	['{% end‸ %}', 'end-tag'],
	['{{ name|‸ }}', 'filter'],
	['{{ name| ‸ }}', 'filter'],
	['{{ name|up‸ }}', 'filter'],
	['{% apply ‸ %}{% endapply %}', 'filter'],
	['{% apply upper|‸ %}{% endapply %}', 'filter'],
	['{% if x is ‸ %}{% endif %}', 'test'],
	['{% if x is not ‸ %}{% endif %}', 'test'],
	['{% if x is def‸ %}{% endif %}', 'test'],
	['{{ da‸te() }}', 'function-call'],
	['{{ date(‸) }}', 'named-argument'],
	['{{ date(tim‸) }}', 'named-argument'],
	['{{ ‸ }}', 'expression'],
	['{{ it‸ }}', 'expression'],
	['{% set x = ‸ %}', 'expression'],
	['{% for x in ‸ %}', 'expression'],
	['{{ user.‸ }}', 'member-access'],
	['{{ user.na‸me }}', 'member-access'],
	['{{ { ‸ } }}', 'hash-key'],
	['{{ { ke‸y: 1 } }}', 'hash-key'],
	['{% include "a.tw‸ig" %}', 'template-string'],
	['{{ block("ti‸") }}', 'block-name'],
])('classifies %j', (marked, expected) => {
	it(`as ${expected}`, () => {
		expect(kindAt(marked)).toBe(expected);
	});
});

describe('positions that are not Twig', () => {
	// The acceptance criterion: nothing fires in prose, however Twig-shaped.
	it.each([
		['{# comm‸ent #}', 'a comment'],
		['<div>ra‸w</div>', 'raw HTML text'],
		['{% verbatim %}{{ x‸ }}{% endverbatim %}', 'a verbatim body'],
		['{{ "hello ‸" }}', 'string text'],
		['{{ x }}‸', 'text after an output'],
		['{‸{ x }}', 'inside the opening delimiter'],
		['{{ x }‸}', 'inside the closing delimiter'],
	])('offers nothing in %j (%s)', (marked) => {
		expect(kindAt(marked)).toBe('none');
	});

	it('treats a `#{}` interpolation as an expression again', () => {
		expect(kindAt('{{ "#{ x‸ }" }}')).toBe('expression');
	});
});

describe('binding positions', () => {
	// A name being declared has nothing to complete against: every candidate is
	// by definition a name that already exists.
	it.each([
		'{% for ‸ %}',
		'{% for it‸em in x %}',
		'{% set ‸ %}',
		'{% set x‸ = 1 %}',
		'{% block ‸ %}{% endblock %}',
		'{% macro fo‸o() %}{% endmacro %}',
		'{% from "m.twig" import butt‸ %}',
		'{% import "m.twig" as fo‸rms %}',
	])('offers nothing at %j', (marked) => {
		expect(kindAt(marked)).toBe('none');
	});
});

describe('open blocks', () => {
	function openTags(marked: string): string[] {
		const { context } = at(marked);
		return 'openTags' in context ? context.openTags.map((tag) => tag.endName) : [];
	}

	it('offers the end tag of a block that has none yet', () => {
		expect(openTags('{% if x %}{% ‸ %}')).toEqual(['endif']);
	});

	it('says nothing about a block that is already closed', () => {
		expect(openTags('{% for a in b %}{% ‸ %}{% endfor %}')).toEqual([]);
	});

	it('lists enclosing blocks innermost first', () => {
		expect(openTags('{% block a %}{% for i in x %}{% ‸ %}')).toEqual(['endfor', 'endblock']);
	});

	it('counts a mismatched end tag as no end tag at all', () => {
		expect(openTags('{% for a in b %}{% end‸ %}{% endif %}')).toEqual(['endfor']);
	});
});

describe('replacement ranges', () => {
	it('replaces the word under the cursor, not the whole expression', () => {
		expect(replacedText('{{ name|up‸ }}')).toBe('up');
		expect(replacedText('{{ user.na‸me }}')).toBe('name');
		expect(replacedText('{% if x is def‸ %}{% endif %}')).toBe('def');
	});

	it('collapses to a caret in an empty slot', () => {
		expect(replacedText('{{ name|‸ }}')).toBe('');
		expect(replacedText('{{ user.‸ }}')).toBe('');
	});

	// Tag snippets carry their own delimiters, so the edit has to own the
	// interior — including the space the editor auto-inserted.
	it('covers the whole region interior for a tag name', () => {
		expect(replacedText('{% ‸ %}')).toBe('  ');
		expect(replacedText('{% fo‸ %}')).toBe(' fo ');
	});

	it('replaces a string literal from the inside', () => {
		expect(replacedText('{% include "a.tw‸ig" %}')).toBe('a.twig');
		expect(replacedText('{{ block("ti‸") }}')).toBe('ti');
	});
});

describe('slots that need a separator first', () => {
	// `is` is a word: `{% if x isdefined %}` is not what anyone meant.
	it('waits for a space after `is` before offering tests', () => {
		expect(kindAt('{% if x is‸ %}{% endif %}')).not.toBe('test');
		expect(kindAt('{% if x is ‸ %}{% endif %}')).toBe('test');
	});

	// `|` is punctuation, and `{{ x|upper }}` needs no space at all.
	it('offers filters the moment the pipe lands', () => {
		expect(kindAt('{{ name|‸ }}')).toBe('filter');
	});
});
