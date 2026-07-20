import type { Position } from 'vscode-languageserver/node';
import type { Token } from '@twig-toolbox/parser';
import type { ParsedDocument } from './document-store';
import { findRegions, regionAt, type TwigRegion } from './regions';

/**
 * The closer for a `{` or `[` just typed inside a Twig expression, if any.
 *
 * The server half of `twig/autoCloseBrace`, built like `html/tag`: the client
 * watches for the character and applies whatever comes back as a snippet.
 *
 * It lives here rather than in the language config because an auto-closing pair
 * there is a plain text match, and these two characters are ambiguous in a way
 * no text match resolves. The `{` of `{{ ` opens a delimiter, the `{` of
 * `{% set a = {` opens a hash, and the `{` in `<p>{</p>` is a brace the user
 * wants left alone. A bare `{`/`}` pair once tried anyway and stacked closers
 * onto the delimiter pairs — typing `{{ ` produced `{{  }}}`. `[` had the same
 * disease from the other direction: a global pair closed it in HTML prose, where
 * a bracket is usually just punctuation. Only the region index tells these
 * apart, and the region index lives on this side of the wire.
 *
 * Every rule below is a decline, deliberately. The failure mode of this feature
 * is a closer the user has to go back and delete, so anything the parse does not
 * positively identify as a Twig expression gets no answer at all.
 */

/** Twig has no unary `[`; after one of these the bracket subscripts a value. */
const INDEX_ACCESS_BEFORE = /[A-Za-z0-9_)\]]/;

const CLOSERS: Record<string, string> = { '{': '}', '[': ']' };

export function getBraceCompletion(
	parsed: ParsedDocument,
	position: Position,
	trigger: string,
): string | undefined {
	const source = parsed.document.getText();
	const offset = parsed.document.offsetAt(position);
	// The caret must sit immediately after the character the client saw typed.
	// Anything else means the document moved on and this edit is not ours.
	if (source[offset - 1] !== trigger) {
		return undefined;
	}

	const before = source[offset - 2];
	// `#{` only opens Twig string interpolation inside a double-quoted string —
	// the language config can't tell that from a stray `#{` in HTML prose, so
	// this is the server's call alone, made from the same tokens the parser
	// used to decide whether it lexed one.
	if (trigger === '{' && before === '#') {
		return interpolationCloser(parsed, offset);
	}

	const close = CLOSERS[trigger];
	if (close === undefined) {
		return undefined;
	}

	// `{{` is a delimiter the language config already closes; closing it again
	// is the stacking bug that pair exists to avoid.
	if (trigger === '{' && before === '{') {
		return undefined;
	}

	if (!inExpression(parsed, source, offset)) {
		return undefined;
	}

	// `foo[` subscripts a value and closes tight. A `[` anywhere else opens an
	// array literal, which gets the inner spaces the house style puts inside
	// `{{ }}` — as does every `{`, since Twig has no `foo{…}` form to confuse it
	// with.
	const tight = trigger === '[' && before !== undefined && INDEX_ACCESS_BEFORE.test(before);
	return tight ? `$0${close}` : `$0 ${close}`;
}

/**
 * The closer for a `#{` just typed, if it opened real interpolation.
 *
 * The lexer only recognizes `#{` as `interpolation-start` inside a
 * double-quoted string — everywhere else (HTML prose, a single-quoted string)
 * it lexes as two unrelated characters. So the check is just: did that token
 * land right where the caret is now.
 */
function interpolationCloser(parsed: ParsedDocument, offset: number): string | undefined {
	const region = regionAt(
		findRegions(parsed.result.tokens, parsed.document.getText().length),
		offset,
	);
	const opened = region?.tokens.some(
		(token) => token.kind === 'interpolation-start' && token.end === offset,
	);
	return opened ? '$0}' : undefined;
}

/** True only inside the expression of a `{{ … }}` or `{% … %}`, strings aside. */
function inExpression(parsed: ParsedDocument, source: string, offset: number): boolean {
	const region = regionAt(findRegions(parsed.result.tokens, source.length), offset);
	if (region === undefined || (region.kind !== 'output' && region.kind !== 'block')) {
		// Raw text, comments and `verbatim` bodies. A `{` typed in HTML starts a
		// Twig delimiter far more often than it wants a mate, and a `[` there is
		// usually prose.
		return false;
	}
	// Inside the region but still within its delimiters — the cursor in `<p>{‸{{ x }}`
	// resolves to the output region that starts under it, and owes nothing.
	if (offset <= region.contentStart || (region.closed && offset > region.contentEnd)) {
		return false;
	}
	return !inString(region, offset);
}

/**
 * True when `offset` falls inside a string literal.
 *
 * Braces are literal text inside a Twig string. The whole span counts, `#{…}`
 * interpolation holes included: a hash or array written inside an interpolation
 * is real Twig and loses a closer it might have wanted, which is the trade
 * declining by default asks for. The alternative is tracking nesting depth to
 * save a keystroke in `{{ "#{ {'a': 1} }}" }}`, which nobody types.
 */
function inString(region: TwigRegion, offset: number): boolean {
	let open: Token | undefined;
	for (const token of region.tokens) {
		if (token.kind === 'string-start') {
			open = token;
		} else if (token.kind === 'string-end' && open !== undefined) {
			if (offset > open.start && offset <= token.start) {
				return true;
			}
			open = undefined;
		}
	}
	// An unterminated string owns the rest of its region: the closing quote of
	// `{{ 'abc‸` has not been typed yet, and may never be.
	return open !== undefined && offset > open.start;
}
