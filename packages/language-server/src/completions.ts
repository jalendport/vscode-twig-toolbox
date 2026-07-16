import type { SourceRange } from '@twig-toolbox/parser';
import {
	CompletionItemKind,
	CompletionItemTag,
	InsertTextFormat,
	MarkupKind,
	type CompletionItem,
	type Range,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type {
	CatalogEntryKind,
	CatalogEntryWithProvenance,
	CatalogRegistry,
	CatalogEntryMap,
} from './catalog';
import { classifyCompletion, type CompletionContext, type OpenTag } from './completion-context';
import type { ParsedDocument } from './document-store';
import {
	BUILTIN_MEMBER_PROVIDERS,
	provideMembers,
	type MemberCompletion,
	type MemberProvider,
} from './members';
import { findRegions } from './regions';
import { collectSymbols, type SymbolTable, type TwigSymbol } from './symbols';

/**
 * Completion items for a cursor position.
 *
 * The context decides the menu — filters after a `|`, tests after an `is`, tags
 * only at a tag name — so nothing here is a union of everything on offer. What
 * the document itself defines outranks what the catalogs do: a local `{% set %}`
 * is a better guess than a filter that happens to share its prefix.
 */

export interface CompletionOptions {
	readonly catalogRegistry: CatalogRegistry;
	readonly memberProviders?: readonly MemberProvider[];
}

/** Sort buckets. Lower sorts higher; VS Code compares `sortText` as a string. */
const RANK = {
	/** `endfor` while a `for` is open — the one item context alone can name. */
	endTag: '0',
	/** Names this document defines: variables, macros, parameters, members. */
	local: '1',
	/** Catalog entries from the active dialect packs. */
	catalog: '2',
} as const;

const KIND_ICONS: Record<CatalogEntryKind, CompletionItemKind> = {
	tags: CompletionItemKind.Keyword,
	filters: CompletionItemKind.Function,
	functions: CompletionItemKind.Function,
	tests: CompletionItemKind.Keyword,
	globals: CompletionItemKind.Variable,
};

const SYMBOL_ICONS: Record<TwigSymbol['kind'], CompletionItemKind> = {
	variable: CompletionItemKind.Variable,
	'loop-variable': CompletionItemKind.Variable,
	loop: CompletionItemKind.Variable,
	parameter: CompletionItemKind.Variable,
	macro: CompletionItemKind.Function,
	'macro-namespace': CompletionItemKind.Module,
};

export function getCompletions(
	parsed: ParsedDocument,
	offset: number,
	options: CompletionOptions,
): CompletionItem[] {
	const context = classifyCompletion(parsed, offset);
	if (context.kind === 'none') {
		return [];
	}

	const entries = options.catalogRegistry.getMergedEntries(parsed.workspaceContext);
	const symbols = collectSymbols(
		parsed.result.template,
		parsed.result.source,
		findRegions(parsed.result.tokens, parsed.result.source.length),
	);
	const range = toRange(parsed.document, context.replace);

	switch (context.kind) {
		case 'tag-name':
		case 'end-tag':
			return tagItems(context, entries, parsed, range);

		case 'filter':
			return catalogItems(entries.filters, 'filters', range, stripPipe);

		case 'test':
			return catalogItems(entries.tests, 'tests', range, stripIs);

		case 'function-call':
			return catalogItems(entries.functions, 'functions', range);

		case 'expression':
			return [
				...symbolItems(symbols.visibleAt(offset), range),
				...catalogItems(entries.functions, 'functions', range),
				...catalogItems(entries.globals, 'globals', range),
			];

		case 'member-access':
			return memberItems(context, parsed, symbols, offset, options, range);

		case 'named-argument':
			return [
				...parameterItems(context.owner, entries, range),
				...symbolItems(symbols.visibleAt(offset), range),
				...catalogItems(entries.functions, 'functions', range),
			];

		case 'block-name':
			return symbols.blocks
				.filter((block) => block.name !== '')
				.map((block) => ({
					label: block.name,
					kind: CompletionItemKind.Value,
					detail: 'Block in this template',
					sortText: `${RANK.local}:${block.name}`,
					textEdit: { range, newText: block.name },
				}));

		// Hash keys are the author's own invention, and template paths need the
		// template roots milestone 08 discovers.
		case 'hash-key':
		case 'template-string':
			return [];
	}
}

/**
 * Tags, plus the `end…` of every block still open here.
 *
 * Tag snippets carry their own `{% %}`, so the edit covers the region's interior
 * and the snippet gives its delimiters back — which keeps `{%-` whitespace
 * control intact, and works whether or not the closing `%}` has been typed yet.
 */
function tagItems(
	context: Extract<CompletionContext, { kind: 'tag-name' | 'end-tag' }>,
	entries: CatalogEntryMap,
	parsed: ParsedDocument,
	range: Range,
): CompletionItem[] {
	const { region, nameSlot } = context;
	// Whatever sits between `{%` and the name — the edit swallows it, so filtering
	// has to expect it back.
	const gap = parsed.result.source.slice(region.contentStart, nameSlot.start);

	const item = (label: string, snippet: string, rank: string, base: Partial<CompletionItem>) => ({
		...base,
		label,
		filterText: `${gap}${label}`,
		sortText: `${rank}:${label}`,
		insertTextFormat: InsertTextFormat.Snippet,
		textEdit: { range, newText: tagSnippet(snippet, region.closed) },
	});

	const endItems = context.openTags.map((open: OpenTag, at: number) =>
		item(open.endName, `{% ${open.endName} %}`, `${RANK.endTag}${at}`, {
			kind: CompletionItemKind.Keyword,
			detail: `Closes {% ${open.name} %}`,
		}),
	);

	if (context.kind === 'end-tag') {
		return endItems;
	}

	const tagItems = [...new Set(entries.tags.values())].map((entry) =>
		item(entry.name, entry.completionSnippet, RANK.catalog, describe(entry, 'tags')),
	);
	return [...endItems, ...tagItems];
}

/**
 * Strips the delimiters a tag snippet supplies itself. The trailing `%}` stays
 * when the region has no closing delimiter to reuse.
 */
function tagSnippet(snippet: string, regionClosed: boolean): string {
	const withoutOpen = snippet.startsWith('{%') ? snippet.slice(2) : snippet;
	return regionClosed && withoutOpen.endsWith('%}') ? withoutOpen.slice(0, -2) : withoutOpen;
}

/** `|upper` → `upper`: the `|` the user already typed is not part of the edit. */
function stripPipe(snippet: string): string {
	return snippet.startsWith('|') ? snippet.slice(1) : snippet;
}

/** `is defined` → `defined`: likewise for the `is` that created the slot. */
function stripIs(snippet: string): string {
	return snippet.startsWith('is ') ? snippet.slice(3) : snippet;
}

function catalogItems(
	entries: CatalogEntryMap[CatalogEntryKind],
	kind: CatalogEntryKind,
	range: Range,
	insertText: (snippet: string) => string = (snippet) => snippet,
): CompletionItem[] {
	// Aliases share an entry object; offer each name once, under its own label.
	return [...entries].map(([name, entry]) => ({
		...describe(entry, kind),
		label: name,
		sortText: `${RANK.catalog}:${name}`,
		insertTextFormat: InsertTextFormat.Snippet,
		textEdit: { range, newText: insertText(entry.completionSnippet) },
	}));
}

function symbolItems(symbols: readonly TwigSymbol[], range: Range): CompletionItem[] {
	return symbols.map((symbol) => ({
		label: symbol.name,
		kind: SYMBOL_ICONS[symbol.kind],
		...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
		labelDetails: { description: describeSymbol(symbol) },
		sortText: `${RANK.local}:${symbol.name}`,
		textEdit: { range, newText: symbol.name },
	}));
}

function describeSymbol(symbol: TwigSymbol): string {
	switch (symbol.kind) {
		case 'loop-variable':
			return 'loop variable';
		case 'loop':
			return 'loop';
		case 'parameter':
			return 'macro parameter';
		case 'macro':
			return 'macro';
		case 'macro-namespace':
			return 'macros';
		case 'variable':
			return 'variable';
	}
}

function memberItems(
	context: Extract<CompletionContext, { kind: 'member-access' }>,
	parsed: ParsedDocument,
	symbols: SymbolTable,
	offset: number,
	options: CompletionOptions,
	range: Range,
): CompletionItem[] {
	const { object } = context;
	const members = provideMembers(options.memberProviders ?? BUILTIN_MEMBER_PROVIDERS, {
		object,
		symbol: object.type === 'Identifier' ? symbols.resolve(object.name, offset) : undefined,
		symbols,
		document: parsed,
		offset,
	});
	return members.map((member) => memberItem(member, range));
}

function memberItem(member: MemberCompletion, range: Range): CompletionItem {
	return {
		label: member.name,
		kind: CompletionItemKind.Property,
		...(member.detail === undefined ? {} : { detail: member.detail }),
		...(member.source === undefined ? {} : { labelDetails: { description: member.source } }),
		...(member.documentation === undefined
			? {}
			: { documentation: { kind: MarkupKind.Markdown, value: member.documentation } }),
		sortText: `${RANK.local}:${member.name}`,
		insertTextFormat: InsertTextFormat.Snippet,
		textEdit: { range, newText: member.insertText ?? member.name },
	};
}

/** `date(timezone=‸)` — the callee's own parameter names, ahead of everything. */
function parameterItems(
	owner: Extract<CompletionContext, { kind: 'named-argument' }>['owner'],
	entries: CatalogEntryMap,
	range: Range,
): CompletionItem[] {
	const entry = owner === undefined ? undefined : entries[owner.kind].get(owner.name);
	return (entry?.parameters ?? []).map((parameter) => ({
		label: `${parameter.name}=`,
		kind: CompletionItemKind.Property,
		detail: parameter.type ?? 'argument',
		...(parameter.description === undefined
			? {}
			: {
					documentation: {
						kind: MarkupKind.Markdown,
						value: parameter.description,
					},
				}),
		sortText: `${RANK.local}:${parameter.name}`,
		textEdit: { range, newText: `${parameter.name}=` },
	}));
}

/** Shared presentation for a catalog entry: icon, detail line, docs, provenance. */
function describe(entry: CatalogEntryWithProvenance, kind: CatalogEntryKind): CompletionItem {
	return {
		label: entry.name,
		kind: KIND_ICONS[kind],
		detail: firstSentence(entry.description),
		labelDetails: { description: entry.pack.displayName },
		...(entry.deprecated === undefined ? {} : { tags: [CompletionItemTag.Deprecated] }),
		documentation: { kind: MarkupKind.Markdown, value: documentation(entry) },
	};
}

function documentation(entry: CatalogEntryWithProvenance): string {
	const parts = [`\`\`\`twig\n${entry.signature}\n\`\`\``];
	if (entry.deprecated !== undefined) {
		const detail = entry.deprecated.message ?? '';
		parts.push(
			`**Deprecated** since ${entry.deprecated.sinceVersion}.${detail === '' ? '' : ` ${detail}`}`,
		);
	}
	if (entry.description !== '') {
		parts.push(entry.description);
	}
	if (entry.sinceVersion !== undefined) {
		parts.push(`Available since ${entry.pack.displayName} ${entry.sinceVersion}.`);
	}
	parts.push(`[${entry.pack.displayName} documentation](${entry.docsUrl})`);
	return parts.join('\n\n');
}

/** Detail lines get one sentence; the panel gets the rest. */
function firstSentence(description: string): string {
	const match = /^[\s\S]*?\.(?=\s|$)/.exec(description.trim());
	return (match?.[0] ?? description).replace(/\s+/g, ' ').trim();
}

function toRange(document: TextDocument, range: SourceRange): Range {
	return {
		start: document.positionAt(range.start),
		end: document.positionAt(range.end),
	};
}
