import { parse } from '@twig-toolbox/parser';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionItemKind, type CompletionItem } from 'vscode-languageserver/node';
import { describe, expect, it } from 'vitest';
import { CatalogRegistry, type CatalogEntry, type DialectPack } from './catalog';
import { getCompletions } from './completions';
import type { ParsedDocument } from './document-store';
import type { MemberProvider } from './members';

/**
 * Completions end to end: fixture plus a `‸` cursor in, items out.
 *
 * Assertions are about what is present, absent and shaped how — never about the
 * whole list, which would break every time a catalog gains an entry.
 */
function completionsAt(marked: string, providers?: readonly MemberProvider[]): CompletionItem[] {
	const offset = marked.indexOf('‸');
	if (offset === -1) {
		throw new Error(`fixture has no ‸ cursor: ${marked}`);
	}
	const text = marked.slice(0, offset) + marked.slice(offset + 1);
	const uri = 'file:///project/templates/index.twig';
	const parsed: ParsedDocument = {
		uri,
		version: 1,
		document: TextDocument.create(uri, 'twig', 1, text),
		result: parse(text),
		workspaceContext: {},
	};
	return getCompletions(parsed, offset, {
		catalogRegistry: CatalogRegistry.fromPacks([corePack]),
		...(providers === undefined ? {} : { memberProviders: providers }),
	});
}

function labelsAt(marked: string): string[] {
	return completionsAt(marked).map((item) => item.label);
}

function itemAt(marked: string, label: string): CompletionItem {
	const item = completionsAt(marked).find((candidate) => candidate.label === label);
	if (item === undefined) {
		throw new Error(`no ${JSON.stringify(label)} in [${labelsAt(marked).join(', ')}]`);
	}
	return item;
}

/** What a chosen item would leave the document looking like. */
function applied(marked: string, label: string): string {
	const offset = marked.indexOf('‸');
	const text = marked.slice(0, offset) + marked.slice(offset + 1);
	const document = TextDocument.create('file:///a.twig', 'twig', 1, text);
	const item = itemAt(marked, label);
	if (item.textEdit === undefined || !('range' in item.textEdit)) {
		throw new Error('item has no replacing text edit');
	}
	const start = document.offsetAt(item.textEdit.range.start);
	const end = document.offsetAt(item.textEdit.range.end);
	return text.slice(0, start) + item.textEdit.newText + text.slice(end);
}

describe('tag names', () => {
	it('offers tags at `{% ‸ %}`', () => {
		const labels = labelsAt('{% ‸ %}');
		expect(labels).toEqual(expect.arrayContaining(['if', 'for', 'set', 'block']));
	});

	// The acceptance criterion: picking `for` writes the whole block.
	it('inserts the full block snippet for `for`', () => {
		expect(applied('{% ‸ %}', 'for')).toBe('{% for $1 in $2 %}\n\t$0\n{% endfor %}');
		expect(itemAt('{% ‸ %}', 'for').insertTextFormat).toBe(2);
	});

	it('keeps the closing delimiter when the region has none yet', () => {
		expect(applied('{% fo‸', 'for')).toBe('{% for $1 in $2 %}\n\t$0\n{% endfor %}');
	});

	// The edit swallows the interior, so whitespace control on the delimiters
	// survives a completion instead of being rewritten away.
	it('preserves whitespace control markers', () => {
		expect(applied('{%- fo‸ -%}', 'for')).toBe('{%- for $1 in $2 %}\n\t$0\n{% endfor -%}');
	});

	it('filters against the text the edit covers, not the bare label', () => {
		expect(itemAt('{% fo‸ %}', 'for').filterText).toBe(' for');
	});

	it('offers the end tag of the open block, ranked above the rest', () => {
		const items = completionsAt('{% for a in b %}{% ‸ %}');
		const endfor = items.find((item) => item.label === 'endfor');
		const iff = items.find((item) => item.label === 'if');
		expect(endfor?.detail).toBe('Closes {% for %}');
		expect(endfor?.sortText?.localeCompare(iff?.sortText ?? '')).toBeLessThan(0);
		expect(applied('{% for a in b %}{% ‸ %}', 'endfor')).toBe('{% for a in b %}{% endfor %}');
	});

	it('does not offer an end tag for a block that already has one', () => {
		expect(labelsAt('{% for a in b %}{% ‸ %}{% endfor %}')).not.toContain('endfor');
	});

	it('offers only end tags once `end` is typed', () => {
		expect(labelsAt('{% if x %}{% end‸ %}')).toEqual(['endif']);
	});

	it('offers no tags inside an output', () => {
		expect(labelsAt('{{ ‸ }}')).not.toContain('for');
	});

	it('offers no filters at a tag name', () => {
		expect(labelsAt('{% ‸ %}')).not.toContain('upper');
	});
});

