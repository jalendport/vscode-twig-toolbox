import type {
	ApplyFilter,
	Argument,
	Expression,
	Identifier,
	IfBranch,
	MacroParam,
	SourceRange,
	TagNode,
	Template,
	TemplateChild,
	UseAlias,
	FromImport,
} from './ast';
import type { ParseError } from './errors';
import { ExpressionParser } from './expressions';
import { tokenize } from './lexer';
import type { Token } from './tokens';

export interface ParseResult {
	readonly template: Template;
	readonly errors: readonly ParseError[];
	readonly tokens: readonly Token[];
	readonly source: string;
}

/** How a body ended: at EOF, or at a tag someone is waiting for. */
type BodyStop = { kind: 'eof' } | { kind: 'tag'; name: string; claimedByOuter: boolean };

interface BodyResult {
	body: TemplateChild[];
	stop: BodyStop;
}

interface TagContext {
	open: Token;
	name: string;
	nameRange: SourceRange;
}

/**
 * Core tags that always take a body but have no shape worth a dedicated node —
 * they parse as `GenericTag`. Listing them means a missing end tag is reported
 * even when no `end<name>` exists anywhere in the document.
 */
const KNOWN_BLOCK_TAGS = new Set(['sandbox', 'cache', 'guard']);

/** Words that cannot be loop variables, however name-like the lexer finds them. */
const FOR_RESERVED = new Set(['in']);

/**
 * Deepest tag nesting parsed before recovery flattens the rest. Each level of
 * `{% if %}{% if %}…` costs a handful of stack frames, so unbounded nesting
 * overflows the call stack and breaks the "parse never throws" contract. Past
 * the cap, deeper tags parse as unclosed siblings — degraded, but total.
 */
const MAX_TAG_DEPTH = 250;

class Parser extends ExpressionParser {
	private readonly stopStack: Set<string>[] = [];

	parseTemplate(): Template {
		const { body } = this.parseBody();
		return { type: 'Template', body, start: 0, end: this.source.length };
	}

	// --- Body -------------------------------------------------------------

	private parseBody(): BodyResult {
		const body: TemplateChild[] = [];
		for (;;) {
			const token = this.current;
			switch (token.kind) {
				case 'eof':
					return { body, stop: { kind: 'eof' } };
				case 'text':
				case 'raw':
					this.advance();
					body.push({
						type: 'Text',
						value: token.value,
						start: token.start,
						end: token.end,
					});
					continue;
				case 'comment-start':
					body.push(this.parseComment());
					continue;
				case 'var-start':
					body.push(this.parseOutput());
					continue;
				case 'block-start': {
					const name = this.peekTagName();
					if (name !== undefined) {
						const claim = this.classifyTag(name);
						if (claim !== 'none') {
							return {
								body,
								stop: { kind: 'tag', name, claimedByOuter: claim === 'outer' },
							};
						}
					}
					body.push(this.parseTag());
					continue;
				}
				default:
					// Leftovers from lexer recovery; never part of a well-formed stream.
					this.error(
						'unexpected-token',
						`Unexpected ${JSON.stringify(token.value)}.`,
						token.start,
						token.end,
					);
					this.advance();
					continue;
			}
		}
	}

	/**
	 * Decides who a tag belongs to. `own` means the innermost open tag should
	 * stop here; `outer` means an enclosing tag is waiting for it, so the
	 * innermost one is unclosed. An `end*` tag nobody claims is handed to the
	 * innermost tag, which reports it as mismatched — that is what makes
	 * `{% for %}…{% endif %}` recover instead of cascading.
	 */
	private classifyTag(name: string): 'own' | 'outer' | 'none' {
		const depth = this.stopStack.length;
		if (depth === 0) {
			return 'none';
		}
		if (this.stopStack[depth - 1]?.has(name) === true) {
			return 'own';
		}
		for (let at = depth - 2; at >= 0; at--) {
			if (this.stopStack[at]?.has(name) === true) {
				return 'outer';
			}
		}
		return name.startsWith('end') ? 'own' : 'none';
	}

