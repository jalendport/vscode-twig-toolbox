import type { Diagnostic } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CatalogRegistry, WorkspaceCatalogContext } from './catalog';
import { getDiagnostics } from './diagnostics';
import { DocumentStore, type DocumentStoreOptions, type ParsedDocument } from './document-store';
import type { TwigToolboxSettings } from './settings';

export interface TwigServerCoreOptions {
	readonly catalogRegistry: CatalogRegistry;
	readonly getSettings: (uri: string) => Promise<TwigToolboxSettings>;
	readonly publishDiagnostics: (uri: string, diagnostics: Diagnostic[]) => void;
	readonly parseDelayMs?: number;
	readonly resolveWorkspaceContext?: (uri: string) => WorkspaceCatalogContext;
}

export class TwigServerCore {
	private readonly catalogRegistry: CatalogRegistry;
	private readonly getSettings: (uri: string) => Promise<TwigToolboxSettings>;
	private readonly publishDiagnostics: (uri: string, diagnostics: Diagnostic[]) => void;
	private readonly documents: DocumentStore;

	constructor(options: TwigServerCoreOptions) {
		this.catalogRegistry = options.catalogRegistry;
		this.getSettings = options.getSettings;
		this.publishDiagnostics = options.publishDiagnostics;
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
