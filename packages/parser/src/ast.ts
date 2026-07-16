/**
 * Twig 3 AST.
 *
 * Every node carries offset-based `start`/`end` ranges over the original
 * source. Missing sub-expressions are `undefined` rather than a placeholder
 * node: `{{ user. }}` is a `MemberAccess` whose `property` is `undefined`, and
 * the accompanying `ParseError` explains why. Consumers that need "what is at
 * this offset" should go through `nodePathAt` in `navigation.ts`.
 */

export interface SourceRange {
	readonly start: number;
	readonly end: number;
}

export interface BaseNode {
	readonly type: string;
	start: number;
	end: number;
}

// --- Template level -------------------------------------------------------

export interface Template extends BaseNode {
	readonly type: 'Template';
	body: TemplateChild[];
}

export interface TextNode extends BaseNode {
	readonly type: 'Text';
	value: string;
}

export interface OutputNode extends BaseNode {
	readonly type: 'Output';
	expression: Expression | undefined;
}

export interface CommentNode extends BaseNode {
	readonly type: 'Comment';
	value: string;
}

export type TemplateChild = TextNode | OutputNode | CommentNode | TagNode;

// --- Tags -----------------------------------------------------------------

export interface TagBase extends BaseNode {
	/** Tag keyword as written, e.g. `if`, `for`, `nav`. */
	name: string;
	nameRange: SourceRange;
}

export interface ForTag extends TagBase {
	readonly type: 'ForTag';
	keyTarget: Identifier | undefined;
	valueTarget: Identifier | undefined;
	sequence: Expression | undefined;
	/** `{% for x in y if z %}` — removed in Twig 3, parsed only to report it. */
	condition: Expression | undefined;
	body: TemplateChild[];
	elseBody: TemplateChild[] | undefined;
}

export interface IfBranch extends BaseNode {
	readonly type: 'IfBranch';
	kind: 'if' | 'elseif' | 'else';
	condition: Expression | undefined;
	body: TemplateChild[];
}

export interface IfTag extends TagBase {
	readonly type: 'IfTag';
	branches: IfBranch[];
}

export interface SetTag extends TagBase {
	readonly type: 'SetTag';
	targets: Identifier[];
	/** Inline form values; empty for the `{% set x %}…{% endset %}` body form. */
	values: Expression[];
	body: TemplateChild[] | undefined;
}

export interface BlockTag extends TagBase {
	readonly type: 'BlockTag';
	blockName: Identifier | undefined;
	/** Shorthand form `{% block title 'Hi' %}`. */
	value: Expression | undefined;
	body: TemplateChild[] | undefined;
	/** Name repeated on `{% endblock title %}`. */
	endName: Identifier | undefined;
}

export interface MacroParam extends BaseNode {
	readonly type: 'MacroParam';
	name: Identifier;
	default: Expression | undefined;
}

export interface MacroTag extends TagBase {
	readonly type: 'MacroTag';
	macroName: Identifier | undefined;
	params: MacroParam[];
	body: TemplateChild[];
}

export interface IncludeTag extends TagBase {
	readonly type: 'IncludeTag';
	template: Expression | undefined;
	variables: Expression | undefined;
	only: boolean;
	ignoreMissing: boolean;
}

export interface ExtendsTag extends TagBase {
	readonly type: 'ExtendsTag';
	template: Expression | undefined;
}

export interface EmbedTag extends TagBase {
	readonly type: 'EmbedTag';
	template: Expression | undefined;
	variables: Expression | undefined;
	only: boolean;
	ignoreMissing: boolean;
	body: TemplateChild[];
}

export interface UseAlias extends BaseNode {
	readonly type: 'UseAlias';
	original: Identifier | undefined;
	alias: Identifier | undefined;
}

export interface UseTag extends TagBase {
	readonly type: 'UseTag';
	template: Expression | undefined;
	aliases: UseAlias[];
}

export interface ImportTag extends TagBase {
	readonly type: 'ImportTag';
	template: Expression | undefined;
	alias: Identifier | undefined;
}

export interface FromImport extends BaseNode {
	readonly type: 'FromImport';
	macroName: Identifier | undefined;
	alias: Identifier | undefined;
}

export interface FromTag extends TagBase {
	readonly type: 'FromTag';
	template: Expression | undefined;
	imports: FromImport[];
}

/** One link of the `{% apply upper|escape %}` filter chain. */
export interface ApplyFilter extends BaseNode {
	readonly type: 'ApplyFilter';
	name: Identifier | undefined;
	args: Argument[];
}

export interface ApplyTag extends TagBase {
	readonly type: 'ApplyTag';
	filters: ApplyFilter[];
	body: TemplateChild[];
}

export interface AutoescapeTag extends TagBase {
	readonly type: 'AutoescapeTag';
	strategy: Expression | undefined;
	body: TemplateChild[];
}

export interface DoTag extends TagBase {
	readonly type: 'DoTag';
	expression: Expression | undefined;
}

export interface FlushTag extends TagBase {
	readonly type: 'FlushTag';
}

export interface DeprecatedTag extends TagBase {
	readonly type: 'DeprecatedTag';
	expression: Expression | undefined;
	/** `package=`/`version=` options (Twig 3.11+). */
	args: Argument[];
}

export interface WithTag extends TagBase {
	readonly type: 'WithTag';
	variables: Expression | undefined;
	only: boolean;
	body: TemplateChild[];
}

export interface VerbatimTag extends TagBase {
	readonly type: 'VerbatimTag';
	value: string;
	valueRange: SourceRange;
}

