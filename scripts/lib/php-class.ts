import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePhpParameters, type PhpParameter } from './php';

/**
 * Enough of PHP's class model to walk an API surface.
 *
 * Same bargain as `php.ts`: not a parser, and reading only the shapes the two
 * upstreams actually write — a class header, a docblock, a public declaration.
 * What it adds is the ability to follow one class to the next, because the
 * question "what can a template dot into `craft.app.request`?" is not answerable
 * from `Request.php` alone. Half of what `craft.app.*` offers is declared on a
 * trait, and half of what `craft.app.request.*` offers is Yii's.
 *
 * So every member remembers the class that declared it. That is what decides
 * where its documentation lives (see the language server's `craft-api.ts`), and
 * it is not recoverable afterwards: by the time members are flattened onto one
 * object, a member from a trait and one from the class look identical.
 */

export interface NamespaceRoot {
	/** Namespace prefix, e.g. `craft\`. */
	readonly prefix: string;
	/** Directory it maps to — `<checkout>/src` for `craft\`, PSR-4 style. */
	readonly directory: string;
}

export interface PhpClassMember {
	readonly name: string;
	readonly kind: 'property' | 'method';
	/** Declared type, as written: `Sites`, `string`, `bool`. Absent when untyped. */
	readonly type?: string;
	/** `type` resolved through the file's imports, when it names a class. */
	readonly typeClass?: string;
	readonly parameters: PhpParameter[];
	/** Trailing prose from an `@property`/`@method` line. */
	readonly summary?: string;
	/** The member's own docblock, for callers that extract more from it. */
	readonly docblock?: string;
	readonly declaringClass: string;
	/** True for a fluent setter — `self`, `static` or `$this` back. */
	readonly returnsSelf: boolean;
}

export interface PhpClass {
	readonly fqn: string;
	readonly parent?: string;
	readonly traits: readonly string[];
	/** The class's own docblock, for callers that want its summary. */
	readonly docblock?: string;
	/** Only what this class itself declares. */
	readonly members: readonly PhpClassMember[];
}

export interface MemberWalkOptions {
	/**
	 * Classes to stop at, and never take members from. Yii's object plumbing
	 * (`init()`, `attachBehavior()`, `hasProperty()`) is public and inherited by
	 * everything, and is not API a template author has any use for.
	 */
	readonly stopAt?: ReadonlySet<string>;
}

/** PHP's own type keywords — everything else in type position names a class. */
const BUILTIN_TYPES = new Set([
	'array',
	'bool',
	'callable',
	'false',
	'float',
	'int',
	'iterable',
	'mixed',
	'never',
	'null',
	'object',
	'resource',
	'self',
	'static',
	'string',
	'true',
	'void',
	'$this',
]);

const SELF_TYPES = new Set(['self', 'static', '$this']);

export class PhpClassIndex {
	private readonly roots: readonly NamespaceRoot[];
	private readonly cache = new Map<string, PhpClass | undefined>();

	constructor(roots: readonly NamespaceRoot[]) {
		this.roots = roots;
	}

	/** The class as declared, or undefined when no checked-out root holds it. */
	read(fqn: string): PhpClass | undefined {
		if (this.cache.has(fqn)) {
			return this.cache.get(fqn);
		}
		const parsed = this.parse(fqn);
		this.cache.set(fqn, parsed);
		return parsed;
	}

	/**
	 * Everything `fqn` exposes: its own declarations first, then its traits', then
	 * its parent's. First declaration of a name wins, so a class narrowing an
	 * inherited member keeps its own — and keeps being recorded as the declarer.
	 */
	members(fqn: string, options: MemberWalkOptions = {}): PhpClassMember[] {
		return this.walk(fqn, options, true);
	}

