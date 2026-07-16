import { describe, expect, it } from 'vitest';
import type { ParseErrorCode } from './errors';
import { parse } from './parser';

function codes(source: string): ParseErrorCode[] {
	return parse(source).errors.map((error) => error.code);
}

/** `code@start-end` for every error — recovery is about ranges, not just codes. */
function ranges(source: string): string[] {
	return parse(source).errors.map((error) => `${error.code}@${error.start}-${error.end}`);
}

describe('incomplete member access', () => {
	// The single most important recovery case: this is what every keystroke of
	// `user.` looks like, and completions need the receiver to suggest anything.
	it('keeps the receiver of `{{ user. }}`', () => {
		const source = '{{ user. }}';
		const result = parse(source);
		const output = result.template.body[0];
		if (output?.type !== 'Output') throw new Error('expected Output');
		expect(output.expression).toMatchObject({
			type: 'MemberAccess',
			computed: false,
			property: undefined,
			object: { type: 'Identifier', name: 'user' },
		});
		// The error is a caret exactly after the dot.
		expect(ranges(source)).toEqual(['missing-property@8-8']);
		expect(source.slice(0, 8)).toBe('{{ user.');
	});

	it('keeps the receiver of a chained access', () => {
		const result = parse('{{ user.profile. }}');
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'MemberAccess') {
			throw new Error('expected MemberAccess');
		}
		expect(output.expression.property).toBeUndefined();
		expect(output.expression.object).toMatchObject({
			type: 'MemberAccess',
			property: { name: 'profile' },
		});
	});

	it('keeps a trailing access inside a larger expression', () => {
		const result = parse('{% if user. %}x{% endif %}');
		expect(codes(result.source)).toEqual(['missing-property']);
		const node = result.template.body[0];
		if (node?.type !== 'IfTag') throw new Error('expected IfTag');
		expect(node.branches[0]?.condition).toMatchObject({ type: 'MemberAccess' });
		expect(node.branches[0]?.body).toHaveLength(1);
	});
});

describe('incomplete filter', () => {
	it('keeps the target of `{{ x | }}`', () => {
		const source = '{{ x | }}';
		const result = parse(source);
		const output = result.template.body[0];
		if (output?.type !== 'Output') throw new Error('expected Output');
		expect(output.expression).toMatchObject({
			type: 'FilterExpression',
			name: undefined,
			args: [],
			target: { type: 'Identifier', name: 'x' },
		});
		expect(ranges(source)).toEqual(['missing-filter-name@6-6']);
		expect(source.slice(0, 6)).toBe('{{ x |');
	});

	it('keeps a filter chain up to the incomplete link', () => {
		const result = parse('{{ x|upper| }}');
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'FilterExpression') {
			throw new Error('expected FilterExpression');
		}
		expect(output.expression.name).toBeUndefined();
		expect(output.expression.target).toMatchObject({
			type: 'FilterExpression',
			name: { name: 'upper' },
		});
	});
});

describe('unclosed tags', () => {
	it('auto-closes `{% if x %}` at EOF and records the error', () => {
		const source = '{% if x %}';
		const result = parse(source);
		expect(ranges(source)).toEqual(['missing-end-tag@10-10']);
		const node = result.template.body[0];
		if (node?.type !== 'IfTag') throw new Error('expected IfTag');
		expect(node.branches).toHaveLength(1);
		expect(node.branches[0]?.condition).toMatchObject({ name: 'x' });
		expect(node.end).toBe(source.length);
	});

	it('auto-closes an unclosed if that still has a body', () => {
		const result = parse('{% if x %}<p>hi</p>');
		expect(result.errors.map((error) => error.code)).toEqual(['missing-end-tag']);
		const node = result.template.body[0];
		if (node?.type !== 'IfTag') throw new Error('expected IfTag');
		expect(node.branches[0]?.body).toHaveLength(1);
	});

	it('auto-closes at an enclosing boundary rather than swallowing it', () => {
		// The inner `if` is unclosed; `endfor` belongs to the `for`, so the `if`
		// must stop there and let the `for` close normally.
		const result = parse('{% for i in list %}{% if i %}x{% endfor %}');
		expect(result.errors.map((error) => error.code)).toEqual(['missing-end-tag']);
		const node = result.template.body[0];
		if (node?.type !== 'ForTag') throw new Error('expected ForTag');
		expect(node.end).toBe(result.source.length);
		expect(node.body.filter((child) => child.type === 'IfTag')).toHaveLength(1);
	});

	it('reports each unclosed tag once', () => {
		expect(codes('{% block a %}{% if b %}{% for c in d %}')).toEqual([
			'missing-end-tag',
			'missing-end-tag',
			'missing-end-tag',
		]);
	});
});

describe('mismatched end tags', () => {
	it('accepts `{% endif %}` as the close of a for, with an error', () => {
		const source = '{% for a in b %}x{% endif %}';
		const result = parse(source);
		expect(ranges(source)).toEqual(['mismatched-end-tag@17-25']);
		expect(source.slice(17, 25)).toBe('{% endif');
		const node = result.template.body[0];
		if (node?.type !== 'ForTag') throw new Error('expected ForTag');
		// Recovery consumes the end tag, so the document stays balanced.
		expect(node.end).toBe(source.length);
		expect(node.body).toHaveLength(1);
	});

	it('does not cascade past a mismatched end tag', () => {
		const result = parse('{% if a %}x{% endfor %}{% if b %}y{% endif %}');
		expect(result.errors.map((error) => error.code)).toEqual(['mismatched-end-tag']);
		expect(result.template.body.filter((node) => node.type === 'IfTag')).toHaveLength(2);
	});

	it('reports a stray end tag at the top level', () => {
		const result = parse('<p>hi</p>{% endif %}');
		expect(result.errors.map((error) => error.code)).toEqual(['unexpected-end-tag']);
		expect(result.template.body.map((node) => node.type)).toEqual(['Text', 'GenericTag']);
	});

	it('prefers the enclosing owner over a mismatch', () => {
		// `endblock` belongs to the block, so the if is unclosed rather than the
		// endblock being treated as the if's terminator.
		const result = parse('{% block a %}{% if b %}x{% endblock %}');
		expect(result.errors.map((error) => error.code)).toEqual(['missing-end-tag']);
		const node = result.template.body[0];
		if (node?.type !== 'BlockTag') throw new Error('expected BlockTag');
		expect(node.end).toBe(result.source.length);
	});
});

