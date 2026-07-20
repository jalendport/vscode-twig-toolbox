import { createError, type ParseError, type ParseErrorCode } from './errors';
import type { Token, TokenKind, WhitespaceControl } from './tokens';

export interface LexResult {
	readonly tokens: Token[];
	readonly errors: ParseError[];
}

/**
 * Operators, longest match first. Word operators (`and`, `is`, `starts with`…)
 * are lexed as `name` tokens and reinterpreted by the parser; only `b-and` and
 * friends need lexer help because of the embedded hyphen.
 */
const OPERATORS = [
	'...',
	'<=>',
	'**',
	'//',
	'==',
	'!=',
	'>=',
	'<=',
	'=>',
	'??',
	'..',
	'+',
	'-',
	'*',
	'/',
	'%',
	'<',
	'>',
	'=',
	'~',
];

/** Mirrors Twig's `PUNCTUATION_TYPE` character set. */
const PUNCTUATION = new Set(['(', ')', '[', ']', '{', '}', '?', ':', '.', ',', '|']);

const NAME_RE = /[a-zA-Z_][a-zA-Z0-9_]*/y;
const BITWISE_RE = /b-(?:and|or|xor)(?![a-zA-Z0-9_])/y;
const NUMBER_RE =
	/0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[bB][01][01_]*|0[oO][0-7][0-7_]*|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y;
const VERBATIM_NAME_RE = /verbatim(?![a-zA-Z0-9_])/y;
const ENDVERBATIM_RE = /\{%[-~]?\s*endverbatim\s*[-~]?%\}/g;

/** Every sequence that can open a Twig construct. */
const MARKERS = ['{{', '{%', '{#'];

type RegionKind = 'var' | 'block';

/**
 * Deepest `"#{ "#{ … }" }"` nesting lexed before `#{` is treated as literal
 * string text. Each level recurses `lexString → lexInterpolation`, so a cap is
 * what keeps `tokenize` total on pathological input; no real template nests
 * interpolations anywhere near this deep.
 */
const MAX_INTERPOLATION_DEPTH = 50;

/** Delimiter that legally closes each region kind. */
const REGION_CLOSE: Record<RegionKind, string> = { var: '}}', block: '%}' };
const REGION_UNTERMINATED: Record<RegionKind, ParseErrorCode> = {
	var: 'unterminated-output',
	block: 'unterminated-block',
};
const REGION_END_KIND: Record<RegionKind, TokenKind> = { var: 'var-end', block: 'block-end' };

class Lexer {
	private pos = 0;
	private interpolationDepth = 0;
	/** Delimiter closing the region being lexed; guides unterminated-string recovery. */
	private regionClose: string | undefined;
	private readonly markerCache = new Map<string, number>();
	readonly tokens: Token[] = [];
	readonly errors: ParseError[] = [];

	constructor(private readonly source: string) {}

	run(): void {
		const { source } = this;
		while (this.pos < source.length) {
			const next = this.findConstruct(this.pos);
			if (next === undefined) {
				this.push('text', this.pos, source.length);
				this.pos = source.length;
				break;
			}
			if (next > this.pos) {
				this.push('text', this.pos, next);
			}
			this.pos = next;
			const marker = source.charAt(next + 1);
			if (marker === '#') {
				this.lexComment();
			} else if (marker === '{') {
				this.lexRegionTag('var');
			} else {
				this.lexRegionTag('block');
			}
		}
		this.push('eof', source.length, source.length);
	}

	/** Offset of the next `{{`, `{%` or `{#`, or undefined if the rest is text. */
	private findConstruct(from: number): number | undefined {
		let best: number | undefined;
		for (const marker of MARKERS) {
			const at = this.nextMarker(marker, from);
			if (at !== -1 && (best === undefined || at < best)) {
				best = at;
			}
		}
		return best;
	}

