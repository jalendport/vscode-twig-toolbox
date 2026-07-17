import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import {
	type AnyNode,
	type Expression,
	type ForTag,
	type SourceRange,
	visit,
} from '@twig-toolbox/parser';
import YAML from 'yaml';
import { Location } from 'vscode-languageserver/node';
import type { ProjectContext, ProjectContextResolver } from './project-context';
import { filePathToUri, isInside, uriToFilePath } from './workspace';

export interface CraftField {
	readonly uid: string;
	readonly handle: string;
	readonly name: string;
	readonly type: string;
	readonly valueType: string;
	readonly sourceFile: string;
	readonly matrixFields: readonly CraftField[];
	readonly matrixEntryTypeUids: readonly string[];
}

export interface CraftEntryType {
	readonly uid: string;
	readonly handle: string;
	readonly name: string;
	readonly fields: readonly CraftField[];
	readonly sourceFile: string;
}

export interface CraftSection {
	readonly uid: string;
	readonly handle: string;
	readonly name: string;
	readonly type: string;
	readonly entryTypes: readonly CraftEntryType[];
	readonly sourceFile: string;
}

export interface CraftGlobalSet {
	readonly uid: string;
	readonly handle: string;
	readonly name: string;
	readonly fields: readonly CraftField[];
	readonly sourceFile: string;
}

export interface CraftVolume {
	readonly uid: string;
	readonly handle: string;
	readonly name: string;
	readonly fields: readonly CraftField[];
	readonly sourceFile: string;
}

export interface CraftGroup {
	readonly uid: string;
	readonly handle: string;
	readonly name: string;
	readonly fields: readonly CraftField[];
	readonly sourceFile: string;
}

export interface CraftSite {
	readonly uid: string;
	readonly handle: string;
	readonly name: string;
	readonly sourceFile: string;
}

export interface CraftHandle {
	readonly kind:
		| 'section'
		| 'entry type'
		| 'asset volume'
		| 'global set'
		| 'category group'
		| 'tag group'
		| 'site';
	readonly handle: string;
	readonly name: string;
	readonly sourceFile: string;
}

export interface CraftProjectSchema {
	readonly sections: readonly CraftSection[];
	readonly entryTypes: readonly CraftEntryType[];
	readonly fields: readonly CraftField[];
	readonly globalSets: readonly CraftGlobalSet[];
	readonly volumes: readonly CraftVolume[];
	readonly categoryGroups: readonly CraftGroup[];
	readonly tagGroups: readonly CraftGroup[];
	readonly sites: readonly CraftSite[];
	fieldsForEntryQuery(query: CraftEntryQuery): readonly CraftField[];
	entryTypesForQuery(query: CraftEntryQuery): readonly CraftEntryType[];
	matrixFieldsFor(handle: string): readonly CraftField[];
	handle(kind: CraftHandle['kind'], handle: string): CraftHandle | undefined;
	handles(kind: CraftHandle['kind']): readonly CraftHandle[];
	globalSet(handle: string): CraftGlobalSet | undefined;
	sourceLocation(sourceFile: string): Location;
}

export interface CraftEntryQuery {
	readonly sections?: readonly string[];
	readonly types?: readonly string[];
}

interface RawItem {
	readonly uid: string;
	readonly value: Record<string, unknown>;
	readonly sourceFile: string;
}

interface RawProjectConfig {
	readonly fields: RawItem[];
	readonly entryTypes: RawItem[];
	readonly sections: RawItem[];
	readonly globalSets: RawItem[];
	readonly volumes: RawItem[];
	readonly categoryGroups: RawItem[];
	readonly tagGroups: RawItem[];
	readonly sites: RawItem[];
}

interface CachedSchema {
	readonly schema: CraftProjectSchema;
	readonly projectConfigDir: string;
}

const EMPTY_SCHEMA = createSchema({
	fields: [],
	entryTypes: [],
	sections: [],
	globalSets: [],
	volumes: [],
	categoryGroups: [],
	tagGroups: [],
	sites: [],
});

export class CraftProjectConfigResolver {
	private readonly cache = new Map<string, CachedSchema>();

	constructor(
		private readonly projects: ProjectContextResolver,
		private readonly log: (message: string) => void = () => {},
	) {}

