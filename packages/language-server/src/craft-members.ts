import type { Expression } from '@twig-toolbox/parser';
import type {
	CatalogMemberWithProvenance,
	CatalogObjectWithProvenance,
	CatalogRegistry,
} from './catalog';
import type { MemberCompletion, MemberContext, MemberProvider } from './members';

/**
 * `craft.‸`, and everything a query chain opens up after it.
 *
 * Twig has no types, so this is not inference — it is a walk over the catalog's
 * `objects` graph, which the generator builds out of Craft's own PHP return
 * types. `craft` is an object because the `craft` global says so; `craft.entries`
 * is an `EntryQuery` because `CraftVariable::entries()` returns one; and
 * `craft.entries.section('news').` still completes query params because
 * `section()` returns the query. A chain ends where Craft's types end: `.all()`
 * yields rows, names no object, and offers nothing.
 *
 * The provider declines everything outside a Craft project by construction —
 * with the pack inactive there are no objects to walk — and declines a receiver
 * the template has bound itself, so `{% set craft = 5 %}` does not get an
 * element query's completions.
 */
export function createCraftMemberProvider(registry: CatalogRegistry): MemberProvider {
	return {
		id: 'craft.api',
		provideMembers(context) {
			const objects = registry.getMergedObjects(context.document.workspaceContext);
			if (objects.size === 0) {
				return [];
			}

			const object = resolveObject(context.object, context, objects, registry);
			return object === undefined ? [] : object.members.map(toCompletion);
		},
	};
}

function resolveObject(
	expression: Expression,
	context: MemberContext,
	objects: ReadonlyMap<string, CatalogObjectWithProvenance>,
	registry: CatalogRegistry,
): CatalogObjectWithProvenance | undefined {
	const typeName = resolveType(expression, context, objects, registry);
	return typeName === undefined ? undefined : objects.get(typeName);
}

/** The object type an expression evaluates to, or undefined if we cannot say. */
function resolveType(
	expression: Expression,
	context: MemberContext,
	objects: ReadonlyMap<string, CatalogObjectWithProvenance>,
	registry: CatalogRegistry,
): string | undefined {
	switch (expression.type) {
		case 'Identifier': {
			// A name the template binds is the template's, whatever Craft calls it.
			if (context.symbols.resolve(expression.name, context.offset) !== undefined) {
				return undefined;
			}
			const global = registry
				.getMergedEntries(context.document.workspaceContext)
				.globals.get(expression.name);
			return global?.objectType;
		}

		case 'MemberAccess': {
			if (expression.computed || expression.property?.type !== 'Identifier') {
				return undefined;
			}
			const parent = resolveObject(expression.object, context, objects, registry);
			const property = expression.property.name;
			return parent?.members.find((member) => member.name === property)?.type;
		}

		// `craft.entries.section('news').‸` — the call's type is its callee's,
		// because a query param method returns the query it narrowed.
		case 'CallExpression':
			return resolveType(expression.callee, context, objects, registry);

		default:
			return undefined;
	}
}

function toCompletion(member: CatalogMemberWithProvenance): MemberCompletion {
	return {
		name: member.name,
		detail: member.signature,
		documentation: member.description,
		source: member.pack.displayName,
		insertText: member.completionSnippet,
		available: member.available,
		signature: member.signature,
		parameters: member.parameters,
		docsUrl: member.docsUrl,
		...(member.sinceVersion === undefined ? {} : { sinceVersion: member.sinceVersion }),
		...(member.removedVersion === undefined ? {} : { removedVersion: member.removedVersion }),
		...(member.deprecated === undefined ? {} : { deprecated: member.deprecated }),
	};
}
