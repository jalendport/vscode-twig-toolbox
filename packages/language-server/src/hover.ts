import {
	nodePathAt,
	type AnyNode,
	type Identifier,
	type MacroParam,
	type SourceRange,
} from '@twig-toolbox/parser';
import type { Hover, Range } from 'vscode-languageserver/node';
import type { CatalogRegistry } from './catalog';
import type { ParsedDocument } from './document-store';
import {
	catalogMarkdown,
	localMacroMarkdown,
	localParameterMarkdown,
	markdown,
	memberMarkdown,
	symbolMarkdown,
	type LocalParameter,
} from './markdown';
import { BUILTIN_MEMBER_PROVIDERS, provideMembers, type MemberProvider } from './members';
import { findRegions, regionAt, tokenAt, type TwigRegion } from './regions';
import { collectSymbols, type MacroDefinition, type SymbolTable, type TwigSymbol } from './symbols';

export interface HoverOptions {
	readonly catalogRegistry: CatalogRegistry;
	readonly memberProviders?: readonly MemberProvider[];
}

export function getHover(
	parsed: ParsedDocument,
	offset: number,
	options: HoverOptions,
): Hover | undefined {
	const { source, template, tokens } = parsed.result;
	const regions = findRegions(tokens, source.length);
	const region = regionAt(regions, offset);
	if (
		region === undefined ||
		region.kind === 'text' ||
		region.kind === 'comment' ||
		offset < region.contentStart ||
		offset > region.contentEnd
	) {
		return undefined;
	}

	const token = tokenAt(region, offset);
	if (token === undefined) {
		return undefined;
	}

	const path = nodePathAt(template, offset);
	const entries = options.catalogRegistry.getMergedEntries(parsed.workspaceContext);
	const symbols = collectSymbols(template, source, regions);

	const localDefinition = localDefinitionHover(path, offset, symbols, source, parsed);
	if (localDefinition !== undefined) {
		return localDefinition;
	}

	const member = memberHover(path, offset, parsed, symbols, options);
	if (member !== undefined) {
		return member;
	}

	const catalog = catalogHover(path, region, offset, source, parsed, entries, symbols);
	if (catalog !== undefined) {
		return catalog;
	}

	const identifier = identifierAt(path, offset);
	if (identifier === undefined) {
		return undefined;
	}

	const symbol = symbols.resolve(identifier.name, offset);
	if (symbol !== undefined) {
		return hover(symbolMarkdown(symbol, source), parsed, identifier);
	}

	const global = entries.globals.get(identifier.name);
	return global === undefined ? undefined : hover(catalogMarkdown(global), parsed, identifier);
}

