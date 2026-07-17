import type { Expression } from '@twig-toolbox/parser';
import type {
	CatalogMemberWithProvenance,
	CatalogObjectWithProvenance,
	CatalogRegistry,
	WorkspaceCatalogContext,
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
			if (object === undefined) {
				return [];
			}

			const major = craftMajor(context.document.workspaceContext);
			return object.members.map((member) => toCompletion(member, major));
		},
	};
}

/**
 * Craft publishes its class reference once per major, at the same paths.
 *
 * The pack is generated from Craft 5 and merged with 4, so one URL is baked per
 * member and it is the 5 one. Sending a Craft 4 project to the Craft 5 reference
 * is how a docs link ends up describing a signature the reader does not have, so
 * the major the project actually installed picks the host directory here, at the
 * point where the project is known. Only the class reference moves: every other
 * `docsUrl` in the pack is versioned already, or is not Craft's to version.
 */
const API_PREFIX = 'https://docs.craftcms.com/api/';
const GENERATED_MAJOR = 5;

function craftMajor(context: WorkspaceCatalogContext): number | undefined {
	const version = context.packageVersions?.['craftcms/cms'];
	const major =
		version === undefined ? Number.NaN : Number.parseInt(version.replace(/^v/i, ''), 10);
	return Number.isNaN(major) ? undefined : major;
}

export function versionedDocsUrl(docsUrl: string, major: number | undefined): string {
	const generated = `${API_PREFIX}v${GENERATED_MAJOR}/`;
	if (major === undefined || major === GENERATED_MAJOR || !docsUrl.startsWith(generated)) {
		return docsUrl;
	}
	// 4 is the only other major the pack covers. A project on something newer
	// than what this was generated from is better served by the reference that
	// exists than by a guess at a URL that may not.
	return major === 4 ? `${API_PREFIX}v4/${docsUrl.slice(generated.length)}` : docsUrl;
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

function toCompletion(
	member: CatalogMemberWithProvenance,
	major: number | undefined,
): MemberCompletion {
	return {
		name: member.name,
		detail: member.signature,
		documentation: member.description,
		source: member.pack.displayName,
		insertText: member.completionSnippet,
		available: member.available,
		signature: member.signature,
		parameters: member.parameters,
		docsUrl: versionedDocsUrl(member.docsUrl, major),
		...(member.sinceVersion === undefined ? {} : { sinceVersion: member.sinceVersion }),
		...(member.removedVersion === undefined ? {} : { removedVersion: member.removedVersion }),
		...(member.deprecated === undefined ? {} : { deprecated: member.deprecated }),
	};
}
