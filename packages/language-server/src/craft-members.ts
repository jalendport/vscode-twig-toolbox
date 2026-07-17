import type { Expression } from '@twig-toolbox/parser';
import type {
	CatalogMemberWithProvenance,
	CatalogObjectWithProvenance,
	CatalogRegistry,
	WorkspaceCatalogContext,
} from './catalog';
import { apiMemberUrl, craftMajor, type CraftMajor } from './craft-api';
import {
	inferCraftElement,
	type CraftElementKind,
	type CraftField,
	type CraftProjectConfigResolver,
} from './craft-project-config';
import type { MemberCompletion, MemberContext, MemberProvider } from './members';

/**
 * Everything a Craft template can dot into: `craft.‸`, the elements, and the
 * chains that run between them.
 *
 * Twig has no types, so this is not inference — it is a walk over the catalog's
 * object graph, which the generator builds out of Craft's own PHP return types.
 * `craft` is an object because the `craft` global says so; `craft.entries` is an
 * `EntryQuery` because `CraftVariable::entries()` returns one; `.one()` is an
 * `Entry` because `EntryQuery` says which element it queries; and `entry.author`
 * is a `User` because `craft\elements\Entry` declares it. A chain ends where
 * Craft's types end: `.all()` yields rows, names no object, and offers nothing.
 *
 * Two sources of truth meet here, and neither is complete alone:
 *
 * - The **class model** knows what an `Entry` is — `title`, `author`, `postDate`,
 *   and where each one is documented. It has never heard of `myAssetsField`.
 * - The **project config** (milestone 10) knows every field handle in this
 *   project and what type each field yields. It has never heard of `title`.
 *
 * `entry.myAssetsField.one().dataUrl` needs both on the same chain, so they are
 * merged per object rather than raced: the handles win the detail line, because
 * a real field's own name and type is the more specific answer, and the native
 * member keeps its documentation link on the way through. See `mergeMembers`.
 *
 * The provider declines everything outside a Craft project by construction —
 * with the pack inactive there are no objects to walk — and declines a receiver
 * the template has bound itself, so `{% set craft = 5 %}` does not get an
 * element query's completions.
 */

/**
 * What milestone 10's element kinds are, as classes.
 *
 * The bridge between the two halves. `inferCraftElement` answers "this is an
 * entry" from the template and the project config; the class model answers "an
 * entry is a `craft\elements\Entry`". Neither can say both.
 *
 * `block` is version-dependent because Matrix is: Craft 5 nests real entries in
 * a Matrix field, Craft 4 nested a `MatrixBlock`, and the two are different
 * classes with different surfaces.
 */
const ELEMENT_CLASSES: Record<CraftElementKind, string> = {
	entry: 'craft\\elements\\Entry',
	asset: 'craft\\elements\\Asset',
	category: 'craft\\elements\\Category',
	tag: 'craft\\elements\\Tag',
	user: 'craft\\elements\\User',
	globalSet: 'craft\\elements\\GlobalSet',
	block: 'craft\\elements\\Entry',
};

const CRAFT_4_BLOCK_CLASS = 'craft\\elements\\MatrixBlock';

/** Sort buckets within one object's members. Lower sorts higher. */
const RANK = {
	/** The handful of members a template reaches for first. */
	core: 0,
	/** This project's own field handles. */
	field: 1,
	/** The rest of the class surface. */
	native: 2,
	/** `getDataUrl` beside `dataUrl` — a second name for a member already listed. */
	accessor: 3,
} as const;

/**
 * The members every element leads with, in the order a template wants them.
 *
 * The class model has all of these and several hundred more, sorted
 * alphabetically, which makes `entry.title` the 180th completion. This is not
 * extra data — it is an opinion about ordering, and the only part of milestone
 * 10's hand-written element members worth keeping now that the real classes are
 * modelled.
 */