function localDefinitionHover(
	path: readonly AnyNode[],
	offset: number,
	symbols: SymbolTable,
	source: string,
	parsed: ParsedDocument,
): Hover | undefined {
	const child = identifierAt(path, offset);
	if (child === undefined) {
		return undefined;
	}
	const parent = parentOf(path, child);
	if (parent === undefined) {
		return undefined;
	}

	switch (parent.type) {
		case 'SetTag': {
			const at = parent.targets.findIndex((target) => target === child);
			if (at === -1) {
				return undefined;
			}
			const value = parent.values[at];
			const detail =
				value === undefined ? undefined : `= ${source.slice(value.start, value.end)}`;
			return hover(
				symbolMarkdown(
					syntheticSymbol(child.name, 'variable', {
						definitionRange: { start: parent.start, end: parent.end },
						...(detail === undefined ? {} : { detail }),
					}),
					source,
				),
				parsed,
				child,
			);
		}
		case 'ForTag': {
			if (parent.keyTarget !== child && parent.valueTarget !== child) {
				return undefined;
			}
			const detail =
				parent.sequence === undefined
					? undefined
					: `for … in ${source.slice(parent.sequence.start, parent.sequence.end)}`;
			return hover(
				symbolMarkdown(
					syntheticSymbol(child.name, 'loop-variable', {
						definitionRange: { start: child.start, end: child.end },
						...(detail === undefined ? {} : { detail }),
					}),
					source,
				),
				parsed,
				child,
			);
		}
		case 'MacroTag': {
			if (parent.macroName !== child) {
				return undefined;
			}
			const macro = macroByName(symbols, child.name, parent.start);
			return macro === undefined
				? undefined
				: hover(
						localMacroMarkdown(
							macro.signature,
							localParameters(macro.params, source),
							source,
							macro.range,
						),
						parsed,
						child,
					);
		}
		case 'MacroParam':
			if (parent.name !== child) {
				return undefined;
			}
			return hover(localParameterMarkdown(localParameter(parent, source)), parsed, child);
		case 'BlockTag':
			return parent.blockName === child || parent.endName === child
				? hover(
						`\`\`\`twig\nblock ${child.name}\n\`\`\`\n\nBlock defined in this template.`,
						parsed,
						child,
					)
				: undefined;
		case 'FromImport': {
			if (parent.alias !== child && parent.macroName !== child) {
				return undefined;
			}
			const tag = parentOf(path, parent);
			if (tag?.type !== 'FromTag') {
				return undefined;
			}
			const importedFrom =
				tag.template === undefined
					? undefined
					: source.slice(tag.template.start, tag.template.end);
			const importedName = parent.macroName?.name ?? child.name;
			const macro =
				importedFrom === '_self'
					? symbols.macros.find((candidate) => candidate.name === importedName)
					: undefined;
			return hover(
				symbolMarkdown(
					syntheticSymbol(child.name, 'macro', {
						definitionRange: { start: tag.start, end: tag.end },
						detail: macro?.signature ?? `${child.name}()`,
						signature: macro?.signature ?? `${child.name}()`,
						...(macro === undefined ? {} : { params: macro.params }),
						...(importedFrom === undefined ? {} : { importedFrom }),
					}),
					source,
				),
				parsed,
				child,
			);
		}
		case 'ImportTag': {
			if (parent.alias !== child) {
				return undefined;
			}
			const importedFrom =
				parent.template === undefined
					? undefined
					: source.slice(parent.template.start, parent.template.end);
			return hover(
				symbolMarkdown(
					syntheticSymbol(child.name, 'macro-namespace', {
						definitionRange: { start: parent.start, end: parent.end },
						detail:
							importedFrom === undefined ? 'macros' : `macros from ${importedFrom}`,
						...(importedFrom === undefined ? {} : { importedFrom }),
					}),
					source,
				),
				parsed,
				child,
			);
		}
		default:
			return undefined;
	}
}

function memberHover(
	path: readonly AnyNode[],
	offset: number,
	parsed: ParsedDocument,
	symbols: SymbolTable,
	options: HoverOptions,
): Hover | undefined {
	const access = nearest(path, 'MemberAccess');
	if (
		access === undefined ||
		access.computed ||
		access.property?.type !== 'Identifier' ||
		!inside(access.property, offset)
	) {
		return undefined;
	}

	const property = access.property;
	if (access.object.type === 'Identifier' && access.object.name === '_self') {
		const macro = symbols.macros.find((candidate) => candidate.name === property.name);
		return macro === undefined
			? undefined
			: hover(
					localMacroMarkdown(
						macro.signature,
						localParameters(macro.params, parsed.result.source),
						parsed.result.source,
						macro.range,
					),
					parsed,
					property,
				);
	}

	const members = provideMembers(options.memberProviders ?? BUILTIN_MEMBER_PROVIDERS, {
		object: access.object,
		symbol:
			access.object.type === 'Identifier'
				? symbols.resolve(access.object.name, offset)
				: undefined,
		symbols,
		document: parsed,
		offset,
	});
	const member = members.find((candidate) => candidate.name === property.name);
	return member === undefined ? undefined : hover(memberMarkdown(member), parsed, property);
}