	/**
	 * Memoised `indexOf` for a construct marker.
	 *
	 * The cursor only moves forward, so a previously found occurrence at or
	 * after `from` is still the next one, and "none found" stays true forever.
	 * Without this, a template containing no `{#` re-scans the entire remaining
	 * source for it at every construct — quadratic on exactly the templates that
	 * are already the largest.
	 */
	private nextMarker(marker: string, from: number): number {
		const cached = this.markerCache.get(marker);
		if (cached !== undefined && (cached === -1 || cached >= from)) {
			return cached;
		}
		const at = this.source.indexOf(marker, from);
		this.markerCache.set(marker, at);
		return at;
	}

	private push(kind: TokenKind, start: number, end: number, wsControl?: WhitespaceControl): void {
		const value = this.source.slice(start, end);
		this.tokens.push(
			wsControl === undefined
				? { kind, value, start, end }
				: { kind, value, start, end, wsControl },
		);
	}

	private error(code: ParseErrorCode, message: string, start: number, end: number): void {
		this.errors.push(createError(code, message, start, end));
	}

	/** Consumes a leading `-`/`~` marker directly after an opening delimiter. */
	private readOpenWsControl(): WhitespaceControl | undefined {
		const ch = this.source.charAt(this.pos);
		if (ch === '-' || ch === '~') {
			this.pos++;
			return ch;
		}
		return undefined;
	}

	private lexComment(): void {
		const start = this.pos;
		this.pos += 2;
		const openWs = this.readOpenWsControl();
		this.push('comment-start', start, this.pos, openWs);

		const close = this.source.indexOf('#}', this.pos);
		if (close === -1) {
			if (this.pos < this.source.length) {
				this.push('comment-text', this.pos, this.source.length);
			}
			this.error(
				'unterminated-comment',
				'Unclosed comment: expected "#}".',
				start,
				this.source.length,
			);
			this.pos = this.source.length;
			return;
		}

		let textEnd = close;
		let ws: WhitespaceControl | undefined;
		const prev = this.source.charAt(close - 1);
		if ((prev === '-' || prev === '~') && close - 1 >= this.pos) {
			textEnd = close - 1;
			ws = prev;
		}
		if (textEnd > this.pos) {
			this.push('comment-text', this.pos, textEnd);
		}
		this.push('comment-end', textEnd, close + 2, ws);
		this.pos = close + 2;
	}

	private lexRegionTag(kind: RegionKind): void {
		const start = this.pos;
		this.pos += 2;
		const ws = this.readOpenWsControl();
		this.push(kind === 'var' ? 'var-start' : 'block-start', start, this.pos, ws);

		const verbatim = kind === 'block' && this.peeksVerbatim();
		this.regionClose = REGION_CLOSE[kind];
		this.lexRegion(kind, start);
		this.regionClose = undefined;
		if (verbatim) {
			this.lexVerbatimBody();
		}
	}

	/** True when the block region we just opened is a `{% verbatim %}` tag. */
	private peeksVerbatim(): boolean {
		let at = this.pos;
		while (at < this.source.length && isWhitespace(this.source.charAt(at))) {
			at++;
		}
		VERBATIM_NAME_RE.lastIndex = at;
		return VERBATIM_NAME_RE.test(this.source);
	}

	private lexVerbatimBody(): void {
		ENDVERBATIM_RE.lastIndex = this.pos;
		const match = ENDVERBATIM_RE.exec(this.source);
		if (match === null) {
			if (this.pos < this.source.length) {
				this.push('raw', this.pos, this.source.length);
			}
			this.error(
				'unterminated-verbatim',
				'Unclosed "verbatim" block: expected "{% endverbatim %}".',
				this.pos,
				this.source.length,
			);
			this.pos = this.source.length;
			return;
		}
		if (match.index > this.pos) {
			this.push('raw', this.pos, match.index);
		}
		// Leave the `{% endverbatim %}` itself to the main loop, which lexes it
		// as an ordinary block so the parser sees a normal end tag.
		this.pos = match.index;
	}