/**
 * Any tag without a dedicated shape. Covers the structurally uninteresting core
 * tags (`sandbox`, `cache`, `guard`, `types`) and every third-party tag — Craft
 * and plugin tags all land here. A body is parsed when a matching `end<name>`
 * exists somewhere ahead.
 */
export interface GenericTag extends TagBase {
	readonly type: 'GenericTag';
	args: Expression[];
	body: TemplateChild[] | undefined;
}

export type TagNode =
	| ForTag
	| IfTag
	| SetTag
	| BlockTag
	| MacroTag
	| IncludeTag
	| ExtendsTag
	| EmbedTag
	| UseTag
	| ImportTag
	| FromTag
	| ApplyTag
	| AutoescapeTag
	| DoTag
	| FlushTag
	| DeprecatedTag
	| WithTag
	| VerbatimTag
	| GenericTag;

// --- Expressions ----------------------------------------------------------

export interface StringText extends BaseNode {
	readonly type: 'StringText';
	value: string;
}

export interface Interpolation extends BaseNode {
	readonly type: 'Interpolation';
	expression: Expression | undefined;
}

export type StringPart = StringText | Interpolation;

export interface StringLiteral extends BaseNode {
	readonly type: 'StringLiteral';
	/** Decoded value; only meaningful when the string has no interpolation. */
	value: string;
	parts: StringPart[];
	quote: '"' | "'";
}

export interface NumberLiteral extends BaseNode {
	readonly type: 'NumberLiteral';
	value: number;
	raw: string;
}

export interface BooleanLiteral extends BaseNode {
	readonly type: 'BooleanLiteral';
	value: boolean;
}

export interface NullLiteral extends BaseNode {
	readonly type: 'NullLiteral';
}

export interface Identifier extends BaseNode {
	readonly type: 'Identifier';
	name: string;
}

export interface SpreadElement extends BaseNode {
	readonly type: 'SpreadElement';
	argument: Expression | undefined;
}

export interface ArrayLiteral extends BaseNode {
	readonly type: 'ArrayLiteral';
	elements: (Expression | SpreadElement)[];
}

export interface HashEntry extends BaseNode {
	readonly type: 'HashEntry';
	key: Expression | undefined;
	value: Expression | undefined;
	/** `{ name }` shorthand for `{ name: name }`. */
	shorthand: boolean;
}

export interface HashLiteral extends BaseNode {
	readonly type: 'HashLiteral';
	entries: (HashEntry | SpreadElement)[];
}

export interface UnaryExpression extends BaseNode {
	readonly type: 'UnaryExpression';
	operator: string;
	operatorRange: SourceRange;
	argument: Expression | undefined;
}

export interface BinaryExpression extends BaseNode {
	readonly type: 'BinaryExpression';
	/** Normalized operator, e.g. `starts with`, `not in`, `b-and`. */
	operator: string;
	operatorRange: SourceRange;
	left: Expression;
	right: Expression | undefined;
}

export interface ConditionalExpression extends BaseNode {
	readonly type: 'ConditionalExpression';
	test: Expression;
	/** Absent for the `a ?: b` shorthand. */
	consequent: Expression | undefined;
	alternate: Expression | undefined;
}

export interface Argument extends BaseNode {
	readonly type: 'Argument';
	/** Present for named arguments, e.g. `date(timezone='UTC')`. */
	name: Identifier | undefined;
	value: Expression | SpreadElement | undefined;
}

export interface FilterExpression extends BaseNode {
	readonly type: 'FilterExpression';
	target: Expression;
	name: Identifier | undefined;
	args: Argument[];
}

export interface CallExpression extends BaseNode {
	readonly type: 'CallExpression';
	callee: Expression;
	args: Argument[];
}

export interface MemberAccess extends BaseNode {
	readonly type: 'MemberAccess';
	object: Expression;
	/** `undefined` for incomplete access such as `{{ user. }}`. */
	property: Expression | undefined;
	/** True for `a[b]`, false for `a.b`. */
	computed: boolean;
}

/** `items[1:3]` — Twig's slice subscript, desugared by Twig to the `slice` filter. */
export interface SliceExpression extends BaseNode {
	readonly type: 'SliceExpression';
	target: Expression;
	/** Omitted in `items[:3]`. */
	from: Expression | undefined;
	/** Omitted in `items[1:]`. */
	to: Expression | undefined;
}

export interface ArrowFunction extends BaseNode {
	readonly type: 'ArrowFunction';
	params: Identifier[];
	body: Expression | undefined;
}

export interface TestExpression extends BaseNode {
	readonly type: 'TestExpression';
	target: Expression;
	negated: boolean;
	/** Test name as written, e.g. `defined`, `divisible by`. */
	name: Identifier | undefined;
	args: Argument[];
}

export type Expression =
	| StringLiteral
	| NumberLiteral
	| BooleanLiteral
	| NullLiteral
	| Identifier
	| ArrayLiteral
	| HashLiteral
	| UnaryExpression
	| BinaryExpression
	| ConditionalExpression
	| FilterExpression
	| CallExpression
	| MemberAccess
	| SliceExpression
	| ArrowFunction
	| TestExpression;

export type AnyNode =
	| Template
	| TemplateChild
	| TagNode
	| Expression
	| IfBranch
	| MacroParam
	| UseAlias
	| FromImport
	| ApplyFilter
	| Argument
	| HashEntry
	| SpreadElement
	| StringPart;
