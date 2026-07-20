import type {
	Argument,
	ArrayLiteral,
	ArrowFunction,
	Expression,
	HashEntry,
	Identifier,
	SourceRange,
	SpreadElement,
	StringLiteral,
	StringPart,
} from './ast';
import { createError, type ParseError, type ParseErrorCode } from './errors';
import { KEYWORD_LITERALS, type Token } from './tokens';

export type Associativity = 'left' | 'right';

interface OperatorInfo {
	readonly precedence: number;
	readonly associativity: Associativity;
}

/**
 * Unary operator precedences, straight from `twig/twig`'s Core extension.
 */
export const UNARY_OPERATORS: ReadonlyMap<string, OperatorInfo> = new Map([
	['not', { precedence: 50, associativity: 'left' as const }],
	['-', { precedence: 500, associativity: 'left' as const }],
	['+', { precedence: 500, associativity: 'left' as const }],
]);

/**
 * Binary operator precedences, straight from `twig/twig`'s Core extension and
 * cross-checked against the Twig 3 documentation's operator-precedence table.
 * Higher binds tighter. `|` (filter), `.`/`[]` (subscript) and `(` (call) are
 * postfix and bind tighter than everything here.
 */
export const BINARY_OPERATORS: ReadonlyMap<string, OperatorInfo> = new Map([
	['or', { precedence: 10, associativity: 'left' as const }],
	['and', { precedence: 15, associativity: 'left' as const }],
	['b-or', { precedence: 16, associativity: 'left' as const }],
	['b-xor', { precedence: 17, associativity: 'left' as const }],
	['b-and', { precedence: 18, associativity: 'left' as const }],
	['==', { precedence: 20, associativity: 'left' as const }],
	['!=', { precedence: 20, associativity: 'left' as const }],
	['<=>', { precedence: 20, associativity: 'left' as const }],
	['<', { precedence: 20, associativity: 'left' as const }],
	['>', { precedence: 20, associativity: 'left' as const }],
	['>=', { precedence: 20, associativity: 'left' as const }],
	['<=', { precedence: 20, associativity: 'left' as const }],
	['not in', { precedence: 20, associativity: 'left' as const }],
	['in', { precedence: 20, associativity: 'left' as const }],
	['matches', { precedence: 20, associativity: 'left' as const }],
	['starts with', { precedence: 20, associativity: 'left' as const }],
	['ends with', { precedence: 20, associativity: 'left' as const }],
	['has some', { precedence: 20, associativity: 'left' as const }],
	['has every', { precedence: 20, associativity: 'left' as const }],
	['..', { precedence: 25, associativity: 'left' as const }],
	['+', { precedence: 30, associativity: 'left' as const }],
	['-', { precedence: 30, associativity: 'left' as const }],
	['~', { precedence: 40, associativity: 'left' as const }],
	['*', { precedence: 60, associativity: 'left' as const }],
	['/', { precedence: 60, associativity: 'left' as const }],
	['//', { precedence: 60, associativity: 'left' as const }],
	['%', { precedence: 60, associativity: 'left' as const }],
	['is', { precedence: 100, associativity: 'left' as const }],
	['is not', { precedence: 100, associativity: 'left' as const }],
	['**', { precedence: 200, associativity: 'right' as const }],
	['??', { precedence: 300, associativity: 'right' as const }],
]);

/**
 * Core two-word tests. The parser is otherwise name-agnostic, but `is` cannot
 * be disambiguated structurally: `x is divisible by(3)` needs to know that
 * `divisible by` is one name. Only Twig core's two-word tests are special-cased.
 */
const TWO_WORD_TESTS: ReadonlyMap<string, string> = new Map([
	['divisible', 'by'],
	['same', 'as'],
]);

/**
 * Deepest expression nesting parsed before recovery gives up on the subtree.
 * Every nesting construct re-enters `parseExpression`, so bounding it there
 * bounds the call stack — without a cap, a few thousand pasted `[[[[…` or
 * `((((…` characters overflow it and break the "parse never throws" contract.
 * Real templates stay in single digits; the cap only exists for garbage input.
 */