describe('filters', () => {
	// The acceptance criterion: `{{ name| }}` is filters and nothing else.
	it('offers filters and only filters after a pipe', () => {
		const labels = labelsAt('{{ name|‸ }}');
		expect(labels).toEqual(expect.arrayContaining(['upper', 'escape']));
		expect(labels).not.toContain('for');
		expect(labels).not.toContain('date');
		expect(labels).not.toContain('defined');
	});

	it('drops the pipe the user already typed', () => {
		expect(applied('{{ name|‸ }}', 'upper')).toBe('{{ name|upper }}');
		expect(applied('{{ name|up‸ }}', 'upper')).toBe('{{ name|upper }}');
	});

	it('keeps argument tab stops', () => {
		expect(applied('{{ items|‸ }}', 'batch')).toBe('{{ items|batch($1, $2) }}');
	});

	it('offers filters in an apply tag, where there is no pipe to drop', () => {
		expect(applied('{% apply ‸ %}{% endapply %}', 'upper')).toBe(
			'{% apply upper %}{% endapply %}',
		);
	});
});

describe('tests', () => {
	// The acceptance criterion: `{% if x is  %}` is tests and nothing else.
	it('offers tests and only tests after `is`', () => {
		const labels = labelsAt('{% if x is ‸ %}{% endif %}');
		expect(labels).toEqual(expect.arrayContaining(['defined', 'empty']));
		expect(labels).not.toContain('upper');
		expect(labels).not.toContain('for');
	});

	it('offers tests after `is not` too', () => {
		expect(labelsAt('{% if x is not ‸ %}{% endif %}')).toContain('defined');
	});

	it('drops the `is` the user already typed', () => {
		expect(applied('{% if x is ‸ %}{% endif %}', 'defined')).toBe(
			'{% if x is defined %}{% endif %}',
		);
	});

	it('handles two-word tests', () => {
		expect(applied('{% if x is ‸ %}{% endif %}', 'divisible by')).toBe(
			'{% if x is divisible by($1) %}{% endif %}',
		);
	});
});

describe('variables', () => {
	// The acceptance criterion, both halves.
	it('completes a loop variable inside its loop', () => {
		expect(labelsAt('{% for item in items %}{{ it‸ }}{% endfor %}')).toContain('item');
	});

	it('does not complete a loop variable outside its loop', () => {
		expect(labelsAt('{% for item in items %}{% endfor %}{{ it‸ }}')).not.toContain('item');
	});

	it('ranks variables above catalog entries', () => {
		const items = completionsAt('{% set date = 1 %}{{ ‸ }}');
		const variable = items.find(
			(item) => item.label === 'date' && item.kind === CompletionItemKind.Variable,
		);
		const fn = items.find(
			(item) => item.label === 'date' && item.kind === CompletionItemKind.Function,
		);
		expect(variable?.sortText?.localeCompare(fn?.sortText ?? '')).toBeLessThan(0);
	});

	it('offers globals from the active packs', () => {
		const labels = labelsAt('{{ ‸ }}');
		expect(labels).toContain('app');
	});

	it('offers functions and variables together in an expression', () => {
		const labels = labelsAt('{% set thing = 1 %}{{ ‸ }}');
		expect(labels).toEqual(expect.arrayContaining(['thing', 'date']));
		expect(labels).not.toContain('upper');
	});

	it('offers macro parameters inside the macro, and nothing from outside', () => {
		const labels = labelsAt('{% set outer = 1 %}{% macro f(label) %}{{ ‸ }}{% endmacro %}');
		expect(labels).toContain('label');
		expect(labels).not.toContain('outer');
	});

	// The acceptance criterion: a same-file import graph resolves.
	it('completes a macro brought in by `from … import`', () => {
		const labels = labelsAt('{% from "macros.twig" import button %}{{ butt‸ }}');
		expect(labels).toContain('button');
	});
});

describe('member access', () => {
	it('completes loop members inside a loop', () => {
		const labels = labelsAt('{% for item in items %}{{ loop.‸ }}{% endfor %}');
		expect(labels).toEqual(
			expect.arrayContaining(['index', 'index0', 'first', 'last', 'length', 'parent']),
		);
	});

	it('completes nothing for `loop` outside a loop', () => {
		expect(labelsAt('{{ loop.‸ }}')).toEqual([]);
	});

	it('completes nothing for a receiver no provider knows', () => {
		expect(labelsAt('{{ user.‸ }}')).toEqual([]);
	});

	it('completes macros through a `_self` import namespace', () => {
		const labels = labelsAt(
			'{% import _self as m %}{{ m.‸ }}{% macro button() %}{% endmacro %}',
		);
		expect(labels).toEqual(['button']);
	});

	// The seam milestone 10 arrives through: a provider sees the receiver and
	// the symbol it resolved to, and decides for itself.
	it('lets an injected provider answer for a receiver of its own', () => {
		const craftish: MemberProvider = {
			id: 'test.entry',
			provideMembers: ({ object, symbol }) =>
				object.type === 'Identifier' && object.name === 'entry' && symbol === undefined
					? [{ name: 'myField', detail: 'PlainText', source: 'CraftCMS' }]
					: [],
		};
		expect(labelsAt('{{ entry.‸ }}')).toEqual([]);
		expect(completionsAt('{{ entry.‸ }}', [craftish])).toMatchObject([
			{ label: 'myField', labelDetails: { description: 'CraftCMS' } },
		]);
	});

	it('lets a local definition shadow what a provider would claim', () => {
		const always: MemberProvider = {
			id: 'test.always',
			provideMembers: ({ symbol }) => (symbol === undefined ? [{ name: 'global' }] : []),
		};
		expect(completionsAt('{% set entry = 1 %}{{ entry.‸ }}', [always])).toEqual([]);
	});
});