const CORE_MEMBERS: Record<CraftElementKind, readonly string[]> = {
	entry: ['id', 'title', 'slug', 'uri', 'url', 'postDate', 'expiryDate', 'section', 'type'],
	asset: [
		'id',
		'title',
		'filename',
		'url',
		'extension',
		'kind',
		'width',
		'height',
		'size',
		'alt',
	],
	category: ['id', 'title', 'slug', 'uri', 'url', 'level'],
	tag: ['id', 'title', 'slug'],
	user: ['id', 'username', 'email', 'firstName', 'lastName', 'fullName', 'photo'],
	globalSet: ['id', 'name', 'handle'],
	block: ['id', 'title', 'type'],
};

export function createCraftMemberProvider(
	registry: CatalogRegistry,
	schemaResolver?: CraftProjectConfigResolver,
): MemberProvider {
	return {
		id: 'craft.api',
		provideMembers(context) {
			const objects = registry.getMergedObjects(context.document.workspaceContext);
			if (objects.size === 0) {
				return [];
			}

			const resolver = new ChainResolver(context, objects, registry, schemaResolver);
			const type = resolver.typeOf(context.object);
			if (type === undefined) {
				return [];
			}

			const major = craftMajor(craftVersion(context.document.workspaceContext));
			const native = objects.get(type)?.members ?? [];
			const fields = resolver.fieldsOn(context.object, type);
			if (native.length === 0 && fields.length === 0) {
				return [];
			}

			return mergeMembers(native, fields, elementKindOf(type, major), major);
		},
	};
}

function craftVersion(context: WorkspaceCatalogContext): string | undefined {
	return context.packageVersions?.['craftcms/cms'];
}

/**
 * The element kind a class is, for the sake of ranking only.
 *
 * A reverse of `ELEMENT_CLASSES`, and deliberately partial: a `craft\web\Request`
 * is not an element and has no members worth promoting, so it gets none.
 */
function elementKindOf(type: string, major: CraftMajor): CraftElementKind | undefined {
	if (major === 4 && type === CRAFT_4_BLOCK_CLASS) {
		return 'block';
	}
	return (Object.keys(ELEMENT_CLASSES) as CraftElementKind[]).find(
		(kind) => kind !== 'block' && ELEMENT_CLASSES[kind] === type,
	);
}

/**
 * One object's members, from both halves of the model.
 *
 * Dedupe is by name, and a project's field handle wins: if someone named a field
 * `title`, then `entry.title` in *this* project is that field, and saying
 * "Entry title" would be describing a different project's template. What the
 * native member still contributes is its documentation link and its version
 * metadata — the field handle has neither, and dropping them would make hover
 * worse for a name that is, underneath, still Craft's.
 */
function mergeMembers(
	native: readonly CatalogMemberWithProvenance[],
	fields: readonly CraftField[],
	kind: CraftElementKind | undefined,
	major: CraftMajor,
): MemberCompletion[] {
	const byName = new Map<string, MemberCompletion>();

	for (const member of native) {
		byName.set(member.name, nativeCompletion(member, kind, major));
	}

	for (const field of fields) {
		const native = byName.get(field.handle);
		byName.set(field.handle, fieldCompletion(field, native));
	}

	return [...byName.values()];
}

function nativeCompletion(
	member: CatalogMemberWithProvenance,
	kind: CraftElementKind | undefined,
	major: CraftMajor,
): MemberCompletion {
	const core = kind === undefined ? -1 : CORE_MEMBERS[kind].indexOf(member.name);
	const rank = core !== -1 ? RANK.core : isAccessor(member) ? RANK.accessor : RANK.native;
	const sortKey = core !== -1 ? String(core).padStart(3, '0') : member.name;
	const docsUrl = memberDocsUrl(member, major);

	return {
		name: member.name,
		detail: member.signature,
		documentation: member.description,
		source: member.pack.displayName,
		insertText: member.completionSnippet,
		sortText: `${rank}:${sortKey}`,
		available: member.available,
		signature: member.signature,
		parameters: member.parameters,
		...(docsUrl === undefined ? {} : { docsUrl }),
		...(member.sinceVersion === undefined ? {} : { sinceVersion: member.sinceVersion }),
		...(member.removedVersion === undefined ? {} : { removedVersion: member.removedVersion }),
		...(member.deprecated === undefined ? {} : { deprecated: member.deprecated }),
	};
}