const MAX_EXPRESSION_DEPTH = 250;

/** Token kinds that end a Twig region; expression parsing never consumes them. */
const BOUNDARY_KINDS = new Set([
	'eof',
	'text',
	'raw',
	'var-start',
	'var-end',
	'block-start',
	'block-end',
	'comment-start',
	'comment-text',
	'comment-end',
	'interpolation-end',
]);

/**
 * Token stream cursor plus the full Twig 3 expression grammar. `Parser` in
 * `parser.ts` extends this with template/tag structure.
 */
export class ExpressionParser {
	protected index = 0;
	private expressionDepth = 0;
	readonly errors: ParseError[] = [];

	constructor(
		protected readonly tokens: readonly Token[],
		protected readonly source: string,
		errors: readonly ParseError[] = [],
	) {
		this.errors.push(...errors);
	}

	// --- Cursor -----------------------------------------------------------

	protected peek(offset = 0): Token {
		const token = this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
		// The lexer always terminates the stream with `eof`, so this holds.
		return token as Token;
	}

	protected get current(): Token {
		return this.peek();
	}

	protected advance(): Token {
		const token = this.current;
		if (this.index < this.tokens.length - 1) {
			this.index++;
		}
		return token;
	}

	/** True when the cursor sits on a token that closes the enclosing region. */
	protected atBoundary(offset = 0): boolean {
		return BOUNDARY_KINDS.has(this.peek(offset).kind);
	}

	protected test(kind: Token['kind'], value?: string, offset = 0): boolean {
		const token = this.peek(offset);
		return token.kind === kind && (value === undefined || token.value === value);
	}

	protected accept(kind: Token['kind'], value?: string): Token | undefined {
		return this.test(kind, value) ? this.advance() : undefined;
	}

	/**
	 * Records an error, dropping exact duplicates. Recovery routinely rediscovers
	 * the same defect from several levels of the recursive descent; reporting it
	 * once is what milestone 04 wants to surface.
	 */
	protected error(code: ParseErrorCode, message: string, start: number, end: number): void {
		const last = this.errors[this.errors.length - 1];
		if (
			last !== undefined &&
			last.code === code &&
			last.start === start &&
			last.end === end &&
			last.message === message
		) {
			return;
		}
		this.errors.push(createError(code, message, start, end));
	}

	/** Records a zero-width "something should be here" error at `at`. */
	protected missing(code: ParseErrorCode, message: string, at: number): void {
		this.error(code, message, at, at);
	}

	// --- Expressions ------------------------------------------------------

	/**
	 * Mirrors Twig's `ExpressionParser::parseExpression`: a primary (which
	 * absorbs prefix operators and postfix `.`/`[]`/`|`/`()`), then a precedence
	 * climb over binary operators, then the conditional operator at the top.
	 */
	parseExpression(precedence = 0, allowArrow = false): Expression | undefined {
		if (this.expressionDepth >= MAX_EXPRESSION_DEPTH) {
			// Refusing without consuming is safe: every caller treats an undefined
			// expression as "stop collecting" and unwinds to a token-consuming loop.
			this.missing(
				'nesting-too-deep',
				'Expression is nested too deeply.',
				this.current.start,
			);
			return undefined;
		}
		this.expressionDepth++;
		try {
			return this.parseExpressionAtDepth(precedence, allowArrow);
		} finally {
			this.expressionDepth--;
		}
	}

