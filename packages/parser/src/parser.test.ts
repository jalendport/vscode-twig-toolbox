import { describe, expect, it } from 'vitest';
import type { TagNode, TemplateChild } from './ast';
import { parse } from './parser';

/** Parses and asserts the input is clean, returning the template body. */
function body(source: string): TemplateChild[] {
	const result = parse(source);
	expect(result.errors.map((error) => `${error.code}: ${error.message}`)).toEqual([]);
	return result.template.body;
}

/** The single tag a source is expected to produce. */
function tag(source: string): TagNode {
	const nodes = body(source).filter((node) => node.type !== 'Text');
	expect(nodes).toHaveLength(1);
	const node = nodes[0];
	if (node === undefined || node.type === 'Output' || node.type === 'Comment') {
		throw new Error(`expected a tag, got ${node?.type ?? 'nothing'}`);
	}
	return node;
}

function text(source: string, node: { start: number; end: number }): string {
	return source.slice(node.start, node.end);
}

describe('template structure', () => {
	it('parses text, output and comment', () => {
		expect(body('a{{ x }}{# c #}b').map((node) => node.type)).toEqual([
			'Text',
			'Output',
			'Comment',
			'Text',
		]);
	});

	it('keeps comment text', () => {
		const node = body('{# hello #}')[0];
		expect(node).toMatchObject({ type: 'Comment', value: ' hello ' });
	});

	it('spans the whole document', () => {
		const source = 'a{{ x }}b';
		const result = parse(source);
		expect(result.template.start).toBe(0);
		expect(result.template.end).toBe(source.length);
	});

	it('gives an empty document an empty body', () => {
		expect(body('')).toEqual([]);
	});

	it('ranges an output across its delimiters', () => {
		const source = '<p>{{ x }}</p>';
		const node = body(source)[1];
		expect(node).toBeDefined();
		expect(text(source, node as TemplateChild)).toBe('{{ x }}');
	});
});

describe('if', () => {
	it('parses a single branch', () => {
		const node = tag('{% if a %}yes{% endif %}');
		expect(node.type).toBe('IfTag');
		if (node.type !== 'IfTag') return;
		expect(node.branches).toHaveLength(1);
		expect(node.branches[0]?.kind).toBe('if');
		expect(node.branches[0]?.condition).toMatchObject({ type: 'Identifier', name: 'a' });
	});

	it('parses elseif and else branches', () => {
		const node = tag('{% if a %}1{% elseif b %}2{% elseif c %}3{% else %}4{% endif %}');
		if (node.type !== 'IfTag') throw new Error('expected IfTag');
		expect(node.branches.map((branch) => branch.kind)).toEqual([
			'if',
			'elseif',
			'elseif',
			'else',
		]);
		expect(node.branches.at(-1)?.condition).toBeUndefined();
	});

	it('binds else to the innermost if', () => {
		const node = tag('{% if a %}{% if b %}x{% else %}y{% endif %}{% endif %}');
		if (node.type !== 'IfTag') throw new Error('expected IfTag');
		expect(node.branches).toHaveLength(1);
		const inner = node.branches[0]?.body.find((child) => child.type === 'IfTag');
		expect(inner?.type).toBe('IfTag');
		if (inner?.type !== 'IfTag') return;
		expect(inner.branches.map((branch) => branch.kind)).toEqual(['if', 'else']);
	});
});

