import { nodePathAt, type AnyNode, type MacroParam, type Token } from '@twig-toolbox/parser';
import type {
	ParameterInformation,
	SignatureHelp,
	SignatureInformation,
} from 'vscode-languageserver/node';
import type { CatalogEntryWithProvenance, CatalogRegistry } from './catalog';
import type { ParsedDocument } from './document-store';
import {
	catalogMarkup,
	localMacroMarkdown,
	localParameterMarkdown,
	markdown,
	type LocalParameter,
} from './markdown';
import { BUILTIN_MEMBER_PROVIDERS, provideMembers, type MemberProvider } from './members';
import { findRegions, regionAt, type TwigRegion } from './regions';
import { collectSymbols, type MacroDefinition, type SymbolTable } from './symbols';
import type { TemplateSymbolResolver } from './template-symbols';

export interface SignatureOptions {
	readonly catalogRegistry: CatalogRegistry;
	readonly memberProviders?: readonly MemberProvider[];
	readonly symbolResolver?: TemplateSymbolResolver;
}

type SignatureTarget =
	| {
			readonly kind: 'catalog';
			readonly entry: CatalogEntryWithProvenance;
			readonly argOpen: Token;
	  }
	| {
			readonly kind: 'macro';
			readonly macro: MacroDefinition;
			readonly source: string;
			readonly argOpen: Token;
	  };

interface ResolvedMacro {
	readonly macro: MacroDefinition;
	readonly source: string;
}

export function getSignatureHelp(
	parsed: ParsedDocument,
	offset: number,
	options: SignatureOptions,
): SignatureHelp | undefined {
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

	const path = nodePathAt(template, offset);
	const symbols =
		options.symbolResolver?.collect(parsed) ?? collectSymbols(template, source, regions);
	const target = signatureTarget(path, region, offset, parsed, symbols, options);
	if (target === undefined) {
		return undefined;
	}

	const activeParameter = clampActiveParameter(
		activeParameterAt(region, target.argOpen, offset),
		target,
	);
	return {
		signatures: [signatureInformation(target)],
		activeSignature: 0,
		activeParameter,
	};
}

function signatureTarget(
	path: readonly AnyNode[],
	region: TwigRegion,
	offset: number,
	parsed: ParsedDocument,
	symbols: SymbolTable,
	options: SignatureOptions,
): SignatureTarget | undefined {
	const entries = options.catalogRegistry.getMergedEntries(parsed.workspaceContext);

	for (let at = path.length - 1; at >= 0; at--) {
		const node = path[at];
		if (node?.type === 'CallExpression') {
			const argOpen = argOpenToken(region, node.callee.end, node.end, offset);
			if (argOpen === undefined) {
				continue;
			}
			const macro = macroForCall(node.callee, symbols, offset, parsed, options);
			if (macro !== undefined) {
				return { kind: 'macro', macro: macro.macro, source: macro.source, argOpen };
			}
			if (node.callee.type === 'Identifier') {
				const entry =
					entries.functions.get(node.callee.name) ??
					entries.filters.get(node.callee.name);
				if (entry !== undefined) {
					return { kind: 'catalog', entry, argOpen };
				}
			}
		}

		if (node?.type === 'FilterExpression' && node.name !== undefined) {
			const argOpen = argOpenToken(region, node.name.end, node.end, offset);
			if (argOpen === undefined) {
				continue;
			}
			const entry = entries.filters.get(node.name.name);
			if (entry !== undefined) {
				return { kind: 'catalog', entry, argOpen };
			}
		}
	}

	return undefined;
}