	private parseExpressionAtDepth(
		precedence: number,
		allowArrow: boolean,
	): Expression | undefined {
		if (allowArrow) {
			const arrow = this.tryParseArrow();
			if (arrow !== undefined) {
				return arrow;
			}
		}

		let left = this.parsePrimary();
		if (left === undefined) {
			return undefined;
		}

		for (;;) {
			const operator = this.readBinaryOperator();
			if (operator === undefined || operator.info.precedence < precedence) {
				break;
			}
			this.index = operator.nextIndex;

			if (operator.name === 'is' || operator.name === 'is not') {
				left = this.parseTestExpression(left, operator.name === 'is not', operator.range);
				continue;
			}

			const nextPrecedence =
				operator.info.associativity === 'left'
					? operator.info.precedence + 1
					: operator.info.precedence;
			const right = this.parseExpression(nextPrecedence, allowArrow);
			left = {
				type: 'BinaryExpression',
				operator: operator.name,
				operatorRange: operator.range,
				left,
				right,
				start: left.start,
				end: right?.end ?? operator.range.end,
			};
		}

		return precedence === 0 ? this.parseConditional(left, allowArrow) : left;
	}

	/**
	 * Matches a binary operator at the cursor without consuming it. Word
	 * operators arrive as `name` tokens and several span two of them
	 * (`not in`, `starts with`, `has every`, `is not`).
	 */
	private readBinaryOperator():
		{ name: string; info: OperatorInfo; range: SourceRange; nextIndex: number } | undefined {
		const token = this.current;
		const build = (
			name: string,
			end: Token,
			nextIndex: number,
		):
			| { name: string; info: OperatorInfo; range: SourceRange; nextIndex: number }
			| undefined => {
			const info = BINARY_OPERATORS.get(name);
			return info === undefined
				? undefined
				: { name, info, range: { start: token.start, end: end.end }, nextIndex };
		};

		if (token.kind === 'operator') {
			return build(token.value, token, this.index + 1);
		}
		if (token.kind !== 'name') {
			return undefined;
		}

		const next = this.peek(1);
		if (next.kind === 'name') {
			const pair = `${token.value} ${next.value}`;
			if (BINARY_OPERATORS.has(pair)) {
				return build(pair, next, this.index + 2);
			}
		}
		return build(token.value, token, this.index + 1);
	}

	/** `a ? b : c` and the `a ?: b` shorthand. */
	private parseConditional(expression: Expression, allowArrow: boolean): Expression {
		let test = expression;
		while (this.test('punctuation', '?')) {
			this.advance();
			let consequent: Expression | undefined;
			let alternate: Expression | undefined;
			if (this.accept('punctuation', ':') !== undefined) {
				alternate = this.parseExpression(0, allowArrow);
			} else {
				consequent = this.parseExpression(0, allowArrow);
				if (this.accept('punctuation', ':') !== undefined) {
					alternate = this.parseExpression(0, allowArrow);
				}
			}
			test = {
				type: 'ConditionalExpression',
				test,
				consequent,
				alternate,
				start: test.start,
				end: alternate?.end ?? consequent?.end ?? this.previousEnd(),
			};
		}
		return test;
	}

	/** End offset of the last consumed token — the anchor for truncated nodes. */
	protected previousEnd(): number {
		const previous = this.tokens[Math.max(this.index - 1, 0)];
		return previous?.end ?? 0;
	}

	/**
	 * End offset for a node whose expected element is missing, stretching over
	 * the hole to the next token. `{{ name | }}` must stay a `FilterExpression`
	 * covering offset 9, not stop at the `|` — a cursor resting in the hole is
	 * exactly where completions get asked what belongs there.
	 */
	protected holeEnd(from: number): number {
		return Math.max(from, this.current.start);
	}