describe('for', () => {
	it('parses a value target', () => {
		const node = tag('{% for item in items %}x{% endfor %}');
		if (node.type !== 'ForTag') throw new Error('expected ForTag');
		expect(node.keyTarget).toBeUndefined();
		expect(node.valueTarget).toMatchObject({ name: 'item' });
		expect(node.sequence).toMatchObject({ name: 'items' });
		expect(node.elseBody).toBeUndefined();
	});

	it('parses key and value targets', () => {
		const node = tag('{% for k, v in map %}x{% endfor %}');
		if (node.type !== 'ForTag') throw new Error('expected ForTag');
		expect(node.keyTarget).toMatchObject({ name: 'k' });
		expect(node.valueTarget).toMatchObject({ name: 'v' });
	});

	it('parses an else body', () => {
		const node = tag('{% for i in list %}a{% else %}b{% endfor %}');
		if (node.type !== 'ForTag') throw new Error('expected ForTag');
		expect(node.body).toHaveLength(1);
		expect(node.elseBody).toHaveLength(1);
	});

	it('parses a range sequence', () => {
		const node = tag('{% for i in 1..10 %}x{% endfor %}');
		if (node.type !== 'ForTag') throw new Error('expected ForTag');
		expect(node.sequence).toMatchObject({ type: 'BinaryExpression', operator: '..' });
	});

	it('parses but flags the Twig 2 condition form', () => {
		const result = parse('{% for i in list if i.ok %}x{% endfor %}');
		expect(result.errors.map((error) => error.code)).toEqual(['removed-in-twig-3']);
		const node = result.template.body[0];
		if (node?.type !== 'ForTag') throw new Error('expected ForTag');
		expect(node.condition).toMatchObject({ type: 'MemberAccess' });
	});
});

describe('set', () => {
	it('parses the inline form', () => {
		const node = tag("{% set title = 'Hi' %}");
		if (node.type !== 'SetTag') throw new Error('expected SetTag');
		expect(node.targets.map((target) => target.name)).toEqual(['title']);
		expect(node.values).toHaveLength(1);
		expect(node.body).toBeUndefined();
	});

	it('parses multiple targets and values', () => {
		const node = tag('{% set a, b = 1, 2 %}');
		if (node.type !== 'SetTag') throw new Error('expected SetTag');
		expect(node.targets.map((target) => target.name)).toEqual(['a', 'b']);
		expect(node.values).toHaveLength(2);
	});

	it('parses the body form', () => {
		const node = tag('{% set greeting %}Hello{% endset %}');
		if (node.type !== 'SetTag') throw new Error('expected SetTag');
		expect(node.values).toEqual([]);
		expect(node.body).toHaveLength(1);
	});
});

describe('block and macro', () => {
	it('parses a block body', () => {
		const node = tag('{% block title %}Hi{% endblock %}');
		if (node.type !== 'BlockTag') throw new Error('expected BlockTag');
		expect(node.blockName).toMatchObject({ name: 'title' });
		expect(node.body).toHaveLength(1);
		expect(node.endName).toBeUndefined();
	});

	it('records the name repeated on endblock', () => {
		const node = tag('{% block title %}Hi{% endblock title %}');
		if (node.type !== 'BlockTag') throw new Error('expected BlockTag');
		expect(node.endName).toMatchObject({ name: 'title' });
	});

	it('parses the shorthand value form', () => {
		const node = tag("{% block title 'Hi' %}");
		if (node.type !== 'BlockTag') throw new Error('expected BlockTag');
		expect(node.value).toMatchObject({ type: 'StringLiteral', value: 'Hi' });
		expect(node.body).toBeUndefined();
	});

	it('parses macro parameters and defaults', () => {
		const node = tag("{% macro field(name, value = '', type = 'text') %}x{% endmacro %}");
		if (node.type !== 'MacroTag') throw new Error('expected MacroTag');
		expect(node.macroName).toMatchObject({ name: 'field' });
		expect(node.params.map((param) => param.name.name)).toEqual(['name', 'value', 'type']);
		expect(node.params[0]?.default).toBeUndefined();
		expect(node.params[1]?.default).toMatchObject({ type: 'StringLiteral', value: '' });
	});

	it('parses a macro with no parameters', () => {
		const node = tag('{% macro hr() %}<hr>{% endmacro %}');
		if (node.type !== 'MacroTag') throw new Error('expected MacroTag');
		expect(node.params).toEqual([]);
	});
});

