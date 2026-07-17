import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CompletionItemKind, type CompletionItem, type Range } from 'vscode-languageserver/node';
import type { WorkspaceFolder } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { ProjectContextResolver } from './project-context';
import type { TwigToolboxSettings } from './settings';
import { filePathToUri, isInside, uriToFilePath } from './workspace';

export interface TemplateRoot {
	readonly path: string;
	readonly source: 'setting' | 'craft' | 'symfony' | 'templates' | 'workspace';
}

export interface ResolvedTemplate {
	readonly name: string;
	readonly uri: string;
	readonly path: string;
	readonly root: TemplateRoot;
}

export interface TemplateStringSlot {
	readonly value: string;
	readonly valueRange: { readonly start: number; readonly end: number };
	readonly replace: { readonly start: number; readonly end: number };
}

interface WorkspaceRoot {
	readonly path: string;
}

const TEMPLATE_EXTENSIONS = ['.twig', '.html.twig', '.html'] as const;

/** Files whose contents decide where a project's templates live. */
const INVALIDATING_FILES = new Set([
	'composer.json',
	'composer.lock',
	'bootstrap.php',
	'index.php',
	'craft',
]);

export class TemplateResolver {
	private readonly workspaces: readonly WorkspaceRoot[];
	private readonly projects: ProjectContextResolver;
	private readonly rootCache = new Map<string, readonly TemplateRoot[]>();

	constructor(workspaceFolders: readonly WorkspaceFolder[], projects?: ProjectContextResolver) {
		this.workspaces = workspaceFolders
			.map((folder) => {
				const path = uriToFilePath(folder.uri);
				return path === undefined ? undefined : { path };
			})
			.filter((root): root is WorkspaceRoot => root !== undefined)
			.sort((a, b) => b.path.length - a.path.length);
		this.projects = projects ?? new ProjectContextResolver(workspaceFolders);
	}

	getTemplateRoots(uri: string, settings: TwigToolboxSettings): readonly TemplateRoot[] {
		const workspace = this.workspaceForUri(uri);
		if (workspace === undefined) {
			return [];
		}

		if (settings.templateRoots.length > 0) {
			return settings.templateRoots.map((root) => ({
				path: normalizePath(isAbsolute(root) ? root : resolve(workspace.path, root)),
				source: 'setting',
			}));
		}

		let cached = this.rootCache.get(workspace.path);
		if (cached === undefined) {
			cached = this.detectRoots(workspace.path);
			this.rootCache.set(workspace.path, cached);
		}
		return cached;
	}

	resolve(
		fromUri: string,
		name: string,
		settings: TwigToolboxSettings,
	): readonly ResolvedTemplate[] {
		if (name.startsWith('@') || name.trim() === '') {
			return [];
		}

		const templateName = normalizeTemplateName(name);
		const candidates = candidateNames(templateName);
		const resolved = new Map<string, ResolvedTemplate>();
		for (const root of this.getTemplateRoots(fromUri, settings)) {
			for (const candidate of candidates) {
				const target = normalizePath(resolve(root.path, candidate));
				if (!isInside(target, root.path) || !existsAsFile(target)) {
					continue;
				}
				resolved.set(target, {
					name: this.templateNameForPath(target, root) ?? templateName,
					path: target,
					uri: filePathToUri(target),
					root,
				});
			}
		}
		return [...resolved.values()];
	}

