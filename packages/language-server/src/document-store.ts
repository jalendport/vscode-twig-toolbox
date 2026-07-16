import { readFileSync, statSync } from 'node:fs';
import { parse, type ParseResult } from '@twig-toolbox/parser';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { WorkspaceCatalogContext } from './catalog';
import { createEmbeddedDocuments, type EmbeddedDocuments } from './embedded-documents';
import { findRegions } from './regions';
import { uriToFilePath } from './workspace';

export interface ParsedDocument {
	readonly uri: string;
	readonly version: number;
	readonly document: TextDocument;
	readonly result: ParseResult;
	readonly workspaceContext: WorkspaceCatalogContext;
	/**
	 * Virtual HTML/CSS shadow copies, cached alongside the parse and invalidated
	 * with it. Built on first read: a document nobody asks HTML questions about
	 * — one that only ever gets diagnostics — never pays for them.
	 */
	readonly embedded: EmbeddedDocuments;
}

/**
 * A parse plus everything derived from it, for one version of one document.
 *
 * The store builds these, and so do tests: both go through here so a fixture
 * document behaves exactly like a real one.
 */
export function createParsedDocument(
	document: TextDocument,
	workspaceContext: WorkspaceCatalogContext = {},
): ParsedDocument {
	const source = document.getText();
	const result = parse(source);
	let embedded: EmbeddedDocuments | undefined;

	return {
		uri: document.uri,
		version: document.version,
		document,
		result,
		workspaceContext,
		get embedded(): EmbeddedDocuments {
			embedded ??= createEmbeddedDocuments(
				document.uri,
				document.version,
				source,
				findRegions(result.tokens, source.length),
			);
			return embedded;
		},
	};
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

interface ExternalEntry {
	parsed: ParsedDocument;
	mtimeMs: number;
	size: number;
}

const DEFAULT_PARSE_DELAY_MS = 200;

export class DocumentStore {
	private readonly entries = new Map<string, DocumentEntry>();
	private readonly externalEntries = new Map<string, ExternalEntry>();
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

	getParsedFile(uri: string): ParsedDocument | undefined {
		const open = this.getParsed(uri);
		if (open !== undefined) {
			return open;
		}

		const filePath = uriToFilePath(uri);
		if (filePath === undefined) {
			return undefined;
		}

		try {
			const stat = statSync(filePath);
			const cached = this.externalEntries.get(uri);
			if (
				cached !== undefined &&
				cached.mtimeMs === stat.mtimeMs &&
				cached.size === stat.size
			) {
				return cached.parsed;
			}

			const text = readFileSync(filePath, 'utf8');
			const document = TextDocument.create(uri, 'twig', Math.floor(stat.mtimeMs), text);
			const parsed = createParsedDocument(document, this.resolveWorkspaceContext(uri));
			this.externalEntries.set(uri, { parsed, mtimeMs: stat.mtimeMs, size: stat.size });
			return parsed;
		} catch {
			this.externalEntries.delete(uri);
			return undefined;
		}
	}

	invalidate(uri: string): void {
		this.externalEntries.delete(uri);
		const open = this.entries.get(uri);
		if (open !== undefined) {
			open.stale = true;
		}
	}

	parseNow(uri: string): ParsedDocument {
		const entry = this.entries.get(uri);
		if (entry === undefined) {
			throw new Error(`Cannot parse unopened document: ${uri}`);
		}

		this.clearTimer(uri);
		const parsed = createParsedDocument(entry.document, this.resolveWorkspaceContext(uri));
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