	forUri(uri: string): CraftProjectSchema {
		const context = this.projects.forUri(uri);
		return context?.kind === 'craft' ? this.forProject(context) : EMPTY_SCHEMA;
	}

	isCraftProject(uri: string): boolean {
		return this.projects.forUri(uri)?.kind === 'craft';
	}

	invalidate(uri: string): void {
		const filePath = uriToFilePath(uri);
		if (filePath === undefined) {
			return;
		}
		if (['composer.json', 'composer.lock'].includes(basename(filePath))) {
			for (const root of this.cache.keys()) {
				if (isInside(filePath, root)) {
					this.cache.delete(root);
				}
			}
			return;
		}
		if (!isProjectConfigYaml(filePath)) {
			return;
		}
		for (const root of this.cache.keys()) {
			if (isInside(filePath, this.cache.get(root)?.projectConfigDir ?? root)) {
				this.cache.delete(root);
			}
		}
	}

	private forProject(context: ProjectContext): CraftProjectSchema {
		const cached = this.cache.get(context.root);
		if (cached !== undefined) {
			return cached.schema;
		}

		const projectConfigDir = resolve(context.root, 'config', 'project');
		const schema = readProjectConfig(projectConfigDir, context, this.log);
		this.cache.set(context.root, { schema, projectConfigDir });
		return schema;
	}
}

export type CraftElementKind =
	'entry' | 'asset' | 'category' | 'tag' | 'user' | 'globalSet' | 'block';

export interface InferredCraftElement {
	readonly kind: CraftElementKind;
	readonly fields: readonly CraftField[];
}

export function inferCraftElement(
	expression: Expression,
	symbol: { readonly definitionRange?: SourceRange; readonly kind?: string } | undefined,
	document: { readonly result: { readonly template: AnyNode } },
	schema: CraftProjectSchema,
): InferredCraftElement | undefined {
	if (expression.type === 'Identifier') {
		const loop =
			symbol?.kind === 'loop-variable'
				? findLoopForSymbol(document.result.template, symbol)
				: undefined;
		if (loop?.sequence !== undefined) {
			const sequence = inferCraftElementFromSequence(loop.sequence, schema);
			if (sequence !== undefined) {
				return sequence;
			}
		}

		switch (expression.name) {
			case 'entry':
				return { kind: 'entry', fields: schema.fieldsForEntryQuery({}) };
			case 'asset':
				return {
					kind: 'asset',
					fields: unionFields(schema.volumes.flatMap((volume) => volume.fields)),
				};
			case 'category':
				return {
					kind: 'category',
					fields: unionFields(schema.categoryGroups.flatMap((group) => group.fields)),
				};
			case 'tag':
				return {
					kind: 'tag',
					fields: unionFields(schema.tagGroups.flatMap((group) => group.fields)),
				};
			case 'user':
				return { kind: 'user', fields: [] };
			default: {
				const globalSet = schema.globalSet(expression.name);
				return globalSet === undefined
					? undefined
					: { kind: 'globalSet', fields: globalSet.fields };
			}
		}
	}

	const matrix = inferMatrixFieldExpression(expression, schema);
	return matrix === undefined ? undefined : { kind: 'block', fields: matrix };
}

export interface CraftQueryHandleSlot {
	readonly kind: CraftHandle['kind'];
	readonly handles: readonly CraftHandle[];
	readonly currentHandle: string;
}

export function craftHandleSlot(
	callee: Expression,
	currentHandle: string,
	schema: CraftProjectSchema,
): CraftQueryHandleSlot | undefined {
	if (
		callee.type !== 'MemberAccess' ||
		callee.computed ||
		callee.property?.type !== 'Identifier'
	) {
		return undefined;
	}
	const method = callee.property.name;
	const root = craftQueryRoot(callee.object);

	if (root === 'entries' && method === 'section') {
		return { kind: 'section', handles: schema.handles('section'), currentHandle };
	}
	if (root === 'entries' && method === 'type') {
		return { kind: 'entry type', handles: schema.handles('entry type'), currentHandle };
	}
	if (root === 'assets' && method === 'volume') {
		return { kind: 'asset volume', handles: schema.handles('asset volume'), currentHandle };
	}
	if (root === 'categories' && method === 'group') {
		return { kind: 'category group', handles: schema.handles('category group'), currentHandle };
	}
	if (root === 'tags' && method === 'group') {
		return { kind: 'tag group', handles: schema.handles('tag group'), currentHandle };
	}
	if (root === 'globalSets' && method === 'handle') {
		return { kind: 'global set', handles: schema.handles('global set'), currentHandle };
	}
	return undefined;
}