	completions(
		document: TextDocument,
		slot: TemplateStringSlot,
		settings: TwigToolboxSettings,
	): CompletionItem[] {
		if (slot.value.startsWith('@')) {
			return [];
		}

		const valueBeforeReplace = slot.value.slice(0, slot.replace.start - slot.valueRange.start);
		const slash = valueBeforeReplace.lastIndexOf('/');
		const directoryName = slash === -1 ? '' : valueBeforeReplace.slice(0, slash + 1);
		const range: Range = {
			start: document.positionAt(slot.replace.start),
			end: document.positionAt(slot.replace.end),
		};

		const byKey = new Map<string, CompletionItem>();
		for (const root of this.getTemplateRoots(document.uri, settings)) {
			const directory = normalizePath(resolve(root.path, directoryName));
			if (!isInside(directory, root.path) || !existsAsDirectory(directory)) {
				continue;
			}
			for (const entry of safeReadDirectory(directory)) {
				const isDirectory = entry.isDirectory();
				if (!isDirectory && !entry.isFile()) {
					continue;
				}
				const label = isDirectory ? `${entry.name}/` : entry.name;
				const key = `${isDirectory ? '0' : '1'}:${label}`;
				if (byKey.has(key)) {
					continue;
				}
				byKey.set(key, {
					label,
					kind: isDirectory ? CompletionItemKind.Folder : CompletionItemKind.File,
					detail: isDirectory ? 'Template directory' : 'Template',
					sortText: key,
					textEdit: { range, newText: label },
				});
			}
		}
		return [...byKey.values()].sort((a, b) =>
			(a.sortText ?? a.label).localeCompare(b.sortText ?? b.label),
		);
	}

	templateNameForPath(filePath: string, root: TemplateRoot): string | undefined {
		const normalized = normalizePath(filePath);
		if (!isInside(normalized, root.path) || !existsAsFile(normalized)) {
			return undefined;
		}
		const relativePath = relative(root.path, normalized).split(sep).join('/');
		return stripTemplateExtension(relativePath);
	}

	invalidate(uri: string): void {
		this.projects.invalidate(uri);
		const filePath = uriToFilePath(uri);
		if (filePath === undefined) {
			return;
		}
		for (const root of this.workspaces) {
			if (isInside(filePath, root.path) && INVALIDATING_FILES.has(basename(filePath))) {
				this.rootCache.delete(root.path);
			}
		}
	}

	private workspaceForUri(uri: string): WorkspaceRoot | undefined {
		const filePath = uriToFilePath(uri);
		return filePath === undefined
			? undefined
			: this.workspaces.find((root) => isInside(filePath, root.path));
	}

	private detectRoots(workspacePath: string): readonly TemplateRoot[] {
		const project = this.projects.forRoot(workspacePath);
		const templatesPath = normalizePath(resolve(workspacePath, 'templates'));
		if (project.kind === 'craft') {
			return [
				{
					path: readCraftTemplatesPath(workspacePath) ?? templatesPath,
					source: 'craft',
				},
			];
		}
		if (project.composerPackages.includes('symfony/framework-bundle')) {
			return [{ path: templatesPath, source: 'symfony' }];
		}
		if (existsAsDirectory(templatesPath)) {
			return [{ path: templatesPath, source: 'templates' }];
		}
		return [{ path: normalizePath(workspacePath), source: 'workspace' }];
	}
}

function readCraftTemplatesPath(root: string): string | undefined {
	return craftTemplatesPathFromBootstrap(root);
}

/**
 * The `define('CRAFT_TEMPLATES_PATH', …)` override, found by starting from the
 * entry points every Craft project has — the `craft` executable, a root
 * `bootstrap.php`, and `index.php` under the common web roots — and following
 * their `require`s a couple of hops, since the bootstrap itself can live
 * anywhere (`config/craft/bootstrap.php` is real). The expressions are PHP we
 * cannot evaluate, so only the shapes projects actually use are recognised,
 * and a guess is trusted only when the directory it names exists — anything
 * else falls back to `templates/` rather than pointing navigation somewhere
 * wrong.
 */
const ENTRY_CANDIDATES = [
	'craft',
	'bootstrap.php',
	join('web', 'index.php'),
	join('public', 'index.php'),
	join('public_html', 'index.php'),
	join('www', 'index.php'),
];

const MAX_REQUIRE_DEPTH = 2;
const MAX_SCANNED_FILES = 12;

