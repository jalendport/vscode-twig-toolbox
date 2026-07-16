import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem } from 'vscode-languageserver/node';
import { describe, expect, it } from 'vitest';
import { CatalogRegistry, type CatalogEntry, type DialectPack } from './catalog';
import { createParsedDocument, type ParsedDocument } from './document-store';
import { maskTwig } from './embedded-documents';
import { isEmbeddedOffset } from './embedded';
import { getMergedCompletions, getMergedHover } from './merge';
import { findRegions } from './regions';

/**
 * Embedded HTML/CSS end to end: a `‸`-marked fixture in, merged items out.
 *
 * The html and css services are not on trial here — they are VS Code's own, and
 * asserting their full menus would break on every upstream data update. What is
 * on trial is everything we put around them: that the shadow copy lines up with
 * the source character for character, and that the right service is asked.
 */

const corePack: DialectPack = {
	schemaVersion: 1,
	name: 'twig-core',
	displayName: 'Twig',
	version: '1.0.0',
	sources: {
		twig: { repository: 'twig/twig', ref: 'v3.22.0' },
		docs: { repository: 'twigphp/Twig-Doc', ref: '3.x' },
	},
	detect: { kind: 'always' },
	entries: {
		tags: [entry('for', '{% for $1 in $2 %}\n\t$0\n{% endfor %}')],
		filters: [entry('upper', '|upper')],
		functions: [entry('range', 'range($1, $2)')],
		tests: [],
		globals: [],
	},
};

function entry(name: string, completionSnippet: string): CatalogEntry {
	return {
		name,
		signature: name,
		parameters: [],
		description: `The ${name} entry.`,
		docsUrl: `https://twig.symfony.com/doc/3.x/${name}.html`,
		completionSnippet,
	};
}

function cursor(marked: string): { parsed: ParsedDocument; offset: number } {
	const offset = marked.indexOf('‸');
	if (offset === -1) {
		throw new Error(`fixture has no ‸ cursor: ${marked}`);
	}
	const text = marked.slice(0, offset) + marked.slice(offset + 1);
	return {
		offset,
		parsed: createParsedDocument(
			TextDocument.create('file:///project/templates/index.twig', 'twig', 1, text),
		),
	};
}

function completionsAt(marked: string): CompletionItem[] {
	const { parsed, offset } = cursor(marked);
	return getMergedCompletions(parsed, offset, {
		catalogRegistry: CatalogRegistry.fromPacks([corePack]),
	});
}

function labelsAt(marked: string): string[] {
	return completionsAt(marked).map((item) => item.label);
}

function hoverAt(marked: string): string | undefined {
	const { parsed, offset } = cursor(marked);
	const hover = getMergedHover(parsed, offset, {
		catalogRegistry: CatalogRegistry.fromPacks([corePack]),
	});
	const contents = hover?.contents;
	return typeof contents === 'object' && contents !== null && 'value' in contents
		? contents.value
		: undefined;
}

function mask(source: string): string {
	return maskTwig(source, findRegions(...tokensOf(source)));
}

function tokensOf(
	source: string,
): [ReturnType<typeof createParsedDocument>['result']['tokens'], number] {
	const parsed = createParsedDocument(
		TextDocument.create('file:///project/templates/index.twig', 'twig', 1, source),
	);
	return [parsed.result.tokens, source.length];
}

/** `gap(n)` reads better than counting spaces, and cannot be miscounted. */
function gap(length: number): string {
	return ' '.repeat(length);
}

describe('maskTwig', () => {
	it('blanks output, block and comment regions', () => {
		expect(mask('<p>{{ name }}</p>')).toBe(`<p>${gap('{{ name }}'.length)}</p>`);
		expect(mask('<p>{% if a %}x{% endif %}</p>')).toBe(
			`<p>${gap('{% if a %}'.length)}x${gap('{% endif %}'.length)}</p>`,
		);
		expect(mask('<p>{# hi #}</p>')).toBe(`<p>${gap('{# hi #}'.length)}</p>`);
	});

	it('keeps raw text and verbatim bodies, which the browser still sees', () => {
		expect(mask('{% verbatim %}<b>{{ x }}</b>{% endverbatim %}')).toBe(
			`${gap('{% verbatim %}'.length)}<b>{{ x }}</b>${gap('{% endverbatim %}'.length)}`,
		);
	});

	it('preserves length exactly', () => {
		for (const source of [
			'<p>{{ name }}</p>',
			'{# a #}{{ b }}{% set c = 1 %}',
			'<a href="{{ url }}">{{ label|upper }}</a>',
			'{% verbatim %}{{ raw }}{% endverbatim %}',
		]) {
			expect(mask(source)).toHaveLength(source.length);
		}
	});
});

