import {
	nodePathAt,
	type AnyNode,
	type Expression,
	type SourceRange,
	type TagNode,
	type Token,
} from '@twig-toolbox/parser';
import type { ParsedDocument } from './document-store';
import { findRegions, regionAt, tokenAt, type TwigRegion } from './regions';

/**
 * Where the cursor is, in Twig's terms.
 *
 * Classification runs off the parser's own output — the recovered AST for
 * structure, the token stream for regions and for the exact slot a name goes
 * in. It never reads the line as text: a half-typed `{{ user. }}` is a
 * `MemberAccess` with a hole in it, and the hole is the answer. When a context
 * comes out wrong, the fix belongs in parser recovery, not here.
 */

export type CompletionContextKind =
	| 'tag-name'
	| 'end-tag'
	| 'filter'
	| 'function-call'
	| 'test'
	| 'expression'
	| 'member-access'
	| 'hash-key'
	| 'named-argument'
	| 'template-string'
	| 'block-name'
	| 'none';

/** A block tag still waiting for its `end…`, innermost first. */
export interface OpenTag {
	readonly name: string;
	readonly endName: string;
}

/** What a named argument would be an argument to. */
export interface ArgumentOwner {
	readonly kind: 'functions' | 'filters' | 'tests';
	readonly name: string;
}

interface Slot {
	/** Range a chosen item replaces. */
	readonly replace: SourceRange;
}

export type CompletionContext =
	| { readonly kind: 'none' }
	| (Slot & {
			readonly kind: 'tag-name' | 'end-tag';
			readonly region: TwigRegion;
			/** Where the tag name itself sits, for filtering. */
			readonly nameSlot: SourceRange;
			readonly openTags: readonly OpenTag[];
	  })
	| (Slot & { readonly kind: 'filter' | 'test' | 'function-call' | 'expression' })
	| (Slot & { readonly kind: 'member-access'; readonly object: Expression })
	| (Slot & { readonly kind: 'hash-key' })
	| (Slot & { readonly kind: 'named-argument'; readonly owner: ArgumentOwner | undefined })
	| (Slot & { readonly kind: 'template-string' })
	| (Slot & { readonly kind: 'block-name' });

/** Identifiers that bind a new name rather than reference an existing one. */
function isBindingSlot(parent: AnyNode, child: AnyNode): boolean {
	switch (parent.type) {
		case 'ForTag':
			return child === parent.keyTarget || child === parent.valueTarget;
		case 'SetTag':
			return parent.targets.some((target) => target === child);
		case 'BlockTag':
			return child === parent.blockName || child === parent.endName;
		case 'MacroTag':
			return child === parent.macroName;
		case 'MacroParam':
			return child === parent.name;
		case 'FromImport':
			return child === parent.macroName || child === parent.alias;
		case 'UseAlias':
			return child === parent.original || child === parent.alias;
		case 'ImportTag':
			return child === parent.alias;
		default:
			return false;
	}
}

/**
 * True when `offset` sits in the gap a missing name left behind.
 *
 * `opener` is the token that introduced the slot — the `|`, the `.`, the `is`.
 * A word opener needs a separator before the name can start, so the cursor must
 * clear its end; punctuation does not, which is what makes `{{ x|‸ }}` a filter
 * slot while `{% if x is‸ %}` is not yet a test slot.
 */
function inHole(opener: Token | undefined, holeEnd: number, offset: number): boolean {
	if (opener === undefined) {
		return false;
	}
	const start = opener.kind === 'name' ? opener.end + 1 : opener.end;
	return offset >= start && offset <= holeEnd;
}

/** Last token in `range` matching `values`, e.g. the `is`/`not` before a test. */
function findToken(
	region: TwigRegion,
	range: SourceRange,
	kind: Token['kind'],
	values: readonly string[],
): Token | undefined {
	let found: Token | undefined;
	for (const token of region.tokens) {
		if (token.start >= range.start && token.end <= range.end) {
			if (token.kind === kind && values.includes(token.value)) {
				found = token;
			}
		}
	}
	return found;
}

