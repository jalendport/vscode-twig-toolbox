import { MarkupKind, type MarkupContent } from 'vscode-languageserver/node';
import type { CatalogEntryWithProvenance, CatalogParameter } from './catalog';
import type { MemberCompletion } from './members';
import type { TwigSymbol } from './symbols';

export interface LocalParameter {
	readonly name: string;
	readonly signature: string;
	readonly default?: string;
}

export function catalogMarkdown(entry: CatalogEntryWithProvenance): string {
	const parts = [codeBlock(entry.signature)];
	if (entry.deprecated !== undefined) {
		const detail = entry.deprecated.message ?? '';
		parts.push(
			`**Deprecated** since ${entry.deprecated.sinceVersion}.${detail === '' ? '' : ` ${detail}`}`,
		);
	}
	if (entry.description !== '') {
		parts.push(entry.description);
	}
	if (entry.parameters.length > 0) {
		parts.push(parameterTable(entry.parameters));
	}
	parts.push(`**Source:** ${entry.pack.displayName}`);
	parts.push(...availabilityNotes(entry.pack.displayName, entry));
	parts.push(`[Documentation ↗](${entry.docsUrl})`);
	return parts.join('\n\n');
}

export function catalogMarkup(entry: CatalogEntryWithProvenance): MarkupContent {
	return markdown(catalogMarkdown(entry));
}

export function memberMarkdown(member: MemberCompletion): string {
	const parts = [
		codeBlock(
			member.signature ??
				(member.detail === undefined ? member.name : `${member.name}: ${member.detail}`),
		),
	];
	if (member.deprecated !== undefined) {
		const detail = member.deprecated.message ?? '';
		parts.push(
			`**Deprecated** since ${member.deprecated.sinceVersion}.${detail === '' ? '' : ` ${detail}`}`,
		);
	}
	if (member.documentation !== undefined) {
		parts.push(member.documentation);
	}
	if (member.parameters !== undefined && member.parameters.length > 0) {
		parts.push(parameterTable(member.parameters));
	}
	if (member.source !== undefined) {
		parts.push(`**Source:** ${member.source}`);
	}
	parts.push(...availabilityNotes(member.source, member));
	if (member.docsUrl !== undefined) {
		parts.push(`[Documentation ↗](${member.docsUrl})`);
	}
	return parts.join('\n\n');
}

/**
 * Why a name that exists is not on offer here.
 *
 * Hover reaches items completion filtered out, and this is the line that earns
 * that: someone reading `craft.matrixBlocks` in a Craft 5 project has a broken
 * template and a question, and "Removed in Craft CMS 5.0.0" is the answer.
 */
function availabilityNotes(
	subject: string | undefined,
	item: { sinceVersion?: string; removedVersion?: string },
): string[] {
	const name = subject ?? 'this pack';
	const notes: string[] = [];
	if (item.sinceVersion !== undefined) {
		notes.push(`Available since ${name} ${item.sinceVersion}.`);
	}
	if (item.removedVersion !== undefined) {
		notes.push(`Removed in ${name} ${item.removedVersion}.`);
	}
	return notes;
}

export function symbolMarkdown(symbol: TwigSymbol, source: string): string {
	const parts: string[] = [];
	const signature = symbol.signature ?? symbol.name;
	if (symbol.kind === 'macro' || symbol.kind === 'macro-namespace') {
		parts.push(codeBlock(signature));
	} else if (symbol.detail !== undefined) {
		parts.push(codeBlock(`${symbol.name} ${symbol.detail}`));
	} else {
		parts.push(codeBlock(symbol.name));
	}

	parts.push(symbolDescription(symbol));

	const definitionSource = symbol.definitionSource ?? source;
	const definingLine = symbol.definitionRange
		? sourceSnippet(definitionSource, symbol.definitionRange)
		: '';
	if (definingLine !== '') {
		parts.push(codeBlock(definingLine));
	}
	return parts.join('\n\n');
}

export function localMacroMarkdown(
	signature: string,
	params: readonly LocalParameter[],
	source: string,
	definitionRange: { readonly start: number; readonly end: number },
): string {
	const parts = [codeBlock(signature), 'Macro defined in this template.'];
	if (params.length > 0) {
		parts.push(localParameterTable(params));
	}
	const definingLine = sourceSnippet(source, definitionRange);
	if (definingLine !== '') {
		parts.push(codeBlock(definingLine));
	}
	return parts.join('\n\n');
}

export function localParameterMarkdown(parameter: LocalParameter): string {
	const parts = [codeBlock(parameter.signature), 'Macro parameter.'];
	if (parameter.default !== undefined) {
		parts.push(`Default: \`${parameter.default}\``);
	}
	return parts.join('\n\n');
}

export function markdown(value: string): MarkupContent {
	return { kind: MarkupKind.Markdown, value };
}

export function firstSentence(description: string): string {
	const match = /^[\s\S]*?\.(?=\s|$)/.exec(description.trim());
	return (match?.[0] ?? description).replace(/\s+/g, ' ').trim();
}

function parameterTable(parameters: readonly CatalogParameter[]): string {
	const rows = parameters.map((parameter) =>
		[
			escapeCell(parameter.name),
			escapeCell(parameter.type ?? ''),
			parameter.optional ? 'Yes' : 'No',
			escapeCell(parameter.default ?? ''),
			escapeCell(parameter.description ?? ''),
		].join(' | '),
	);
	return [
		'| Parameter | Type | Optional | Default | Description |',
		'| --- | --- | --- | --- | --- |',
		...rows.map((row) => `| ${row} |`),
	].join('\n');
}

function localParameterTable(parameters: readonly LocalParameter[]): string {
	const rows = parameters.map((parameter) =>
		[
			escapeCell(parameter.name),
			parameter.default === undefined ? 'No' : 'Yes',
			escapeCell(parameter.default ?? ''),
		].join(' | '),
	);
	return [
		'| Parameter | Optional | Default |',
		'| --- | --- | --- |',
		...rows.map((row) => `| ${row} |`),
	].join('\n');
}

function codeBlock(value: string): string {
	return `\`\`\`twig\n${value}\n\`\`\``;
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function sourceSnippet(
	source: string,
	range: { readonly start: number; readonly end: number },
): string {
	const snippet = source.slice(range.start, range.end).trim();
	const firstBreak = snippet.indexOf('\n');
	return firstBreak === -1 ? snippet : snippet.slice(0, firstBreak).trim();
}

function symbolDescription(symbol: TwigSymbol): string {
	switch (symbol.kind) {
		case 'loop-variable':
			return 'Loop variable.';
		case 'loop':
			return 'Loop context variable.';
		case 'parameter':
			return 'Macro parameter.';
		case 'macro':
			return symbol.importedFrom === undefined ? 'Macro.' : 'Imported macro.';
		case 'macro-namespace':
			return 'Imported macro namespace.';
		case 'variable':
			return 'Variable set in this template.';
	}
}