describe('masking offset stability', () => {
	/**
	 * The reason masking blanks characters instead of deleting them. If a
	 * position in the shadow copy ever stopped meaning what it means in the
	 * source, every hover and completion range below the first Twig tag would
	 * land somewhere else.
	 */
	function assertPositionsAgree(source: string): void {
		const { parsed } = cursor(`${source}‸`);
		const masked = parsed.embedded.html;
		expect(masked.getText()).toHaveLength(source.length);
		for (let offset = 0; offset <= source.length; offset++) {
			expect(masked.positionAt(offset)).toEqual(parsed.document.positionAt(offset));
		}
	}

	it('holds under CRLF line endings', () => {
		assertPositionsAgree(
			'<ul>\r\n{% for x in y %}\r\n<li>{{ x }}</li>\r\n{% endfor %}\r\n</ul>',
		);
	});

	it('holds under multibyte characters inside and outside Twig', () => {
		assertPositionsAgree('<p>🎉 héllo</p>\n{{ "🎉 emoji"|upper }}\n<p>{# 🎉 #}naïve</p>');
	});

	it('holds when a newline sits inside a masked region', () => {
		assertPositionsAgree('<p>{{\n  name\n}}</p>\n<div>x</div>');
	});

	it('keeps the css shadow copy aligned too', () => {
		const source =
			'<p style="color: red">🎉</p>\r\n<style>\r\na { color: {{ c }}; }\r\n</style>';
		const { parsed } = cursor(`${source}‸`);
		expect(parsed.embedded.css.getText()).toHaveLength(source.length);
		for (let offset = 0; offset <= source.length; offset++) {
			expect(parsed.embedded.css.positionAt(offset)).toEqual(
				parsed.document.positionAt(offset),
			);
		}
	});
});

describe('routing', () => {
	it('claims raw text for the embedded services', () => {
		const { parsed, offset } = cursor('<p>‸</p>');
		expect(isEmbeddedOffset(parsed, offset)).toBe(true);
	});

	it('declines inside output and block regions', () => {
		for (const marked of ['{{ ‸x }}', '{% if ‸a %}{% endif %}', '{# ‸note #}']) {
			const { parsed, offset } = cursor(marked);
			expect(isEmbeddedOffset(parsed, offset)).toBe(false);
		}
	});

	/**
	 * A boundary belongs to both regions. Whichever way the cursor is about to
	 * move, exactly one side has an answer — the Twig classifier calls an offset
	 * outside its delimiters `none` — so consulting both is safe and consulting
	 * only the later one loses `<p>‸{{ x }}`.
	 */
	it('claims both sides of a text/Twig boundary', () => {
		for (const marked of ['<p>‸{{ x }}', '{{ x }}‸<p>']) {
			const { parsed, offset } = cursor(marked);
			expect(isEmbeddedOffset(parsed, offset)).toBe(true);
		}
	});

	it('treats a verbatim body as raw text', () => {
		const { parsed, offset } = cursor('{% verbatim %}<p>‸</p>{% endverbatim %}');
		expect(isEmbeddedOffset(parsed, offset)).toBe(true);
	});
});