/**
 * Whether the cursor is on a node's name, rather than merely somewhere in it.
 * Compared by identity, and never satisfied by a name that isn't there: two
 * `undefined`s are not a match.
 */
function isNameChild(child: AnyNode | undefined, name: AnyNode | undefined): boolean {
	return child !== undefined && child === name;
}

/** The word under the cursor, or a caret where a word would go. */
function wordSlot(region: TwigRegion, offset: number): SourceRange {
	const token = tokenAt(region, offset);
	return token?.kind === 'name'
		? { start: token.start, end: token.end }
		: { start: offset, end: offset };
}

/** Block tags enclosing `offset` that have no `end…` yet, innermost first. */
function openTagsAt(path: readonly AnyNode[], regions: readonly TwigRegion[]): OpenTag[] {
	const open: OpenTag[] = [];
	for (const node of path) {
		if (!isBlockTag(node) || isClosed(node, regions)) {
			continue;
		}
		open.unshift({ name: node.name, endName: `end${node.name}` });
	}
	return open;
}

function isBlockTag(node: AnyNode): node is TagNode & { name: string } {
	switch (node.type) {
		case 'ForTag':
		case 'IfTag':
		case 'MacroTag':
		case 'EmbedTag':
		case 'ApplyTag':
		case 'AutoescapeTag':
		case 'WithTag':
			return true;
		case 'BlockTag':
		case 'SetTag':
			return node.body !== undefined;
		case 'GenericTag':
			return node.body !== undefined;
		default:
			return false;
	}
}

/**
 * Whether a block tag actually reached its `end…`.
 *
 * Read off the source rather than the error list: a tag that closed properly
 * ends with its own end tag, and one the parser auto-closed at EOF or at an
 * enclosing boundary does not. `{% for %}…{% endif %}` counts as unclosed,
 * which is the honest answer — the `for` never got its `endfor`.
 */
function isClosed(tag: TagNode & { name: string }, regions: readonly TwigRegion[]): boolean {
	const region = regionAt(regions, Math.max(tag.start, tag.end - 1));
	if (region === undefined || region.kind !== 'block' || region.start === tag.start) {
		return false;
	}
	const first = region.tokens[0];
	return first?.kind === 'name' && first.value === `end${tag.name}`;
}

/** `{% ‸ %}` and `{% fo‸ %}`: the tag name is always the region's first token. */
function tagNameSlot(region: TwigRegion, offset: number): SourceRange | undefined {
	const first = region.tokens[0];
	if (first === undefined || offset < first.start) {
		return { start: offset, end: offset };
	}
	return first.kind === 'name' && offset <= first.end
		? { start: first.start, end: first.end }
		: undefined;
}

export function classifyCompletion(parsed: ParsedDocument, offset: number): CompletionContext {
	const { template, tokens, source } = parsed.result;
	const regions = findRegions(tokens, source.length);
	const region = regionAt(regions, offset);

	// Raw HTML, comments and verbatim bodies are not Twig; nor is a cursor
	// wedged inside `{{`, `%}` or any other delimiter.
	if (
		region === undefined ||
		region.kind === 'text' ||
		region.kind === 'comment' ||
		offset < region.contentStart ||
		offset > region.contentEnd
	) {
		return { kind: 'none' };
	}

	const path = nodePathAt(template, offset);

	if (region.kind === 'block') {
		const nameSlot = tagNameSlot(region, offset);
		if (nameSlot !== undefined) {
			const typed = source.slice(nameSlot.start, offset);
			return {
				kind: typed.startsWith('end') ? 'end-tag' : 'tag-name',
				region,
				nameSlot,
				replace: { start: region.contentStart, end: region.contentEnd },
				openTags: openTagsAt(path, regions),
			};
		}
	}

	return classifyExpression(path, region, offset) ?? tagFallback(path, region, offset);
}