	/**
	 * Only what `fqn` itself brings: its own declarations and its traits'.
	 *
	 * This is the half of `members()` that a class does not share with its parent,
	 * and it is what makes the catalog storable once per declaration. `Entry`,
	 * `Asset` and `User` each inherit the ~200 members of `craft\base\Element`;
	 * flattening those into all three is how the same surface gets paid for three
	 * times, so the catalog stores this and names the parent instead.
	 *
	 * Traits are folded in rather than named, because a trait is not something a
	 * class extends — a class uses several, and the catalog's `extends` is one
	 * link. Folding them costs nothing: a trait is used by one or two classes, and
	 * each member still remembers the trait as its `declaringClass`, which is what
	 * the documentation link is derived from.
	 */
	ownMembers(fqn: string, options: MemberWalkOptions = {}): PhpClassMember[] {
		return this.walk(fqn, options, false);
	}

	/**
	 * The class `fqn` extends, when the walk is allowed to follow it.
	 *
	 * A parent in `stopAt` is not a parent as far as the model is concerned: the
	 * chain is meant to end at Yii's object plumbing, and saying so here keeps the
	 * "where does the walk stop" rule in one place rather than two.
	 */
	parentOf(fqn: string, options: MemberWalkOptions = {}): string | undefined {
		const parent = this.read(fqn)?.parent;
		if (parent === undefined || options.stopAt?.has(parent) === true) {
			return undefined;
		}
		return this.read(parent) === undefined ? undefined : parent;
	}

	private walk(fqn: string, options: MemberWalkOptions, followParent: boolean): PhpClassMember[] {
		const collected: PhpClassMember[] = [];
		const seenNames = new Set<string>();
		const visited = new Set<string>();

		const visit = (current: string): void => {
			if (visited.has(current) || options.stopAt?.has(current) === true) {
				return;
			}
			visited.add(current);

			const parsed = this.read(current);
			if (parsed === undefined) {
				return;
			}

			for (const member of parsed.members) {
				const key = `${member.kind}:${member.name}`;
				if (!seenNames.has(key)) {
					seenNames.add(key);
					collected.push(member);
				}
			}

			for (const trait of parsed.traits) {
				visit(trait);
			}
			if (followParent && parsed.parent !== undefined) {
				visit(parsed.parent);
			}
		};

		visit(fqn);
		return collected;
	}

	private pathFor(fqn: string): string | undefined {
		for (const root of this.roots) {
			if (!fqn.startsWith(root.prefix)) {
				continue;
			}
			const relative = fqn.slice(root.prefix.length).split('\\');
			const path = join(root.directory, ...relative) + '.php';
			if (existsSync(path)) {
				return path;
			}
		}
		return undefined;
	}

	private parse(fqn: string): PhpClass | undefined {
		const path = this.pathFor(fqn);
		if (path === undefined) {
			return undefined;
		}

		const php = readFileSync(path, 'utf8');
		const namespace = /^namespace\s+([^;]+);/m.exec(php)?.[1]?.trim() ?? '';
		const imports = readImports(php);
		const resolve = (name: string): string => resolveClassName(name, imports, namespace);

		const header =
			/^(?:abstract\s+|final\s+|readonly\s+)*(?:class|trait|interface)\s+(\w+)(?:\s+extends\s+([\w\\]+))?/m.exec(
				php,
			);
		if (header === null) {
			return undefined;
		}

		const parent = header[2] === undefined ? undefined : resolve(header[2]);
		const classDocblock = docblockBefore(php, header.index);

		const members = [
			...readDocblockProperties(classDocblock, fqn, resolve),
			...readDocblockMethods(classDocblock, fqn, resolve),
			...readDeclaredProperties(php, fqn, resolve),
			...readDeclaredMethods(php, fqn, resolve),
		];

		return {
			fqn,
			...(parent === undefined ? {} : { parent }),
			traits: readTraitUses(php).map(resolve),
			...(classDocblock === undefined ? {} : { docblock: classDocblock }),
			members,
		};
	}
}