describe('template tags', () => {
	it('parses extends', () => {
		const node = tag("{% extends 'base.twig' %}");
		expect(node).toMatchObject({ type: 'ExtendsTag', template: { value: 'base.twig' } });
	});

	it('parses include options', () => {
		const node = tag("{% include 'a.twig' ignore missing with { x: 1 } only %}");
		if (node.type !== 'IncludeTag') throw new Error('expected IncludeTag');
		expect(node.ignoreMissing).toBe(true);
		expect(node.only).toBe(true);
		expect(node.variables).toMatchObject({ type: 'HashLiteral' });
	});

	it('defaults include options to false', () => {
		const node = tag("{% include 'a.twig' %}");
		expect(node).toMatchObject({ type: 'IncludeTag', only: false, ignoreMissing: false });
	});

	it('parses an include with a list of candidates', () => {
		const node = tag("{% include ['a.twig', 'b.twig'] %}");
		if (node.type !== 'IncludeTag') throw new Error('expected IncludeTag');
		expect(node.template).toMatchObject({ type: 'ArrayLiteral' });
	});

	it('parses embed with a body', () => {
		const node = tag(
			"{% embed 'card.twig' with { a: 1 } only %}{% block b %}x{% endblock %}{% endembed %}",
		);
		if (node.type !== 'EmbedTag') throw new Error('expected EmbedTag');
		expect(node.only).toBe(true);
		expect(node.body.filter((child) => child.type === 'BlockTag')).toHaveLength(1);
	});

	it('parses use aliases', () => {
		const node = tag(
			"{% use 'blocks.twig' with sidebar as base_sidebar, footer as base_footer %}",
		);
		if (node.type !== 'UseTag') throw new Error('expected UseTag');
		expect(node.aliases.map((alias) => [alias.original?.name, alias.alias?.name])).toEqual([
			['sidebar', 'base_sidebar'],
			['footer', 'base_footer'],
		]);
	});

	it('parses import', () => {
		const node = tag("{% import 'macros.twig' as m %}");
		expect(node).toMatchObject({ type: 'ImportTag', alias: { name: 'm' } });
	});

	it('parses import from _self', () => {
		const node = tag('{% import _self as self %}');
		if (node.type !== 'ImportTag') throw new Error('expected ImportTag');
		expect(node.template).toMatchObject({ type: 'Identifier', name: '_self' });
	});

	it('parses from with aliases', () => {
		const node = tag("{% from 'macros.twig' import field, button as btn %}");
		if (node.type !== 'FromTag') throw new Error('expected FromTag');
		expect(node.imports.map((entry) => [entry.macroName?.name, entry.alias?.name])).toEqual([
			['field', undefined],
			['button', 'btn'],
		]);
	});
});

describe('other core tags', () => {
	it('parses an apply filter chain', () => {
		const node = tag("{% apply upper|escape('html') %}x{% endapply %}");
		if (node.type !== 'ApplyTag') throw new Error('expected ApplyTag');
		expect(node.filters.map((filter) => filter.name?.name)).toEqual(['upper', 'escape']);
		expect(node.filters[1]?.args).toHaveLength(1);
	});

	it('parses autoescape with and without a strategy', () => {
		expect(tag("{% autoescape 'js' %}x{% endautoescape %}")).toMatchObject({
			type: 'AutoescapeTag',
			strategy: { type: 'StringLiteral', value: 'js' },
		});
		expect(tag('{% autoescape %}x{% endautoescape %}')).toMatchObject({ strategy: undefined });
		expect(tag('{% autoescape false %}x{% endautoescape %}')).toMatchObject({
			strategy: { type: 'BooleanLiteral', value: false },
		});
	});

	it('parses do, flush and deprecated', () => {
		expect(tag("{% do form.setMethod('POST') %}")).toMatchObject({
			type: 'DoTag',
			expression: { type: 'CallExpression' },
		});
		expect(tag('{% flush %}')).toMatchObject({ type: 'FlushTag' });
		expect(tag("{% deprecated 'gone' %}")).toMatchObject({
			type: 'DeprecatedTag',
			expression: { value: 'gone' },
		});
	});

	it('parses deprecated options', () => {
		const node = tag("{% deprecated 'gone' package='acme/pkg' version='1.2' %}");
		if (node.type !== 'DeprecatedTag') throw new Error('expected DeprecatedTag');
		expect(node.args.map((arg) => arg.name?.name)).toEqual(['package', 'version']);
	});

	it('parses with', () => {
		expect(tag('{% with { x: 1 } only %}y{% endwith %}')).toMatchObject({
			type: 'WithTag',
			only: true,
			variables: { type: 'HashLiteral' },
		});
		expect(tag('{% with %}y{% endwith %}')).toMatchObject({
			variables: undefined,
			only: false,
		});
	});

	it('keeps a verbatim body verbatim', () => {
		const node = tag('{% verbatim %}{{ x }}{% if y %}{% endverbatim %}');
		if (node.type !== 'VerbatimTag') throw new Error('expected VerbatimTag');
		expect(node.value).toBe('{{ x }}{% if y %}');
	});

	it('gives an empty verbatim an empty value', () => {
		const node = tag('{% verbatim %}{% endverbatim %}');
		expect(node).toMatchObject({ type: 'VerbatimTag', value: '' });
	});
});

