import { parse, type ParseResult } from '@twig-toolbox/parser';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { WorkspaceCatalogContext } from './catalog';

export interface ParsedDocument {
	readonly uri: string;
	readonly version: number;
	readonly document: TextDocument;
	readonly result: ParseResult;
	readonly workspaceContext: WorkspaceCatalogContext;
}

export interface DocumentStoreOptions {
	readonly parseDelayMs?: number;
	readonly resolveWorkspaceContext?: (uri: string) => WorkspaceCatalogContext;
	readonly onParsed?: (document: ParsedDocument) => void;
}

interface DocumentEntry {
	document: TextDocument;
	parsed: ParsedDocument | undefined;
	stale: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_PARSE_DELAY_MS = 200;

export class DocumentStore {
	private readonly entries = new Map<string, DocumentEntry>();
	private readonly parseDelayMs: number;
	private readonly resolveWorkspaceContext: (uri: string) => WorkspaceCatalogContext;
	private readonly onParsed: ((document: ParsedDocument) => void) | undefined;

	constructor(options: DocumentStoreOptions = {}) {
		this.parseDelayMs = options.parseDelayMs ?? DEFAULT_PARSE_DELAY_MS;
		this.resolveWorkspaceContext = options.resolveWorkspaceContext ?? (() => ({}));
		this.onParsed = options.onParsed;
	}

	open(document: TextDocument): ParsedDocument {
		this.clearTimer(document.uri);
		this.entries.set(document.uri, {
			document,
			parsed: undefined,
			stale: true,
			timer: undefined,
		});

		return this.parseNow(document.uri);
	}

	update(document: TextDocument): void {
		const existing = this.entries.get(document.uri);
		if (existing === undefined) {
			this.entries.set(document.uri, {
				document,
				parsed: undefined,
				stale: true,
				timer: undefined,
			});
		} else {
			existing.document = document;
			existing.stale = true;
		}

		this.schedule(document.uri);
	}

	close(uri: string): void {
		this.clearTimer(uri);
		this.entries.delete(uri);
	}

	get(uri: string): TextDocument | undefined {
		return this.entries.get(uri)?.document;
	}

	all(): TextDocument[] {
		return [...this.entries.values()].map((entry) => entry.document);
	}

	getParsed(uri: string): ParsedDocument | undefined {
		const entry = this.entries.get(uri);
		if (entry === undefined) {
			return undefined;
		}

		if (entry.parsed === undefined || entry.stale) {
			return this.parseNow(uri);
		}

		return entry.parsed;
	}

	parseNow(uri: string): ParsedDocument {
		const entry = this.entries.get(uri);
		if (entry === undefined) {
			throw new Error(`Cannot parse unopened document: ${uri}`);
		}

		this.clearTimer(uri);
		const parsed: ParsedDocument = {
			uri,
			version: entry.document.version,
			document: entry.document,
			result: parse(entry.document.getText()),
			workspaceContext: this.resolveWorkspaceContext(uri),
		};
		entry.parsed = parsed;
		entry.stale = false;
		this.onParsed?.(parsed);
		return parsed;
	}

	private schedule(uri: string): void {
		const entry = this.entries.get(uri);
		if (entry === undefined) {
			return;
		}

		this.clearTimer(uri);
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			if (this.entries.has(uri)) {
				this.parseNow(uri);
			}
		}, this.parseDelayMs);
	}

	private clearTimer(uri: string): void {
		const entry = this.entries.get(uri);
		if (entry?.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
	}
}