/**
 * A field handle, keeping whatever the native member of the same name knew.
 *
 * The detail line and the documentation are the field's, because in this project
 * that is what the name means. The link and the version metadata are the native
 * member's, because the field has none and a hover with a dead "Documentation"
 * line is worse than one with Craft's.
 */
function fieldCompletion(
	field: CraftField,
	native: MemberCompletion | undefined,
): MemberCompletion {
	return {
		name: field.handle,
		detail: field.valueType,
		documentation: [
			`${field.name} (${fieldTypeName(field.type)}).`,
			`Defined in \`${field.sourceFile}\`.`,
		].join('\n\n'),
		source: 'Craft CMS project',
		sortText: `${RANK.field}:${field.handle}`,
		...(native?.docsUrl === undefined ? {} : { docsUrl: native.docsUrl }),
		...(native?.sinceVersion === undefined ? {} : { sinceVersion: native.sinceVersion }),
		...(native?.removedVersion === undefined ? {} : { removedVersion: native.removedVersion }),
		...(native?.available === undefined ? {} : { available: native.available }),
	};
}

function fieldTypeName(type: string): string {
	const short = type.split('\\').at(-1);
	return short === undefined || short === '' ? type : short;
}

/** True for `getDataUrl` sitting beside `dataUrl` — the same member, said twice. */
function isAccessor(member: CatalogMemberWithProvenance): boolean {
	return member.kind === 'method' && /^get[A-Z]/.test(member.name);
}

/**
 * Where a member is documented.
 *
 * Carried when the pack has one — the docs pages behind `craft.entries` are
 * hand-written and unguessable. Derived otherwise, which is every member of the
 * class model: the reference's URL is a function of the declaring class, the
 * kind and the name, and deriving it here is what lets the pack not store ~3,000
 * of them, and lets a Craft 4 project get Craft 4's page.
 */
function memberDocsUrl(member: CatalogMemberWithProvenance, major: CraftMajor): string | undefined {
	if (member.docsUrl !== undefined) {
		return member.docsUrl;
	}
	// An object keyed by something other than a class — `EntryQuery`, `craft` —
	// has no reference page to derive from.
	if (!member.owner.includes('\\')) {
		return undefined;
	}
	return apiMemberUrl({
		major,
		objectClass: member.owner,
		declaringClass: member.declaredOn,
		kind: member.kind,
		name: member.name,
	});
}

/**
 * Walks an expression to the object it evaluates to.
 *
 * The two halves meet here too. A receiver can be typed by the catalog (`craft`,
 * `currentUser`), by the project config (`entry`, a loop over `craft.entries`, a
 * Matrix block), or by a member of something already typed — including a field
 * handle, which is how `entry.myAssetsField` becomes an `AssetQuery`.
 */
class ChainResolver {
	constructor(
		private readonly context: MemberContext,
		private readonly objects: ReadonlyMap<string, CatalogObjectWithProvenance>,
		private readonly registry: CatalogRegistry,
		private readonly schemaResolver: CraftProjectConfigResolver | undefined,
	) {}

