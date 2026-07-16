import { findRegions } from './regions';
import type { TwigToolboxSettings } from './settings';
import {
	collectSymbols,
	type BlockDefinition,
	type ExternalTemplateSymbols,
	type SymbolTable,
} from './symbols';
import type { TemplateResolver } from './template-resolver';
import { collectTemplateReferences } from './template-references';
import type { DocumentStore, ParsedDocument } from './document-store';

export interface ResolvedBlock {
	readonly uri: string;
	readonly source: string;
	readonly block: BlockDefinition;
}

export class TemplateSymbolResolver {
	private readonly symbolsByUri = new Map<string, ExternalTemplateSymbols>();
	private readonly resolving = new Set<string>();

	constructor(
		private readonly documents: DocumentStore,
		private readonly templates: TemplateResolver,
		private readonly settings: TwigToolboxSettings,
	) {}

	collect(parsed: ParsedDocument): SymbolTable {
		return collectSymbols(
			parsed.result.template,
			parsed.result.source,
			findRegions(parsed.result.tokens, parsed.result.source.length),
			{
				documentUri: parsed.uri,
				resolveTemplateSymbols: (templateName) =>
					this.symbolsForTemplate(parsed.uri, templateName),
			},
		);
	}

	symbolsForTemplate(fromUri: string, templateName: string): ExternalTemplateSymbols | undefined {
		const target = this.templates.resolve(fromUri, templateName, this.settings)[0];
		if (target === undefined) {
			return undefined;
		}
		return this.symbolsForUri(target.uri);
	}

	parentBlocks(parsed: ParsedDocument): ResolvedBlock[] {
		const blocks: ResolvedBlock[] = [];
		let current: ParsedDocument | undefined = parsed;
		const seen = new Set<string>([parsed.uri]);
		for (;;) {
			const parent = this.extendsTarget(current);
			if (parent === undefined || seen.has(parent.uri)) {
				return blocks;
			}
			seen.add(parent.uri);
			const parentParsed = this.documents.getParsedFile(parent.uri);
			if (parentParsed === undefined) {
				return blocks;
			}
			const parentSymbols = this.symbolsForUri(parent.uri);
			if (parentSymbols === undefined) {
				return blocks;
			}
			for (const block of parentSymbols.blocks) {
				blocks.push({ uri: parent.uri, source: parentSymbols.source, block });
			}
			current = parentParsed;
		}
	}

	parentBlock(parsed: ParsedDocument, name: string): ResolvedBlock | undefined {
		return this.parentBlocks(parsed).find((block) => block.block.name === name);
	}

	private symbolsForUri(uri: string): ExternalTemplateSymbols | undefined {
		const cached = this.symbolsByUri.get(uri);
		if (cached !== undefined) {
			return cached;
		}
		if (this.resolving.has(uri)) {
			return undefined;
		}

		const parsed = this.documents.getParsedFile(uri);
		if (parsed === undefined) {
			return undefined;
		}

		this.resolving.add(uri);
		try {
			const symbols = this.collect(parsed);
			const external = {
				uri,
				source: parsed.result.source,
				macros: symbols.macros,
				blocks: symbols.blocks,
			};
			this.symbolsByUri.set(uri, external);
			return external;
		} finally {
			this.resolving.delete(uri);
		}
	}

	private extendsTarget(parsed: ParsedDocument): { readonly uri: string } | undefined {
		const reference = collectTemplateReferences(parsed).find(
			(candidate) => candidate.kind === 'extends',
		);
		if (reference === undefined) {
			return undefined;
		}
		const resolved = this.templates.resolve(parsed.uri, reference.name, this.settings)[0];
		return resolved === undefined ? undefined : { uri: resolved.uri };
	}
}