	private parsePrimary(): Expression | undefined {
		const token = this.current;

		if (this.atBoundary()) {
			this.missing('missing-expression', 'Expected an expression.', token.start);
			return undefined;
		}

		if (token.kind === 'operator' && UNARY_OPERATORS.has(token.value)) {
			const info = UNARY_OPERATORS.get(token.value) as OperatorInfo;
			this.advance();
			const argument = this.parseExpression(info.precedence);
			return this.parsePostfix({
				type: 'UnaryExpression',
				operator: token.value,
				operatorRange: { start: token.start, end: token.end },
				argument,
				start: token.start,
				end: argument?.end ?? token.end,
			});
		}
		if (token.kind === 'name' && token.value === 'not') {
			const info = UNARY_OPERATORS.get('not') as OperatorInfo;
			this.advance();
			const argument = this.parseExpression(info.precedence);
			return this.parsePostfix({
				type: 'UnaryExpression',
				operator: 'not',
				operatorRange: { start: token.start, end: token.end },
				argument,
				start: token.start,
				end: argument?.end ?? token.end,
			});
		}

		if (this.test('punctuation', '(')) {
			this.advance();
			// Arrows are allowed here even though Twig only permits them in
			// argument lists: `list has some (v => v.ok)` is real Twig 3.15, and
			// a tolerant parser should never invent an error Twig would not.
			const inner = this.parseExpression(0, true);
			const close = this.accept('punctuation', ')');
			if (close === undefined) {
				this.error(
					'unclosed-parenthesis',
					'Unclosed "(": expected ")".',
					token.start,
					this.previousEnd(),
				);
			}
			if (inner === undefined) {
				return undefined;
			}
			// Twig discards parentheses; widening the range keeps offset lookups
			// inside the parens resolving to the expression they wrap.
			inner.start = token.start;
			inner.end = close?.end ?? inner.end;
			return this.parsePostfix(inner);
		}

		return this.parsePrimaryValue(token);
	}

	private parsePrimaryValue(token: Token): Expression | undefined {
		if (token.kind === 'name') {
			this.advance();
			const lower = token.value.toLowerCase();
			if (KEYWORD_LITERALS.has(lower)) {
				const literal: Expression =
					lower === 'true' || lower === 'false'
						? {
								type: 'BooleanLiteral',
								value: lower === 'true',
								start: token.start,
								end: token.end,
							}
						: { type: 'NullLiteral', start: token.start, end: token.end };
				return this.parsePostfix(literal);
			}
			const identifier: Identifier = {
				type: 'Identifier',
				name: token.value,
				start: token.start,
				end: token.end,
			};
			return this.parsePostfix(identifier);
		}

		if (token.kind === 'number') {
			this.advance();
			return this.parsePostfix({
				type: 'NumberLiteral',
				value: parseNumber(token.value),
				raw: token.value,
				start: token.start,
				end: token.end,
			});
		}

		if (token.kind === 'string-start') {
			return this.parsePostfix(this.parseString());
		}

		if (this.test('punctuation', '[')) {
			return this.parsePostfix(this.parseArray());
		}

		if (this.test('punctuation', '{')) {
			return this.parsePostfix(this.parseHash());
		}

		this.error(
			'unexpected-token',
			`Unexpected ${JSON.stringify(token.value)} in expression.`,
			token.start,
			token.end,
		);
		this.advance();
		return undefined;
	}

	private parseString(): StringLiteral {
		const open = this.advance();
		const quote = open.value === '"' ? '"' : "'";
		const parts: StringPart[] = [];
		let decoded = '';
		let end = open.end;

		for (;;) {
			const token = this.current;
			if (token.kind === 'string-text') {
				this.advance();
				const value = decodeEscapes(token.value);
				decoded += value;
				parts.push({ type: 'StringText', value, start: token.start, end: token.end });
				end = token.end;
				continue;
			}
			if (token.kind === 'interpolation-start') {
				this.advance();
				const expression = this.parseExpression();
				const close = this.accept('interpolation-end');
				parts.push({
					type: 'Interpolation',
					expression,
					start: token.start,
					end: close?.end ?? expression?.end ?? token.end,
				});
				end = close?.end ?? end;
				continue;
			}
			if (token.kind === 'string-end') {
				this.advance();
				end = token.end;
			}
			break;
		}

		return { type: 'StringLiteral', value: decoded, parts, quote, start: open.start, end };
	}

