/**
 * Twig Toolbox parser — a tolerant Twig 3 lexer, parser and AST.
 *
 * Pure library: no `vscode` or LSP imports. `parse` never throws, whatever the
 * input, and always returns a tree covering the whole document.
 */

export type * from './ast';
export * from './errors';
export * from './navigation';
export * from './tokens';
export { tokenize, type LexResult } from './lexer';
export { parse, type ParseResult } from './parser';
export { BINARY_OPERATORS, UNARY_OPERATORS, type Associativity } from './expressions';

/** Twig dialect version this parser targets. */
export const TWIG_VERSION = '3.x';