/**
 * Walks the AST path outwards from the cursor; the first construct that owns
 * the offset decides. Returns undefined when nothing claims it, leaving the
 * enclosing tag to have the last word.
 */
function classifyExpression(
	path: readonly AnyNode[],
	region: TwigRegion,
	offset: number,
): CompletionContext | undefined {
	const replace = wordSlot(region, offset);

	for (let at = path.length - 1; at >= 0; at--) {
		const node = path[at] as AnyNode;
		const child = path[at + 1];

		if (child !== undefined && isBindingSlot(node, child)) {
			return { kind: 'none' };
		}

		switch (node.type) {
			// A `#{ … }` hole is an expression again, whatever string encloses it.
			case 'Interpolation':
				return { kind: 'expression', replace };

			case 'MemberAccess': {
				if (node.computed) {
					break;
				}
				const dot = findToken(
					region,
					{ start: node.object.end, end: node.end },
					'punctuation',
					['.'],
				);
				if (isNameChild(child, node.property) || inHole(dot, node.end, offset)) {
					return { kind: 'member-access', object: node.object, replace };
				}
				break;
			}

			case 'FilterExpression': {
				const pipe = findToken(
					region,
					{ start: node.target.end, end: node.end },
					'punctuation',
					['|'],
				);
				if (isNameChild(child, node.name) || inHole(pipe, node.end, offset)) {
					return { kind: 'filter', replace };
				}
				if (node.name !== undefined && offset > node.name.end) {
					return argumentContext(namedOwner('filters', node.name.name), replace);
				}
				break;
			}

			case 'ApplyFilter':
				if (isNameChild(child, node.name)) {
					return { kind: 'filter', replace };
				}
				break;

			case 'TestExpression': {
				const is = findToken(region, { start: node.target.end, end: node.end }, 'name', [
					'is',
					'not',
				]);
				if (isNameChild(child, node.name) || inHole(is, node.end, offset)) {
					return { kind: 'test', replace };
				}
				if (node.name !== undefined && offset > node.name.end) {
					return argumentContext(namedOwner('tests', node.name.name), replace);
				}
				break;
			}

			case 'CallExpression':
				if (child === node.callee) {
					return { kind: 'function-call', replace };
				}
				if (offset > node.callee.end) {
					return argumentContext(
						namedOwner(
							'functions',
							node.callee.type === 'Identifier' ? node.callee.name : undefined,
						),
						replace,
					);
				}
				break;

			case 'Argument':
				// A bare word in an argument slot is still ambiguous: it could be
				// finishing a value, or starting `name=`. Offer both.
				if (
					child !== undefined &&
					(child === node.name || (child === node.value && child.type === 'Identifier'))
				) {
					return argumentContext(ownerOf(path, at), replace);
				}
				break;

			case 'HashEntry':
				if (child === node.key) {
					return { kind: 'hash-key', replace };
				}
				break;

			case 'HashLiteral':
				return { kind: 'hash-key', replace };

			case 'StringLiteral':
				return stringContext(path, at, offset);

			default:
				break;
		}
	}

	return undefined;
}

/** Rebuilds an argument owner from a path index, for `Argument` nodes. */
function ownerOf(path: readonly AnyNode[], at: number): ArgumentOwner | undefined {
	const parent = path[at - 1];
	if (parent?.type === 'CallExpression') {
		return parent.callee.type === 'Identifier'
			? { kind: 'functions', name: parent.callee.name }
			: undefined;
	}
	if (parent?.type === 'FilterExpression' && parent.name !== undefined) {
		return { kind: 'filters', name: parent.name.name };
	}
	if (parent?.type === 'TestExpression' && parent.name !== undefined) {
		return { kind: 'tests', name: parent.name.name };
	}
	return undefined;
}

function argumentContext(
	owner: ArgumentOwner | undefined,
	replace: SourceRange,
): CompletionContext {
	return { kind: 'named-argument', owner, replace };
}

