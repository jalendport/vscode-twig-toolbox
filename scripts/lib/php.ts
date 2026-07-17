import type { CatalogParameter } from '../../packages/language-server/src/catalog';

/**
 * Just enough PHP reading to lift signatures out of an extension class.
 *
 * This is not a parser and does not want to be: the generators look at two
 * shapes — a parameter list and a docblock — in files whose formatting is
 * enforced by the upstream projects' own linters. Anything it cannot read, it
 * says so about (by throwing) rather than guessing, and the overrides file is
 * where the answer goes instead.
 */

export interface PhpParameter {
	name: string;
	type?: string;
	optional: boolean;
	default?: string;
}

/** Splits on a separator that is not inside brackets or a string. */
export function splitTopLevel(source: string, separator: string): string[] {
	const parts: string[] = [];
	let current = '';
	let depth = 0;
	let quote: string | undefined;

	for (const character of source) {
		if (quote) {
			current += character;
			if (character === quote) {
				quote = undefined;
			}
			continue;
		}

		if (character === '"' || character === "'") {
			quote = character;
			current += character;
			continue;
		}

		if (character === '[' || character === '(') {
			depth += 1;
		}

		if (character === ']' || character === ')') {
			depth -= 1;
		}

		if (character === separator && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}

		current += character;
	}

	parts.push(current.trim());
	return parts;
}

export function parsePhpParameters(parameterSource: string): PhpParameter[] {
	if (!parameterSource.trim()) {
		return [];
	}

	return (
		splitTopLevel(parameterSource, ',')
			// Multi-line signatures may end with a trailing comma, which splits into
			// a final empty part that is not a parameter.
			.filter((rawParameter) => rawParameter.trim() !== '')
			.map((rawParameter) => {
				const source = rawParameter.trim();
				const [leftSide, defaultValue] = splitTopLevel(source, '=') as [string, string?];
				const name = leftSide.match(/\$([A-Za-z_][A-Za-z0-9_]*)/)?.[1];

				if (!name) {
					throw new Error(`Unable to parse PHP parameter: ${source}`);
				}

				const type = leftSide
					.replace(/=.*$/, '')
					.replace(/&?\s*\.\.\.\s*/, '')
					.replace(new RegExp(`\\$${name}\\b`), '')
					.trim();

				return pruneUndefined({
					name,
					type: type || undefined,
					optional: defaultValue !== undefined,
					default: defaultValue?.trim(),
				});
			})
	);
}

/**
 * A PHP type as a template author would say it: `\DateTime` → `DateTime`.
 *
 * Both upstreams `use`-import their types, so what reaches here is already a
 * short name or a builtin, and the leading root-namespace `\` is the only thing
 * to strip.
 */
export function normalizeType(type: string | undefined): string | undefined {
	if (!type) {
		return undefined;
	}

	return type
		.replace(/^\\/, '')
		.replace(/\\([A-Za-z]+)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * A description down to its first sentence.
 *
 * The class model is the reason this exists: a docblock summary runs to a
 * paragraph, and a paragraph times ~5,000 members is most of the pack. The first
 * sentence is the part that answers "what is this", and everything after it is
 * what the documentation link is for.
 *
 * The language server has the same rule in `markdown.ts`, for the completion
 * detail line. The two layers cannot import each other — one is bundled into the
 * extension, the other only ever runs under `tsx` — so the rule is written twice
 * rather than reached across for.
 */
export function firstSentence(description: string): string {
	const match = /^[\s\S]*?\.(?=\s|$)/.exec(description.trim());
	return (match?.[0] ?? description).replace(/\s+/g, ' ').trim();
}

export function buildSignature(name: string, parameters: readonly CatalogParameter[]): string {
	if (parameters.length === 0) {
		return name;
	}

	return `${name}(${parameters
		.map((parameter) => {
			const defaultValue = parameter.default ? ` = ${parameter.default}` : '';
			return parameter.optional
				? `${parameter.name}?${defaultValue}`
				: `${parameter.name}${defaultValue}`;
		})
		.join(', ')})`;
}

export function deepMerge<T extends object>(base: T, override: Partial<T>): T {
	const baseRecord = base as Record<string, unknown>;
	const merged: Record<string, unknown> = { ...baseRecord };

	for (const [key, value] of Object.entries(override)) {
		const baseValue = baseRecord[key];

		if (
			value &&
			!Array.isArray(value) &&
			typeof value === 'object' &&
			baseValue &&
			!Array.isArray(baseValue) &&
			typeof baseValue === 'object'
		) {
			merged[key] = deepMerge(
				baseValue as Record<string, unknown>,
				value as Record<string, unknown>,
			);
		} else if (value !== undefined) {
			merged[key] = value;
		}
	}

	return merged as T;
}

/**
 * The type `pruneUndefined` earns: a key whose value could be `undefined` comes
 * back optional and non-`undefined`, because the key is gone when it was. That
 * is exactly the shape `exactOptionalPropertyTypes` asks for, so pruned objects
 * assign straight to the catalog interfaces without a cast.
 */
export type Pruned<T> = {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
	[K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function pruneUndefined<T extends object>(value: T): Pruned<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, propertyValue]) => propertyValue !== undefined),
	) as Pruned<T>;
}
