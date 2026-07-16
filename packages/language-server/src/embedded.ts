import type {
	CompletionItem,
	DocumentHighlight,
	Hover,
	Position,
} from 'vscode-languageserver/node';
import type { ParsedDocument } from './document-store';
import { cssLanguageService, htmlLanguageService } from './embedded-documents';
import { findRegions } from './regions';

/**
 * HTML and CSS features over the virtual documents.
 *
 * Everything here is the stock `vscode-html-languageservice` /
 * `vscode-css-languageservice` behaviour pointed at a shadow copy. Because
 * masking preserves offsets exactly, positions go in and come back out
 * unchanged; there is no mapping layer and there should never need to be one.
 *
 * The gate is `isEmbeddedOffset`: the services see a document full of blanks
 * where the Twig used to be, and would happily offer an attribute value inside
 * what is really `{{ … }}`. Only offsets the region index calls raw text are
 * theirs to answer.
 */

/**
 * True when a raw-text region contains `offset`.
 *
 * Both ends count, so a cursor wedged between text and Twig — `<p>‸{{ x }}` —
 * is still HTML's to answer. The Twig side of the same boundary declines on its
 * own: the offset sits outside the region's delimiters, which classifies as
 * `none`.
 */
export function isEmbeddedOffset(parsed: ParsedDocument, offset: number): boolean {
	const { tokens, source } = parsed.result;
	return findRegions(tokens, source.length).some(
		(region) => region.kind === 'text' && region.start <= offset && offset <= region.end,
	);
}

export function getEmbeddedCompletions(parsed: ParsedDocument, offset: number): CompletionItem[] {
	if (!isEmbeddedOffset(parsed, offset)) {
		return [];
	}

	const embedded = parsed.embedded;
	const position = parsed.document.positionAt(offset);
	const list =
		embedded.languageAt(offset) === 'css'
			? cssLanguageService.doComplete(embedded.css, position, embedded.stylesheet)
			: htmlLanguageService.doComplete(embedded.html, position, embedded.htmlDocument);
	return list.items;
}

export function getEmbeddedHover(parsed: ParsedDocument, offset: number): Hover | undefined {
	if (!isEmbeddedOffset(parsed, offset)) {
		return undefined;
	}

	const embedded = parsed.embedded;
	const position = parsed.document.positionAt(offset);
	const hover =
		embedded.languageAt(offset) === 'css'
			? cssLanguageService.doHover(embedded.css, position, embedded.stylesheet)
			: htmlLanguageService.doHover(embedded.html, position, embedded.htmlDocument);
	return hover ?? undefined;
}

/**
 * Matching open/close tag pairs. Free with the html service, and it works on the
 * shadow copy because the tags themselves are never masked.
 */
export function getEmbeddedHighlights(
	parsed: ParsedDocument,
	position: Position,
): DocumentHighlight[] {
	if (!isEmbeddedOffset(parsed, parsed.document.offsetAt(position))) {
		return [];
	}
	return htmlLanguageService.findDocumentHighlights(
		parsed.embedded.html,
		position,
		parsed.embedded.htmlDocument,
	);
}

/**
 * The snippet that finishes a tag or quote the user just opened, if any.
 *
 * This is the server half of the `html/tag` request VS Code's own HTML support
 * uses: the client watches for `>`, `/` and `=` and asks what to insert. The
 * trigger decides which service call answers, exactly as `html-language-features`
 * splits `html.autoClosingTags` from `html.autoCreateQuotes`.
 */
export function getTagCompletion(
	parsed: ParsedDocument,
	position: Position,
	trigger: string,
): string | undefined {
	if (!isEmbeddedOffset(parsed, parsed.document.offsetAt(position))) {
		return undefined;
	}

	const { html, htmlDocument } = parsed.embedded;
	const completion =
		trigger === '='
			? htmlLanguageService.doQuoteComplete(html, position, htmlDocument)
			: htmlLanguageService.doTagComplete(html, position, htmlDocument);
	return completion ?? undefined;
}
