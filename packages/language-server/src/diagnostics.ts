import {
	type AnyNode,
	type Identifier,
	type ParseError,
	type SourceRange,
	visit,
} from '@twig-toolbox/parser';
import { DiagnosticSeverity, type Diagnostic, type Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CatalogEntryKind, CatalogEntryMap, CatalogRegistry } from './catalog';
import type { ParsedDocument } from './document-store';
import { findRegions } from './regions';
import type { TwigToolboxSettings, UnknownNamesSetting } from './settings';
import { collectSymbols, type SymbolTable } from './symbols';
import type { TemplateResolver } from './template-resolver';
import { collectTemplateReferences } from './template-references';

type UnknownDiagnosticKind = Extract<CatalogEntryKind, 'tags' | 'filters' | 'functions' | 'tests'>;

interface NameReference {
	readonly kind: UnknownDiagnosticKind;
	readonly name: string;
	readonly range: SourceRange;
}

const DIAGNOSTIC_SOURCE = 'twig-toolbox';

export function getDiagnostics(
	parsed: ParsedDocument,
	settings: TwigToolboxSettings,
	catalogRegistry: CatalogRegistry,
	templateResolver?: TemplateResolver,
): Diagnostic[] {
	// Gated: a name this project's Craft does not have is exactly the kind of
	// unknown name the check exists to report.
	const entries = catalogRegistry.getMergedEntries(parsed.workspaceContext, {
		availableOnly: true,
	});
	return [
		...parsed.result.errors.map((error) => parseErrorToDiagnostic(error, parsed)),
		...getUnknownNameDiagnostics(parsed, settings, entries),
		...getMissingTemplateDiagnostics(parsed, settings, templateResolver),
	];
}

function parseErrorToDiagnostic(error: ParseError, parsed: ParsedDocument): Diagnostic {
	return {
		range: rangeForParseError(error, parsed),
		severity:
			error.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
		code: error.code,
		source: DIAGNOSTIC_SOURCE,
		message: error.message,
	};
}

function rangeForParseError(error: ParseError, parsed: ParsedDocument): Range {
	if (error.code === 'missing-end-tag') {
		const tagRange = findUnclosedTagOpeningRange(error, parsed);
		if (tagRange !== undefined) {
			return offsetRange(parsed.document, tagRange.start, tagRange.end);
		}
	}

	return offsetRange(parsed.document, error.start, error.end);
}

function findUnclosedTagOpeningRange(
	error: ParseError,
	parsed: ParsedDocument,
): SourceRange | undefined {
	let candidate: AnyNode | undefined;
	visit(parsed.result.template, (node) => {
		if (!isTagNode(node) || node.end !== error.start) {
			return;
		}
		if (candidate === undefined || node.start >= candidate.start) {
			candidate = node;
		}
	});

	if (!isTagNode(candidate)) {
		return undefined;
	}

	const tagEnd = parsed.result.source.indexOf('%}', candidate.nameRange.end);
	return {
		start: candidate.start,
		end: tagEnd === -1 ? candidate.nameRange.end : tagEnd + 2,
	};
}

function getUnknownNameDiagnostics(
	parsed: ParsedDocument,
	settings: TwigToolboxSettings,
	entries: CatalogEntryMap,
): Diagnostic[] {
	const severity = severityForUnknownNames(settings.diagnostics.unknownNames);
	if (severity === undefined) {
		return [];
	}

	// Built locally rather than threaded through from the caller: existence of an
	// imported/defined macro doesn't depend on cross-file resolution, only on
	// what `{% from %}`/`{% import %}` bound in this document.
	const symbols = collectSymbols(
		parsed.result.template,
		parsed.result.source,
		findRegions(parsed.result.tokens, parsed.result.source.length),
	);

	const ignoredNames = new Set(settings.diagnostics.ignoredNames);
	const diagnostics: Diagnostic[] = [];
	for (const reference of collectNameReferences(parsed.result.template)) {
		if (
			ignoredNames.has(reference.name) ||
			entries[reference.kind].has(reference.name) ||
			isImportedMacroReference(reference, symbols)
		) {
			continue;
		}

		diagnostics.push({
			range: offsetRange(parsed.document, reference.range.start, reference.range.end),
			severity,
			code: `unknown-${singularKind(reference.kind)}`,
			source: DIAGNOSTIC_SOURCE,
			message: `Unknown Twig ${singularKind(reference.kind)} "${reference.name}".`,
		});
	}

	return diagnostics;
}