export function craftHandleAt(
	callee: Expression,
	handle: string,
	schema: CraftProjectSchema,
): CraftHandle | undefined {
	return craftHandleSlot(callee, handle, schema)?.handles.find(
		(candidate) => candidate.handle === handle,
	);
}

function readProjectConfig(
	projectConfigDir: string,
	context: ProjectContext,
	log: (message: string) => void,
): CraftProjectSchema {
	if (!existsSync(projectConfigDir)) {
		return EMPTY_SCHEMA;
	}

	try {
		const raw = readRawProjectConfig(projectConfigDir);
		return createSchema(normalizeRaw(raw, majorVersion(context.craftVersion)));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`Craft project config ignored: ${message}`);
		return EMPTY_SCHEMA;
	}
}

function readRawProjectConfig(projectConfigDir: string): RawProjectConfig {
	const raw: RawProjectConfig = {
		fields: [],
		entryTypes: [],
		sections: [],
		globalSets: [],
		volumes: [],
		categoryGroups: [],
		tagGroups: [],
		sites: [],
	};

	for (const sourceFile of yamlFiles(projectConfigDir)) {
		const parsed = YAML.parse(readFileSync(sourceFile, 'utf8')) as unknown;
		if (!isRecord(parsed)) {
			continue;
		}
		const relativePath = relative(projectConfigDir, sourceFile).split(/[\\/]/);
		addItems(raw, bucketFromPath(relativePath), parsed, sourceFile);
		for (const [key, value] of Object.entries(parsed)) {
			addItems(raw, bucketFromKey(key), value, sourceFile);
		}
	}
	return raw;
}

function normalizeRaw(raw: RawProjectConfig, craftMajor: number | undefined): RawProjectConfig {
	if (craftMajor === 4) {
		return {
			...raw,
			entryTypes: [...raw.entryTypes, ...raw.sections.flatMap(craft4EntryTypesFromSection)],
		};
	}
	return raw;
}

