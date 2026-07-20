import type {
	CompletionItem,
	Definition,
	Diagnostic,
	DocumentLink,
	DocumentHighlight,
	Hover,
	Position,
	SignatureHelp,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CatalogRegistry, WorkspaceCatalogContext } from './catalog';
import { getBraceCompletion } from './auto-close-brace';
import type { CraftProjectConfigResolver } from './craft-project-config';
import { getDiagnostics } from './diagnostics';
import { DocumentStore, type DocumentStoreOptions, type ParsedDocument } from './document-store';
import { getEmbeddedHighlights, getTagCompletion } from './embedded';
import { getMergedCompletions, getMergedHover } from './merge';
import type { MemberProvider } from './members';
import type { TwigToolboxSettings } from './settings';
import { getSignatureHelp } from './signatures';
import { TemplateContextIndex } from './template-context';
import { getDefinition, getTemplateDocumentLinks } from './template-navigation';
import type { TemplateResolver } from './template-resolver';
import { TemplateSymbolResolver } from './template-symbols';

export interface TwigServerCoreOptions {
	readonly catalogRegistry: CatalogRegistry;
	readonly getSettings: (uri: string) => Promise<TwigToolboxSettings>;
	readonly publishDiagnostics: (uri: string, diagnostics: Diagnostic[], version?: number) => void;
	readonly parseDelayMs?: number;
	readonly resolveWorkspaceContext?: (uri: string) => WorkspaceCatalogContext;
	/** Defaults to the builtins; milestone 10 adds project-typed members here. */
	readonly memberProviders?: readonly MemberProvider[];
	readonly templateResolver?: TemplateResolver;
	readonly craftProjectConfig?: CraftProjectConfigResolver;
}

export class TwigServerCore {
	private readonly catalogRegistry: CatalogRegistry;
	private readonly getSettings: (uri: string) => Promise<TwigToolboxSettings>;
	private readonly publishDiagnostics: (
		uri: string,
		diagnostics: Diagnostic[],
		version?: number,
	) => void;
	private readonly documents: DocumentStore;
	private readonly memberProviders: readonly MemberProvider[] | undefined;
	private readonly templateResolver: TemplateResolver | undefined;
	private readonly craftProjectConfig: CraftProjectConfigResolver | undefined;
	/**
	 * Long-lived on purpose: `TemplateSymbolResolver` is rebuilt per request
	 * because it caches against one settings snapshot, but the inclusion graph
	 * is workspace state, and rebuilding it per keystroke would defeat the
	 * laziness that keeps it off the perf budget.
	 */
	private readonly contextIndex: TemplateContextIndex | undefined;

	constructor(options: TwigServerCoreOptions) {
		this.catalogRegistry = options.catalogRegistry;
		this.getSettings = options.getSettings;
		this.publishDiagnostics = options.publishDiagnostics;
		this.memberProviders = options.memberProviders;
		this.templateResolver = options.templateResolver;
		this.craftProjectConfig = options.craftProjectConfig;
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
		this.contextIndex =
			this.templateResolver === undefined
				? undefined
				: new TemplateContextIndex(this.documents, this.templateResolver);
	}

	openDocument(document: TextDocument): void {
		this.documents.open(document);
	}

	updateDocument(document: TextDocument): void {
		this.documents.update(document);
		// An edit to an open template can add or remove an include, and the
		// watcher only fires on save.
		this.contextIndex?.invalidate(document.uri);
	}

	closeDocument(uri: string): void {
		this.documents.close(uri);
		this.publishDiagnostics(uri, []);
	}

	getParsedDocument(uri: string): ParsedDocument | undefined {
		return this.documents.getParsed(uri);
	}