	private parseArray(): ArrayLiteral {
		const open = this.advance();
		const elements: (Expression | SpreadElement)[] = [];
		while (!this.test('punctuation', ']') && !this.atBoundary()) {
			if (elements.length > 0 && this.accept('punctuation', ',') === undefined) {
				break;
			}
			if (this.test('punctuation', ']')) {
				break;
			}
			const element = this.parseSpreadOrExpression();
			if (element === undefined) {
				break;
			}
			elements.push(element);
		}
		const close = this.accept('punctuation', ']');
		if (close === undefined) {
			this.error(
				'unclosed-bracket',
				'Unclosed "[": expected "]".',
				open.start,
				this.previousEnd(),
			);
		}
		return {
			type: 'ArrayLiteral',
			elements,
			start: open.start,
			end: close?.end ?? this.previousEnd(),
		};
	}

	private parseHash(): Expression {
		const open = this.advance();
		const entries: (HashEntry | SpreadElement)[] = [];
		while (!this.test('punctuation', '}') && !this.atBoundary()) {
			if (entries.length > 0 && this.accept('punctuation', ',') === undefined) {
				break;
			}
			if (this.test('punctuation', '}')) {
				break;
			}
			const entry = this.parseHashEntry();
			if (entry === undefined) {
				break;
			}
			entries.push(entry);
		}
		const close = this.accept('punctuation', '}');
		if (close === undefined) {
			this.error(
				'unclosed-brace',
				'Unclosed "{": expected "}".',
				open.start,
				this.previousEnd(),
			);
		}
		return {
			type: 'HashLiteral',
			entries,
			start: open.start,
			end: close?.end ?? this.previousEnd(),
		};
	}

	private parseHashEntry(): HashEntry | SpreadElement | undefined {
		const spread = this.tryParseSpread();
		if (spread !== undefined) {
			return spread;
		}

		const start = this.current.start;
		// `{ (expr): v }` uses parentheses for computed keys; bare names and
		// literals are keys, everything else is an error Twig would raise too.
		const key = this.parseExpression();
		if (key === undefined) {
			return undefined;
		}
		if (this.accept('punctuation', ':') === undefined) {
			// `{ name }` shorthand for `{ name: name }`.
			return { type: 'HashEntry', key, value: key, shorthand: true, start, end: key.end };
		}
		const value = this.parseExpression();
		return {
			type: 'HashEntry',
			key,
			value,
			shorthand: false,
			start,
			end: value?.end ?? this.previousEnd(),
		};
	}

	private parseSpreadOrExpression(): Expression | SpreadElement | undefined {
		return this.tryParseSpread() ?? this.parseExpression();
	}

	private tryParseSpread(): SpreadElement | undefined {
		const token = this.accept('operator', '...');
		if (token === undefined) {
			return undefined;
		}
		const argument = this.parseExpression();
		return {
			type: 'SpreadElement',
			argument,
			start: token.start,
			end: argument?.end ?? token.end,
		};
	}

	/** `.name`, `.method(…)`, `[expr]`, `[a:b]` slices, `(…)` calls and `|filter`. */
	private parsePostfix(node: Expression): Expression {
		let current = node;
		for (;;) {
			if (this.test('punctuation', '.')) {
				current = this.parseMemberAccess(current);
			} else if (this.test('punctuation', '[')) {
				current = this.parseSubscript(current);
			} else if (this.test('punctuation', '(')) {
				current = this.parseCall(current);
			} else if (this.test('punctuation', '|')) {
				current = this.parseFilter(current);
			} else {
				return current;
			}
		}
	}

	private parseMemberAccess(object: Expression): Expression {
		const dot = this.advance();
		const token = this.current;
		// Twig allows names and integers after `.`; `a.and` and `a.0` are legal.
		if (token.kind === 'name' || token.kind === 'number') {
			this.advance();
			const property: Identifier = {
				type: 'Identifier',
				name: token.value,
				start: token.start,
				end: token.end,
			};
			return {
				type: 'MemberAccess',
				object,
				property,
				computed: false,
				start: object.start,
				end: token.end,
			};
		}
		// `{{ user. }}` — keep the access so completions know the receiver.
		this.missing('missing-property', 'Expected a property name after ".".', dot.end);
		return {
			type: 'MemberAccess',
			object,
			property: undefined,
			computed: false,
			start: object.start,
			end: this.holeEnd(dot.end),
		};
	}