	private parseTagBody(stops: string[]): BodyResult {
		if (this.stopStack.length >= MAX_TAG_DEPTH) {
			// Pretend the body ended at EOF without consuming anything: closeTag
			// records the missing end tag, and the enclosing body loop keeps
			// consuming tokens, so deeper tags become flat siblings instead of
			// stack frames.
			this.missing('nesting-too-deep', 'Tags are nested too deeply.', this.current.start);
			return { body: [], stop: { kind: 'eof' } };
		}
		this.stopStack.push(new Set(stops));
		try {
			return this.parseBody();
		} finally {
			this.stopStack.pop();
		}
	}

	private peekTagName(): string | undefined {
		const token = this.peek(1);
		return token.kind === 'name' ? token.value : undefined;
	}

	// --- Leaves -----------------------------------------------------------

	private parseComment(): TemplateChild {
		const open = this.advance();
		const text = this.accept('comment-text');
		const close = this.accept('comment-end');
		return {
			type: 'Comment',
			value: text?.value ?? '',
			start: open.start,
			end: close?.end ?? this.previousEnd(),
		};
	}

	private parseOutput(): TemplateChild {
		const open = this.advance();
		const expression = this.parseExpression();
		const end = this.expectRegionEnd('var-end');
		return { type: 'Output', expression, start: open.start, end: end ?? this.previousEnd() };
	}

	/**
	 * Consumes the closing delimiter of a region, reporting anything left over
	 * before it. Returns undefined when the lexer never found one — it has
	 * already reported the unterminated region in that case.
	 */
	private expectRegionEnd(kind: 'var-end' | 'block-end'): number | undefined {
		if (!this.test(kind)) {
			const start = this.current.start;
			let end = start;
			while (!this.test(kind) && !this.atBoundary()) {
				end = this.advance().end;
			}
			if (end > start) {
				this.error(
					'unexpected-token',
					`Unexpected ${JSON.stringify(this.source.slice(start, end))} here.`,
					start,
					end,
				);
			}
		}
		return this.accept(kind)?.end;
	}

	// --- Tags -------------------------------------------------------------

	private parseTag(): TagNode {
		const open = this.advance();
		const nameToken = this.accept('name');
		if (nameToken === undefined) {
			this.missing('missing-tag-name', 'Expected a tag name after "{%".', open.end);
			// `{% ` — the hole where the name belongs is the whole point of this
			// node; stopping at `{%` would leave the cursor outside the tree.
			const end = this.expectRegionEnd('block-end') ?? this.holeEnd(this.previousEnd());
			return {
				type: 'GenericTag',
				name: '',
				nameRange: { start: open.end, end: open.end },
				args: [],
				body: undefined,
				start: open.start,
				end,
			};
		}

		const ctx: TagContext = {
			open,
			name: nameToken.value,
			nameRange: { start: nameToken.start, end: nameToken.end },
		};

		switch (ctx.name) {
			case 'if':
				return this.parseIf(ctx);
			case 'for':
				return this.parseFor(ctx);
			case 'set':
				return this.parseSet(ctx);
			case 'block':
				return this.parseBlock(ctx);
			case 'macro':
				return this.parseMacro(ctx);
			case 'include':
				return this.parseInclude(ctx);
			case 'extends':
				return this.parseExtends(ctx);
			case 'embed':
				return this.parseEmbed(ctx);
			case 'use':
				return this.parseUse(ctx);
			case 'import':
				return this.parseImport(ctx);
			case 'from':
				return this.parseFrom(ctx);
			case 'apply':
				return this.parseApply(ctx);
			case 'autoescape':
				return this.parseAutoescape(ctx);
			case 'do':
			case 'deprecated':
				return this.parseExpressionTag(ctx);
			case 'flush':
				return this.parseFlush(ctx);
			case 'with':
				return this.parseWith(ctx);
			case 'verbatim':
				return this.parseVerbatim(ctx);
			default:
				return this.parseGenericTag(ctx);
		}
	}

