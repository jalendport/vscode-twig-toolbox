import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { CatalogRegistry, type CatalogEntry, type DialectPack } from './catalog';
import { createParsedDocument, type ParsedDocument } from './document-store';
import { getHover } from './hover';
import { getSignatureHelp } from './signatures';

function parsedAt(marked: string): { parsed: ParsedDocument; offset: number } {
	const offset = marked.indexOf('‸');
	if (offset === -1) {
		throw new Error(`fixture has no ‸ cursor: ${marked}`);
	}
	const text = marked.slice(0, offset) + marked.slice(offset + 1);
	const uri = 'file:///project/templates/index.twig';
	return {
		offset,
		parsed: createParsedDocument(TextDocument.create(uri, 'twig', 1, text)),
	};
}

function hoverMarkdown(marked: string): string | undefined {
	const { parsed, offset } = parsedAt(marked);
	const hover = getHover(parsed, offset, {
		catalogRegistry: CatalogRegistry.fromPacks([corePack]),
	});
	if (hover === undefined) {
		return undefined;
	}
	const contents = hover.contents;
	if (typeof contents === 'string') {
		return contents;
	}
	return Array.isArray(contents) || !('value' in contents) ? undefined : contents.value;
}

function activeParameter(marked: string): number | undefined {
	const { parsed, offset } = parsedAt(marked);
	return (
		getSignatureHelp(parsed, offset, {
			catalogRegistry: CatalogRegistry.fromPacks([corePack]),
		})?.activeParameter ?? undefined
	);
}

function signatureLabel(marked: string): string | undefined {
	const { parsed, offset } = parsedAt(marked);
	return getSignatureHelp(parsed, offset, {
		catalogRegistry: CatalogRegistry.fromPacks([corePack]),
	})?.signatures[0]?.label;
}

describe('hover markdown', () => {
	it.each([
		['{{ items|sli‸ce }}', 'catalog filter'],
		['{% set slice = 1 %}{{ sli‸ce }}', 'local variable with same name as filter'],
		['{% set hero = entry.heroImage %}\n{{ he‸ro }}', 'set variable usage'],
		[
			'{% macro button(label, url = "#") %}{% endmacro %}{{ _self.but‸ton("Read") }}',
			'macro member',
		],
		['{% for item in items %}{{ loop.ind‸ex }}{% endfor %}', 'loop member'],
	])('renders %s (%s)', (marked) => {
		expect(hoverMarkdown(marked)).toMatchSnapshot();
	});

	it('shows a local variable instead of the same catalog filter in variable position', () => {
		const markdown = hoverMarkdown('{% set slice = 1 %}{{ sli‸ce }}');
		expect(markdown).toContain('{% set slice = 1 %}');
		expect(markdown).not.toContain('The `slice` filter extracts');
	});

	it('shows the set line for a later set-variable usage', () => {
		expect(hoverMarkdown('{% set hero = entry.heroImage %}\n{{ he‸ro }}')).toContain(
			'{% set hero = entry.heroImage %}',
		);
	});

	it.each([
		['{# a comm‸ent #}', 'comment'],
		['<div class="x">te‸xt</div>', 'raw HTML'],
		['{% verbatim %}{{ na‸me }}{% endverbatim %}', 'verbatim body'],
	])('returns no hover in %s (%s)', (marked) => {
		expect(hoverMarkdown(marked)).toBeUndefined();
	});
});

describe('signature help', () => {
	it.each([
		['{{ items|slice(‸) }}', 0, 'slice(start, length? = null, preserveKeys? = false)'],
		['{{ items|slice(1, ‸) }}', 1, 'slice(start, length? = null, preserveKeys? = false)'],
		[
			'{% macro button(label, url = "#") %}{% endmacro %}{{ _self.button("Read", ‸) }}',
			1,
			'button(label, url = "#")',
		],
		['{{ max(min(a, ‸), c) }}', 1, 'min(value, values)'],
		['{{ max(min(a, b), ‸) }}', 1, 'max(value, values)'],
	])('sets active parameter for %s', (marked, expectedActive, expectedLabel) => {
		expect(signatureLabel(marked)).toBe(expectedLabel);
		expect(activeParameter(marked)).toBe(expectedActive);
	});
});

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
		tags: [
			entry('set', {
				signature: 'set name = value',
				docsUrl: 'https://twig.symfony.com/doc/3.x/tags/set.html',
			}),
			entry('for', {
				signature: 'for item in items',
				docsUrl: 'https://twig.symfony.com/doc/3.x/tags/for.html',
			}),
		],
		filters: [
			entry('slice', {
				signature: 'slice(start, length? = null, preserveKeys? = false)',
				parameters: [
					{
						name: 'start',
						type: 'number',
						optional: false,
						description: 'The start of the slice.',
					},
					{
						name: 'length',
						type: 'number',
						optional: true,
						default: 'null',
						description: 'The size of the slice.',
					},
					{
						name: 'preserveKeys',
						type: 'boolean',
						optional: true,
						default: 'false',
						description: 'Whether to preserve keys.',
					},
				],
				description:
					'The `slice` filter extracts a slice of a sequence, a mapping, or a string.',
				docsUrl: 'https://twig.symfony.com/doc/3.x/filters/slice.html',
				completionSnippet: '|slice($1, $2, $3)',
			}),
		],
		functions: [
			entry('max', {
				signature: 'max(value, values)',
				parameters: [
					{ name: 'value', optional: false },
					{ name: 'values', optional: true },
				],
			}),
			entry('min', {
				signature: 'min(value, values)',
				parameters: [
					{ name: 'value', optional: false },
					{ name: 'values', optional: true },
				],
			}),
		],
		tests: [],
		globals: [],
	},
};

function entry(name: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		name,
		signature: name,
		parameters: [],
		description: `The \`${name}\` entry does something.`,
		docsUrl: `https://twig.symfony.com/doc/3.x/${name}.html`,
		completionSnippet: name,
		...overrides,
	};
}