	private parseSubscript(object: Expression): Expression {
		const open = this.advance();
		const first = this.test('punctuation', ':') ? undefined : this.parseExpression();

		if (this.accept('punctuation', ':') !== undefined) {
			const to = this.test('punctuation', ']') ? undefined : this.parseExpression();
			const sliceClose = this.expectBracket(open);
			return {
				type: 'SliceExpression',
				target: object,
				from: first,
				to,
				start: object.start,
				end: sliceClose ?? this.previousEnd(),
			};
		}

		const close = this.expectBracket(open);
		return {
			type: 'MemberAccess',
			object,
			property: first,
			computed: true,
			start: object.start,
			end: close ?? this.previousEnd(),
		};
	}

	private expectBracket(open: Token): number | undefined {
		const close = this.accept('punctuation', ']');
		if (close === undefined) {
			this.error(
				'unclosed-bracket',
				'Unclosed "[": expected "]".',
				open.start,
				this.previousEnd(),
			);
		}
		return close?.end;
	}

	private parseCall(callee: Expression): Expression {
		const args = this.parseArguments();
		return {
			type: 'CallExpression',
			callee,
			args: args.args,
			start: callee.start,
			end: args.end,
		};
	}

	private parseFilter(target: Expression): Expression {
		const pipe = this.advance();
		const token = this.accept('name');
		if (token === undefined) {
			// `{{ x | }}` — keep the filter so completions know the target.
			this.missing('missing-filter-name', 'Expected a filter name after "|".', pipe.end);
			return {
				type: 'FilterExpression',
				target,
				name: undefined,
				args: [],
				start: target.start,
				end: this.holeEnd(pipe.end),
			};
		}
		const name: Identifier = {
			type: 'Identifier',
			name: token.value,
			start: token.start,
			end: token.end,
		};
		const args = this.test('punctuation', '(') ? this.parseArguments() : undefined;
		return {
			type: 'FilterExpression',
			target,
			name,
			args: args?.args ?? [],
			start: target.start,
			end: args?.end ?? token.end,
		};
	}

	private parseTestExpression(
		target: Expression,
		negated: boolean,
		operatorRange: SourceRange,
	): Expression {
		const token = this.accept('name');
		if (token === undefined) {
			this.missing(
				'missing-test-name',
				'Expected a test name after "is".',
				operatorRange.end,
			);
			return {
				type: 'TestExpression',
				target,
				negated,
				name: undefined,
				args: [],
				start: target.start,
				end: this.holeEnd(operatorRange.end),
			};
		}

		let end = token.end;
		let text = token.value;
		const second = TWO_WORD_TESTS.get(token.value);
		if (second !== undefined && this.test('name', second)) {
			end = this.advance().end;
			text = `${token.value} ${second}`;
		}
		const name: Identifier = { type: 'Identifier', name: text, start: token.start, end };
		const args = this.test('punctuation', '(') ? this.parseArguments() : undefined;
		return {
			type: 'TestExpression',
			target,
			negated,
			name,
			args: args?.args ?? [],
			start: target.start,
			end: args?.end ?? end,
		};
	}

	/** `( a, b=1, ...rest, v => v.x )`. Arrow functions are allowed here only. */
	protected parseArguments(): { args: Argument[]; end: number } {
		const open = this.advance();
		const args: Argument[] = [];

		while (!this.test('punctuation', ')') && !this.atBoundary()) {
			if (args.length > 0 && this.accept('punctuation', ',') === undefined) {
				break;
			}
			if (this.test('punctuation', ')')) {
				break;
			}
			const argument = this.parseArgument();
			if (argument === undefined) {
				break;
			}
			args.push(argument);
		}

		const close = this.accept('punctuation', ')');
		if (close === undefined) {
			this.error(
				'unclosed-parenthesis',
				'Unclosed "(": expected ")".',
				open.start,
				this.previousEnd(),
			);
		}
		return { args, end: close?.end ?? this.previousEnd() };
	}