	private parseIf(ctx: TagContext): TagNode {
		const branches: IfBranch[] = [];
		let branchStart = ctx.open.start;
		let kind: IfBranch['kind'] = 'if';
		let condition = this.parseExpression();
		this.expectRegionEnd('block-end');

		for (;;) {
			const result = this.parseTagBody(['elseif', 'else', 'endif']);
			branches.push({
				type: 'IfBranch',
				kind,
				condition,
				body: result.body,
				start: branchStart,
				end: this.previousEnd(),
			});

			const { stop } = result;
			if (
				stop.kind === 'tag' &&
				!stop.claimedByOuter &&
				(stop.name === 'elseif' || stop.name === 'else')
			) {
				branchStart = this.current.start;
				this.advance();
				this.advance();
				kind = stop.name;
				condition = stop.name === 'elseif' ? this.parseExpression() : undefined;
				this.expectRegionEnd('block-end');
				continue;
			}

			const { end } = this.closeTag(ctx, stop, 'endif', false);
			return {
				type: 'IfTag',
				name: ctx.name,
				nameRange: ctx.nameRange,
				branches,
				start: ctx.open.start,
				end,
			};
		}
	}

	private parseFor(ctx: TagContext): TagNode {
		const first = this.parseName(FOR_RESERVED);
		let keyTarget: Identifier | undefined;
		let valueTarget = first;
		if (this.accept('punctuation', ',') !== undefined) {
			keyTarget = first;
			valueTarget = this.parseName(FOR_RESERVED);
		}

		if (this.accept('name', 'in') === undefined) {
			this.missing('unexpected-token', 'Expected "in" in a "for" tag.', this.current.start);
		}
		const sequence = this.parseExpression();

		let condition: Expression | undefined;
		const conditionToken = this.accept('name', 'if');
		if (conditionToken !== undefined) {
			condition = this.parseExpression();
			this.error(
				'removed-in-twig-3',
				'The "if" condition on "for" was removed in Twig 3; use "|filter" on the sequence instead.',
				conditionToken.start,
				condition?.end ?? conditionToken.end,
			);
		}
		this.expectRegionEnd('block-end');

		const result = this.parseTagBody(['else', 'endfor']);
		let elseBody: TemplateChild[] | undefined;
		let { stop } = result;
		if (stop.kind === 'tag' && !stop.claimedByOuter && stop.name === 'else') {
			this.advance();
			this.advance();
			this.expectRegionEnd('block-end');
			const elseResult = this.parseTagBody(['endfor']);
			elseBody = elseResult.body;
			stop = elseResult.stop;
		}

		const { end } = this.closeTag(ctx, stop, 'endfor', false);
		return {
			type: 'ForTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			keyTarget,
			valueTarget,
			sequence,
			condition,
			body: result.body,
			elseBody,
			start: ctx.open.start,
			end,
		};
	}

	private parseSet(ctx: TagContext): TagNode {
		const targets: Identifier[] = [];
		for (;;) {
			const target = this.parseName();
			if (target === undefined) {
				break;
			}
			targets.push(target);
			if (this.accept('punctuation', ',') === undefined) {
				break;
			}
		}

		if (this.accept('operator', '=') !== undefined) {
			const values: Expression[] = [];
			for (;;) {
				const value = this.parseExpression();
				if (value !== undefined) {
					values.push(value);
				}
				if (this.accept('punctuation', ',') === undefined) {
					break;
				}
			}
			const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
			return {
				type: 'SetTag',
				name: ctx.name,
				nameRange: ctx.nameRange,
				targets,
				values,
				body: undefined,
				start: ctx.open.start,
				end,
			};
		}

		this.expectRegionEnd('block-end');
		const result = this.parseTagBody(['endset']);
		const { end } = this.closeTag(ctx, result.stop, 'endset', false);
		return {
			type: 'SetTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			targets,
			values: [],
			body: result.body,
			start: ctx.open.start,
			end,
		};
	}

