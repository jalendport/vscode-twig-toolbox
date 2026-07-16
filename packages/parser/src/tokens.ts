/**
 * Token vocabulary for the Twig 3 lexer.
 *
 * Tokens are flat and cover the whole document: raw template text between Twig
 * constructs is a `text` token, so concatenating every token value reproduces
 * the source exactly, minus insignificant whitespace inside Twig regions.
 */

export type TokenKind =
	| 'text'
	| 'raw'
	| 'comment-start'
	| 'comment-text'
	| 'comment-end'
	| 'var-start'
	| 'var-end'
	| 'block-start'
	| 'block-end'
	| 'name'
	| 'number'
	| 'string-start'
	| 'string-text'
	| 'string-end'
	| 'interpolation-start'
	| 'interpolation-end'
	| 'operator'
	| 'punctuation'
	| 'error'
	| 'eof';

/**
 * Whitespace-control marker attached to a delimiter: `-` trims all adjacent
 * whitespace, `~` trims everything but newlines.
 */
export type WhitespaceControl = '-' | '~';

export interface Token {
	readonly kind: TokenKind;
	/** Raw source text covered by the token. */
	readonly value: string;
	readonly start: number;
	readonly end: number;
	/** Present on delimiter tokens carrying a `-` or `~` marker. */
	readonly wsControl?: WhitespaceControl;
}

/** Literal keywords that never resolve to a variable. */
export const KEYWORD_LITERALS = new Set(['true', 'false', 'none', 'null']);
