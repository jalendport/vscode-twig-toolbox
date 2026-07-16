import {
	visit,
	type EmbedTag,
	type Expression,
	type ForTag,
	type ImportTag,
	type FromTag,
	type MacroParam,
	type MacroTag,
	type SetTag,
	type SourceRange,
	type TagNode,
	type Template,
	type TemplateChild,
	type WithTag,
} from '@twig-toolbox/parser';
import { regionAt, type TwigRegion } from './regions';

/**
 * Per-document symbol table: what names exist, and where they mean anything.
 *
 * Twig's context is flat — `{% set %}` inside an `{% if %}` is still set after
 * the `{% endif %}` — except at the walls, where a fresh context replaces the
 * inherited one. Walls are macro bodies (a macro sees only its arguments) and
 * `only` on `{% with %}`/`{% embed %}`. Loop variables are the one construct
 * genuinely popped at its own end, so they scope to their `{% for %}` and no
 * further.
 */

export type TwigSymbolKind =
	'variable' | 'loop-variable' | 'loop' | 'parameter' | 'macro' | 'macro-namespace';

export interface TwigSymbol {
	readonly name: string;
	readonly kind: TwigSymbolKind;
	/** Offsets over which the name resolves to this definition. */
	readonly scope: SourceRange;
	/** Innermost wall enclosing the definition; 0 is the template itself. */
	readonly wall: number;
	/** Short right-hand summary, e.g. a macro signature or the loop sequence. */
	readonly detail?: string;
	/** Key member providers resolve members against — see `members.ts`. */
	readonly typeName?: string;
}

export interface MacroDefinition {
	readonly name: string;
	/** `button(label, url = '#')`, ready for a detail line. */
	readonly signature: string;
	readonly params: readonly MacroParam[];
	readonly range: SourceRange;
}

export interface BlockDefinition {
	readonly name: string;
	readonly range: SourceRange;
}

export interface SymbolTable {
	/** Symbols in scope at `offset`, innermost definition per name. */
	visibleAt(offset: number): TwigSymbol[];
	/** The symbol a bare name resolves to at `offset`, if any. */
	resolve(name: string, offset: number): TwigSymbol | undefined;
	readonly macros: readonly MacroDefinition[];
	readonly blocks: readonly BlockDefinition[];
}

interface Wall {
	readonly id: number;
	readonly range: SourceRange;
}

interface WalkState {
	/** Innermost wall enclosing the nodes being walked. */
	readonly wall: number;
	/** End of that wall — how far a `{% set %}` here can reach. */
	readonly wallEnd: number;
}

class Collector {
	readonly symbols: TwigSymbol[] = [];
	readonly blocks: BlockDefinition[] = [];
	readonly walls: Wall[] = [];
	private nextWall = 1;

	constructor(
		private readonly source: string,
		private readonly regions: readonly TwigRegion[],
		/** Pre-collected: `{% from _self import x %}` may precede the macro. */
		readonly macros: readonly MacroDefinition[],
	) {}

	/** End of a tag's `{% … %}` header — where its body, and its scopes, begin. */
	private headerEnd(tag: TagNode): number {
		return regionAt(this.regions, tag.start)?.end ?? tag.start;
	}

	private openWall(range: SourceRange): number {
		const id = this.nextWall++;
		this.walls.push({ id, range });
		return id;
	}

	private add(symbol: TwigSymbol): void {
		this.symbols.push(symbol);
	}

	walk(children: readonly TemplateChild[], state: WalkState): void {
		for (const child of children) {
			if (child.type !== 'Text' && child.type !== 'Output' && child.type !== 'Comment') {
				this.tag(child, state);
			}
		}
	}

	private tag(tag: TagNode, state: WalkState): void {
		switch (tag.type) {
			case 'ForTag':
				return this.forTag(tag, state);
			case 'SetTag':
				return this.setTag(tag, state);
			case 'MacroTag':
				return this.macroTag(tag);
			case 'WithTag':
			case 'EmbedTag':
				return this.scopedBody(tag, state);
			case 'ImportTag':
				return this.importTag(tag, state);
			case 'FromTag':
				return this.fromTag(tag, state);
			case 'BlockTag':
				this.blocks.push({
					name: tag.blockName?.name ?? '',
					range: { start: tag.start, end: tag.end },
				});
				return this.walk(tag.body ?? [], state);
			case 'IfTag':
				for (const branch of tag.branches) {
					this.walk(branch.body, state);
				}
				return;
			case 'ApplyTag':
			case 'AutoescapeTag':
				return this.walk(tag.body, state);
			case 'GenericTag':
				return this.walk(tag.body ?? [], state);
			default:
				return;
		}
	}

	private forTag(tag: ForTag, state: WalkState): void {
		const scope: SourceRange = { start: this.headerEnd(tag), end: tag.end };
		const sequence = tag.sequence === undefined ? '' : this.text(tag.sequence);
		for (const target of [tag.keyTarget, tag.valueTarget]) {
			if (target !== undefined) {
				this.add({
					name: target.name,
					kind: 'loop-variable',
					scope,
					wall: state.wall,
					...(sequence === '' ? {} : { detail: `for … in ${sequence}` }),
				});
			}
		}
		this.add({ name: 'loop', kind: 'loop', scope, wall: state.wall, typeName: 'loop' });
		this.walk(tag.body, state);
		this.walk(tag.elseBody ?? [], state);
	}

