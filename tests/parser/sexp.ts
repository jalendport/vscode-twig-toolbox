import type { Argument, Expression, SpreadElement } from '../../packages/parser/src/index';

/**
 * Renders an expression as a fully-parenthesised s-expression.
 *
 * Precedence and associativity are the whole point of the expression grammar,
 * and a nested-object snapshot buries them. `(+ a (* b c))` shows the shape at
 * a glance, which is what the operator-table tests need to be readable.
 */
export function sexp(node: Expression | SpreadElement | Argument | undefined): string {
	if (node === undefined) {
		return '?';
	}
	switch (node.type) {
		case 'Identifier':
			return node.name;
		case 'NumberLiteral':
			return node.raw;
		case 'BooleanLiteral':
			return String(node.value);
		case 'NullLiteral':
			return 'null';
		case 'StringLiteral':
			return node.parts.some((part) => part.type === 'Interpolation')
				? `(str ${node.parts
						.map((part) =>
							part.type === 'StringText'
								? JSON.stringify(part.value)
								: sexp(part.expression),
						)
						.join(' ')})`
				: JSON.stringify(node.value);
		case 'UnaryExpression':
			return `(${node.operator}. ${sexp(node.argument)})`;
		case 'BinaryExpression':
			return `(${node.operator} ${sexp(node.left)} ${sexp(node.right)})`;
		case 'ConditionalExpression':
			return `(?: ${sexp(node.test)} ${sexp(node.consequent)} ${sexp(node.alternate)})`;
		case 'FilterExpression':
			return `(| ${sexp(node.target)} ${node.name?.name ?? '?'}${args(node.args)})`;
		case 'CallExpression':
			return `(call ${sexp(node.callee)}${args(node.args)})`;
		case 'MemberAccess':
			return node.computed
				? `(at ${sexp(node.object)} ${sexp(node.property)})`
				: `(. ${sexp(node.object)} ${node.property?.type === 'Identifier' ? node.property.name : '?'})`;
		case 'SliceExpression':
			return `(slice ${sexp(node.target)} ${sexp(node.from)} ${sexp(node.to)})`;
		case 'TestExpression':
			return `(${node.negated ? 'is-not' : 'is'} ${sexp(node.target)} ${node.name?.name ?? '?'}${args(node.args)})`;
		case 'ArrowFunction':
			return `(fn [${node.params.map((param) => param.name).join(' ')}] ${sexp(node.body)})`;
		case 'ArrayLiteral':
			return `[${node.elements.map(sexp).join(' ')}]`;
		case 'HashLiteral':
			return `{${node.entries
				.map((entry) =>
					entry.type === 'SpreadElement'
						? sexp(entry)
						: `${sexp(entry.key)}: ${sexp(entry.value)}`,
				)
				.join(' ')}}`;
		case 'SpreadElement':
			return `(... ${sexp(node.argument)})`;
		case 'Argument':
			return node.name === undefined
				? sexp(node.value)
				: `${node.name.name}=${sexp(node.value)}`;
	}
}

function args(list: readonly Argument[]): string {
	return list.length === 0 ? '' : ` ${list.map(sexp).join(' ')}`;
}