	/**
	 * Lexes the inside of a `{{ }}` or `{% %}` region up to and including its
	 * closing delimiter. Recovers at a mismatched close, at the start of another
	 * Twig construct, or at EOF.
	 */
	private lexRegion(kind: RegionKind, regionStart: number): void {
		const { source } = this;
		for (;;) {
			this.skipWhitespace();
			if (this.pos >= source.length) {
				this.error(
					REGION_UNTERMINATED[kind],
					`Unclosed ${kind === 'var' ? 'output' : 'block'}: expected "${REGION_CLOSE[kind]}".`,
					regionStart,
					source.length,
				);
				return;
			}

			const close = this.tryReadRegionEnd(kind);
			if (close) {
				return;
			}
			if (this.startsConstruct(this.pos)) {
				this.error(
					REGION_UNTERMINATED[kind],
					`Unclosed ${kind === 'var' ? 'output' : 'block'}: expected "${REGION_CLOSE[kind]}".`,
					regionStart,
					this.pos,
				);
				return;
			}
			this.lexExpressionToken();
		}
	}

	/**
	 * Consumes a region-closing delimiter if one is at the cursor. A delimiter
	 * belonging to the *other* region kind is consumed too, with an error — a
	 * `{{ x %}` typo should not swallow the rest of the document.
	 */
	private tryReadRegionEnd(kind: RegionKind): boolean {
		const { source, pos } = this;
		const ch = source.charAt(pos);
		const ws = ch === '-' || ch === '~' ? ch : undefined;
		const at = ws === undefined ? pos : pos + 1;
		const expected = REGION_CLOSE[kind];
		const other = kind === 'var' ? '%}' : '}}';

		if (!source.startsWith(expected, at)) {
			if (!source.startsWith(other, at)) {
				return false;
			}
			this.error(
				'mismatched-delimiter',
				`Expected "${expected}" to close this ${kind === 'var' ? 'output' : 'block'}, found "${other}".`,
				pos,
				at + 2,
			);
		}
		this.push(REGION_END_KIND[kind], pos, at + 2, ws);
		this.pos = at + 2;
		return true;
	}

	private startsConstruct(at: number): boolean {
		const { source } = this;
		return (
			source.startsWith('{{', at) ||
			source.startsWith('{%', at) ||
			source.startsWith('{#', at)
		);
	}

	private skipWhitespace(): void {
		while (this.pos < this.source.length && isWhitespace(this.source.charAt(this.pos))) {
			this.pos++;
		}
	}

	/** Lexes exactly one token inside a Twig region. Always advances the cursor. */
	private lexExpressionToken(): void {
		const { source, pos } = this;
		const ch = source.charAt(pos);

		if (ch === '"' || ch === "'") {
			this.lexString(ch);
			return;
		}

		if (ch === 'b') {
			BITWISE_RE.lastIndex = pos;
			const bitwise = BITWISE_RE.exec(source);
			if (bitwise !== null) {
				this.pos = pos + bitwise[0].length;
				this.push('operator', pos, this.pos);
				return;
			}
		}

		NAME_RE.lastIndex = pos;
		const name = NAME_RE.exec(source);
		if (name !== null) {
			this.pos = pos + name[0].length;
			this.push('name', pos, this.pos);
			return;
		}

		if (ch >= '0' && ch <= '9') {
			NUMBER_RE.lastIndex = pos;
			const number = NUMBER_RE.exec(source);
			if (number !== null) {
				this.pos = pos + number[0].length;
				this.push('number', pos, this.pos);
				return;
			}
		}

		for (const op of OPERATORS) {
			if (source.startsWith(op, pos)) {
				this.pos = pos + op.length;
				this.push('operator', pos, this.pos);
				return;
			}
		}

		if (PUNCTUATION.has(ch)) {
			this.pos = pos + 1;
			this.push('punctuation', pos, this.pos);
			return;
		}

		this.pos = pos + 1;
		this.push('error', pos, this.pos);
		this.error(
			'unexpected-character',
			`Unexpected character ${JSON.stringify(ch)}.`,
			pos,
			this.pos,
		);
	}