function createSchema(raw: RawProjectConfig): CraftProjectSchema {
	const fieldsByUid = new Map<string, CraftField>();
	for (const item of raw.fields) {
		const field = createField(item, fieldsByUid);
		if (field !== undefined) {
			fieldsByUid.set(field.uid, field);
		}
	}

	const entryTypesByUid = new Map<string, CraftEntryType>();
	for (const item of raw.entryTypes) {
		const entryType = createEntryType(item, fieldsByUid);
		if (entryType !== undefined) {
			entryTypesByUid.set(entryType.uid, entryType);
		}
	}

	const sections = raw.sections.flatMap((item) => createSection(item, entryTypesByUid));
	const globalSets = raw.globalSets.flatMap((item) => createGlobalSet(item, fieldsByUid));
	const volumes = raw.volumes.flatMap((item) => createVolume(item, fieldsByUid));
	const categoryGroups = raw.categoryGroups.flatMap((item) => createGroup(item, fieldsByUid));
	const tagGroups = raw.tagGroups.flatMap((item) => createGroup(item, fieldsByUid));
	const sites = raw.sites.flatMap(createSite);
	const entryTypes = [...entryTypesByUid.values()];
	const fields = [...fieldsByUid.values()];

	const handles = new Map<CraftHandle['kind'], CraftHandle[]>();
	const addHandle = (
		kind: CraftHandle['kind'],
		handle: string,
		name: string,
		sourceFile: string,
	) => {
		const list = handles.get(kind) ?? [];
		list.push({ kind, handle, name, sourceFile });
		handles.set(kind, list);
	};
	for (const section of sections)
		addHandle('section', section.handle, section.name, section.sourceFile);
	for (const entryType of entryTypes)
		addHandle('entry type', entryType.handle, entryType.name, entryType.sourceFile);
	for (const volume of volumes)
		addHandle('asset volume', volume.handle, volume.name, volume.sourceFile);
	for (const set of globalSets) addHandle('global set', set.handle, set.name, set.sourceFile);
	for (const group of categoryGroups)
		addHandle('category group', group.handle, group.name, group.sourceFile);
	for (const group of tagGroups)
		addHandle('tag group', group.handle, group.name, group.sourceFile);
	for (const site of sites) addHandle('site', site.handle, site.name, site.sourceFile);

	return {
		sections,
		entryTypes,
		fields,
		globalSets,
		volumes,
		categoryGroups,
		tagGroups,
		sites,
		fieldsForEntryQuery(query) {
			return unionFields(
				this.entryTypesForQuery(query).flatMap((entryType) => entryType.fields),
			);
		},
		entryTypesForQuery(query) {
			const sectionHandles = new Set(query.sections ?? []);
			const typeHandles = new Set(query.types ?? []);
			const scoped =
				sectionHandles.size === 0
					? entryTypes
					: sections
							.filter((section) => sectionHandles.has(section.handle))
							.flatMap((section) => section.entryTypes);
			const filtered =
				typeHandles.size === 0
					? scoped
					: scoped.filter((entryType) => typeHandles.has(entryType.handle));
			return uniqueBy(filtered, (entryType) => entryType.uid);
		},
		matrixFieldsFor(handle) {
			const matrix = fields.find((field) => field.handle === handle);
			if (matrix === undefined) {
				return [];
			}
			const entryTypeFields = matrix.matrixEntryTypeUids.flatMap(
				(uid) => entryTypesByUid.get(uid)?.fields ?? [],
			);
			return unionFields([...matrix.matrixFields, ...entryTypeFields]);
		},
		handle(kind, handle) {
			return handles.get(kind)?.find((candidate) => candidate.handle === handle);
		},
		handles(kind) {
			return handles.get(kind) ?? [];
		},
		globalSet(handle) {
			return globalSets.find((candidate) => candidate.handle === handle);
		},
		sourceLocation(sourceFile) {
			return Location.create(filePathToUri(sourceFile), {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 },
			});
		},
	};
}

function createField(
	item: RawItem,
	fieldsByUid: ReadonlyMap<string, CraftField>,
): CraftField | undefined {
	const handle = stringValue(item.value.handle);
	if (handle === undefined) {
		return undefined;
	}
	const name = stringValue(item.value.name) ?? handle;
	const type = stringValue(item.value.type) ?? 'unknown';
	const matrixFields = matrixSubfields(item, fieldsByUid);
	return {
		uid: item.uid,
		handle,
		name,
		type,
		valueType: valueTypeForField(type),
		sourceFile: item.sourceFile,
		matrixFields,
		matrixEntryTypeUids: matrixEntryTypeUids(item.value.settings),
	};
}

function createEntryType(
	item: RawItem,
	fieldsByUid: ReadonlyMap<string, CraftField>,
): CraftEntryType | undefined {
	const handle = stringValue(item.value.handle);
	if (handle === undefined) {
		return undefined;
	}
	return {
		uid: item.uid,
		handle,
		name: stringValue(item.value.name) ?? handle,
		fields: fieldsFromLayout(item.value.fieldLayouts, fieldsByUid),
		sourceFile: item.sourceFile,
	};
}

function createSection(
	item: RawItem,
	entryTypesByUid: ReadonlyMap<string, CraftEntryType>,
): CraftSection[] {
	const handle = stringValue(item.value.handle);
	if (handle === undefined) {
		return [];
	}
	const entryTypes = refsFromValue(item.value.entryTypes).flatMap((uid) => {
		const entryType = entryTypesByUid.get(uid);
		return entryType === undefined ? [] : [entryType];
	});
	return [
		{
			uid: item.uid,
			handle,
			name: stringValue(item.value.name) ?? handle,
			type: stringValue(item.value.type) ?? 'channel',
			entryTypes,
			sourceFile: item.sourceFile,
		},
	];
}

