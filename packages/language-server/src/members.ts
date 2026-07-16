import type { Expression } from '@twig-toolbox/parser';
import type { ParsedDocument } from './document-store';
import type { SymbolTable, TwigSymbol } from './symbols';

/**
 * Member completions for `{{ receiver.‸ }}`.
 *
 * Twig has no type system, so nothing here is inference: a provider recognises
 * receivers it knows about and declines everything else. `loop` and `_self`
 * macro namespaces are the two the language itself defines, and they ship as
 * `BUILTIN_MEMBER_PROVIDERS` below.
 *
 * Milestone 10 plugs project-typed members (`entry.myField`) in as another
 * provider: it gets the receiver expression, so it can match the names Craft's
 * project config gives it, and the symbol the name resolves to, so a local
 * `{% set entry = … %}` can shadow the global it would otherwise match.
 */

export interface MemberCompletion {
	readonly name: string;
	/** Right-hand summary — a signature, a type, whatever fits one line. */
	readonly detail?: string;
	/** Markdown for the documentation panel. */
	readonly documentation?: string;
	/** Provenance, shown beside the label. */
	readonly source?: string;
	/** Snippet body; defaults to the plain name. */
	readonly insertText?: string;
}

export interface MemberContext {
	/** Receiver being dotted into: `user` in `{{ user.‸ }}`. */
	readonly object: Expression;
	/** What the receiver resolves to, when it is a bare in-scope name. */
	readonly symbol: TwigSymbol | undefined;
	readonly symbols: SymbolTable;
	readonly document: ParsedDocument;
	readonly offset: number;
}

export interface MemberProvider {
	readonly id: string;
	/** Empty when the provider does not recognise the receiver. */
	provideMembers(context: MemberContext): MemberCompletion[];
}

/**
 * `loop` inside a `{% for %}`. Not catalog-driven: dialect packs describe named
 * tags, filters, functions and tests, and `loop` is none of those — it is a
 * variable the `for` tag injects, documented only in prose.
 *
 * `parent`, `length`, `revindex*` and `last` are all offered even though Twig
 * only defines them for countable sequences; the alternative is inferring the
 * sequence type, which Twig itself does not do until render.
 */
const LOOP_MEMBERS: readonly MemberCompletion[] = [
	{ name: 'index', detail: 'number', documentation: 'The current iteration, starting at 1.' },
	{ name: 'index0', detail: 'number', documentation: 'The current iteration, starting at 0.' },
	{
		name: 'revindex',
		detail: 'number',
		documentation: 'Iterations remaining until the end, counting down to 1.',
	},
	{
		name: 'revindex0',
		detail: 'number',
		documentation: 'Iterations remaining until the end, counting down to 0.',
	},
	{ name: 'first', detail: 'boolean', documentation: 'True on the first iteration.' },
	{ name: 'last', detail: 'boolean', documentation: 'True on the last iteration.' },
	{
		name: 'length',
		detail: 'number',
		documentation:
			'Number of items in the sequence.\n\nOnly available for countable sequences.',
	},
	{
		name: 'parent',
		detail: 'hash',
		documentation: 'The context of the enclosing template — use it to reach an outer `loop`.',
	},
];

const loopMemberProvider: MemberProvider = {
	id: 'twig.loop',
	provideMembers: ({ symbol }) =>
		symbol?.typeName === 'loop' ? LOOP_MEMBERS.map(withTwigSource) : [],
};

/**
 * `{% import _self as m %}` → `{{ m.‸ }}`. Only `_self` resolves today; pointing
 * an import at another template needs the loader that milestone 08 builds.
 */
const selfMacroProvider: MemberProvider = {
	id: 'twig.macros.self',
	provideMembers: ({ symbol, symbols }) =>
		symbol?.typeName === 'macros:_self'
			? symbols.macros.map((macro) => ({
					name: macro.name,
					detail: macro.signature,
					documentation: 'Macro defined in this template.',
					source: 'Twig',
					insertText: `${macro.name}(${macro.params.length > 0 ? '$1' : ''})`,
				}))
			: [],
};

function withTwigSource(member: MemberCompletion): MemberCompletion {
	return { ...member, source: 'Twig' };
}

export const BUILTIN_MEMBER_PROVIDERS: readonly MemberProvider[] = [
	loopMemberProvider,
	selfMacroProvider,
];

/** First provider that recognises the receiver wins; the rest are not consulted. */
export function provideMembers(
	providers: readonly MemberProvider[],
	context: MemberContext,
): MemberCompletion[] {
	for (const provider of providers) {
		const members = provider.provideMembers(context);
		if (members.length > 0) {
			return members;
		}
	}
	return [];
}