function craftTemplatesPathFromBootstrap(root: string): string | undefined {
	const visited = new Set<string>();
	for (const candidate of ENTRY_CANDIDATES) {
		const found = scanForTemplatesDefine(resolve(root, candidate), root, visited, 0);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function scanForTemplatesDefine(
	filePath: string,
	root: string,
	visited: Set<string>,
	depth: number,
): string | undefined {
	const normalized = normalizePath(filePath);
	if (visited.has(normalized) || visited.size >= MAX_SCANNED_FILES) {
		return undefined;
	}
	visited.add(normalized);

	let source: string;
	try {
		source = readFileSync(normalized, 'utf8');
	} catch {
		return undefined;
	}

	const fileDir = dirname(normalized);
	const basePath = readDefine(source, 'CRAFT_BASE_PATH', root, fileDir, root) ?? root;

	const defined = readDefine(source, 'CRAFT_TEMPLATES_PATH', root, fileDir, basePath);
	if (defined !== undefined && existsAsDirectory(defined)) {
		return defined;
	}

	if (depth >= MAX_REQUIRE_DEPTH) {
		return undefined;
	}
	for (const match of source.matchAll(/require(?:_once)?\s*\(?\s*(.+?)\)?\s*;/g)) {
		const required =
			match[1] === undefined
				? undefined
				: resolvePhpPathExpression(match[1], root, fileDir, basePath);
		if (required === undefined || !required.endsWith('.php') || !isInside(required, root)) {
			continue;
		}
		if (required.split(sep).includes('vendor')) {
			continue;
		}
		const found = scanForTemplatesDefine(required, root, visited, depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

function readDefine(
	source: string,
	constant: string,
	root: string,
	fileDir: string,
	basePath: string,
): string | undefined {
	const match = new RegExp(`define\\(\\s*['"]${constant}['"]\\s*,\\s*(.+?)\\)\\s*;`).exec(source);
	return match?.[1] === undefined
		? undefined
		: resolvePhpPathExpression(match[1], root, fileDir, basePath);
}

function resolvePhpPathExpression(
	expression: string,
	root: string,
	fileDir: string,
	basePath: string,
): string | undefined {
	const trimmed = expression.trim();
	const literal = /^['"]([^'"]+)['"]$/.exec(trimmed);
	if (literal?.[1] !== undefined) {
		return normalizePath(isAbsolute(literal[1]) ? literal[1] : resolve(root, literal[1]));
	}
	const bare = /^(CRAFT_BASE_PATH|__DIR__|dirname\(\s*__DIR__\s*(?:,\s*(\d+)\s*)?\))$/.exec(
		trimmed,
	);
	if (bare !== null) {
		return normalizePath(phpBase(bare[0], bare[2], fileDir, basePath));
	}
	const concat =
		/^(CRAFT_BASE_PATH|__DIR__|dirname\(\s*__DIR__\s*(?:,\s*(\d+)\s*)?\))\s*\.\s*['"]([^'"]+)['"]$/.exec(
			trimmed,
		);
	if (concat?.[1] === undefined || concat[3] === undefined) {
		return undefined;
	}
	return normalizePath(join(phpBase(concat[1], concat[2], fileDir, basePath), concat[3]));
}

function phpBase(
	expression: string,
	dirnameLevels: string | undefined,
	fileDir: string,
	basePath: string,
): string {
	if (expression === 'CRAFT_BASE_PATH') {
		return basePath;
	}
	if (expression === '__DIR__') {
		return fileDir;
	}
	let base = fileDir;
	for (let level = Number(dirnameLevels ?? '1'); level > 0; level--) {
		base = dirname(base);
	}
	return base;
}

function candidateNames(name: string): string[] {
	const names = new Set<string>([name]);
	if (!hasTemplateExtension(name)) {
		for (const extension of TEMPLATE_EXTENSIONS) {
			names.add(`${name}${extension}`);
		}
		for (const extension of TEMPLATE_EXTENSIONS) {
			names.add(`${name}/index${extension}`);
		}
	}
	return [...names];
}

function hasTemplateExtension(name: string): boolean {
	return (
		TEMPLATE_EXTENSIONS.some((extension) => name.endsWith(extension)) || extname(name) !== ''
	);
}

function stripTemplateExtension(name: string): string {
	for (const extension of TEMPLATE_EXTENSIONS) {
		if (name.endsWith(extension)) {
			return name.slice(0, -extension.length);
		}
	}
	return name;
}

function normalizeTemplateName(name: string): string {
	return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizePath(path: string): string {
	return resolve(path);
}

function existsAsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function existsAsDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function safeReadDirectory(path: string): Dirent[] {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
}