describe('unclosed delimiters', () => {
	it('recovers an unclosed output at the next construct', () => {
		const result = parse('{{ a\n{{ b }}');
		expect(result.errors.map((error) => error.code)).toEqual(['unterminated-output']);
		expect(result.template.body.map((node) => node.type)).toEqual(['Output', 'Output']);
	});

	it('recovers an unclosed block at the next construct', () => {
		const result = parse('{% if a\n{{ b }}');
		expect(result.errors.map((error) => error.code)).toEqual([
			'unterminated-block',
			'missing-end-tag',
		]);
		const node = result.template.body[0];
		if (node?.type !== 'IfTag') throw new Error('expected IfTag');
		expect(node.branches[0]?.condition).toMatchObject({ name: 'a' });
	});

	it('recovers an output closed with the wrong delimiter', () => {
		const result = parse('{{ x %}rest');
		expect(result.errors.map((error) => error.code)).toEqual(['mismatched-delimiter']);
		expect(result.template.body.map((node) => node.type)).toEqual(['Output', 'Text']);
	});

	it('keeps the rest of the document after an unterminated string', () => {
		const result = parse('{{ "oops }}\n<p>rest</p>');
		expect(result.errors.map((error) => error.code)).toEqual(['unterminated-string']);
		expect(result.template.body.map((node) => node.type)).toEqual(['Output', 'Text']);
	});

	it('reports an unterminated comment', () => {
		expect(codes('{# nope')).toEqual(['unterminated-comment']);
	});
});

describe('incomplete expressions', () => {
	it('reports a missing expression in an empty output', () => {
		expect(ranges('{{ }}')).toEqual(['missing-expression@3-3']);
	});

	it('keeps the left side of a dangling binary operator', () => {
		const result = parse('{{ a + }}');
		expect(result.errors.map((error) => error.code)).toEqual(['missing-expression']);
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'BinaryExpression') {
			throw new Error('expected BinaryExpression');
		}
		expect(output.expression.left).toMatchObject({ name: 'a' });
		expect(output.expression.right).toBeUndefined();
	});

	it('keeps the target of a dangling test', () => {
		const result = parse('{{ a is }}');
		expect(result.errors.map((error) => error.code)).toEqual(['missing-test-name']);
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'TestExpression') {
			throw new Error('expected TestExpression');
		}
		expect(output.expression.name).toBeUndefined();
		expect(output.expression.target).toMatchObject({ name: 'a' });
	});

	it('reports unclosed brackets, braces and parentheses', () => {
		expect(codes('{{ f(a }}')).toEqual(['unclosed-parenthesis']);
		expect(codes('{{ [1, 2 }}')).toEqual(['unclosed-bracket']);
		expect(codes('{{ { a: 1 }}')).toEqual(['unclosed-brace']);
		expect(codes('{{ a[0 }}')).toEqual(['unclosed-bracket']);
	});

	it('keeps a call node for an unclosed argument list', () => {
		const result = parse("{{ path('home', }}");
		const output = result.template.body[0];
		if (output?.type !== 'Output' || output.expression?.type !== 'CallExpression') {
			throw new Error('expected CallExpression');
		}
		expect(output.expression.callee).toMatchObject({ name: 'path' });
		expect(output.expression.args).toHaveLength(1);
	});

	it('reports leftover tokens in a tag', () => {
		expect(codes("{% extends 'a.twig' junk here %}")).toEqual(['unexpected-token']);
	});

	it('reports a missing tag name', () => {
		expect(codes('{% %}')).toEqual(['missing-tag-name']);
	});

	it('reports a missing name where a name is required', () => {
		expect(codes('{% set = 1 %}')).toEqual(['missing-name']);
		expect(codes('{% for in list %}x{% endfor %}')).toEqual(['missing-name']);
	});
});

describe('never throws', () => {
	const samples = [
		'',
		'{',
		'{{',
		'{%',
		'{#',
		'{{}}',
		'{%%}',
		'{##}',
		'{{{{{{',
		'{% % %}',
		'{{ . }}',
		'{{ | }}',
		'{{ ?? }}',
		'{{ ... }}',
		'{{ a. }}{{ b| }}{% if %}',
		'{% endif %}{% endfor %}{% endblock %}',
		'{% for %}',
		'{% if %}{% elseif %}{% else %}{% endif %}',
		'{{ "unterminated',
		"{{ 'unterminated",
		'{{ "#{',
		'{{ "#{ a }',
		'{% verbatim %}',
		'{% macro %}',
		'{% block %}',
		'{{ a[[[[ }}',
		'{{ (((( }}',
		'{{ {{{{ }}',
		'{{ a ? b ? c ? d }}',
		'{{ ,,,, }}',
		'{% set a, , b = %}',
		' {{   }}',
		'{{ 999999999999999999999999 }}',
	];

	for (const sample of samples) {
		it(`survives ${JSON.stringify(sample)}`, () => {
			expect(() => parse(sample)).not.toThrow();
			const result = parse(sample);
			expect(result.template.start).toBe(0);
			expect(result.template.end).toBe(sample.length);
		});
	}
});