	/**
	 * Lexes a quoted string into `string-start`, alternating `string-text` and
	 * interpolation regions, then `string-end`.
	 *
	 * Twig strings may span lines, so an unterminated string is only clamped
	 * once we know no closing quote exists at all — legitimate multi-line
	 * strings stay intact. The clamp stops at the enclosing region's closing
	 * delimiter or the end of the line, whichever comes first, so `{{ "oops }}`
	 * still closes its output and leaves the rest of the document as text.
	 */
	private lexString(quote: string): void {
		const { source } = this;
		const start = this.pos;
		this.pos++;
		this.push('string-start', start, this.pos);
		const limit = this.stringLimit(quote);

		let textStart = this.pos;
		const flushText = (): void => {
			if (this.pos > textStart) {
				this.push('string-text', textStart, this.pos);
			}
		};

		while (this.pos < limit) {
			const ch = source.charAt(this.pos);
			if (ch === '\\' && this.pos + 1 < limit) {
				this.pos += 2;
				continue;
			}
			if (ch === quote) {
				flushText();
				this.push('string-end', this.pos, this.pos + 1);
				this.pos++;
				return;
			}
			if (
				quote === '"' &&
				ch === '#' &&
				source.charAt(this.pos + 1) === '{' &&
				this.interpolationDepth < MAX_INTERPOLATION_DEPTH
			) {
				flushText();
				this.push('interpolation-start', this.pos, this.pos + 2);
				this.pos += 2;
				this.lexInterpolation();
				textStart = this.pos;
				continue;
			}
			this.pos++;
		}

		this.pos = limit;
		flushText();
		this.error('unterminated-string', `Unclosed string: expected ${quote}.`, start, limit);
	}

	/** Where an unterminated string has to stop; `source.length` if it closes. */
	private stringLimit(quote: string): number {
		const { source } = this;
		if (findClosingQuote(source, this.pos, quote) !== -1) {
			return source.length;
		}
		let limit = lineEnd(source, this.pos);
		if (this.regionClose !== undefined) {
			const close = source.indexOf(this.regionClose, this.pos);
			if (close !== -1 && close < limit) {
				limit = close;
			}
		}
		return limit;
	}

	/** Lexes `#{ … }` inside a double-quoted string, up to the matching brace. */
	private lexInterpolation(): void {
		this.interpolationDepth++;
		try {
			this.lexInterpolationBody();
		} finally {
			this.interpolationDepth--;
		}
	}

	private lexInterpolationBody(): void {
		const start = this.pos - 2;
		let depth = 0;
		for (;;) {
			this.skipWhitespace();
			if (this.pos >= this.source.length || this.startsConstruct(this.pos)) {
				this.error(
					'unterminated-interpolation',
					'Unclosed interpolation: expected "}".',
					start,
					this.pos,
				);
				return;
			}
			const ch = this.source.charAt(this.pos);
			if (ch === '}') {
				if (depth === 0) {
					this.push('interpolation-end', this.pos, this.pos + 1);
					this.pos++;
					return;
				}
				depth--;
			} else if (ch === '{') {
				depth++;
			}
			this.lexExpressionToken();
		}
	}
}

function isWhitespace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function lineEnd(source: string, from: number): number {
	const at = source.indexOf('\n', from);
	return at === -1 ? source.length : at;
}

/** Index of the quote closing a string opened at `from`, or -1. Escape-aware. */
function findClosingQuote(source: string, from: number, quote: string): number {
	for (let at = from; at < source.length; at++) {
		const ch = source.charAt(at);
		if (ch === '\\') {
			at++;
			continue;
		}
		if (ch === quote) {
			return at;
		}
	}
	return -1;
}

/** Tokenizes a Twig document. Never throws: malformed input yields errors. */
export function tokenize(source: string): LexResult {
	const lexer = new Lexer(source);
	lexer.run();
	return { tokens: lexer.tokens, errors: lexer.errors };
}
