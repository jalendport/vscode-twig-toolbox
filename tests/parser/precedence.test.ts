import { describe, expect, it } from 'vitest';
import { BINARY_OPERATORS, parse, UNARY_OPERATORS } from '../../packages/parser/src/index';
import { sexp } from './sexp';

/** Parses `{{ source }}` and renders the expression, asserting it is clean. */
function expr(source: string): string {
	const result = parse(`{{ ${source} }}`);
	expect(result.errors).toEqual([]);
	const output = result.template.body[0];
	if (output?.type !== 'Output') {
		throw new Error(`expected an Output node, got ${output?.type ?? 'nothing'}`);
	}
	return sexp(output.expression);
}

/**
 * Twig 3's documented operator-precedence table, lowest tier first.
 *
 * Source: the "Operator Precedence" table in the Twig 3 docs, cross-checked
 * against `Twig\Extension\CoreExtension::getOperators()`. The ternary `?:` sits
 * below every binary operator and is handled outside this table, and the
 * postfix `|`, `[]` and `.` sit above it.
 */
const DOCUMENTED_TIERS: readonly (readonly string[])[] = [
	['or'],
	['and'],
	['b-or'],
	['b-xor'],
	['b-and'],
	[
		'==',
		'!=',
		'<=>',
		'<',
		'>',
		'>=',
		'<=',
		'in',
		'not in',
		'matches',
		'starts with',
		'ends with',
		'has some',
		'has every',
	],
	['..'],
	['+', '-'],
	['~'],
	['*', '/', '//', '%'],
	['is', 'is not'],
	['**'],
	['??'],
];

describe('operator precedence table', () => {
	it('covers exactly the documented operators', () => {
		expect([...BINARY_OPERATORS.keys()].sort()).toEqual([...DOCUMENTED_TIERS.flat()].sort());
	});

	it('gives every operator in a tier the same precedence', () => {
		for (const tier of DOCUMENTED_TIERS) {
			const precedences = tier.map((name) => BINARY_OPERATORS.get(name)?.precedence);
			expect(new Set(precedences).size, `tier ${tier.join(', ')}`).toBe(1);
		}
	});

	it('orders the tiers as documented', () => {
		const precedences = DOCUMENTED_TIERS.map(
			(tier) => BINARY_OPERATORS.get(tier[0] as string)?.precedence,
		);
		const ascending = [...precedences].sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(precedences).toEqual(ascending);
		expect(new Set(precedences).size).toBe(DOCUMENTED_TIERS.length);
	});

	it('makes only ** and ?? right-associative', () => {
		const right = [...BINARY_OPERATORS.entries()]
			.filter(([, info]) => info.associativity === 'right')
			.map(([name]) => name);
		expect(right.sort()).toEqual(['**', '??']);
	});

	it('ranks unary minus above every binary operator except none', () => {
		expect(UNARY_OPERATORS.get('-')?.precedence).toBe(500);
		expect(UNARY_OPERATORS.get('+')?.precedence).toBe(500);
		// `not` deliberately binds looser than `is`, so `not a is defined`
		// negates the test rather than its target.
		expect(UNARY_OPERATORS.get('not')?.precedence).toBe(50);
	});
});

describe('precedence in practice', () => {
	const cases: readonly (readonly [string, string])[] = [
		// Arithmetic tiers.
		['1 + 2 * 3', '(+ 1 (* 2 3))'],
		['1 * 2 + 3', '(+ (* 1 2) 3)'],
		['1 + 2 - 3', '(- (+ 1 2) 3)'],
		['1 - 2 - 3', '(- (- 1 2) 3)'],
		['8 / 4 / 2', '(/ (/ 8 4) 2)'],
		['8 // 4 % 3', '(% (// 8 4) 3)'],
		// `**` is the only right-associative arithmetic operator.
		['2 ** 3 ** 2', '(** 2 (** 3 2))'],
		['2 * 3 ** 2', '(* 2 (** 3 2))'],
		// `~` binds tighter than `+`/`-` — a documented Twig surprise.
		['1 + 2 ~ 3', '(+ 1 (~ 2 3))'],
		['a ~ b ~ c', '(~ (~ a b) c)'],
		// Comparison below arithmetic, logic below comparison.
		['a + 1 == b * 2', '(== (+ a 1) (* b 2))'],
		['a and b or c', '(or (and a b) c)'],
		['a or b and c', '(or a (and b c))'],
		['a == b and c != d', '(and (== a b) (!= c d))'],
		['a b-or b b-and c', '(b-or a (b-and b c))'],
		['a b-and b b-xor c b-or d', '(b-or (b-xor (b-and a b) c) d)'],
		// Same tier stays left-associative.
		['a in b == c', '(== (in a b) c)'],
		['a starts with b and c', '(and (starts with a b) c)'],
		['a not in b or c', '(or (not in a b) c)'],
		// Range sits between comparison and `+`.
		['1 + 1 .. 3 * 2', '(.. (+ 1 1) (* 3 2))'],
		['a == 1 .. 2', '(== a (.. 1 2))'],
		// `is` binds tighter than everything but `**`, `??` and postfix.
		['a is defined and b', '(and (is a defined) b)'],
		['a is not empty or b', '(or (is-not a empty) b)'],
		['not a is defined', '(not. (is a defined))'],
		['a is divisible by(3)', '(is a divisible by 3)'],
		['a is same as(b)', '(is a same as b)'],
		// `is` outranks arithmetic, so this tests `1`, not `a + 1` — which is
		// why Twig's docs tell you to parenthesise. Pinned deliberately.
		['a + 1 is odd', '(+ a (is 1 odd))'],
		['(a + 1) is odd', '(is (+ a 1) odd)'],
		// `??` binds tighter than `**`, per the documented table.
		['a ?? b ?? c', '(?? a (?? b c))'],
		['a ?? b or c', '(or (?? a b) c)'],
		['a ?? b ** c', '(** (?? a b) c)'],
		// Ternary is the loosest of all, and chains to the right.
		['a ? b : c', '(?: a b c)'],
		['a ? b : c ? d : e', '(?: a b (?: c d e))'],
		['a ?: b', '(?: a ? b)'],
		['a ? b', '(?: a b ?)'],
		['a or b ? c : d', '(?: (or a b) c d)'],
		['a ?? b ? c : d', '(?: (?? a b) c d)'],
		// Postfix binds tightest.
		['a * b|upper', '(* a (| b upper))'],
		['a|upper ~ b|lower', '(~ (| a upper) (| b lower))'],
		['a.b.c', '(. (. a b) c)'],
		['a[0][1]', '(at (at a 0) 1)'],
		['a|b|c', '(| (| a b) c)'],
		['a.b(1)|c', '(| (call (. a b) 1) c)'],
		['a not in b|keys', '(not in a (| b keys))'],
		// Unary minus outranks every binary operator, so it captures only its
		// operand — but postfix still wins, which is Twig's `-1|abs` gotcha.
		['-a + b', '(+ (-. a) b)'],
		['-a ** b', '(** (-. a) b)'],
		['-1|abs', '(-. (| 1 abs))'],
		['not a and b', '(and (not. a) b)'],
		['not a or not b', '(or (not. a) (not. b))'],
		// Parentheses override everything.
		['(1 + 2) * 3', '(* (+ 1 2) 3)'],
		['(a or b) and c', '(and (or a b) c)'],
		['not (a and b)', '(not. (and a b))'],
	];

	for (const [source, expected] of cases) {
		it(`parses ${source} as ${expected}`, () => {
			expect(expr(source)).toBe(expected);
		});
	}
});