	private setTag(tag: SetTag, state: WalkState): void {
		// A `set` is live from its own end — including past `{% endset %}` for the
		// body form — to the end of the enclosing wall.
		const scope: SourceRange = { start: tag.end, end: state.wallEnd };
		tag.targets.forEach((target, at) => {
			const value = tag.values[at];
			this.add({
				name: target.name,
				kind: 'variable',
				scope,
				wall: state.wall,
				...(value === undefined ? {} : { detail: `= ${this.text(value)}` }),
			});
		});
		this.walk(tag.body ?? [], state);
	}

	/** Always opens a wall, whatever encloses it — hence no incoming state. */
	private macroTag(tag: MacroTag): void {
		const body: SourceRange = { start: this.headerEnd(tag), end: tag.end };
		const wall = this.openWall(body);
		for (const param of tag.params) {
			this.add({
				name: param.name.name,
				kind: 'parameter',
				scope: body,
				wall,
				...(param.default === undefined ? {} : { detail: `= ${this.text(param.default)}` }),
			});
		}
		this.walk(tag.body, { wall, wallEnd: tag.end });
	}

	/** `{% with %}` and `{% embed %}`: shared shape, and `only` walls off the body. */
	private scopedBody(tag: WithTag | EmbedTag, state: WalkState): void {
		const range: SourceRange = { start: this.headerEnd(tag), end: tag.end };
		const wall = tag.only ? this.openWall(range) : state.wall;
		if (tag.variables?.type === 'HashLiteral') {
			for (const entry of tag.variables.entries) {
				const name = entry.type === 'HashEntry' ? hashKeyName(entry.key) : undefined;
				if (name !== undefined) {
					this.add({ name, kind: 'variable', scope: range, wall });
				}
			}
		}
		this.walk(tag.body, { wall, wallEnd: tag.only ? tag.end : state.wallEnd });
	}

	private importTag(tag: ImportTag, state: WalkState): void {
		if (tag.alias === undefined) {
			return;
		}
		const template = tag.template;
		this.add({
			name: tag.alias.name,
			kind: 'macro-namespace',
			scope: { start: tag.end, end: state.wallEnd },
			wall: state.wall,
			detail: template === undefined ? 'macros' : `macros from ${this.text(template)}`,
			// Cross-template macros need the loader from milestone 08; `_self`
			// resolves against this document's own macros today.
			...(isSelf(template) ? { typeName: 'macros:_self' } : {}),
		});
	}

	private fromTag(tag: FromTag, state: WalkState): void {
		const local = isSelf(tag.template);
		for (const imported of tag.imports) {
			const name = imported.alias?.name ?? imported.macroName?.name;
			if (name === undefined) {
				continue;
			}
			const macro = local
				? this.macros.find((candidate) => candidate.name === imported.macroName?.name)
				: undefined;
			this.add({
				name,
				kind: 'macro',
				scope: { start: tag.end, end: state.wallEnd },
				wall: state.wall,
				detail: macro?.signature ?? `${name}()`,
			});
		}
	}

	private text(node: { start: number; end: number }): string {
		return this.source.slice(node.start, node.end);
	}
}

/**
 * Macro definitions, gathered before the scope walk: `{% from _self import x %}`
 * is free to appear above the `{% macro x %}` it names.
 */
function collectMacros(template: Template, source: string): MacroDefinition[] {
	const macros: MacroDefinition[] = [];
	visit(template, (node) => {
		if (node.type !== 'MacroTag' || node.macroName === undefined) {
			return;
		}
		macros.push({
			name: node.macroName.name,
			signature: macroSignature(node.macroName.name, node.params, source),
			params: node.params,
			range: { start: node.start, end: node.end },
		});
	});
	return macros;
}

function macroSignature(name: string, params: readonly MacroParam[], source: string): string {
	const rendered = params.map((param) =>
		param.default === undefined
			? param.name.name
			: `${param.name.name} = ${source.slice(param.default.start, param.default.end)}`,
	);
	return `${name}(${rendered.join(', ')})`;
}

function hashKeyName(key: Expression | undefined): string | undefined {
	if (key?.type === 'Identifier') {
		return key.name;
	}
	return key?.type === 'StringLiteral' && key.parts.length <= 1 ? key.value : undefined;
}

function isSelf(template: Expression | undefined): boolean {
	return template?.type === 'Identifier' && template.name === '_self';
}

export function collectSymbols(
	template: Template,
	source: string,
	regions: readonly TwigRegion[],
): SymbolTable {
	const collector = new Collector(source, regions, collectMacros(template, source));
	collector.walk(template.body, { wall: 0, wallEnd: template.end });

	const wallAt = (offset: number): number => {
		let innermost = 0;
		for (const wall of collector.walls) {
			if (wall.range.start <= offset && offset <= wall.range.end) {
				innermost = wall.id;
			}
		}
		return innermost;
	};

	const visibleAt = (offset: number): TwigSymbol[] => {
		const wall = wallAt(offset);
		const byName = new Map<string, TwigSymbol>();
		for (const symbol of collector.symbols) {
			if (
				symbol.wall === wall &&
				symbol.scope.start <= offset &&
				offset <= symbol.scope.end
			) {
				// Later definitions shadow earlier ones: `{% set x = 1 %}{% set x = 2 %}`.
				byName.set(symbol.name, symbol);
			}
		}
		return [...byName.values()];
	};

	return {
		visibleAt,
		resolve: (name, offset) => visibleAt(offset).find((symbol) => symbol.name === name),
		macros: collector.macros,
		blocks: collector.blocks,
	};
}
