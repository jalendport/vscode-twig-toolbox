import type { CatalogRegistry } from './catalog';
import {
	type CraftElementKind,
	type CraftField,
	type CraftProjectConfigResolver,
	inferCraftElement,
} from './craft-project-config';
import type { MemberCompletion, MemberProvider } from './members';

interface BaseMember {
	readonly name: string;
	readonly detail: string;
	readonly documentation: string;
}

const BASE_MEMBERS: Record<CraftElementKind, readonly BaseMember[]> = {
	entry: [
		{ name: 'id', detail: 'number', documentation: 'Entry element ID.' },
		{ name: 'title', detail: 'string', documentation: 'Entry title.' },
		{ name: 'slug', detail: 'string', documentation: 'Entry slug.' },
		{ name: 'uri', detail: 'string', documentation: 'Entry URI.' },
		{ name: 'url', detail: 'string', documentation: 'Entry URL.' },
		{ name: 'postDate', detail: 'DateTime', documentation: 'Entry post date.' },
		{ name: 'expiryDate', detail: 'DateTime', documentation: 'Entry expiry date.' },
		{ name: 'section', detail: 'Section', documentation: 'Entry section.' },
		{ name: 'type', detail: 'EntryType', documentation: 'Entry type.' },
	],
	asset: [
		{ name: 'id', detail: 'number', documentation: 'Asset element ID.' },
		{ name: 'title', detail: 'string', documentation: 'Asset title.' },
		{ name: 'filename', detail: 'string', documentation: 'Asset filename.' },
		{ name: 'url', detail: 'string', documentation: 'Asset URL.' },
		{ name: 'extension', detail: 'string', documentation: 'Asset file extension.' },
		{ name: 'kind', detail: 'string', documentation: 'Asset kind.' },
		{ name: 'width', detail: 'number', documentation: 'Image width, when available.' },
		{ name: 'height', detail: 'number', documentation: 'Image height, when available.' },
		{ name: 'size', detail: 'number', documentation: 'File size in bytes.' },
		{ name: 'alt', detail: 'string', documentation: 'Alternative text.' },
	],
	category: [
		{ name: 'id', detail: 'number', documentation: 'Category element ID.' },
		{ name: 'title', detail: 'string', documentation: 'Category title.' },
		{ name: 'slug', detail: 'string', documentation: 'Category slug.' },
		{ name: 'uri', detail: 'string', documentation: 'Category URI.' },
		{ name: 'url', detail: 'string', documentation: 'Category URL.' },
		{ name: 'level', detail: 'number', documentation: 'Category structure level.' },
	],
	tag: [
		{ name: 'id', detail: 'number', documentation: 'Tag element ID.' },
		{ name: 'title', detail: 'string', documentation: 'Tag title.' },
		{ name: 'slug', detail: 'string', documentation: 'Tag slug.' },
	],
	user: [
		{ name: 'id', detail: 'number', documentation: 'User element ID.' },
		{ name: 'username', detail: 'string', documentation: 'Username.' },
		{ name: 'email', detail: 'string', documentation: 'Email address.' },
		{ name: 'firstName', detail: 'string', documentation: 'First name.' },
		{ name: 'lastName', detail: 'string', documentation: 'Last name.' },
		{ name: 'fullName', detail: 'string', documentation: 'Full name.' },
		{ name: 'photo', detail: 'Asset|null', documentation: 'User photo asset.' },
	],
	globalSet: [
		{ name: 'id', detail: 'number', documentation: 'Global set element ID.' },
		{ name: 'name', detail: 'string', documentation: 'Global set name.' },
		{ name: 'handle', detail: 'string', documentation: 'Global set handle.' },
	],
	block: [
		{ name: 'id', detail: 'number', documentation: 'Nested entry element ID.' },
		{ name: 'title', detail: 'string', documentation: 'Nested entry title.' },
		{ name: 'type', detail: 'EntryType', documentation: 'Nested entry type.' },
	],
};

export function createCraftSchemaMemberProvider(
	schemaResolver: CraftProjectConfigResolver,
	_registry: CatalogRegistry,
): MemberProvider {
	return {
		id: 'craft.projectConfig',
		provideMembers(context) {
			if (!schemaResolver.isCraftProject(context.document.uri)) {
				return [];
			}
			const schema = schemaResolver.forUri(context.document.uri);
			const inferred = inferCraftElement(
				context.object,
				context.symbol,
				context.document,
				schema,
			);
			if (inferred === undefined) {
				return [];
			}

			return [
				...BASE_MEMBERS[inferred.kind].map((member, index) => ({
					...member,
					source: 'Craft CMS',
					sortText: `0:${index.toString().padStart(3, '0')}:${member.name}`,
				})),
				...inferred.fields.map(fieldCompletion),
			];
		},
	};
}

function fieldCompletion(field: CraftField): MemberCompletion {
	return {
		name: field.handle,
		detail: field.valueType,
		documentation: [
			`${field.name} (${fieldTypeName(field.type)}).`,
			`Defined in \`${field.sourceFile}\`.`,
		].join('\n\n'),
		source: 'Craft project',
		sortText: `1:${field.handle}`,
	};
}

function fieldTypeName(type: string): string {
	const short = type.split('\\').at(-1);
	return short === undefined || short === '' ? type : short;
}
