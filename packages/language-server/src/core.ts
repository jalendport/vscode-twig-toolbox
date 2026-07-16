import type {
	CompletionItem,
	Diagnostic,
	DocumentHighlight,
	Hover,
	Position,
	SignatureHelp,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CatalogRegistry, WorkspaceCatalogContext } from './catalog';
import { getDiagnostics } from './diagnostics';
import { DocumentStore, type DocumentStoreOptions, type ParsedDocument } from './document-store';
import { getEmbeddedHighlights, getTagCompletion } from './embedded';
import { getMergedCompletions, getMergedHover } from './merge';
import type { MemberProvider } from './members';
import type { TwigToolboxSettings } from './settings';
import { getSignatureHelp } from './signatures';

export interface TwigServerCoreOptions {
	readonly catalogRegistry: CatalogRegistry;
	readonly getSettings: (uri: string) => Promise<TwigToolboxSettings>;
	readonly publishDiagnostics: (uri: string, diagnostics: Diagnostic[]) => void;
	readonly parseDelayMs?: number;
	readonly resolveWorkspaceContext?: (uri: string) => WorkspaceCatalogContext;
	/** Defaults to the builtins; milestone 10 adds project-typed members here. */
	readonly memberProviders?: readonly MemberProvider[];
}

export class TwigServerCore {
	private readonly catalogRegistry: CatalogRegistry;
	private readonly getSettings: (uri: string) => Promise<TwigToolboxSettings>;
	private readonly publishDiagnostics: (uri: string, diagnostics: Diagnostic[]) => void;
	private readonly documents: DocumentStore;
	private readonly memberProviders: readonly MemberProvider[] | undefined;

	constructor(options: TwigServerCoreOptions) {
		this.catalogRegistry = options.catalogRegistry;
		this.getSettings = options.getSettings;
		this.publishDiagnostics = options.publishDiagnostics;
		this.memberProviders = options.memberProviders;
		const storeOptions: DocumentStoreOptions = {
			onParsed: (document) => {
				void this.publishParsedDiagnostics(document);
			},
			...(options.parseDelayMs === undefined ? {} : { parseDelayMs: options.parseDelayMs }),
			...(options.resolveWorkspaceContext === undefined
				? {}
				: { resolveWorkspaceContext: options.resolveWorkspaceContext }),
		};
		this.documents = new DocumentStore(storeOptions);
	}

	openDocument(document: TextDocument): void {
		this.documents.open(document);
	}

	updateDocument(document: TextDocument): void {
		this.documents.update(document);
	}

	closeDocument(uri: string): void {
		this.documents.close(uri);
		this.publishDiagnostics(uri, []);
	}

	getParsedDocument(uri: string): ParsedDocument | undefined {
		return this.documents.getParsed(uri);
	}

	complete(uri: string, position: Position): CompletionItem[] {
		const parsed = this.documents.getParsed(uri);
		if (parsed === undefined) {
			return [];
		}

		return getMergedCompletions(parsed, parsed.document.offsetAt(position), {
			catalogRegistry: this.catalogRegistry,
			...(this.memberProviders === undefined
				? {}
				: { memberProviders: this.memberProviders }),
		});
	}

	hover(uri: string, position: Position): Hover | undefined {
		const parsed = this.documents.getParsed(uri);
		if (parsed === undefined) {
			return undefined;
		}

		return getMergedHover(parsed, parsed.document.offsetAt(position), {
			catalogRegistry: this.catalogRegistry,
			...(this.memberProviders === undefined
				? {}
				: { memberProviders: this.memberProviders }),
		});
	}

	documentHighlights(uri: string, position: Position): DocumentHighlight[] {
		const parsed = this.documents.getParsed(uri);
		return parsed === undefined ? [] : getEmbeddedHighlights(parsed, position);
	}

	/** Answers the client's `html/tag` request. See `getTagCompletion`. */
	tagCompletion(uri: string, position: Position, trigger: string): string | undefined {
		const parsed = this.documents.getParsed(uri);
		return parsed === undefined ? undefined : getTagCompletion(parsed, position, trigger);
	}

	signatureHelp(uri: string, position: Position): SignatureHelp | undefined {
		const parsed = this.documents.getParsed(uri);
		if (parsed === undefined) {
			return undefined;
		}

		return getSignatureHelp(parsed, parsed.document.offsetAt(position), {
			catalogRegistry: this.catalogRegistry,
			...(this.memberProviders === undefined
				? {}
				: { memberProviders: this.memberProviders }),
		});
	}

	async refreshDiagnostics(uri: string): Promise<void> {
		const parsed = this.documents.getParsed(uri);
		if (parsed !== undefined) {
			await this.publishParsedDiagnostics(parsed);
		}
	}

	async refreshAllDiagnostics(): Promise<void> {
		await Promise.all(
			this.documents.all().map((document) => this.refreshDiagnostics(document.uri)),
		);
	}

	private async publishParsedDiagnostics(parsed: ParsedDocument): Promise<void> {
		const settings = await this.getSettings(parsed.uri);
		this.publishDiagnostics(parsed.uri, getDiagnostics(parsed, settings, this.catalogRegistry));
	}
}