describe('block names', () => {
	it('completes block names inside `block()`', () => {
		expect(labelsAt('{% block title %}{% endblock %}{{ block("‸") }}')).toEqual(['title']);
	});

	it('replaces the partial name inside the quotes', () => {
		expect(applied('{% block title %}{% endblock %}{{ block("ti‸") }}', 'title')).toBe(
			'{% block title %}{% endblock %}{{ block("title") }}',
		);
	});
});

describe('named arguments', () => {
	it('offers the callee’s parameters, ranked above the catalog', () => {
		const items = completionsAt('{{ date(‸) }}');
		const parameter = items.find((item) => item.label === 'timezone=');
		expect(parameter).toBeDefined();
		expect(applied('{{ date(‸) }}', 'timezone=')).toBe('{{ date(timezone=) }}');
		const fn = items.find((item) => item.label === 'date');
		expect(parameter?.sortText?.localeCompare(fn?.sortText ?? '')).toBeLessThan(0);
	});
});

describe('positions with nothing to say', () => {
	// The acceptance criterion: Twig stays out of prose entirely.
	it.each([
		['{# a comm‸ent #}', 'a comment'],
		['<div class="x">te‸xt</div>', 'raw HTML text'],
		['{% verbatim %}{{ na‸me }}{% endverbatim %}', 'a verbatim body'],
		['{{ "some ‸text" }}', 'string text'],
	])('offers nothing in %j (%s)', (marked) => {
		expect(completionsAt(marked)).toEqual([]);
	});
});

describe('presentation', () => {
	it('shows one sentence of detail, provenance, and full docs', () => {
		const item = itemAt('{{ name|‸ }}', 'upper');
		expect(item).toMatchObject({
			// One sentence, though the description runs to two.
			detail: 'The `upper` filter converts a value to uppercase.',
			labelDetails: { description: 'Twig' },
			kind: CompletionItemKind.Function,
		});

		const documentation = item.documentation;
		if (typeof documentation !== 'object' || documentation === undefined) {
			throw new Error('expected markdown documentation');
		}
		expect(documentation.kind).toBe('markdown');
		expect(documentation.value).toContain('It leaves other characters alone.');
		expect(documentation.value).toContain(
			'[Documentation ↗](https://twig.symfony.com/doc/3.x/filters/upper.html)',
		);
	});

	it('marks deprecated entries', () => {
		expect(itemAt('{{ name|‸ }}', 'old')).toMatchObject({ tags: [1] });
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
			tag('if', '{% if $1 %}\n\t$0\n{% endif %}'),
			tag('for', '{% for $1 in $2 %}\n\t$0\n{% endfor %}'),
			tag('set', '{% set $1 = $2 %}'),
			tag('block', '{% block $1 %}\n\t$0\n{% endblock %}'),
			tag('apply', '{% apply $1 %}\n\t$0\n{% endapply %}'),
		],
		filters: [
			entry('upper', {
				signature: 'upper',
				completionSnippet: '|upper',
				description:
					'The `upper` filter converts a value to uppercase. It leaves other characters alone.',
				docsUrl: 'https://twig.symfony.com/doc/3.x/filters/upper.html',
			}),
			entry('escape', { completionSnippet: '|escape' }),
			entry('batch', { completionSnippet: '|batch($1, $2)' }),
			entry('old', {
				completionSnippet: '|old',
				deprecated: { sinceVersion: '3.11', message: 'Use `upper` instead.' },
			}),
		],
		functions: [
			entry('date', {
				completionSnippet: 'date($1, $2)',
				parameters: [
					{ name: 'date', optional: true },
					{ name: 'timezone', optional: true, description: 'Timezone to render in.' },
				],
			}),
			entry('block', { completionSnippet: 'block($0)' }),
		],
		tests: [
			entry('defined', { completionSnippet: 'is defined' }),
			entry('empty', { completionSnippet: 'is empty' }),
			entry('divisible by', { completionSnippet: 'is divisible by($1)' }),
		],
		globals: [entry('app', { description: 'The application context.' })],
	},
};

function entry(name: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		name,
		signature: name,
		parameters: [],
		description: `The \`${name}\` entry does something. And then explains it further.`,
		docsUrl: `https://twig.symfony.com/doc/3.x/${name}.html`,
		completionSnippet: name,
		...overrides,
	};
}

function tag(name: string, completionSnippet: string): CatalogEntry {
	return entry(name, { completionSnippet });
}
