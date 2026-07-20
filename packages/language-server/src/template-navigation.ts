import {
	nodePathAt,
	type AnyNode,
	type Expression,
	type Identifier,
	type SourceRange,
} from '@twig-toolbox/parser';
import { DocumentLink, Location, type Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { craftHandleAt, type CraftProjectConfigResolver } from './craft-project-config';
import type { DocumentStore, ParsedDocument } from './document-store';
import type { TwigToolboxSettings } from './settings';
import type { SymbolTable, TwigSymbol } from './symbols';
import type { TemplateContextIndex } from './template-context';
import type { TemplateResolver } from './template-resolver';
import { collectTemplateReferences, templateReferenceAt } from './template-references';
import type { TemplateSymbolResolver } from './template-symbols';

export function getTemplateDocumentLinks(
	parsed: ParsedDocument,
	templates: TemplateResolver,
	settings: TwigToolboxSettings,
): DocumentLink[] {
	return collectTemplateReferences(parsed).flatMap((reference) => {
		const resolved = templates.resolve(parsed.uri, reference.name, settings)[0];
		return resolved === undefined
			? []
			: [DocumentLink.create(offsetRange(parsed.document, reference.range), resolved.uri)];
	});
}

export function getDefinition(
	parsed: ParsedDocument,
	offset: number,
	documents: DocumentStore,
	templates: TemplateResolver,
	settings: TwigToolboxSettings,
	symbolResolver: TemplateSymbolResolver,
	craftProjectConfig?: CraftProjectConfigResolver,
	contextIndex?: TemplateContextIndex,
): Location[] {
	const template = templateReferenceAt(parsed, offset);
	if (template !== undefined) {
		return templates
			.resolve(parsed.uri, template.name, settings)
			.map((target) => documentStartLocation(documents, target.uri));
	}

	const path = nodePathAt(parsed.result.template, offset);
	const craftHandle = craftHandleDefinition(parsed, offset, path, craftProjectConfig);
	if (craftHandle !== undefined) {
		return [craftHandle];
	}

	const symbols = symbolResolver.collect(parsed);

	const fromImport = fromImportDefinition(
		parsed,
		offset,
		path,
		documents,
		symbolResolver,
		symbols,
	);
	if (fromImport !== undefined) {
		return [fromImport];
	}

	const block = blockDefinition(parsed, offset, path, documents, symbolResolver);
	if (block !== undefined) {
		return [block];
	}

	const member = memberMacroDefinition(offset, path, symbols, documents);
	if (member !== undefined) {
		return [member];
	}

	const identifier = identifierAt(path, offset);
	if (identifier === undefined) {
		return [];
	}
	const symbol = symbols.resolve(identifier.name, offset);
	if (symbol !== undefined) {
		return locationForSymbol(parsed, documents, symbol);
	}

	// Nothing in this file defines the name — so ask the templates that include
	// this one, which is where Twig's context actually came from.
	return (
		contextIndex
			?.resolve(parsed.uri, identifier.name, symbolResolver, settings)
			.flatMap((variable) => {
				const location = locationForRange(
					documents,
					variable.uri,
					variable.definitionRange,
				);
				return location === undefined ? [] : [location];
			}) ?? []
	);
}

function craftHandleDefinition(
	parsed: ParsedDocument,
	offset: number,
	path: readonly AnyNode[],
	craftProjectConfig: CraftProjectConfigResolver | undefined,
): Location | undefined {
	const schema = craftProjectConfig?.forUri(parsed.uri);
	const literal = nearest(path, 'StringLiteral');
	const argument = literal === undefined ? undefined : parentOf(path, literal);
	const call = argument === undefined ? undefined : parentOf(path, argument);
	if (
		schema === undefined ||
		literal === undefined ||
		argument?.type !== 'Argument' ||
		call?.type !== 'CallExpression' ||
		!inside(literal, offset) ||
		literal.parts.length > 1
	) {
		return undefined;
	}

	const handle = craftHandleAt(call.callee, literal.value, schema);
	return handle === undefined ? undefined : schema.sourceLocation(handle.sourceFile);
}

function fromImportDefinition(
	parsed: ParsedDocument,
	offset: number,
	path: readonly AnyNode[],
	documents: DocumentStore,
	symbolResolver: TemplateSymbolResolver,
	symbols: SymbolTable,
): Location | undefined {
	const child = identifierAt(path, offset);
	const parent = child === undefined ? undefined : parentOf(path, child);
	// The alias resolves to the same macro as the original name — `as btn`
	// doesn't rename what's being pointed at, only what it's called here.
	if (
		child === undefined ||
		parent?.type !== 'FromImport' ||
		(parent.macroName !== child && parent.alias !== child)
	) {
		return undefined;
	}
	const tag = parentOf(path, parent);
	const macroName = parent.macroName?.name;
	if (tag?.type !== 'FromTag' || macroName === undefined) {
		return undefined;
	}

	if (isSelfTemplate(tag.template)) {
		const macro = symbols.macros.find((candidate) => candidate.name === macroName);
		return macro === undefined
			? undefined
			: locationForRange(documents, parsed.uri, macro.range);
	}

	if (tag.template?.type !== 'StringLiteral') {
		return undefined;
	}
	const external = symbolResolver.symbolsForTemplate(parsed.uri, tag.template.value);
	const macro = external?.macros.find((candidate) => candidate.name === macroName);
	return external === undefined || macro === undefined
		? undefined
		: locationForRange(documents, external.uri, macro.range);
}

function isSelfTemplate(template: Expression | undefined): boolean {
	return template?.type === 'Identifier' && template.name === '_self';
}

function blockDefinition(
	parsed: ParsedDocument,
	offset: number,
	path: readonly AnyNode[],
	documents: DocumentStore,
	symbolResolver: TemplateSymbolResolver,
): Location | undefined {
	const child = identifierAt(path, offset);
	const block = child === undefined ? undefined : parentOf(path, child);
	if (
		child === undefined ||
		block?.type !== 'BlockTag' ||
		(block.blockName !== child && block.endName !== child) ||
		child.name === ''
	) {
		return undefined;
	}
	const parentBlock = symbolResolver.parentBlock(parsed, child.name);
	return parentBlock === undefined
		? undefined
		: locationForRange(documents, parentBlock.uri, parentBlock.block.range);
}

function memberMacroDefinition(
	offset: number,
	path: readonly AnyNode[],
	symbols: SymbolTable,
	documents: DocumentStore,
): Location | undefined {
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
	const namespace =
		access.object.type === 'Identifier'
			? symbols.resolve(access.object.name, offset)
			: undefined;
	const macro = namespace?.macroMembers?.find((candidate) => candidate.name === property.name);
	if (namespace?.definitionUri === undefined || macro === undefined) {
		return undefined;
	}
	return locationForRange(documents, namespace.definitionUri, macro.range);
}

function locationForSymbol(
	parsed: ParsedDocument,
	documents: DocumentStore,
	symbol: TwigSymbol,
): Location[] {
	if (symbol.definitionRange === undefined) {
		return [];
	}
	const uri = symbol.definitionUri ?? parsed.uri;
	const location = locationForRange(documents, uri, symbol.definitionRange);
	return location === undefined ? [] : [location];
}

function locationForRange(
	documents: DocumentStore,
	uri: string,
	range: SourceRange,
): Location | undefined {
	const parsed = documents.getParsedFile(uri);
	return parsed === undefined
		? undefined
		: Location.create(uri, offsetRange(parsed.document, range));
}

function documentStartLocation(documents: DocumentStore, uri: string): Location {
	const parsed = documents.getParsedFile(uri);
	return Location.create(
		uri,
		parsed === undefined
			? {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				}
			: {
					start: { line: 0, character: 0 },
					end: parsed.document.positionAt(Math.min(1, parsed.result.source.length)),
				},
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

function inside(range: SourceRange, offset: number): boolean {
	return range.start <= offset && offset <= range.end;
}

function offsetRange(document: TextDocument, range: SourceRange): Range {
	return {
		start: document.positionAt(range.start),
		end: document.positionAt(range.end),
	};
}