describe('html completions', () => {
	it('completes a tag name between Twig above and below', () => {
		const labels = labelsAt('{% set a = 1 %}\n<di‸\n{{ a }}');
		expect(labels).toContain('div');
	});

	it('completes an attribute name', () => {
		expect(labelsAt('{{ a }}\n<div cl‸>\n{% if a %}{% endif %}')).toContain('class');
	});

	it('completes attribute values from the html data', () => {
		expect(labelsAt('<input type="‸">')).toContain('checkbox');
	});

	it('completes a closing tag', () => {
		expect(labelsAt('<div>{{ a }}</‸')).toContain('/div');
	});

	it('does not fire inside a Twig region', () => {
		expect(labelsAt('<div>{% ‸ %}</div>')).not.toContain('div');
		expect(labelsAt('<div class="{{ ‸ }}">')).not.toContain('div');
	});

	/**
	 * The masked `{{ tag }}` leaves `<div       >` behind — a hole the html
	 * scanner reads as whitespace between attributes, which is exactly what it
	 * would be if the Twig were resolved.
	 */
	it('completes an attribute alongside a Twig-generated one', () => {
		expect(labelsAt('<div {{ attrs }} cl‸>')).toContain('class');
	});
});

describe('css completions', () => {
	it('completes properties inside a style block', () => {
		expect(labelsAt('{{ a }}\n<style>\na { colo‸ }\n</style>')).toContain('color');
	});

	it('completes properties inside an inline style attribute', () => {
		expect(labelsAt('<p style="colo‸">{{ a }}</p>')).toContain('color');
	});

	it('completes property values inside an inline style attribute', () => {
		expect(labelsAt('<p style="display: fl‸">')).toContain('flex');
	});

	it('completes a property after a Twig-generated declaration', () => {
		expect(labelsAt('<p style="color: {{ c }}; disp‸">')).toContain('display');
	});

	/** What a half-typed attribute looks like before the closing quote exists. */
	it('completes inside a style attribute with no closing quote yet', () => {
		expect(labelsAt('<p style="disp‸')).toContain('display');
		expect(labelsAt('<p style="display: fl‸')).toContain('flex');
	});

	it('completes inside a style block with no closing tag yet', () => {
		expect(labelsAt('<style>\na { disp‸')).toContain('display');
	});

	it('offers html, not css, outside a style context', () => {
		const labels = labelsAt('<p class="colo‸">');
		expect(labels).not.toContain('color');
	});
});

describe('script bodies', () => {
	/**
	 * JS in `<script>` is highlight-only and out of scope. What matters is that
	 * nothing nonsensical is offered there instead — the html service knows a
	 * script body is not markup, so it declines and we pass that through.
	 */
	it('offers nothing inside a script body', () => {
		expect(labelsAt('<script>\nconst a = doc‸\n</script>')).toEqual([]);
		expect(labelsAt('<script>\nlet x = 1; ‸\n</script>')).toEqual([]);
	});
});

describe('twig completions still win where they apply', () => {
	it('completes Twig inside an attribute value', () => {
		const labels = labelsAt('<a href="{{ ra‸ }}">');
		expect(labels).toContain('range');
		expect(labels).not.toContain('href');
	});

	it('completes filters inside an attribute value', () => {
		expect(labelsAt('<a title="{{ x|‸ }}">')).toContain('upper');
	});

	it('completes tags between two html elements', () => {
		expect(labelsAt('<ul>\n{% ‸ %}\n</ul>')).toContain('for');
	});
});

describe('merged ordering', () => {
	/**
	 * Twig items must sort above embedded ones whatever `sortText` the html
	 * service picked, since the two providers never saw each other's lists.
	 */
	it('sorts every embedded item below every Twig item', () => {
		const twig = completionsAt('{{ ‸ }}');
		const html = completionsAt('<di‸');
		expect(twig.length).toBeGreaterThan(0);
		expect(html.length).toBeGreaterThan(0);

		const worstTwig = twig
			.map((item) => item.sortText ?? item.label)
			.sort()
			.at(-1);
		const bestHtml = html
			.map((item) => item.sortText ?? item.label)
			.sort()
			.at(0);
		expect(worstTwig).toBeDefined();
		expect(bestHtml).toBeDefined();
		expect((worstTwig as string) < (bestHtml as string)).toBe(true);
	});
});

describe('hover', () => {
	it('describes an html element', () => {
		expect(hoverAt('{{ a }}\n<di‸v></div>')).toContain('div');
	});

	it('describes a css property in an inline style', () => {
		expect(hoverAt('<p style="colo‸r: red">')).toContain('color');
	});

	it('leaves Twig hover to the Twig providers', () => {
		expect(hoverAt('<p>{{ x|upp‸er }}</p>')).toContain('The upper entry.');
	});
});