	private parseArgument(): Argument | undefined {
		const start = this.current.start;

		const spread = this.tryParseSpread();
		if (spread !== undefined) {
			return { type: 'Argument', name: undefined, value: spread, start, end: spread.end };
		}

		// `name=value` — only a bare name followed by `=` is a named argument.
		if (this.test('name') && this.test('operator', '=', 1)) {
			const nameToken = this.advance();
			this.advance();
			const value = this.parseExpression(0, true);
			return {
				type: 'Argument',
				name: {
					type: 'Identifier',
					name: nameToken.value,
					start: nameToken.start,
					end: nameToken.end,
				},
				value,
				start,
				end: value?.end ?? this.previousEnd(),
			};
		}

		const value = this.parseExpression(0, true);
		if (value === undefined) {
			return undefined;
		}
		return { type: 'Argument', name: undefined, value, start, end: value.end };
	}

	/**
	 * Recognises `v => …` and `(a, b) => …` by lookahead, exactly like Twig's
	 * `ExpressionParser::parseArrow`. Returns undefined when the cursor is not
	 * on an arrow function, without consuming anything.
	 */
	private tryParseArrow(): ArrowFunction | undefined {
		if (this.test('name') && this.test('operator', '=>', 1)) {
			const nameToken = this.advance();
			this.advance();
			const body = this.parseExpression();
			return {
				type: 'ArrowFunction',
				params: [
					{
						type: 'Identifier',
						name: nameToken.value,
						start: nameToken.start,
						end: nameToken.end,
					},
				],
				body,
				start: nameToken.start,
				end: body?.end ?? this.previousEnd(),
			};
		}

		if (!this.test('punctuation', '(')) {
			return undefined;
		}
		let offset = 1;
		if (!this.test('punctuation', ')', offset)) {
			for (;;) {
				if (!this.test('name', undefined, offset)) {
					return undefined;
				}
				offset++;
				if (!this.test('punctuation', ',', offset)) {
					break;
				}
				offset++;
			}
		}
		if (!this.test('punctuation', ')', offset) || !this.test('operator', '=>', offset + 1)) {
			return undefined;
		}

		const open = this.advance();
		const params: Identifier[] = [];
		while (!this.test('punctuation', ')')) {
			if (params.length > 0) {
				this.advance();
			}
			const token = this.advance();
			params.push({
				type: 'Identifier',
				name: token.value,
				start: token.start,
				end: token.end,
			});
		}
		this.advance();
		this.advance();
		const body = this.parseExpression();
		return {
			type: 'ArrowFunction',
			params,
			body,
			start: open.start,
			end: body?.end ?? this.previousEnd(),
		};
	}
}

const ESCAPES: Record<string, string> = {
	n: '\n',
	t: '\t',
	r: '\r',
	f: '\f',
	v: '\v',
	'\\': '\\',
	'"': '"',
	"'": "'",
	'#': '#',
};

function decodeEscapes(raw: string): string {
	if (!raw.includes('\\')) {
		return raw;
	}
	let out = '';
	for (let at = 0; at < raw.length; at++) {
		const ch = raw.charAt(at);
		if (ch !== '\\' || at === raw.length - 1) {
			out += ch;
			continue;
		}
		const next = raw.charAt(at + 1);
		out += ESCAPES[next] ?? next;
		at++;
	}
	return out;
}

function parseNumber(raw: string): number {
	const clean = raw.replace(/_/g, '');
	if (/^0[xXbBoO]/.test(clean)) {
		const value = Number(clean.replace(/^0[oO]/, '0o'));
		return Number.isNaN(value) ? 0 : value;
	}
	const value = Number(clean);
	return Number.isNaN(value) ? 0 : value;
}