	async complete(
		uri: string,
		position: Position,
		triggerCharacter?: string,
	): Promise<CompletionItem[]> {
		const parsed = this.documents.getParsed(uri);
		if (parsed === undefined) {
			return [];
		}
		// A space triggers completions only right after an opening delimiter —
		// `{{ ` / `{% ` (and their whitespace-control forms). Any other space
		// in the document answers with nothing, so the trigger stays silent in
		// HTML prose, attributes and mid-expression.
		if (triggerCharacter === ' ') {
			const lineBeforeCursor = parsed.document.getText({
				start: { line: position.line, character: 0 },
				end: position,
			});
			if (!/(\{\{-?|\{%-?)\s+$/.test(lineBeforeCursor)) {
				return [];
			}
		}
		const settings = await this.getSettings(uri);
		const symbolResolver = this.symbolResolver(settings);

		return getMergedCompletions(parsed, parsed.document.offsetAt(position), {
			catalogRegistry: this.catalogRegistry,
			...(this.templateResolver === undefined
				? {}
				: { templateResolver: this.templateResolver }),
			settings,
			...(symbolResolver === undefined ? {} : { symbolResolver }),
			...(this.memberProviders === undefined
				? {}
				: { memberProviders: this.memberProviders }),
			...(this.craftProjectConfig === undefined
				? {}
				: { craftProjectConfig: this.craftProjectConfig }),
		});
	}

	async hover(uri: string, position: Position): Promise<Hover | undefined> {
		const parsed = this.documents.getParsed(uri);
		if (parsed === undefined) {
			return undefined;
		}
		const settings = await this.getSettings(uri);
		const symbolResolver = this.symbolResolver(settings);

		return getMergedHover(parsed, parsed.document.offsetAt(position), {
			catalogRegistry: this.catalogRegistry,
			settings,
			...(symbolResolver === undefined ? {} : { symbolResolver }),
			...(this.contextIndex === undefined ? {} : { contextIndex: this.contextIndex }),
			...(this.memberProviders === undefined
				? {}
				: { memberProviders: this.memberProviders }),
			...(this.craftProjectConfig === undefined
				? {}
				: { craftProjectConfig: this.craftProjectConfig }),
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

	/** Answers the client's `twig/autoCloseBrace` request. See `getBraceCompletion`. */
	braceCompletion(uri: string, position: Position, trigger: string): string | undefined {
		const parsed = this.documents.getParsed(uri);
		return parsed === undefined ? undefined : getBraceCompletion(parsed, position, trigger);
	}

	async signatureHelp(uri: string, position: Position): Promise<SignatureHelp | undefined> {
		const parsed = this.documents.getParsed(uri);
		if (parsed === undefined) {
			return undefined;
		}
		const settings = await this.getSettings(uri);
		const symbolResolver = this.symbolResolver(settings);

		return getSignatureHelp(parsed, parsed.document.offsetAt(position), {
			catalogRegistry: this.catalogRegistry,
			...(symbolResolver === undefined ? {} : { symbolResolver }),
			...(this.memberProviders === undefined
				? {}
				: { memberProviders: this.memberProviders }),
		});
	}

	async definition(uri: string, position: Position): Promise<Definition | undefined> {
		const parsed = this.documents.getParsed(uri);
		if (parsed === undefined || this.templateResolver === undefined) {
			return undefined;
		}
		const settings = await this.getSettings(uri);
		return getDefinition(
			parsed,
			parsed.document.offsetAt(position),
			this.documents,
			this.templateResolver,
			settings,
			new TemplateSymbolResolver(this.documents, this.templateResolver, settings),
			this.craftProjectConfig,
			this.contextIndex,
		);
	}

	async documentLinks(uri: string): Promise<DocumentLink[]> {
		const parsed = this.documents.getParsed(uri);
		if (parsed === undefined || this.templateResolver === undefined) {
			return [];
		}
		const settings = await this.getSettings(uri);
		return getTemplateDocumentLinks(parsed, this.templateResolver, settings);
	}

	invalidateFile(uri: string): void {
		this.documents.invalidate(uri);
		this.templateResolver?.invalidate(uri);
		this.craftProjectConfig?.invalidate(uri);
		this.contextIndex?.invalidate(uri);
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
		// Never rejects: callers fire-and-forget this from parse callbacks and
		// notification handlers, where an unhandled rejection is fatal to the
		// server process under Node's default rejection mode.
		try {
			const settings = await this.getSettings(parsed.uri);
			const currentVersion = this.documents.peekVersion(parsed.uri);
			if (currentVersion !== undefined && currentVersion > parsed.version) {
				// A newer edit landed while settings were in flight. That edit's
				// own parse publishes its own diagnostics, so publishing this
				// stale batch now would either flicker or — if it resolves after
				// the newer one — clobber correct diagnostics with outdated ones.
				return;
			}
			this.publishDiagnostics(
				parsed.uri,
				getDiagnostics(parsed, settings, this.catalogRegistry, this.templateResolver),
				parsed.version,
			);
		} catch {
			// Settings lookup can fail during shutdown or a client hiccup; stale
			// squiggles until the next parse beat a dead server.
		}
	}

	private symbolResolver(settings: TwigToolboxSettings): TemplateSymbolResolver | undefined {
		return this.templateResolver === undefined
			? undefined
			: new TemplateSymbolResolver(this.documents, this.templateResolver, settings);
	}
}
