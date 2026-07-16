import { visit, type AnyNode, type SourceRange, type StringLiteral } from '@twig-toolbox/parser';
import type { ParsedDocument } from './document-store';

export type TemplateReferenceKind =
	'include' | 'extends' | 'embed' | 'import' | 'from' | 'use' | 'source' | 'block';

export interface TemplateReference {
	readonly kind: TemplateReferenceKind;
	readonly name: string;
	readonly range: SourceRange;
	readonly literal: StringLiteral;
}

export function collectTemplateReferences(parsed: ParsedDocument): TemplateReference[] {
	const references: TemplateReference[] = [];
	visit(parsed.result.template, (node, ancestors) => {
		if (node.type !== 'StringLiteral' || node.parts.length > 1) {
			return;
		}
		const kind = templateReferenceKind(node, ancestors);
		if (kind === undefined) {
			return;
		}
		references.push({
			kind,
			name: node.value,
			range: { start: node.start + 1, end: node.end - 1 },
			literal: node,
		});
	});
	return references;
}

export function templateReferenceAt(
	parsed: ParsedDocument,
	offset: number,
): TemplateReference | undefined {
	return collectTemplateReferences(parsed).find(
		(reference) => reference.range.start <= offset && offset <= reference.range.end,
	);
}

function templateReferenceKind(
	literal: StringLiteral,
	ancestors: readonly AnyNode[],
): TemplateReferenceKind | undefined {
	const parent = ancestors.at(-1);
	switch (parent?.type) {
		case 'IncludeTag':
			return parent.template === literal ? 'include' : undefined;
		case 'ExtendsTag':
			return parent.template === literal ? 'extends' : undefined;
		case 'EmbedTag':
			return parent.template === literal ? 'embed' : undefined;
		case 'ImportTag':
			return parent.template === literal ? 'import' : undefined;
		case 'FromTag':
			return parent.template === literal ? 'from' : undefined;
		case 'UseTag':
			return parent.template === literal ? 'use' : undefined;
		case 'Argument':
			return functionTemplateReferenceKind(parent, ancestors);
		default:
			return undefined;
	}
}

function functionTemplateReferenceKind(
	argument: Extract<AnyNode, { type: 'Argument' }>,
	ancestors: readonly AnyNode[],
): TemplateReferenceKind | undefined {
	const call = ancestors.at(-2);
	if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') {
		return undefined;
	}
	const index = call.args.findIndex((candidate) => candidate === argument);
	switch (call.callee.name) {
		case 'include':
			return index === 0 ? 'include' : undefined;
		case 'source':
			return index === 0 ? 'source' : undefined;
		case 'block':
			return index === 1 ? 'block' : undefined;
		default:
			return undefined;
	}
}