	typeOf(expression: Expression): string | undefined {
		switch (expression.type) {
			case 'Identifier': {
				const inferred = this.inferredClass(expression);
				if (inferred !== undefined) {
					return inferred;
				}
				// A name the template binds is the template's, whatever Craft
				// calls it — unless the project config recognised it above, which
				// is how a `{% for entry in … %}` loop variable keeps its type.
				if (
					this.context.symbols.resolve(expression.name, this.context.offset) !== undefined
				) {
					return undefined;
				}
				return this.registry
					.getMergedEntries(this.context.document.workspaceContext)
					.globals.get(expression.name)?.objectType;
			}

			case 'MemberAccess': {
				if (expression.computed || expression.property?.type !== 'Identifier') {
					return undefined;
				}
				const parent = this.typeOf(expression.object);
				return parent === undefined
					? undefined
					: this.memberType(expression.object, parent, expression.property.name);
			}

			// `craft.entries.section('news').‸` — the call's type is its callee's,
			// because a query param method returns the query it narrowed.
			case 'CallExpression':
				return this.typeOf(expression.callee);

			default:
				return undefined;
		}
	}

	/**
	 * A member's type, from the class model or from this project's fields.
	 *
	 * `entry.myAssetsField` is the case that needs both: the class model has no
	 * such member, and the project config says it is an Assets field, whose value
	 * is an `AssetQuery` — which the class model then knows how to walk.
	 */
	private memberType(
		ownerExpression: Expression,
		owner: string,
		name: string,
	): string | undefined {
		const native = this.objects.get(owner)?.members.find((member) => member.name === name);
		if (native?.type !== undefined) {
			return native.type;
		}
		const field = this.fieldsOn(ownerExpression, owner).find(
			(candidate) => candidate.handle === name,
		);
		// A field's value type is only a type if the model has an object for it:
		// `AssetQuery` is one, `string` is not, and `mixed` is the field types
		// milestone 10 could not place.
		return field !== undefined && this.objects.has(field.valueType)
			? field.valueType
			: undefined;
	}

	/**
	 * This project's fields on a receiver, if it is an element.
	 *
	 * The inference is milestone 10's and is made against the receiver rather
	 * than its class, because that is what scopes the answer:
	 * `craft.entries.section('news').one()` has the fields of that section, not
	 * of every entry type in the project.
	 *
	 * The result is only trusted when the two halves agree about what the
	 * receiver is. They can disagree — `inferCraftElement` types the bare name
	 * `asset`, which nothing in the class model types — and a field list belonging
	 * to a different element than the members it is about to be merged with is
	 * worse than no field list.
	 */
	fieldsOn(expression: Expression, type: string): readonly CraftField[] {
		const schema = this.schema();
		if (schema === undefined) {
			return [];
		}
		const inferred = inferCraftElement(
			expression,
			this.symbolFor(expression),
			this.context.document,
			schema,
		);
		return inferred !== undefined && this.classOf(inferred.kind) === type
			? inferred.fields
			: [];
	}

	/** The class the project config says a receiver is, if it says anything. */
	private inferredClass(expression: Expression): string | undefined {
		const schema = this.schema();
		if (schema === undefined) {
			return undefined;
		}
		const inferred = inferCraftElement(
			expression,
			this.symbolFor(expression),
			this.context.document,
			schema,
		);
		if (inferred === undefined) {
			return undefined;
		}
		const type = this.classOf(inferred.kind);
		return this.objects.has(type) ? type : undefined;
	}

	private classOf(kind: CraftElementKind): string {
		const major = craftMajor(craftVersion(this.context.document.workspaceContext));
		return kind === 'block' && major === 4 ? CRAFT_4_BLOCK_CLASS : ELEMENT_CLASSES[kind];
	}

	/**
	 * What a receiver binds to, when it is a bare name. `context.symbol` is this
	 * for the outermost receiver only, and a chain is resolved inside-out.
	 */
	private symbolFor(expression: Expression) {
		if (expression === this.context.object) {
			return this.context.symbol;
		}
		return expression.type === 'Identifier'
			? this.context.symbols.resolve(expression.name, this.context.offset)
			: undefined;
	}

	private schema() {
		if (this.schemaResolver?.isCraftProject(this.context.document.uri) !== true) {
			return undefined;
		}
		return this.schemaResolver.forUri(this.context.document.uri);
	}
}