describe('generic tags', () => {
	it('parses an unknown tag with no body', () => {
		const node = tag("{% requirePermission 'accessCp' %}");
		if (node.type !== 'GenericTag') throw new Error('expected GenericTag');
		expect(node.name).toBe('requirePermission');
		expect(node.body).toBeUndefined();
		expect(node.args).toHaveLength(1);
	});

	it('parses an unknown tag with a matching end tag as a body', () => {
		const node = tag('{% nav item in entries %}<li>{{ item.title }}</li>{% endnav %}');
		if (node.type !== 'GenericTag') throw new Error('expected GenericTag');
		expect(node.body).toBeDefined();
		expect(node.args[0]).toMatchObject({ type: 'BinaryExpression', operator: 'in' });
	});

	it('pairs nested same-name tags correctly', () => {
		const node = tag('{% foo %}a{% foo %}b{% endfoo %}c{% endfoo %}');
		if (node.type !== 'GenericTag') throw new Error('expected GenericTag');
		expect(node.body?.filter((child) => child.type === 'GenericTag')).toHaveLength(1);
	});

	it('treats core body tags without an end tag as unclosed', () => {
		// `sandbox` is known to take a body, so a missing end tag is an error
		// rather than a bodyless tag.
		const result = parse('{% sandbox %}x');
		expect(result.errors.map((error) => error.code)).toEqual(['missing-end-tag']);
	});

	it('parses several arguments', () => {
		const node = tag('{% paginate query as pageInfo, entries %}');
		if (node.type !== 'GenericTag') throw new Error('expected GenericTag');
		expect(node.args).toHaveLength(4);
	});

	it('records the tag name range', () => {
		const source = '{% dump entry %}';
		const node = tag(source);
		expect(source.slice(node.nameRange.start, node.nameRange.end)).toBe('dump');
	});
});

describe('expressions', () => {
	it('parses named arguments', () => {
		const result = parse("{{ date(timezone = 'UTC') }}");
		expect(result.errors).toEqual([]);
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'CallExpression') {
			throw new Error('expected a call');
		}
		expect(output.expression.args[0]?.name).toMatchObject({ name: 'timezone' });
	});

	it('parses string interpolation into parts', () => {
		const result = parse('{{ "a #{b} c" }}');
		expect(result.errors).toEqual([]);
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'StringLiteral') {
			throw new Error('expected a string');
		}
		expect(output.expression.parts.map((part) => part.type)).toEqual([
			'StringText',
			'Interpolation',
			'StringText',
		]);
	});

	it('decodes escapes', () => {
		const result = parse("{{ 'it\\'s\\na' }}");
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'StringLiteral') {
			throw new Error('expected a string');
		}
		expect(output.expression.value).toBe("it's\na");
	});

	it('parses hash shorthand entries', () => {
		const result = parse('{{ { name, age: 1 } }}');
		expect(result.errors).toEqual([]);
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'HashLiteral') {
			throw new Error('expected a hash');
		}
		expect(output.expression.entries[0]).toMatchObject({ type: 'HashEntry', shorthand: true });
		expect(output.expression.entries[1]).toMatchObject({ shorthand: false });
	});

	it('parses number values', () => {
		const cases: [string, number][] = [
			['42', 42],
			['3.5', 3.5],
			['1_000', 1000],
			['1.5e3', 1500],
			['0xFF', 255],
			['0b1010', 10],
			['0o17', 15],
		];
		for (const [raw, value] of cases) {
			const result = parse(`{{ ${raw} }}`);
			const output = result.template.body[0];
			if (output?.type !== 'Output') throw new Error('expected output');
			expect(output.expression, raw).toMatchObject({ type: 'NumberLiteral', value });
		}
	});
});