	private parseBlock(ctx: TagContext): TagNode {
		const blockName = this.parseName();

		if (!this.test('block-end') && !this.atBoundary()) {
			const value = this.parseExpression();
			const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
			return {
				type: 'BlockTag',
				name: ctx.name,
				nameRange: ctx.nameRange,
				blockName,
				value,
				body: undefined,
				endName: undefined,
				start: ctx.open.start,
				end,
			};
		}

		this.expectRegionEnd('block-end');
		const result = this.parseTagBody(['endblock']);
		const { end, label } = this.closeTag(ctx, result.stop, 'endblock', true);
		return {
			type: 'BlockTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			blockName,
			value: undefined,
			body: result.body,
			endName: label,
			start: ctx.open.start,
			end,
		};
	}

	private parseMacro(ctx: TagContext): TagNode {
		const macroName = this.parseName();
		const params: MacroParam[] = [];

		if (this.test('punctuation', '(')) {
			const open = this.advance();
			while (!this.test('punctuation', ')') && !this.atBoundary()) {
				if (params.length > 0 && this.accept('punctuation', ',') === undefined) {
					break;
				}
				if (this.test('punctuation', ')')) {
					break;
				}
				const name = this.parseName();
				if (name === undefined) {
					break;
				}
				const value =
					this.accept('operator', '=') !== undefined ? this.parseExpression() : undefined;
				params.push({
					type: 'MacroParam',
					name,
					default: value,
					start: name.start,
					end: value?.end ?? name.end,
				});
			}
			if (this.accept('punctuation', ')') === undefined) {
				this.error(
					'unclosed-parenthesis',
					'Unclosed "(": expected ")".',
					open.start,
					this.previousEnd(),
				);
			}
		}

		this.expectRegionEnd('block-end');
		const result = this.parseTagBody(['endmacro']);
		const { end } = this.closeTag(ctx, result.stop, 'endmacro', true);
		return {
			type: 'MacroTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			macroName,
			params,
			body: result.body,
			start: ctx.open.start,
			end,
		};
	}

	private parseInclude(ctx: TagContext): TagNode {
		const template = this.parseExpression();
		const options = this.parseTemplateOptions();
		const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
		return {
			type: 'IncludeTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			template,
			variables: options.variables,
			only: options.only,
			ignoreMissing: options.ignoreMissing,
			start: ctx.open.start,
			end,
		};
	}

	private parseExtends(ctx: TagContext): TagNode {
		const template = this.parseExpression();
		const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
		return {
			type: 'ExtendsTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			template,
			start: ctx.open.start,
			end,
		};
	}

	private parseEmbed(ctx: TagContext): TagNode {
		const template = this.parseExpression();
		const options = this.parseTemplateOptions();
		this.expectRegionEnd('block-end');
		const result = this.parseTagBody(['endembed']);
		const { end } = this.closeTag(ctx, result.stop, 'endembed', false);
		return {
			type: 'EmbedTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			template,
			variables: options.variables,
			only: options.only,
			ignoreMissing: options.ignoreMissing,
			body: result.body,
			start: ctx.open.start,
			end,
		};
	}

	/** Shared `[ignore missing] [with expr] [only]` suffix of include/embed. */
	private parseTemplateOptions(): {
		variables: Expression | undefined;
		only: boolean;
		ignoreMissing: boolean;
	} {
		let ignoreMissing = false;
		if (this.test('name', 'ignore') && this.test('name', 'missing', 1)) {
			this.advance();
			this.advance();
			ignoreMissing = true;
		}
		const variables =
			this.accept('name', 'with') !== undefined ? this.parseExpression() : undefined;
		const only = this.accept('name', 'only') !== undefined;
		return { variables, only, ignoreMissing };
	}