function catalogHover(
	path: readonly AnyNode[],
	region: TwigRegion,
	offset: number,
	source: string,
	parsed: ParsedDocument,
	entries: ReturnType<CatalogRegistry['getMergedEntries']>,
	symbols: SymbolTable,
): Hover | undefined {
	if (region.kind === 'block') {
		const first = region.tokens[0];
		if (first?.kind === 'name' && first.start <= offset && offset <= first.end) {
			const entry = entries.tags.get(first.value);
			return entry === undefined
				? undefined
				: hover(catalogMarkdown(entry), parsed, { start: first.start, end: first.end });
		}
	}

	const filter = nearest(path, 'FilterExpression');
	if (filter?.name !== undefined && inside(filter.name, offset)) {
		const entry = entries.filters.get(filter.name.name);
		return entry === undefined ? undefined : hover(catalogMarkdown(entry), parsed, filter.name);
	}

	const test = nearest(path, 'TestExpression');
	if (test?.name !== undefined && test.name.start <= offset && offset <= test.name.end) {
		const entry = entries.tests.get(test.name.name);
		return entry === undefined ? undefined : hover(catalogMarkdown(entry), parsed, test.name);
	}

	const call = nearest(path, 'CallExpression');
	if (call?.callee.type === 'Identifier' && inside(call.callee, offset)) {
		const name = call.callee.name;
		const symbol = symbols.resolve(name, offset);
		if (symbol?.kind === 'macro') {
			return hover(symbolMarkdown(symbol, source), parsed, call.callee);
		}
		const entry = entries.functions.get(name) ?? entries.filters.get(name);
		return entry === undefined ? undefined : hover(catalogMarkdown(entry), parsed, call.callee);
	}

	return undefined;
}

function localParameter(param: MacroParam, source: string): LocalParameter {
	return {
		name: param.name.name,
		signature:
			param.default === undefined
				? param.name.name
				: `${param.name.name} = ${source.slice(param.default.start, param.default.end)}`,
		...(param.default === undefined
			? {}
			: { default: source.slice(param.default.start, param.default.end) }),
	};
}

function localParameters(params: readonly MacroParam[], source: string): LocalParameter[] {
	return params.map((param) => localParameter(param, source));
}

function macroByName(
	symbols: SymbolTable,
	name: string,
	definitionStart: number,
): MacroDefinition | undefined {
	return symbols.macros.find(
		(macro) => macro.name === name && macro.range.start === definitionStart,
	);
}

function identifierAt(path: readonly AnyNode[], offset: number): Identifier | undefined {
	const node = path.at(-1);
	return node?.type === 'Identifier' && inside(node, offset) ? node : undefined;
}

function parentOf(path: readonly AnyNode[], child: AnyNode): AnyNode | undefined {
	const index = path.findIndex((node) => node === child);
	return index <= 0 ? undefined : path[index - 1];
}

function nearest<T extends AnyNode['type']>(
	path: readonly AnyNode[],
	type: T,
): Extract<AnyNode, { type: T }> | undefined {
	for (let at = path.length - 1; at >= 0; at--) {
		const node = path[at];
		if (node?.type === type) {
			return node as Extract<AnyNode, { type: T }>;
		}
	}
	return undefined;
}

function syntheticSymbol(
	name: string,
	kind: TwigSymbol['kind'],
	overrides: Partial<TwigSymbol>,
): TwigSymbol {
	return {
		name,
		kind,
		scope: { start: 0, end: 0 },
		wall: 0,
		...overrides,
	};
}

function inside(range: SourceRange, offset: number): boolean {
	return range.start <= offset && offset <= range.end;
}

function hover(contents: string, parsed: ParsedDocument, range: SourceRange): Hover {
	return {
		contents: markdown(contents),
		range: toRange(parsed, range),
	};
}

function toRange(parsed: ParsedDocument, range: SourceRange): Range {
	return {
		start: parsed.document.positionAt(range.start),
		end: parsed.document.positionAt(range.end),
	};
}