/** `use craft\services\Sites;` and `use yii\web\Request as YiiRequest;`. */
function readImports(php: string): Map<string, string> {
	const imports = new Map<string, string>();

	for (const match of php.matchAll(
		/^use\s+(?!function\s|const\s)([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm,
	)) {
		const [, fqn = '', alias] = match;
		const short = alias ?? fqn.split('\\').pop() ?? fqn;
		imports.set(short, fqn);
	}

	return imports;
}

/**
 * `use ApplicationTrait;` inside a class body.
 *
 * Indentation is what separates these from the file's imports: both are `use`,
 * and only one of them is inside braces. A closure's `use ($foo)` is not a name,
 * so it cannot match.
 */
function readTraitUses(php: string): string[] {
	const traits: string[] = [];

	for (const match of php.matchAll(/^[ \t]+use\s+([\w\\][\w\\,\s]*?)\s*[;{]/gm)) {
		for (const name of (match[1] as string).split(',')) {
			const trimmed = name.trim();
			if (trimmed !== '') {
				traits.push(trimmed);
			}
		}
	}

	return traits;
}

function readDocblockProperties(
	docblock: string | undefined,
	declaringClass: string,
	resolve: (name: string) => string,
): PhpClassMember[] {
	if (docblock === undefined) {
		return [];
	}

	const members: PhpClassMember[] = [];
	// The summary is horizontal whitespace away, never a newline away: `\s*` here
	// matches the line break and lets a property without a summary swallow the
	// next `@property` line as its own — which drops that property entirely, and
	// does it to every other one in a run of them.
	for (const match of docblock.matchAll(
		/@property(?:-read|-write)?\s+([^\s$]+)\s+\$(\w+)[ \t]*([^\n]*)/g,
	)) {
		const [, type = '', name = '', summary = ''] = match;
		members.push(
			member({
				name,
				kind: 'property',
				type,
				declaringClass,
				resolve,
				summary: cleanSummary(summary),
				parameters: [],
			}),
		);
	}
	return members;
}

/** `@method Request getRequest() Returns the request component.` */
function readDocblockMethods(
	docblock: string | undefined,
	declaringClass: string,
	resolve: (name: string) => string,
): PhpClassMember[] {
	if (docblock === undefined) {
		return [];
	}

	const members: PhpClassMember[] = [];
	// `[ \t]*` for the same reason as `@property` above: a `@method` line with no
	// trailing prose must not eat the one under it.
	for (const match of docblock.matchAll(
		/@method\s+(?:static\s+)?([^\s(]+)\s+(\w+)\(([^)]*)\)[ \t]*([^\n]*)/g,
	)) {
		const [, type = '', name = '', parameterSource = '', summary = ''] = match;
		members.push(
			member({
				name,
				kind: 'method',
				type,
				declaringClass,
				resolve,
				summary: cleanSummary(summary),
				parameters: safeParameters(parameterSource),
			}),
		);
	}
	return members;
}

function readDeclaredProperties(
	php: string,
	declaringClass: string,
	resolve: (name: string) => string,
): PhpClassMember[] {
	const members: PhpClassMember[] = [];

	for (const match of php.matchAll(/^[ \t]+public\s+(?:readonly\s+)?([?\w\\|]+)\s+\$(\w+)/gm)) {
		const [, type = '', name = ''] = match;
		const docblock = docblockBefore(php, match.index);
		members.push(
			member({
				name,
				kind: 'property',
				type,
				declaringClass,
				resolve,
				parameters: [],
				...(docblock === undefined ? {} : { docblock }),
			}),
		);
	}

	return members;
}

function readDeclaredMethods(
	php: string,
	declaringClass: string,
	resolve: (name: string) => string,
): PhpClassMember[] {
	const members: PhpClassMember[] = [];

	for (const match of php.matchAll(
		/^[ \t]+public\s+(?:static\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([?\w\\|]+))?\s*[{;]/gm,
	)) {
		const [, name = '', parameterSource = '', type] = match;
		// `__construct`, `__toString`, `__get` — PHP's, never a template's.
		if (name.startsWith('__')) {
			continue;
		}
		const docblock = docblockBefore(php, match.index);
		members.push(
			member({
				name,
				kind: 'method',
				declaringClass,
				resolve,
				parameters: safeParameters(parameterSource),
				...(type === undefined ? {} : { type }),
				...(docblock === undefined ? {} : { docblock }),
			}),
		);
	}

	return members;
}

interface MemberDraft {
	readonly name: string;
	readonly kind: 'property' | 'method';
	readonly type?: string;
	readonly declaringClass: string;
	readonly resolve: (name: string) => string;
	readonly parameters: PhpParameter[];
	readonly summary?: string;
	readonly docblock?: string;
}

function member(draft: MemberDraft): PhpClassMember {
	const primary = draft.type === undefined ? undefined : primaryType(draft.type);
	// `Site[]` is a list of sites, not a site: it names a class but is not one,
	// and dotting into it is Twig's array access rather than a chain of ours.
	const namesClass =
		primary !== undefined && !BUILTIN_TYPES.has(primary) && !primary.endsWith('[]');
	const typeClass = primary !== undefined && namesClass ? draft.resolve(primary) : undefined;

	return {
		name: draft.name,
		kind: draft.kind,
		...(draft.type === undefined ? {} : { type: draft.type.replace(/^\?/, '') }),
		...(typeClass === undefined ? {} : { typeClass }),
		parameters: draft.parameters,
		...(draft.summary === undefined || draft.summary === '' ? {} : { summary: draft.summary }),
		...(draft.docblock === undefined ? {} : { docblock: draft.docblock }),
		declaringClass: draft.declaringClass,
		returnsSelf: primary !== undefined && SELF_TYPES.has(primary),
	};
}

/**
 * The one type a union is worth reporting: `Queue|QueueInterface` is a queue,
 * and `Site|null` is a site. `null` and `false` are what a union says when a
 * lookup can miss, and neither is the type of the thing being looked up.
 */
function primaryType(type: string): string | undefined {
	const parts = type
		.replace(/^\?/, '')
		.split('|')
		.map((part) => part.trim())
		.filter((part) => part !== '' && part !== 'null' && part !== 'false');
	return parts[0];
}

function resolveClassName(
	name: string,
	imports: ReadonlyMap<string, string>,
	namespace: string,
): string {
	const trimmed = name.replace(/^\?/, '').trim();
	if (trimmed.startsWith('\\')) {
		return trimmed.slice(1);
	}

	const [head = '', ...rest] = trimmed.split('\\');
	const imported = imports.get(head);
	if (imported !== undefined) {
		return [imported, ...rest].join('\\');
	}

	return namespace === '' ? trimmed : `${namespace}\\${trimmed}`;
}

/**
 * A docblock is only this member's if nothing but whitespace separates them —
 * otherwise the nearest one belongs to whatever was declared before it.
 *
 * The body is forbidden from containing a docblock terminator, which is what
 * pins the match to the *last* docblock before `index`. Without that it starts
 * at the first one in the file and swallows everything down to the member, which
 * reads as a docblock whose summary and `@since` belong to another declaration.
 */
function docblockBefore(php: string, index: number): string | undefined {
	return /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/.exec(php.slice(0, index))?.[0];
}

/**
 * Docblock signatures are prose as often as they are PHP, and a `@method` line
 * nobody type-checks is not worth failing a generator over — the member is still
 * real, so it keeps its name and loses its arguments.
 */
function safeParameters(parameterSource: string): PhpParameter[] {
	try {
		return parsePhpParameters(parameterSource);
	} catch {
		return [];
	}
}

function cleanSummary(summary: string): string {
	return summary
		.replace(/\*\/\s*$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}