	private parseUse(ctx: TagContext): TagNode {
		const template = this.parseExpression();
		const aliases: UseAlias[] = [];
		if (this.accept('name', 'with') !== undefined) {
			for (;;) {
				const original = this.parseName();
				if (original === undefined) {
					break;
				}
				const alias =
					this.accept('name', 'as') !== undefined ? this.parseName() : undefined;
				aliases.push({
					type: 'UseAlias',
					original,
					alias,
					start: original.start,
					end: alias?.end ?? original.end,
				});
				if (this.accept('punctuation', ',') === undefined) {
					break;
				}
			}
		}
		const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
		return {
			type: 'UseTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			template,
			aliases,
			start: ctx.open.start,
			end,
		};
	}

	private parseImport(ctx: TagContext): TagNode {
		const template = this.parseExpression();
		const alias = this.accept('name', 'as') !== undefined ? this.parseName() : undefined;
		const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
		return {
			type: 'ImportTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			template,
			alias,
			start: ctx.open.start,
			end,
		};
	}

	private parseFrom(ctx: TagContext): TagNode {
		const template = this.parseExpression();
		const imports: FromImport[] = [];
		if (this.accept('name', 'import') !== undefined) {
			for (;;) {
				const macroName = this.parseName();
				if (macroName === undefined) {
					break;
				}
				const alias =
					this.accept('name', 'as') !== undefined ? this.parseName() : undefined;
				imports.push({
					type: 'FromImport',
					macroName,
					alias,
					start: macroName.start,
					end: alias?.end ?? macroName.end,
				});
				if (this.accept('punctuation', ',') === undefined) {
					break;
				}
			}
		} else {
			this.missing(
				'unexpected-token',
				'Expected "import" in a "from" tag.',
				this.current.start,
			);
		}
		const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
		return {
			type: 'FromTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			template,
			imports,
			start: ctx.open.start,
			end,
		};
	}

	private parseApply(ctx: TagContext): TagNode {
		const filters: ApplyFilter[] = [];
		for (;;) {
			const token = this.accept('name');
			if (token === undefined) {
				this.missing('missing-filter-name', 'Expected a filter name.', this.current.start);
				break;
			}
			const args = this.test('punctuation', '(') ? this.parseArguments() : undefined;
			filters.push({
				type: 'ApplyFilter',
				name: { type: 'Identifier', name: token.value, start: token.start, end: token.end },
				args: args?.args ?? [],
				start: token.start,
				end: args?.end ?? token.end,
			});
			if (this.accept('punctuation', '|') === undefined) {
				break;
			}
		}

		this.expectRegionEnd('block-end');
		const result = this.parseTagBody(['endapply']);
		const { end } = this.closeTag(ctx, result.stop, 'endapply', false);
		return {
			type: 'ApplyTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			filters,
			body: result.body,
			start: ctx.open.start,
			end,
		};
	}

	private parseAutoescape(ctx: TagContext): TagNode {
		const strategy =
			this.test('block-end') || this.atBoundary() ? undefined : this.parseExpression();
		this.expectRegionEnd('block-end');
		const result = this.parseTagBody(['endautoescape']);
		const { end } = this.closeTag(ctx, result.stop, 'endautoescape', false);
		return {
			type: 'AutoescapeTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			strategy,
			body: result.body,
			start: ctx.open.start,
			end,
		};
	}

	/** `{% do expr %}` and `{% deprecated expr [package=…] [version=…] %}`. */
	private parseExpressionTag(ctx: TagContext): TagNode {
		const expression = this.parseExpression();
		if (ctx.name === 'do') {
			const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
			return {
				type: 'DoTag',
				name: ctx.name,
				nameRange: ctx.nameRange,
				expression,
				start: ctx.open.start,
				end,
			};
		}

		const args: Argument[] = [];
		while (this.test('name') && this.test('operator', '=', 1)) {
			const nameToken = this.advance();
			this.advance();
			const value = this.parseExpression();
			args.push({
				type: 'Argument',
				name: {
					type: 'Identifier',
					name: nameToken.value,
					start: nameToken.start,
					end: nameToken.end,
				},
				value,
				start: nameToken.start,
				end: value?.end ?? this.previousEnd(),
			});
		}
		const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
		return {
			type: 'DeprecatedTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			expression,
			args,
			start: ctx.open.start,
			end,
		};
	}