function createGlobalSet(
	item: RawItem,
	fieldsByUid: ReadonlyMap<string, CraftField>,
): CraftGlobalSet[] {
	const handle = stringValue(item.value.handle);
	if (handle === undefined) {
		return [];
	}
	return [
		{
			uid: item.uid,
			handle,
			name: stringValue(item.value.name) ?? handle,
			fields: fieldsFromLayout(item.value.fieldLayouts, fieldsByUid),
			sourceFile: item.sourceFile,
		},
	];
}

function createVolume(item: RawItem, fieldsByUid: ReadonlyMap<string, CraftField>): CraftVolume[] {
	const handle = stringValue(item.value.handle);
	if (handle === undefined) {
		return [];
	}
	return [
		{
			uid: item.uid,
			handle,
			name: stringValue(item.value.name) ?? handle,
			fields: fieldsFromLayout(item.value.fieldLayouts, fieldsByUid),
			sourceFile: item.sourceFile,
		},
	];
}

function createGroup(item: RawItem, fieldsByUid: ReadonlyMap<string, CraftField>): CraftGroup[] {
	const handle = stringValue(item.value.handle);
	if (handle === undefined) {
		return [];
	}
	return [
		{
			uid: item.uid,
			handle,
			name: stringValue(item.value.name) ?? handle,
			fields: fieldsFromLayout(item.value.fieldLayouts, fieldsByUid),
			sourceFile: item.sourceFile,
		},
	];
}

function createSite(item: RawItem): CraftSite[] {
	const handle = stringValue(item.value.handle);
	if (handle === undefined) {
		return [];
	}
	return [
		{
			uid: item.uid,
			handle,
			name: stringValue(item.value.name) ?? handle,
			sourceFile: item.sourceFile,
		},
	];
}

function fieldsFromLayout(
	fieldLayouts: unknown,
	fieldsByUid: ReadonlyMap<string, CraftField>,
): CraftField[] {
	const fields: CraftField[] = [];
	collectFieldUids(fieldLayouts, fields);
	return unionFields(fields);

	function collectFieldUids(value: unknown, out: CraftField[]): void {
		if (Array.isArray(value)) {
			for (const item of value) {
				collectFieldUids(item, out);
			}
			return;
		}
		if (!isRecord(value)) {
			return;
		}
		const uid = stringValue(value.fieldUid) ?? stringValue(value.field);
		const field = uid === undefined ? undefined : fieldsByUid.get(uid);
		if (field !== undefined) {
			out.push(field);
		}
		for (const child of Object.values(value)) {
			collectFieldUids(child, out);
		}
	}
}

function matrixSubfields(
	item: RawItem,
	fieldsByUid: ReadonlyMap<string, CraftField>,
): readonly CraftField[] {
	const settings = item.value.settings;
	if (!isRecord(settings)) {
		return [];
	}
	const out: CraftField[] = [];
	for (const [, blockType] of entriesFromMapish(settings.blockTypes)) {
		if (!isRecord(blockType)) {
			continue;
		}
		for (const [fieldUid, fieldValue] of entriesFromMapish(blockType.fields)) {
			if (!isRecord(fieldValue)) {
				continue;
			}
			const handle = stringValue(fieldValue.handle);
			if (handle === undefined) {
				continue;
			}
			out.push({
				uid: fieldUid,
				handle,
				name: stringValue(fieldValue.name) ?? handle,
				type: stringValue(fieldValue.type) ?? 'unknown',
				valueType: valueTypeForField(stringValue(fieldValue.type) ?? 'unknown'),
				sourceFile: item.sourceFile,
				matrixFields: [],
				matrixEntryTypeUids: [],
			});
		}
		out.push(...fieldsFromLayout(blockType.fieldLayouts, fieldsByUid));
	}
	return unionFields(out);
}

function matrixEntryTypeUids(settings: unknown): readonly string[] {
	if (!isRecord(settings)) {
		return [];
	}
	return refsFromValue(settings.entryTypes);
}

function craft4EntryTypesFromSection(section: RawItem): RawItem[] {
	return entriesFromMapish(section.value.entryTypes).flatMap(([uid, value]) =>
		isRecord(value) ? [{ uid, value, sourceFile: section.sourceFile }] : [],
	);
}