// `{% from "macros" import button %}{{ button() }}` calls a macro, not a
// function — the callee looks identical to `collectNameReferences`, so we
// have to ask the symbol table what `button` actually is at the call site.
function isImportedMacroReference(reference: NameReference, symbols: SymbolTable): boolean {
	return (
		reference.kind === 'functions' &&
		symbols.resolve(reference.name, reference.range.start)?.kind === 'macro'
	);
}

function getMissingTemplateDiagnostics(
	parsed: ParsedDocument,
	settings: TwigToolboxSettings,
	templateResolver: TemplateResolver | undefined,
): Diagnostic[] {
	if (
		templateResolver === undefined ||
		severityForUnknownNames(settings.diagnostics.unknownNames) === undefined
	) {
		return [];
	}

	return collectTemplateReferences(parsed).flatMap((reference) =>
		templateResolver.resolve(parsed.uri, reference.name, settings).length > 0
			? []
			: [
					{
						range: offsetRange(
							parsed.document,
							reference.range.start,
							reference.range.end,
						),
						severity: DiagnosticSeverity.Hint,
						code: 'template-not-found',
						source: DIAGNOSTIC_SOURCE,
						message: `Template "${reference.name}" was not found.`,
					},
				],
	);
}

function collectNameReferences(root: AnyNode): NameReference[] {
	const references: NameReference[] = [];
	visit(root, (node) => {
		if (isTagNode(node)) {
			references.push({
				kind: 'tags',
				name: node.name,
				range: node.nameRange,
			});
		}

		if (node.type === 'FilterExpression' && node.name !== undefined) {
			references.push(identifierReference('filters', node.name));
		}

		if (node.type === 'ApplyFilter' && node.name !== undefined) {
			references.push(identifierReference('filters', node.name));
		}

		if (node.type === 'TestExpression' && node.name !== undefined) {
			references.push(identifierReference('tests', node.name));
		}

		if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
			references.push(identifierReference('functions', node.callee));
		}
	});
	return references;
}

function identifierReference(kind: UnknownDiagnosticKind, identifier: Identifier): NameReference {
	return {
		kind,
		name: identifier.name,
		range: { start: identifier.start, end: identifier.end },
	};
}

function severityForUnknownNames(setting: UnknownNamesSetting): DiagnosticSeverity | undefined {
	switch (setting) {
		case 'hint':
			return DiagnosticSeverity.Hint;
		case 'warning':
			return DiagnosticSeverity.Warning;
		case 'error':
			return DiagnosticSeverity.Error;
		case 'off':
			return undefined;
	}
}

function singularKind(kind: UnknownDiagnosticKind): string {
	switch (kind) {
		case 'filters':
			return 'filter';
		case 'functions':
			return 'function';
		case 'tags':
			return 'tag';
		case 'tests':
			return 'test';
	}
}

function offsetRange(document: TextDocument, start: number, end: number): Range {
	const clampedStart = clampOffset(document, start);
	const clampedEnd = Math.max(clampedStart, clampOffset(document, end));
	return {
		start: document.positionAt(clampedStart),
		end: document.positionAt(clampedEnd === clampedStart ? clampedStart + 1 : clampedEnd),
	};
}

function clampOffset(document: TextDocument, offset: number): number {
	return Math.max(0, Math.min(offset, document.getText().length));
}

function isTagNode(node: AnyNode | undefined): node is AnyNode & {
	name: string;
	nameRange: SourceRange;
} {
	return node !== undefined && 'name' in node && 'nameRange' in node;
}