	private parseFlush(ctx: TagContext): TagNode {
		const end = this.expectRegionEnd('block-end') ?? this.previousEnd();
		return {
			type: 'FlushTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			start: ctx.open.start,
			end,
		};
	}

	private parseWith(ctx: TagContext): TagNode {
		const variables =
			this.test('block-end') || this.test('name', 'only') || this.atBoundary()
				? undefined
				: this.parseExpression();
		const only = this.accept('name', 'only') !== undefined;
		this.expectRegionEnd('block-end');
		const result = this.parseTagBody(['endwith']);
		const { end } = this.closeTag(ctx, result.stop, 'endwith', false);
		return {
			type: 'WithTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			variables,
			only,
			body: result.body,
			start: ctx.open.start,
			end,
		};
	}

	private parseVerbatim(ctx: TagContext): TagNode {
		this.expectRegionEnd('block-end');
		const anchor = this.previousEnd();
		let value = '';
		let valueRange: SourceRange = { start: anchor, end: anchor };
		const raw = this.accept('raw');
		if (raw !== undefined) {
			value = raw.value;
			valueRange = { start: raw.start, end: raw.end };
		}

		let end = valueRange.end;
		if (this.test('block-start') && this.peekTagName() === 'endverbatim') {
			this.advance();
			this.advance();
			end = this.expectRegionEnd('block-end') ?? this.previousEnd();
		}
		// An unterminated verbatim is already reported by the lexer, which owns
		// raw-mode scanning; re-reporting it here would just duplicate.
		return {
			type: 'VerbatimTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			value,
			valueRange,
			start: ctx.open.start,
			end,
		};
	}

	private parseGenericTag(ctx: TagContext): TagNode {
		const args: Expression[] = [];
		while (!this.test('block-end') && !this.atBoundary()) {
			const arg = this.parseExpression();
			if (arg === undefined) {
				break;
			}
			args.push(arg);
			this.accept('punctuation', ',');
		}
		const headerEnd = this.expectRegionEnd('block-end') ?? this.previousEnd();

		if (ctx.name.startsWith('end')) {
			this.error(
				'unexpected-end-tag',
				`Unexpected "{% ${ctx.name} %}": no matching opening tag.`,
				ctx.open.start,
				headerEnd,
			);
			return this.genericTag(ctx, args, undefined, headerEnd);
		}

		const endName = `end${ctx.name}`;
		if (!KNOWN_BLOCK_TAGS.has(ctx.name) && !this.findMatchingEnd(ctx.name)) {
			return this.genericTag(ctx, args, undefined, headerEnd);
		}

		const result = this.parseTagBody([endName]);
		const { end } = this.closeTag(ctx, result.stop, endName, false);
		return this.genericTag(ctx, args, result.body, end);
	}

	private genericTag(
		ctx: TagContext,
		args: Expression[],
		body: TemplateChild[] | undefined,
		end: number,
	): TagNode {
		return {
			type: 'GenericTag',
			name: ctx.name,
			nameRange: ctx.nameRange,
			args,
			body,
			start: ctx.open.start,
			end,
		};
	}

	/**
	 * Token indices of every `{% <name> … %}` in the document, keyed by tag
	 * name and ascending. Built once per parse: scanning the whole stream per
	 * unknown tag instead is quadratic, which a template full of plugin tags
	 * (`{% js %}`, `{% hook %}`, `{% dump %}` …) hits in practice.
	 */
	private tagIndex: Map<string, number[]> | undefined;