function inferCraftElementFromSequence(
	sequence: Expression,
	schema: CraftProjectSchema,
): InferredCraftElement | undefined {
	const query = entryQueryFromExpression(sequence);
	if (query !== undefined) {
		return { kind: 'entry', fields: schema.fieldsForEntryQuery(query) };
	}
	const matrix = inferMatrixFieldExpression(sequence, schema);
	return matrix === undefined ? undefined : { kind: 'block', fields: matrix };
}

function inferMatrixFieldExpression(
	expression: Expression,
	schema: CraftProjectSchema,
): readonly CraftField[] | undefined {
	const target = stripTerminalCall(expression);
	if (
		target.type !== 'MemberAccess' ||
		target.computed ||
		target.property?.type !== 'Identifier' ||
		target.object.type !== 'Identifier'
	) {
		return undefined;
	}
	const owner = target.object.name;
	if (owner !== 'entry' && owner !== 'block') {
		return undefined;
	}
	const fields = schema.matrixFieldsFor(target.property.name);
	return fields.length === 0 ? undefined : fields;
}

function stripTerminalCall(expression: Expression): Expression {
	if (
		expression.type === 'CallExpression' &&
		expression.callee.type === 'MemberAccess' &&
		!expression.callee.computed &&
		expression.callee.property?.type === 'Identifier' &&
		['all', 'one', 'collect'].includes(expression.callee.property.name)
	) {
		return expression.callee.object;
	}
	return expression;
}

function entryQueryFromExpression(expression: Expression): CraftEntryQuery | undefined {
	const parts = collectCraftQuery(expression);
	if (parts?.root !== 'entries') {
		return undefined;
	}
	return {
		...(parts.sections.length === 0 ? {} : { sections: parts.sections }),
		...(parts.types.length === 0 ? {} : { types: parts.types }),
	};
}

interface CraftQueryParts {
	readonly root: 'entries' | 'assets' | 'categories' | 'tags' | 'globalSets';
	readonly sections: string[];
	readonly types: string[];
}

function collectCraftQuery(expression: Expression): CraftQueryParts | undefined {
	if (
		expression.type === 'MemberAccess' &&
		!expression.computed &&
		expression.property?.type === 'Identifier' &&
		expression.object.type === 'Identifier' &&
		expression.object.name === 'craft'
	) {
		const root = expression.property.name;
		return isCraftQueryRoot(root) ? { root, sections: [], types: [] } : undefined;
	}
	if (
		expression.type === 'CallExpression' &&
		expression.callee.type === 'MemberAccess' &&
		!expression.callee.computed &&
		expression.callee.property?.type === 'Identifier'
	) {
		const parts = collectCraftQuery(expression.callee.object);
		if (parts === undefined) {
			return undefined;
		}
		const value = firstStringArg(expression);
		switch (expression.callee.property.name) {
			case 'section':
				if (value !== undefined) parts.sections.push(value);
				break;
			case 'type':
				if (value !== undefined) parts.types.push(value);
				break;
			default:
				break;
		}
		return parts;
	}
	return undefined;
}

function craftQueryRoot(expression: Expression): CraftQueryParts['root'] | undefined {
	return collectCraftQuery(expression)?.root;
}

function firstStringArg(
	expression: Extract<Expression, { type: 'CallExpression' }>,
): string | undefined {
	const first = expression.args[0];
	if (
		first?.type === 'Argument' &&
		first.value?.type === 'StringLiteral' &&
		first.value.parts.length <= 1
	) {
		return first.value.value;
	}
	return undefined;
}

function findLoopForSymbol(
	template: AnyNode,
	symbol: { readonly definitionRange?: SourceRange },
): ForTag | undefined {
	if (symbol.definitionRange === undefined) {
		return undefined;
	}
	let found: ForTag | undefined;
	visit(template, (node) => {
		if (node.type !== 'ForTag') {
			return;
		}
		for (const target of [node.keyTarget, node.valueTarget]) {
			if (
				target !== undefined &&
				target.start === symbol.definitionRange?.start &&
				target.end === symbol.definitionRange.end
			) {
				found = node;
				return false;
			}
		}
		return undefined;
	});
	return found;
}

