import { describe, expect, it } from 'vitest';
import { tokenize } from './lexer';
import type { Token } from './tokens';

/** `kind:value` per token, dropping the trailing eof. */
function kinds(source: string): string[] {
	return tokenize(source)
		.tokens.filter((token) => token.kind !== 'eof')
		.map((token) => `${token.kind}:${token.value}`);
}

function codes(source: string): string[] {
	return tokenize(source).errors.map((error) => error.code);
}

function find(source: string, kind: Token['kind']): Token | undefined {
	return tokenize(source).tokens.find((token) => token.kind === kind);
}

describe('lexer: document structure', () => {
	it('emits raw template text between constructs', () => {
		expect(kinds('<p>hi</p>')).toEqual(['text:<p>hi</p>']);
	});

	it('splits text around an output', () => {
		expect(kinds('a{{ x }}b')).toEqual([
			'text:a',
			'var-start:{{',
			'name:x',
			'var-end:}}',
			'text:b',
		]);
	});

	it.each([
		'a{{ x }}b{% if y %}c{% endif %}',
		// Whitespace-control markers belong to their delimiter token; if they
		// fall between tokens instead, offsets silently drift.
		'{{- x -}}{%~ if y ~%}{#- c -#}{%- endif %}',
		'{% verbatim %}{{ raw }}{% endverbatim %}',
		'{{ "a #{b} c"|upper }}',
	])('covers the whole source with token ranges: %s', (source) => {
		let at = 0;
		for (const token of tokenize(source).tokens) {
			// Only insignificant whitespace inside regions may be skipped.
			expect(source.slice(at, token.start).trim()).toBe('');
			expect(token.value).toBe(source.slice(token.start, token.end));
			at = token.end;
		}
		expect(at).toBe(source.length);
	});

	it('reports no errors for well-formed input', () => {
		expect(codes('{% for a in b %}{{ a }}{% endfor %}{# c #}')).toEqual([]);
	});
});

describe('lexer: whitespace control', () => {
	it.each([
		['{{- x }}', 'var-start', '-'],
		['{{~ x }}', 'var-start', '~'],
		['{{ x -}}', 'var-end', '-'],
		['{{ x ~}}', 'var-end', '~'],
		['{%- x %}', 'block-start', '-'],
		['{% x -%}', 'block-end', '-'],
		['{#- x -#}', 'comment-start', '-'],
	])('records the marker on %s', (source, kind, marker) => {
		expect(find(source, kind as Token['kind'])?.wsControl).toBe(marker);
	});

	it('leaves plain delimiters unmarked', () => {
		expect(find('{{ x }}', 'var-start')?.wsControl).toBeUndefined();
	});

	it('does not mistake a trailing minus for whitespace control', () => {
		expect(kinds('{{ a - }}')).toEqual(['var-start:{{', 'name:a', 'operator:-', 'var-end:}}']);
	});

	it('reads a contiguous minus as whitespace control', () => {
		expect(kinds('{{ a -}}')).toEqual(['var-start:{{', 'name:a', 'var-end:-}}']);
	});
});

describe('lexer: numbers', () => {
	it.each([
		['{{ 0 }}', '0'],
		['{{ 42 }}', '42'],
		['{{ 3.14 }}', '3.14'],
		['{{ 1_000_000 }}', '1_000_000'],
		['{{ 1.5e3 }}', '1.5e3'],
		['{{ 2e-3 }}', '2e-3'],
		['{{ 0xFF }}', '0xFF'],
		['{{ 0b1010 }}', '0b1010'],
		['{{ 0o755 }}', '0o755'],
	])('lexes %s', (source, expected) => {
		expect(find(source, 'number')?.value).toBe(expected);
	});

	it('does not swallow the range operator after an integer', () => {
		expect(kinds('{{ 1..5 }}')).toEqual([
			'var-start:{{',
			'number:1',
			'operator:..',
			'number:5',
			'var-end:}}',
		]);
	});
});

describe('lexer: operators', () => {
	it('prefers the longest operator', () => {
		expect(kinds('{{ a <=> b }}')).toEqual([
			'var-start:{{',
			'name:a',
			'operator:<=>',
			'name:b',
			'var-end:}}',
		]);
		expect(kinds('{{ a // b }}')).toContain('operator://');
		expect(kinds('{{ a ** b }}')).toContain('operator:**');
		expect(kinds('{{ a ?? b }}')).toContain('operator:??');
	});

	it('lexes bitwise word operators despite the hyphen', () => {
		expect(kinds('{{ a b-and b }}')).toEqual([
			'var-start:{{',
			'name:a',
			'operator:b-and',
			'name:b',
			'var-end:}}',
		]);
	});

	it('does not mistake a variable starting with b for a bitwise operator', () => {
		expect(kinds('{{ b }}')).toEqual(['var-start:{{', 'name:b', 'var-end:}}']);
		expect(kinds('{{ border }}')).toEqual(['var-start:{{', 'name:border', 'var-end:}}']);
	});

	it('leaves word operators as names for the parser to interpret', () => {
		expect(kinds('{{ a starts with b }}')).toEqual([
			'var-start:{{',
			'name:a',
			'name:starts',
			'name:with',
			'name:b',
			'var-end:}}',
		]);
	});

	it('lexes ? and : separately so ?: and hashes both work', () => {
		expect(kinds('{{ a ?: b }}')).toEqual([
			'var-start:{{',
			'name:a',
			'punctuation:?',
			'punctuation::',
			'name:b',
			'var-end:}}',
		]);
	});
});