	private buildTagIndex(): Map<string, number[]> {
		const index = new Map<string, number[]>();
		for (let at = 0; at < this.tokens.length - 1; at++) {
			if (this.tokens[at]?.kind !== 'block-start') {
				continue;
			}
			const next = this.tokens[at + 1];
			if (next?.kind !== 'name') {
				continue;
			}
			const list = index.get(next.value);
			if (list === undefined) {
				index.set(next.value, [at]);
			} else {
				list.push(at);
			}
		}
		return index;
	}

	/**
	 * Whether an unknown tag has a body: is there an `end<name>` ahead that is
	 * not claimed by a nested `<name>`? Counting nesting means
	 * `{% foo %}{% foo %}{% endfoo %}{% endfoo %}` pairs up correctly.
	 */
	private findMatchingEnd(name: string): boolean {
		this.tagIndex ??= this.buildTagIndex();
		const ends = this.tagIndex.get(`end${name}`);
		if (ends === undefined) {
			return false;
		}
		const opens = this.tagIndex.get(name) ?? [];

		let open = lowerBound(opens, this.index);
		let depth = 0;
		for (let end = lowerBound(ends, this.index); end < ends.length; end++) {
			const endAt = ends[end] as number;
			while (open < opens.length && (opens[open] as number) < endAt) {
				depth++;
				open++;
			}
			if (depth === 0) {
				return true;
			}
			depth--;
		}
		return false;
	}

	/**
	 * Terminates a block tag. Auto-closes at EOF or at an enclosing tag's
	 * boundary (recording `missing-end-tag`), and accepts a foreign end tag as
	 * the terminator (recording `mismatched-end-tag`) so one typo does not
	 * unbalance the rest of the document.
	 */
	private closeTag(
		ctx: TagContext,
		stop: BodyStop,
		endName: string,
		allowLabel: boolean,
	): { end: number; label: Identifier | undefined } {
		const unclosed = `Unclosed "{% ${ctx.name} %}": expected "{% ${endName} %}".`;
		if (stop.kind === 'eof') {
			this.missing('missing-end-tag', unclosed, this.previousEnd());
			return { end: this.previousEnd(), label: undefined };
		}
		if (stop.claimedByOuter) {
			this.missing('missing-end-tag', unclosed, this.current.start);
			return { end: this.current.start, label: undefined };
		}
		if (stop.name !== endName) {
			this.error(
				'mismatched-end-tag',
				`"{% ${stop.name} %}" cannot close "{% ${ctx.name} %}"; expected "{% ${endName} %}".`,
				this.current.start,
				this.peek(1).end,
			);
		}

		this.advance();
		this.advance();
		let label: Identifier | undefined;
		if (allowLabel && this.test('name')) {
			const token = this.advance();
			label = { type: 'Identifier', name: token.value, start: token.start, end: token.end };
		}
		const end = this.expectRegionEnd('block-end');
		return { end: end ?? this.previousEnd(), label };
	}

	/**
	 * Reads a binding name. `reserved` holds words that are lexically names but
	 * act as keywords in the position being parsed — accepting `in` as a loop
	 * variable in `{% for in list %}` would derail the rest of the tag.
	 */
	private parseName(reserved?: ReadonlySet<string>): Identifier | undefined {
		if (!this.test('name') || reserved?.has(this.current.value) === true) {
			this.missing('missing-name', 'Expected a name.', this.current.start);
			return undefined;
		}
		const token = this.advance();
		return { type: 'Identifier', name: token.value, start: token.start, end: token.end };
	}
}

/** First index in the ascending `values` whose entry is >= `target`. */
function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((values[mid] as number) < target) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

/**
 * Parses a Twig 3 document. Never throws: malformed and half-typed input yields
 * a best-effort tree plus structured errors.
 */
export function parse(source: string): ParseResult {
	const { tokens, errors } = tokenize(source);
	const parser = new Parser(tokens, source, errors);
	const template = parser.parseTemplate();
	// Lexer errors are found first but can sit anywhere; consumers want source order.
	const sorted = [...parser.errors].sort((a, b) => a.start - b.start || a.end - b.end);
	return { template, errors: sorted, tokens, source };
}
