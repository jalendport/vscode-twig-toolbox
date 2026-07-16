import { parse } from '@twig-toolbox/parser';
import { describe, expect, it } from 'vitest';
import { findRegions } from './regions';
import { collectSymbols, type SymbolTable } from './symbols';

function tableFor(text: string): SymbolTable {
	const result = parse(text);
	return collectSymbols(result.template, result.source, findRegions(result.tokens, text.length));
}

/** Names in scope at the `‸` marker. */
function visibleAt(marked: string): string[] {
	const offset = marked.indexOf('‸');
	const text = marked.slice(0, offset) + marked.slice(offset + 1);
	return tableFor(text)
		.visibleAt(offset)
		.map((symbol) => symbol.name)
		.sort();
}

describe('loop variables', () => {
	it('are in scope inside their loop and nowhere else', () => {
		expect(visibleAt('{% for item in items %}{{ ‸ }}{% endfor %}')).toEqual(['item', 'loop']);
		expect(visibleAt('{% for item in items %}{% endfor %}{{ ‸ }}')).toEqual([]);
		expect(visibleAt('{{ ‸ }}{% for item in items %}{% endfor %}')).toEqual([]);
	});

	it('include the key of a two-target loop', () => {
		expect(visibleAt('{% for k, v in items %}{{ ‸ }}{% endfor %}')).toEqual(['k', 'loop', 'v']);
	});

	it('nest, with the inner loop shadowing nothing else', () => {
		expect(
			visibleAt('{% for a in x %}{% for b in y %}{{ ‸ }}{% endfor %}{% endfor %}'),
		).toEqual(['a', 'b', 'loop']);
	});

	it('carry the sequence they came from as a detail', () => {
		const table = tableFor('{% for item in entries.all() %}{% endfor %}');
		expect(table.resolve('item', 31)).toMatchObject({
			kind: 'loop-variable',
			detail: 'for … in entries.all()',
		});
	});
});

describe('{% set %}', () => {
	it('is in scope from its own end onwards', () => {
		expect(visibleAt('{{ ‸ }}{% set x = 1 %}')).toEqual([]);
		expect(visibleAt('{% set x = 1 %}{{ ‸ }}')).toEqual(['x']);
	});

	// Twig's context is flat: a `set` inside a branch survives the branch. The
	// alternative under-offers a name that really is defined at runtime.
	it('outlives the block it was written in', () => {
		expect(visibleAt('{% if a %}{% set x = 1 %}{% endif %}{{ ‸ }}')).toEqual(['x']);
		expect(visibleAt('{% for i in y %}{% set x = 1 %}{% endfor %}{{ ‸ }}')).toEqual(['x']);
	});

	it('covers the body form, after its endset', () => {
		expect(visibleAt('{% set x %}body{% endset %}{{ ‸ }}')).toEqual(['x']);
	});

	it('handles multiple targets', () => {
		expect(visibleAt('{% set a, b = 1, 2 %}{{ ‸ }}')).toEqual(['a', 'b']);
	});

	it('lets a later definition win', () => {
		const source = "{% set x = 1 %}{% set x = 'two' %}";
		const table = tableFor(source);
		expect(table.resolve('x', 20)).toMatchObject({ detail: '= 1' });
		expect(table.resolve('x', source.length)).toMatchObject({ detail: "= 'two'" });
	});
});

describe('walls', () => {
	// A macro body gets its arguments and globals, never the caller's context —
	// so offering the caller's variables inside it would be a lie.
	it('hide the template context from a macro body', () => {
		expect(visibleAt('{% set outer = 1 %}{% macro f(a, b) %}{{ ‸ }}{% endmacro %}')).toEqual([
			'a',
			'b',
		]);
	});

	it('let a macro body define its own names', () => {
		expect(visibleAt('{% macro f(a) %}{% set local = 1 %}{{ ‸ }}{% endmacro %}')).toEqual([
			'a',
			'local',
		]);
	});

	it('are raised by `only` on {% with %}', () => {
		expect(visibleAt('{% set o = 1 %}{% with { a: 1 } only %}{{ ‸ }}{% endwith %}')).toEqual([
			'a',
		]);
	});

	it('are not raised by a plain {% with %}', () => {
		expect(visibleAt('{% set o = 1 %}{% with { a: 1 } %}{{ ‸ }}{% endwith %}')).toEqual([
			'a',
			'o',
		]);
	});

	it('are raised by `only` on {% embed %}', () => {
		expect(
			visibleAt(
				'{% set o = 1 %}{% embed "a.twig" with { a: 1 } only %}{{ ‸ }}{% endembed %}',
			),
		).toEqual(['a']);
	});

	it('nest, so an inner wall hides an outer wall’s names', () => {
		expect(
			visibleAt(
				'{% with { a: 1 } only %}{% with { b: 2 } only %}{{ ‸ }}{% endwith %}{% endwith %}',
			),
		).toEqual(['b']);
	});

	it('do not leak the macro parameters back out', () => {
		expect(visibleAt('{% macro f(a) %}{% endmacro %}{{ ‸ }}')).toEqual([]);
	});
});

describe('macro imports', () => {
	it('brings a `from` import into scope with its signature', () => {
		const table = tableFor('{% from "macros.twig" import button %}{{ butt }}');
		expect(table.resolve('button', 40)).toMatchObject({ kind: 'macro', detail: 'button()' });
	});

	it('honours an alias', () => {
		expect(visibleAt('{% from "m.twig" import button as btn %}{{ ‸ }}')).toEqual(['btn']);
	});

	it('resolves a `from _self` import against this template', () => {
		const table = tableFor(
			"{% from _self import button %}{% macro button(label, url = '#') %}{% endmacro %}",
		);
		expect(table.resolve('button', 30)).toMatchObject({
			kind: 'macro',
			detail: "button(label, url = '#')",
		});
	});

	it('records an `import as` namespace', () => {
		const table = tableFor('{% import _self as forms %}{% macro f() %}{% endmacro %}');
		expect(table.resolve('forms', 27)).toMatchObject({
			kind: 'macro-namespace',
			typeName: 'macros:_self',
		});
	});

	// Reading another template needs the loader milestone 08 builds.
	it('leaves a cross-file namespace untyped for now', () => {
		const table = tableFor('{% import "forms.twig" as forms %}');
		const forms = table.resolve('forms', 34);
		expect(forms).toMatchObject({
			kind: 'macro-namespace',
			detail: 'macros from "forms.twig"',
		});
		// No typeName means no member provider claims it — `forms.` stays empty
		// until milestone 08 can read the imported template.
		expect(forms?.typeName).toBeUndefined();
	});
});

describe('definitions', () => {
	it('collects macros with rendered signatures', () => {
		const table = tableFor("{% macro button(label, url = '#') %}{% endmacro %}");
		expect(table.macros).toMatchObject([
			{ name: 'button', signature: "button(label, url = '#')" },
		]);
	});

	it('collects block names', () => {
		const table = tableFor('{% block title %}{% endblock %}{% block body %}{% endblock %}');
		expect(table.blocks.map((block) => block.name)).toEqual(['title', 'body']);
	});
});