describe('lexer: strings', () => {
	it('splits a plain string into start/text/end', () => {
		expect(kinds("{{ 'hi' }}")).toEqual([
			'var-start:{{',
			"string-start:'",
			'string-text:hi',
			"string-end:'",
			'var-end:}}',
		]);
	});

	it('keeps escapes inside the text token', () => {
		expect(kinds("{{ 'it\\'s' }}")).toContain("string-text:it\\'s");
	});

	it('emits interpolation sub-tokens', () => {
		expect(kinds('{{ "a #{b} c" }}')).toEqual([
			'var-start:{{',
			'string-start:"',
			'string-text:a ',
			'interpolation-start:#{',
			'name:b',
			'interpolation-end:}',
			'string-text: c',
			'string-end:"',
			'var-end:}}',
		]);
	});

	it('tracks brace depth so hashes inside interpolation close correctly', () => {
		expect(kinds('{{ "#{ {a: 1}|json_encode }" }}')).toEqual([
			'var-start:{{',
			'string-start:"',
			'interpolation-start:#{',
			'punctuation:{',
			'name:a',
			'punctuation::',
			'number:1',
			'punctuation:}',
			'punctuation:|',
			'name:json_encode',
			'interpolation-end:}',
			'string-end:"',
			'var-end:}}',
		]);
	});

	it('does not interpolate single-quoted strings', () => {
		expect(kinds("{{ 'a #{b} c' }}")).toEqual([
			'var-start:{{',
			"string-start:'",
			'string-text:a #{b} c',
			"string-end:'",
			'var-end:}}',
		]);
	});

	it('allows a legitimate multi-line string', () => {
		expect(codes('{{ "a\nb" }}')).toEqual([]);
		expect(kinds('{{ "a\nb" }}')).toContain('string-text:a\nb');
	});

	it('clamps an unterminated string to its line instead of the document', () => {
		const source = '{{ "oops }}\n<p>rest of the document</p>';
		expect(codes(source)).toContain('unterminated-string');
		// The HTML after the broken line must survive as text.
		expect(kinds(source)).toContain('text:\n<p>rest of the document</p>');
	});

	it('treats Twig delimiters inside strings as string content', () => {
		expect(kinds("{{ '{{ x }}' }}")).toEqual([
			'var-start:{{',
			"string-start:'",
			'string-text:{{ x }}',
			"string-end:'",
			'var-end:}}',
		]);
	});
});

describe('lexer: comments', () => {
	it('splits a comment into start/text/end', () => {
		expect(kinds('{# hi #}')).toEqual([
			'comment-start:{#',
			'comment-text: hi ',
			'comment-end:#}',
		]);
	});

	it('ignores Twig constructs inside comments', () => {
		expect(kinds('{# {{ x }} {% if %} #}')).toEqual([
			'comment-start:{#',
			'comment-text: {{ x }} {% if %} ',
			'comment-end:#}',
		]);
	});

	it('handles an empty trimmed comment', () => {
		expect(kinds('{#-#}')).toEqual(['comment-start:{#-', 'comment-end:#}']);
	});

	it('reports an unterminated comment', () => {
		expect(codes('{# nope')).toEqual(['unterminated-comment']);
	});
});

describe('lexer: verbatim', () => {
	it('emits the body as a single raw token', () => {
		expect(kinds('{% verbatim %}{{ x }}{% endverbatim %}')).toEqual([
			'block-start:{%',
			'name:verbatim',
			'block-end:%}',
			'raw:{{ x }}',
			'block-start:{%',
			'name:endverbatim',
			'block-end:%}',
		]);
	});

	it('honours whitespace control on the verbatim delimiters', () => {
		expect(codes('{%- verbatim -%}{{ x }}{%- endverbatim -%}')).toEqual([]);
		expect(kinds('{%- verbatim -%}{{ x }}{%- endverbatim -%}')).toContain('raw:{{ x }}');
	});

	it('reports an unterminated verbatim', () => {
		expect(codes('{% verbatim %}{{ x }}')).toEqual(['unterminated-verbatim']);
	});

	it('does not treat endverbatim as an opening verbatim', () => {
		expect(codes('{% verbatim %}a{% endverbatim %}b{{ c }}')).toEqual([]);
	});
});

describe('lexer: recovery', () => {
	it('reports an unterminated output at EOF', () => {
		expect(codes('{{ x')).toEqual(['unterminated-output']);
	});

	it('reports an unterminated block at EOF', () => {
		expect(codes('{% if x')).toEqual(['unterminated-block']);
	});

	it('stops an unclosed region at the next construct instead of eating the file', () => {
		const source = '{{ a\n{{ b }}';
		expect(codes(source)).toEqual(['unterminated-output']);
		expect(kinds(source)).toEqual([
			'var-start:{{',
			'name:a',
			'var-start:{{',
			'name:b',
			'var-end:}}',
		]);
	});

	it('accepts a mismatched delimiter as the close, with an error', () => {
		const source = '{{ x %}rest';
		expect(codes(source)).toEqual(['mismatched-delimiter']);
		expect(kinds(source)).toEqual(['var-start:{{', 'name:x', 'var-end:%}', 'text:rest']);
	});

	it('flags characters that cannot start a token', () => {
		expect(codes('{{ @ }}')).toEqual(['unexpected-character']);
	});

	it('never throws on adversarial input', () => {
		const samples = [
			'{',
			'{{',
			'{%',
			'{#',
			'{{{{',
			'{%%}',
			'{{ "',
			"{{ '",
			'{{ #{',
			'}}',
			'%}',
			'#}',
		];
		for (const sample of samples) {
			expect(() => tokenize(sample), sample).not.toThrow();
		}
	});
});