function namedOwner(
	kind: ArgumentOwner['kind'],
	name: string | undefined,
): ArgumentOwner | undefined {
	return name === undefined ? undefined : { kind, name };
}

/**
 * String literals are opaque by default — `{{ "hello ‸" }}` is prose, not code.
 * Two positions are not: a template path (milestone 08 fills these in) and the
 * name argument of `block()`.
 */
function stringContext(path: readonly AnyNode[], at: number, offset: number): CompletionContext {
	const literal = path[at];
	if (literal?.type !== 'StringLiteral' || offset <= literal.start || offset >= literal.end) {
		return { kind: 'none' };
	}
	const inner: SourceRange = { start: literal.start + 1, end: literal.end - 1 };

	const parent = path[at - 1];
	if (parent !== undefined && isTemplateRef(parent, literal)) {
		return { kind: 'template-string', replace: inner };
	}

	const owner = ownerOf(path, at - 1);
	if (parent?.type === 'Argument' && owner?.kind === 'functions' && owner.name === 'block') {
		return { kind: 'block-name', replace: inner };
	}
	return { kind: 'none' };
}

function isTemplateRef(parent: AnyNode, literal: AnyNode): boolean {
	switch (parent.type) {
		case 'IncludeTag':
		case 'ExtendsTag':
		case 'EmbedTag':
		case 'ImportTag':
		case 'FromTag':
		case 'UseTag':
			return parent.template === literal;
		default:
			return false;
	}
}

/**
 * Last resort for a block region the AST did not claim: the tag itself decides
 * what an unexplained offset in its header means.
 */
function tagFallback(
	path: readonly AnyNode[],
	region: TwigRegion,
	offset: number,
): CompletionContext {
	const replace = wordSlot(region, offset);
	if (region.kind !== 'block') {
		return { kind: 'expression', replace };
	}

	const tag = enclosingTag(path, region);
	if (tag === undefined) {
		return { kind: 'expression', replace };
	}

	switch (tag.type) {
		// `{% apply upper|‸ %}` — the header is a filter chain, not an expression.
		case 'ApplyTag':
			return { kind: 'filter', replace };
		// Binding zones: nothing existing belongs in a name being declared.
		case 'ForTag':
			return bindingZone(region, offset, 'name', ['in'])
				? { kind: 'none' }
				: { kind: 'expression', replace };
		case 'SetTag':
			return bindingZone(region, offset, 'operator', ['='])
				? { kind: 'none' }
				: { kind: 'expression', replace };
		case 'MacroTag':
			return { kind: 'none' };
		case 'BlockTag':
			return bindingZone(region, offset, 'name', [], 1)
				? { kind: 'none' }
				: { kind: 'expression', replace };
		default:
			return { kind: 'expression', replace };
	}
}

/**
 * True while `offset` is still before the token that ends a tag's binding list —
 * the `in` of a `for`, the `=` of a `set`. With no such token the whole header
 * is still bindings.
 */
function bindingZone(
	region: TwigRegion,
	offset: number,
	kind: Token['kind'],
	values: readonly string[],
	skip = 0,
): boolean {
	const candidates = region.tokens.filter(
		(token) => token.kind === kind && (values.length === 0 || values.includes(token.value)),
	);
	// `skip` steps over the tag name itself, which is a `name` token too.
	const marker = candidates[skip];
	if (marker === undefined) {
		return true;
	}
	return kind === 'name' ? offset <= marker.end : offset < marker.end;
}

/** The tag whose header is this region — the innermost one starting with it. */
function enclosingTag(path: readonly AnyNode[], region: TwigRegion): TagNode | undefined {
	for (let at = path.length - 1; at >= 0; at--) {
		const node = path[at];
		if (node !== undefined && 'nameRange' in node && node.start === region.start) {
			return node;
		}
	}
	return undefined;
}

export { findRegions, regionAt };