function macroForCall(
	callee: Extract<AnyNode, { type: 'CallExpression' }>['callee'],
	symbols: SymbolTable,
	offset: number,
	parsed: ParsedDocument,
	options: SignatureOptions,
): ResolvedMacro | undefined {
	if (callee.type === 'Identifier') {
		const symbol = symbols.resolve(callee.name, offset);
		if (
			symbol?.kind === 'macro' &&
			symbol.params !== undefined &&
			symbol.signature !== undefined
		) {
			return {
				macro: {
					name: callee.name,
					signature: symbol.signature,
					params: symbol.params,
					range: symbol.definitionRange ?? symbol.scope,
				},
				source: symbol.definitionSource ?? parsed.result.source,
			};
		}
		const macro = symbols.macros.find((candidate) => candidate.name === callee.name);
		return macro === undefined ? undefined : { macro, source: parsed.result.source };
	}

	if (
		callee.type !== 'MemberAccess' ||
		callee.computed ||
		callee.property?.type !== 'Identifier'
	) {
		return undefined;
	}
	const property = callee.property;

	if (callee.object.type === 'Identifier' && callee.object.name === '_self') {
		const macro = symbols.macros.find((candidate) => candidate.name === property.name);
		return macro === undefined ? undefined : { macro, source: parsed.result.source };
	}

	const namespace =
		callee.object.type === 'Identifier'
			? symbols.resolve(callee.object.name, offset)
			: undefined;
	const namespaceMacro = namespace?.macroMembers?.find(
		(candidate) => candidate.name === property.name,
	);
	if (namespaceMacro !== undefined) {
		return {
			macro: namespaceMacro,
			source: namespace?.definitionSource ?? parsed.result.source,
		};
	}

	const members = provideMembers(options.memberProviders ?? BUILTIN_MEMBER_PROVIDERS, {
		object: callee.object,
		symbol: namespace,
		symbols,
		document: parsed,
		offset,
	});
	const member = members.find((candidate) => candidate.name === property.name);
	if (member?.macro !== undefined) {
		return { macro: member.macro, source: namespace?.definitionSource ?? parsed.result.source };
	}
	const macro =
		member === undefined
			? undefined
			: symbols.macros.find((candidate) => candidate.name === member.name);
	return macro === undefined ? undefined : { macro, source: parsed.result.source };
}

function signatureInformation(target: SignatureTarget): SignatureInformation {
	if (target.kind === 'catalog') {
		return {
			label: target.entry.signature,
			documentation: catalogMarkup(target.entry),
			parameters: target.entry.parameters.map((parameter) => ({
				label: parameterLabel(target.entry.signature, parameter.name),
				...(parameter.description === undefined
					? {}
					: { documentation: markdown(parameter.description) }),
			})),
		};
	}

	const macroSource = target.source;
	const parameters = localParameters(target.macro.params, macroSource);
	return {
		label: target.macro.signature,
		documentation: markdown(
			localMacroMarkdown(target.macro.signature, parameters, macroSource, target.macro.range),
		),
		parameters: parameters.map((parameter) => ({
			label: parameterLabel(target.macro.signature, parameter.name),
			documentation: markdown(localParameterMarkdown(parameter)),
		})),
	};
}

function argOpenToken(
	region: TwigRegion,
	after: number,
	nodeEnd: number,
	offset: number,
): Token | undefined {
	return region.tokens.find(
		(token) =>
			token.kind === 'punctuation' &&
			token.value === '(' &&
			token.start >= after &&
			token.end <= offset &&
			token.start <= nodeEnd,
	);
}

function activeParameterAt(region: TwigRegion, argOpen: Token, offset: number): number {
	let active = 0;
	let depth = 0;
	for (const token of region.tokens) {
		if (token.start < argOpen.end || token.end > offset || token.kind !== 'punctuation') {
			continue;
		}
		switch (token.value) {
			case '(':
			case '[':
			case '{':
				depth++;
				break;
			case ')':
			case ']':
			case '}':
				if (depth === 0) {
					return active;
				}
				depth--;
				break;
			case ',':
				if (depth === 0) {
					active++;
				}
				break;
			default:
				break;
		}
	}
	return active;
}

function clampActiveParameter(activeParameter: number, target: SignatureTarget): number {
	const count =
		target.kind === 'catalog' ? target.entry.parameters.length : target.macro.params.length;
	return count === 0 ? 0 : Math.min(activeParameter, count - 1);
}

function parameterLabel(signature: string, name: string): ParameterInformation['label'] {
	const start = signature.indexOf(name);
	return start === -1 ? name : [start, start + name.length];
}

function localParameters(params: readonly MacroParam[], source: string): LocalParameter[] {
	return params.map((param) => ({
		name: param.name.name,
		signature:
			param.default === undefined
				? param.name.name
				: `${param.name.name} = ${source.slice(param.default.start, param.default.end)}`,
		...(param.default === undefined
			? {}
			: { default: source.slice(param.default.start, param.default.end) }),
	}));
}
