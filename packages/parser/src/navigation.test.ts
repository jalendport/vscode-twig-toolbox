import { describe, expect, it } from 'vitest';
import type { AnyNode } from './ast';
import { childNodes, findAncestor, nodeAt, nodePathAt, visit } from './navigation';
import { parse } from './parser';

/** Node types along the path to `offset`, outermost first. */
function pathAt(source: string, offset: number): string[] {
	return nodePathAt(parse(source).template, offset).map((node) => node.type);
}

/** Offset of `marker` in `source`, with the marker removed before parsing. */
function at(source: string, marker = '|'): { source: string; offset: number } {
	const offset = source.indexOf(marker);
	if (offset === -1) {
		throw new Error(`marker ${marker} not found`);
	}
	return { source: source.replace(marker, ''), offset };
}

describe('nodePathAt', () => {
	it('returns the ancestor chain outermost first', () => {
		expect(pathAt('{{ user.name }}', 9)).toEqual([
			'Template',
			'Output',
			'MemberAccess',
			'Identifier',
		]);
	});

	it('descends into tag bodies', () => {
		const { source, offset } = at('{% for i in list %}{{ i.na|me }}{% endfor %}');
		expect(pathAt(source, offset)).toEqual([
			'Template',
			'ForTag',
			'Output',
			'MemberAccess',
			'Identifier',
		]);
	});

	it('lands on the receiver of an incomplete member access', () => {
		// This is the completion-trigger position: `{{ user.| }}`.
		const { source, offset } = at('{{ user.| }}');
		const path = nodePathAt(parse(source).template, offset);
		expect(path.map((node) => node.type)).toEqual(['Template', 'Output', 'MemberAccess']);
		const access = path.at(-1);
		expect(access).toMatchObject({ type: 'MemberAccess', property: undefined });
	});

	it('lands on the incomplete filter of `{{ x |` ', () => {
		const { source, offset } = at('{{ x || }}');
		const path = nodePathAt(parse(source).template, offset);
		expect(path.at(-1)).toMatchObject({ type: 'FilterExpression', name: undefined });
	});

	it('returns an empty path for an offset outside the document', () => {
		expect(pathAt('{{ x }}', 99)).toEqual([]);
	});

	it('covers every offset of a document', () => {
		const source = '<p>{{ a.b|upper }}</p>{% if c %}x{% endif %}';
		const { template } = parse(source);
		for (let offset = 0; offset <= source.length; offset++) {
			expect(nodePathAt(template, offset)[0], `offset ${offset}`).toBe(template);
		}
	});

	it('resolves inside a string interpolation', () => {
		const { source, offset } = at('{{ "hi #{us|er.name}" }}');
		expect(pathAt(source, offset)).toEqual([
			'Template',
			'Output',
			'StringLiteral',
			'Interpolation',
			'MemberAccess',
			'Identifier',
		]);
	});

	it('sees through parentheses to the expression they wrap', () => {
		const { source, offset } = at('{{ (a + |b) * c }}');
		expect(pathAt(source, offset)).toEqual([
			'Template',
			'Output',
			'BinaryExpression',
			'BinaryExpression',
			'Identifier',
		]);
	});
});

describe('nodeAt', () => {
	it('returns the innermost node', () => {
		expect(nodeAt(parse('{{ user.name }}').template, 9)).toMatchObject({
			type: 'Identifier',
			name: 'name',
		});
	});

	it('resolves a tag argument', () => {
		const { source, offset } = at("{% include 'partials/he|ader.twig' %}");
		expect(nodeAt(parse(source).template, offset)).toMatchObject({ type: 'StringText' });
	});

	it('resolves text between constructs', () => {
		expect(nodeAt(parse('<p>{{ x }}</p>').template, 1)).toMatchObject({ type: 'Text' });
	});
});

describe('findAncestor', () => {
	it('finds the enclosing tag from a deep path', () => {
		const { source, offset } = at('{% for i in list %}{{ i.na|me }}{% endfor %}');
		const path = nodePathAt(parse(source).template, offset);
		expect(findAncestor(path, 'ForTag')).toMatchObject({ type: 'ForTag', name: 'for' });
		expect(findAncestor(path, 'MacroTag')).toBeUndefined();
	});

	it('returns the node itself when it matches', () => {
		const path = nodePathAt(parse('{{ x }}').template, 3);
		expect(findAncestor(path, 'Identifier')).toMatchObject({ name: 'x' });
	});
});

describe('childNodes', () => {
	it('returns children in source order', () => {
		const { template } = parse('a{{ x }}{# c #}b');
		expect(childNodes(template).map((node) => node.type)).toEqual([
			'Text',
			'Output',
			'Comment',
			'Text',
		]);
	});

	it('skips plain range fields that are not nodes', () => {
		const node = parse('{% if a %}{% endif %}').template.body[0] as AnyNode;
		// `nameRange` is a SourceRange, not a node, so it must not appear.
		expect(childNodes(node).map((child) => child.type)).toEqual(['IfBranch']);
	});

	it('has no children for a leaf', () => {
		expect(childNodes(parse('{{ x }}').template.body[0] as AnyNode)).toHaveLength(1);
		expect(childNodes(nodeAt(parse('{{ x }}').template, 3) as AnyNode)).toEqual([]);
	});
});

describe('visit', () => {
	it('walks parents before children', () => {
		const seen: string[] = [];
		visit(parse('{{ a.b }}').template, (node) => {
			seen.push(node.type);
		});
		expect(seen).toEqual(['Template', 'Output', 'MemberAccess', 'Identifier', 'Identifier']);
	});

	it('reports the ancestor chain', () => {
		const chains: string[][] = [];
		visit(parse('{{ a.b }}').template, (node, ancestors) => {
			if (node.type === 'Identifier') {
				chains.push(ancestors.map((ancestor) => ancestor.type));
			}
		});
		expect(chains[0]).toEqual(['Template', 'Output', 'MemberAccess']);
	});

	it('skips a subtree when enter returns false', () => {
		const seen: string[] = [];
		visit(parse('{{ a.b }}').template, (node) => {
			seen.push(node.type);
			return node.type !== 'MemberAccess';
		});
		expect(seen).toEqual(['Template', 'Output', 'MemberAccess']);
	});
});
