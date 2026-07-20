/**
 * Structured parse errors. Every error carries a stable machine code, a human
 * message and an offset range, so milestone 04 can map them to LSP diagnostics
 * without re-deriving anything.
 */

export type ParseErrorSeverity = 'error' | 'warning';

export type ParseErrorCode =
	// Lexer
	| 'unterminated-comment'
	| 'unterminated-output'
	| 'unterminated-block'
	| 'unterminated-string'
	| 'unterminated-verbatim'
	| 'unterminated-interpolation'
	| 'mismatched-delimiter'
	| 'unexpected-character'
	// Parser — structure
	| 'missing-tag-name'
	| 'missing-end-tag'
	| 'mismatched-end-tag'
	| 'unexpected-end-tag'
	| 'unexpected-token'
	| 'removed-in-twig-3'
	// Parser — expressions
	| 'missing-expression'
	| 'missing-property'
	| 'missing-filter-name'
	| 'missing-test-name'
	| 'missing-name'
	| 'unclosed-parenthesis'
	| 'unclosed-bracket'
	| 'unclosed-brace'
	| 'invalid-assignment-target'
	// Parser — recovery limits
	| 'nesting-too-deep';

export interface ParseError {
	readonly code: ParseErrorCode;
	readonly message: string;
	readonly start: number;
	readonly end: number;
	readonly severity: ParseErrorSeverity;
}

export function createError(
	code: ParseErrorCode,
	message: string,
	start: number,
	end: number,
	severity: ParseErrorSeverity = 'error',
): ParseError {
	return { code, message, start, end, severity };
}
