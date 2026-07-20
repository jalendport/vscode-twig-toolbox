import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { getBraceCompletion } from './auto-close-brace';
import { createParsedDocument } from './document-store';

/**
 * The decline rules of `twig/autoCloseBrace`, which are the whole feature.
 *
 * Each fixture is the document as it reads the instant after the character was
 * typed, with `‸` where the caret is — that is the only state the handler ever
 * sees. The answers are snippets: `$0` is where the caret stays, so `$0 }` puts
 * the closer after it and leaves the user typing inside the braces.
 *
 * The declines matter more than the insertions. A bare `{`/`}` pair in the
 * language config once stacked closers onto the delimiter pairs (`{{ ` produced
 * `{{  }}}`), and these rules are what make that structurally impossible from
 * this side: the handler answers only where a parse proves an expression.
 */

function completionAt(marked: string, trigger: string): string | undefined {
	const offset = marked.indexOf('‸');
	if (offset === -1) {
		throw new Error(`fixture has no ‸ cursor: ${marked}`);
	}
	const text = marked.slice(0, offset) + marked.slice(offset + 1);
	const parsed = createParsedDocument(
		TextDocument.create('file:///project/templates/index.twig', 'twig', 1, text),
	);
	return getBraceCompletion(parsed, parsed.document.positionAt(offset), trigger);
}

describe('braces in an expression', () => {
	it('closes a hash literal in a tag header, spaced', () => {
		expect(completionAt('{% set a = {‸ %}', '{')).toBe('$0 }');
	});

	it('closes a hash literal in an output region', () => {
		expect(completionAt('{{ {‸ }}', '{')).toBe('$0 }');
	});

	it('closes a hash nested in an array', () => {
		expect(completionAt('{% set a = [{‸ ] %}', '{')).toBe('$0 }');
	});

	it('closes a hash in a filter argument', () => {
		expect(completionAt("{{ path('x', {‸) }}", '{')).toBe('$0 }');
	});
});

describe('brackets in an expression', () => {
	it('closes an array literal spaced', () => {
		expect(completionAt('{% set a = [‸ %}', '[')).toBe('$0 ]');
		expect(completionAt('{{ [‸ }}', '[')).toBe('$0 ]');
	});

	/** After a value there is nothing to enumerate — the bracket subscripts it. */
	it('closes index access tight', () => {
		expect(completionAt('{{ foo[‸ }}', '[')).toBe('$0]');
		expect(completionAt('{{ foo.bar[‸ }}', '[')).toBe('$0]');
		expect(completionAt('{{ foo()[‸ }}', '[')).toBe('$0]');
		expect(completionAt("{{ foo['a'][‸ }}", '[')).toBe('$0]');
		expect(completionAt('{{ foo1[‸ }}', '[')).toBe('$0]');
	});

	/** Everywhere a value cannot precede it, `[` opens a literal. */
	it('closes an array literal spaced after an operator or separator', () => {
		for (const marked of [
			'{% set a = 1 + [‸ %}',
			'{{ foo([‸) }}',
			'{{ [1, [‸] }}',
			'{{ a|merge([‸) }}',
			"{{ {'k': [‸} }}",
		]) {
			expect(completionAt(marked, '[')).toBe('$0 ]');
		}
	});
});

describe('string interpolation', () => {
	it('closes `#{` tight inside a double-quoted string', () => {
		expect(completionAt('{{ "a#{‸" }}', '{')).toBe('$0}');
		expect(completionAt('{% set a = "#{‸" %}', '{')).toBe('$0}');
	});

	/** Single-quoted strings have no interpolation — `#{` there is two literal characters. */
	it('declines `#{` inside a single-quoted string', () => {
		expect(completionAt("{{ 'a#{‸' }}", '{')).toBeUndefined();
	});

	/** The same stray `#{` the language config used to close in every prose file. */
	it('declines `#{` outside a Twig region', () => {
		expect(completionAt('<p>a#{‸</p>', '{')).toBeUndefined();
	});
});

describe('declines', () => {
	/** A `{` in markup is someone reaching for `{{`, and a `[` there is prose. */
	it('declines in raw HTML', () => {
		expect(completionAt('<p>{‸</p>', '{')).toBeUndefined();
		expect(completionAt('<p>[‸</p>', '[')).toBeUndefined();
		expect(completionAt('{‸', '{')).toBeUndefined();
		expect(completionAt('{{ x }}[‸', '[')).toBeUndefined();
	});

	/**
	 * The stacking gate. `{{` is the delimiter pair's job; answering here is
	 * what produced `{{  }}}`.
	 */
	it('declines after `{`', () => {
		expect(completionAt('{{‸ }}', '{')).toBeUndefined();
		expect(completionAt('{% set a = {{‸ %}', '{')).toBeUndefined();
	});

	/** The `{` of a half-typed delimiter is not yet inside anything. */
	it('declines on the delimiter itself', () => {
		expect(completionAt('<p>{‸{{ x }}', '{')).toBeUndefined();
	});

	it('declines inside a string literal', () => {
		expect(completionAt("{{ 'a{‸' }}", '{')).toBeUndefined();
		expect(completionAt('{{ "a{‸" }}', '{')).toBeUndefined();
		expect(completionAt("{{ 'a[‸' }}", '[')).toBeUndefined();
		expect(completionAt("{% set a = 'x{‸' %}", '{')).toBeUndefined();
	});

	/** The quote may never arrive; until it does the rest of the region is string. */
	it('declines inside an unterminated string literal', () => {
		expect(completionAt("{{ 'a{‸ }}", '{')).toBeUndefined();
	});

	it('declines inside a comment', () => {
		expect(completionAt('{# a {‸ #}', '{')).toBeUndefined();
		expect(completionAt('{# a [‸ #}', '[')).toBeUndefined();
	});

	it('declines inside a verbatim body, which is text however it reads', () => {
		expect(completionAt('{% verbatim %}{% set a = {‸{% endverbatim %}', '{')).toBeUndefined();
		expect(completionAt('{% verbatim %}[‸{% endverbatim %}', '[')).toBeUndefined();
	});

	/** A trigger the client never sends, and a caret that has moved on. */
	it('declines when the caret is not on the trigger', () => {
		expect(completionAt('{{ ‸ }}', '{')).toBeUndefined();
		expect(completionAt('{{ (‸ }}', '(')).toBeUndefined();
		expect(completionAt('{% set a = {‸ %}', '[')).toBeUndefined();
	});
});
