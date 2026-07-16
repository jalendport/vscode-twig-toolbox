import type { Token } from '@twig-toolbox/parser';

/**
 * Twig regions over a document, derived from the token stream.
 *
 * The AST answers "what construct is the cursor in"; it cannot answer "is the
 * cursor in Twig at all", because raw HTML, comments and `verbatim` bodies are
 * opaque leaves whose interiors have no structure. The token stream does cover
 * every offset, so region lookup is the first gate every completion goes
 * through: no Twig items are offered outside an `output` or `block` region.
 */

export type RegionKind =
	/** `{{ … }}` */
	| 'output'
	/** `{% … %}` — a tag header only, never its body. */
	| 'block'
	/** `{# … #}` */
	| 'comment'
	/** Raw template text, plus `verbatim` bodies. */
	| 'text';

export interface TwigRegion {
	readonly kind: RegionKind;
	/** Whole region, delimiters included. */
	readonly start: number;
	readonly end: number;
	/** Interior, delimiters excluded. Equals start/end for `text`. */
	readonly contentStart: number;
	readonly contentEnd: number;
	/** False when the region runs to EOF or into the next region unclosed. */
	readonly closed: boolean;
	/** Interior tokens, in source order. Empty for `text` and `comment`. */
	readonly tokens: readonly Token[];
}

const OPENERS: Partial<Record<Token['kind'], { kind: RegionKind; close: Token['kind'] }>> = {
	'var-start': { kind: 'output', close: 'var-end' },
	'block-start': { kind: 'block', close: 'block-end' },
	'comment-start': { kind: 'comment', close: 'comment-end' },
};

/**
 * Every region of the document, in source order, covering every offset.
 *
 * Gaps between tokens — the insignificant whitespace inside Twig regions — fall
 * inside the enclosing region, which is what lets `{{ ‸ }}` resolve to `output`
 * even though no token sits under the cursor.
 */
export function findRegions(tokens: readonly Token[], sourceLength: number): TwigRegion[] {
	const regions: TwigRegion[] = [];
	let at = 0;

	while (at < tokens.length) {
		const open = tokens[at] as Token;
		const opener = OPENERS[open.kind];
		if (opener === undefined) {
			at++;
			continue;
		}

		const interior: Token[] = [];
		let close: Token | undefined;
		let scan = at + 1;
		for (; scan < tokens.length; scan++) {
			const token = tokens[scan] as Token;
			if (token.kind === opener.close) {
				close = token;
				break;
			}
			// An unterminated region stops where the next one starts instead of
			// swallowing the remainder of the document.
			if (token.kind === 'eof' || OPENERS[token.kind] !== undefined) {
				break;
			}
			interior.push(token);
		}

		// An unterminated region still owns the hole up to whatever stopped it:
		// that hole is where the cursor sits in `{% for x in ‸`.
		const contentEnd = close?.start ?? tokens[scan]?.start ?? sourceLength;
		regions.push({
			kind: opener.kind,
			start: open.start,
			end: close?.end ?? contentEnd,
			contentStart: open.end,
			contentEnd: Math.max(open.end, contentEnd),
			closed: close !== undefined,
			tokens: interior,
		});
		at = close === undefined ? scan : scan + 1;
	}

	return withTextGaps(regions, sourceLength);
}

/** Fills the gaps between Twig regions with `text` regions. */
function withTextGaps(regions: readonly TwigRegion[], sourceLength: number): TwigRegion[] {
	const filled: TwigRegion[] = [];
	let cursor = 0;
	for (const region of regions) {
		if (region.start > cursor) {
			filled.push(textRegion(cursor, region.start));
		}
		filled.push(region);
		cursor = region.end;
	}
	if (cursor < sourceLength) {
		filled.push(textRegion(cursor, sourceLength));
	}
	return filled;
}

function textRegion(start: number, end: number): TwigRegion {
	return {
		kind: 'text',
		start,
		end,
		contentStart: start,
		contentEnd: end,
		closed: true,
		tokens: [],
	};
}

/**
 * Region containing `offset`, preferring the later of two that meet there.
 *
 * At a boundary the cursor belongs to what is about to be typed, not to what
 * just ended: in `{{ x }}‸<p>` the offset is text, not output. Offsets sitting
 * inside a region's delimiters are still that region's — callers compare against
 * `contentStart`/`contentEnd` to tell "in the braces" from "in the expression".
 */
export function regionAt(regions: readonly TwigRegion[], offset: number): TwigRegion | undefined {
	let found: TwigRegion | undefined;
	for (const region of regions) {
		if (region.start > offset) {
			break;
		}
		if (offset <= region.end) {
			found = region;
		}
	}
	return found;
}

/** Interior token containing `offset`, if the cursor is on one. */
export function tokenAt(region: TwigRegion, offset: number): Token | undefined {
	return region.tokens.find((token) => token.start <= offset && offset <= token.end);
}
