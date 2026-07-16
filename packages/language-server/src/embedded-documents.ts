import { TextDocument } from 'vscode-languageserver-textdocument';
import { getCSSLanguageService, type Stylesheet } from 'vscode-css-languageservice';
import {
	getLanguageService as getHTMLLanguageService,
	TokenType,
	type HTMLDocument,
} from 'vscode-html-languageservice';
import type { TwigRegion } from './regions';

/**
 * Virtual HTML and CSS shadow copies of a Twig document.
 *
 * A Twig file is an HTML file with holes in it, so the html language service is
 * fed the same file with every Twig construct blanked out. Masking replaces each
 * masked character with a space and each line terminator with itself, so the
 * shadow copy is character-for-character the same length as the source and every
 * offset — and therefore every line/character position — means the same thing in
 * both. Nothing that comes back from the embedded services needs remapping.
 *
 * CSS gets the same treatment one level down: the HTML shadow copy with
 * everything but stylesheet content blanked out. Inline `style=""` values are
 * the awkward case — a bare declaration list is not a stylesheet — so the
 * `style=` and its quotes, which are being masked anyway, are overwritten with a
 * `__{ … }` rule that wraps the value exactly in place. The value keeps its
 * offsets; only the scaffolding around it changes.
 */

export const htmlLanguageService = getHTMLLanguageService();
export const cssLanguageService = getCSSLanguageService();

/** Selector written over `style=` so an attribute value parses as a CSS rule. */
const STYLE_ATTRIBUTE_SELECTOR = '__';

export type EmbeddedLanguage = 'html' | 'css';

/** A stretch of the virtual HTML document that is really CSS. */
interface CssRegion {
	/** First offset of the CSS itself, scaffolding excluded. */
	readonly start: number;
	readonly end: number;
	/** False for an attribute value whose closing quote is not typed yet. */
	readonly closed: boolean;
}

export interface EmbeddedDocuments {
	/** The Twig source with `{{ }}`, `{% %}` and `{# #}` blanked out. */
	readonly html: TextDocument;
	readonly htmlDocument: HTMLDocument;
	/** The HTML shadow copy with everything but CSS blanked out. */
	readonly css: TextDocument;
	readonly stylesheet: Stylesheet;
	/** `'css'` inside a `<style>` body or a `style=""` value, else `'html'`. */
	languageAt(offset: number): EmbeddedLanguage;
}

/**
 * Blanks out every Twig region, keeping raw text and `verbatim` bodies.
 *
 * `verbatim` bodies survive because they are emitted literally: whatever markup
 * they hold is markup the browser will see, and the region index already calls
 * them text.
 */
export function maskTwig(source: string, regions: readonly TwigRegion[]): string {
	const masked = codeUnits(source);
	for (const region of regions) {
		if (region.kind === 'text') {
			continue;
		}
		blank(masked, region.start, region.end);
	}
	return masked.join('');
}

export function createEmbeddedDocuments(
	uri: string,
	version: number,
	source: string,
	regions: readonly TwigRegion[],
): EmbeddedDocuments {
	const htmlText = maskTwig(source, regions);
	const html = TextDocument.create(uri, 'html', version, htmlText);
	const cssRegions = findCssRegions(htmlText);
	const css = TextDocument.create(uri, 'css', version, maskToCss(htmlText, cssRegions));

	return {
		html,
		htmlDocument: htmlLanguageService.parseHTMLDocument(html),
		css,
		stylesheet: cssLanguageService.parseStylesheet(css),
		languageAt: (offset) =>
			cssRegions.some((region) => region.start <= offset && offset <= region.end)
				? 'css'
				: 'html',
	};
}

/**
 * The string as an array of UTF-16 code units — never code points.
 *
 * `TextDocument` offsets are code-unit offsets, so `[...source]`, which iterates
 * code points, would collapse an emoji to one slot and shift everything after it
 * by one. An emoji inside `{{ "🎉" }}` has to mask to two spaces, not one.
 */
function codeUnits(source: string): string[] {
	return source.split('');
}

/**
 * Overwrites `[start, end)` with spaces, leaving `\r` and `\n` alone.
 *
 * Line terminators have to survive or every position below the first masked
 * newline would shift, which is the whole point of masking rather than slicing.
 */
function blank(masked: string[], start: number, end: number): void {
	for (let at = start; at < end; at++) {
		const char = masked[at];
		if (char !== '\n' && char !== '\r') {
			masked[at] = ' ';
		}
	}
}

/** `<style>` bodies and `style=""` values, found with the html service's scanner. */
function findCssRegions(htmlText: string): CssRegion[] {
	const regions: CssRegion[] = [];
	const scanner = htmlLanguageService.createScanner(htmlText);
	let attribute: string | undefined;

	for (let token = scanner.scan(); token !== TokenType.EOS; token = scanner.scan()) {
		switch (token) {
			case TokenType.Styles:
				regions.push({
					start: scanner.getTokenOffset(),
					end: scanner.getTokenEnd(),
					closed: true,
				});
				break;
			case TokenType.AttributeName:
				attribute = scanner.getTokenText().toLowerCase();
				break;
			case TokenType.AttributeValue: {
				const quoted = quotedValue(scanner.getTokenOffset(), scanner.getTokenText());
				if (attribute === 'style' && quoted !== undefined) {
					regions.push(quoted);
				}
				attribute = undefined;
				break;
			}
			default:
				break;
		}
	}

	return regions;
}

/**
 * The interior of a quoted attribute value, or undefined when it is unquoted.
 *
 * An unquoted value cannot hold a space, so it cannot hold a CSS declaration
 * worth completing; skipping it also spares us guessing where it ends.
 *
 * A value whose closing quote is missing still counts. That is what a half-typed
 * `style="disp‸` is, and completing it is the whole point — the scanner hands
 * back what it has, and the css parser is tolerant of the unclosed rule that
 * results.
 */
function quotedValue(start: number, text: string): CssRegion | undefined {
	const quote = text[0];
	if (quote !== '"' && quote !== "'") {
		return undefined;
	}
	const closed = text.length > 1 && text.endsWith(quote);
	return { start: start + 1, end: start + text.length - (closed ? 1 : 0), closed };
}

/**
 * Blanks the HTML shadow copy down to CSS, wrapping inline values in a rule.
 *
 * A region is an attribute value when the character before it is its opening
 * quote — a `<style>` body has `>` there instead. The quotes and the `style=`
 * ahead of them are being masked either way, so writing `__{` and `}` into them
 * costs nothing and leaves the declarations themselves untouched.
 */
function maskToCss(htmlText: string, regions: readonly CssRegion[]): string {
	const masked = codeUnits(htmlText);
	blank(masked, 0, masked.length);

	for (const region of regions) {
		for (let at = region.start; at < region.end; at++) {
			masked[at] = htmlText[at] as string;
		}

		const openQuote = htmlText[region.start - 1];
		if (openQuote !== '"' && openQuote !== "'") {
			continue;
		}
		masked[region.start - 1] = '{';
		if (region.closed) {
			masked[region.end] = '}';
		}
		const selectorStart = region.start - 1 - STYLE_ATTRIBUTE_SELECTOR.length;
		for (let at = 0; at < STYLE_ATTRIBUTE_SELECTOR.length; at++) {
			masked[selectorStart + at] = STYLE_ATTRIBUTE_SELECTOR[at] as string;
		}
	}

	return masked.join('');
}
