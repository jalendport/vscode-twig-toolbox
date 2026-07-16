import type { CompletionItem, Hover } from 'vscode-languageserver/node';
import { getCompletions, type CompletionOptions } from './completions';
import type { ParsedDocument } from './document-store';
import { getEmbeddedCompletions, getEmbeddedHover } from './embedded';
import { getHover, type HoverOptions } from './hover';

/**
 * The one entry point for completions and hover, routing by region.
 *
 * Both sides gate themselves on the same token-derived region index, from
 * opposite directions: the Twig providers answer inside `{{ }}` and `{% %}`
 * (milestone 05's classifier says `none` everywhere else), the embedded services
 * answer inside raw text. So the two rarely both speak — and where they do, at a
 * text/Twig boundary such as `<p>‸{{ x }}`, only one of them has anything to
 * say. The merge exists for the case where that stops being true; until then it
 * costs one concatenation and guarantees the ordering rule regardless.
 *
 * Twig items come first. In a Twig file the Twig answer is the specific one, and
 * `sortText` cannot arbitrate across providers — the html service writes its own
 * and knows nothing about ours — so precedence is expressed by rewriting it.
 */

/** Sorts ahead of `RANK.*` in completions.ts, which start at `'0'`. */
const EMBEDDED_RANK = '9';

export function getMergedCompletions(
	parsed: ParsedDocument,
	offset: number,
	options: CompletionOptions,
): CompletionItem[] {
	const twig = getCompletions(parsed, offset, options);
	const embedded = getEmbeddedCompletions(parsed, offset).map(demote);
	if (twig.length === 0 || embedded.length === 0) {
		return twig.length === 0 ? embedded : twig;
	}

	const claimed = new Set(twig.map((item) => item.label));
	return [...twig, ...embedded.filter((item) => !claimed.has(item.label))];
}

export function getMergedHover(
	parsed: ParsedDocument,
	offset: number,
	options: HoverOptions,
): Hover | undefined {
	return getHover(parsed, offset, options) ?? getEmbeddedHover(parsed, offset);
}

/** Pushes an html/css item below every Twig item, keeping its relative order. */
function demote(item: CompletionItem): CompletionItem {
	return { ...item, sortText: `${EMBEDDED_RANK}${item.sortText ?? item.label}` };
}