function refsFromValue(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => {
			if (typeof item === 'string') {
				return [item];
			}
			if (Array.isArray(item) && typeof item[0] === 'string') {
				return [item[0]];
			}
			if (isRecord(item)) {
				return refsFromValue(item);
			}
			return [];
		});
	}
	return entriesFromMapish(value).map(([uid]) => uid);
}

function entriesFromMapish(value: unknown): [string, unknown][] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index): [string, unknown][] => {
			if (typeof item === 'string') {
				return [[item, item]];
			}
			if (Array.isArray(item) && typeof item[0] === 'string') {
				return [[item[0], item[1]]];
			}
			return [[String(index), item]];
		});
	}
	if (!isRecord(value)) {
		return [];
	}
	if (Array.isArray(value.__assoc__)) {
		return value.__assoc__.flatMap((item): [string, unknown][] =>
			Array.isArray(item) && typeof item[0] === 'string' ? [[item[0], item[1]]] : [],
		);
	}
	return Object.entries(value);
}

function addItems(
	raw: RawProjectConfig,
	bucket: keyof RawProjectConfig | undefined,
	value: unknown,
	sourceFile: string,
): void {
	if (bucket === undefined) {
		return;
	}
	if (isRecord(value) && stringValue(value.handle) !== undefined) {
		raw[bucket].push({ uid: basename(sourceFile, '.yaml'), value, sourceFile });
		return;
	}
	for (const [uid, item] of entriesFromMapish(value)) {
		if (isRecord(item)) {
			raw[bucket].push({ uid, value: item, sourceFile });
		}
	}
}

function bucketFromPath(parts: readonly string[]): keyof RawProjectConfig | undefined {
	return bucketFromKey(parts[0] ?? '');
}

function bucketFromKey(key: string): keyof RawProjectConfig | undefined {
	switch (key) {
		case 'fields':
			return 'fields';
		case 'entryTypes':
			return 'entryTypes';
		case 'sections':
			return 'sections';
		case 'globalSets':
			return 'globalSets';
		case 'volumes':
			return 'volumes';
		case 'categoryGroups':
			return 'categoryGroups';
		case 'tagGroups':
			return 'tagGroups';
		case 'sites':
			return 'sites';
		default:
			return undefined;
	}
}

function yamlFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			const stat = statSync(path);
			if (stat.isDirectory()) {
				walk(path);
			} else if (isProjectConfigYaml(path)) {
				out.push(path);
			}
		}
	};
	walk(root);
	return out;
}

function isProjectConfigYaml(path: string): boolean {
	return (
		(path.endsWith('.yaml') || path.endsWith('.yml')) && path.split(/[\\/]/).includes('project')
	);
}

function valueTypeForField(type: string): string {
	const normalized = type.toLowerCase();
	if (
		normalized.includes('plaintext') ||
		normalized.includes('ckeditor') ||
		normalized.includes('redactor') ||
		normalized.includes('email') ||
		normalized.includes('url')
	) {
		return 'string';
	}
	if (normalized.includes('lightswitch')) return 'boolean';
	if (normalized.includes('number')) return 'number';
	if (normalized.includes('date')) return 'DateTime';
	if (normalized.includes('assets')) return 'AssetQuery';
	if (normalized.includes('entries') || normalized.includes('matrix')) return 'EntryQuery';
	if (normalized.includes('categories')) return 'CategoryQuery';
	if (normalized.includes('tags')) return 'TagQuery';
	if (normalized.includes('users')) return 'UserQuery';
	if (normalized.includes('table')) return 'array';
	return 'mixed';
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unionFields(fields: readonly CraftField[]): CraftField[] {
	return uniqueBy(fields, (field) => field.handle);
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const value = key(item);
		if (!seen.has(value)) {
			seen.add(value);
			out.push(item);
		}
	}
	return out;
}

function isCraftQueryRoot(value: string): value is CraftQueryParts['root'] {
	return ['entries', 'assets', 'categories', 'tags', 'globalSets'].includes(value);
}

function majorVersion(version: string | undefined): number | undefined {
	const major = version?.match(/^(\d+)/)?.[1];
	return major === undefined ? undefined : Number.parseInt(major, 10);
}
