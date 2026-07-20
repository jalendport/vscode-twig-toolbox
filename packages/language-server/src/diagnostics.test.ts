import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { CatalogRegistry, type DialectPack } from './catalog';
import { getDiagnostics } from './diagnostics';
import { createParsedDocument } from './document-store';
import { DEFAULT_SETTINGS, type TwigToolboxSettings } from './settings';

const registry = CatalogRegistry.fromPacks([createPack()]);

const WARN_UNKNOWN: TwigToolboxSettings = {
	...DEFAULT_SETTINGS,
	diagnostics: { unknownNames: 'warning', ignoredNames: [] },
};

function unknownCodesFor(text: string): string[] {
	const parsed = createParsedDocument(
		TextDocument.create('file:///project/templates/index.twig', 'twig', 1, text),
	);
	return getDiagnostics(parsed, WARN_UNKNOWN, registry)
		.filter((diagnostic) => diagnostic.code?.toString().startsWith('unknown-'))
		.map((diagnostic) => diagnostic.code as string);
}

function createPack(): DialectPack {
	const entry = (name: string) => ({
		name,
		signature: name,
		parameters: [],
		description: `${name} entry`,
		docsUrl: `https://twig.symfony.com/doc/3.x/${name}.html`,
		completionSnippet: name,
	});

	return {
		schemaVersion: 1,
		name: 'twig-core',
		displayName: 'Twig',
		version: '1.0.0',
		sources: {
			twig: { repository: 'twig/twig', ref: 'v3.22.0' },
			docs: { repository: 'twigphp/Twig-Doc', ref: '3.x' },
		},
		detect: { kind: 'always' },
		entries: {
			tags: ['if', 'for', 'set', 'from', 'import', 'macro'].map(entry),
			filters: ['escape', 'upper'].map(entry),
			functions: ['include', 'path'].map(entry),
			tests: ['defined'].map(entry),
			globals: [],
		},
	};
}

describe('unknown-function diagnostics and macros', () => {
	it('does not flag a macro imported with {% from %}', () => {
		expect(unknownCodesFor('{% from "macros" import button %}{{ button() }}')).toEqual([]);
	});

	it('does not flag a macro imported under an alias', () => {
		expect(unknownCodesFor('{% from "macros" import button as btn %}{{ btn() }}')).toEqual([]);
	});

	it('does not flag a macro imported from _self', () => {
		expect(
			unknownCodesFor(
				'{% macro button() %}{% endmacro %}{% from _self import button %}{{ button() }}',
			),
		).toEqual([]);
	});

	it('still flags an unknown function that is not an imported macro', () => {
		expect(unknownCodesFor('{{ button() }}')).toEqual(['unknown-function']);
	});

	it('still flags an unknown function name after an unrelated import', () => {
		expect(
			unknownCodesFor('{% from "macros" import button %}{{ button() }}{{ nope() }}'),
		).toEqual(['unknown-function']);
	});

	it('does not extend the exemption to a namespace import used as a plain name', () => {
		// `{% import "macros" as forms %}` binds `forms` to a macro namespace, not
		// a callable — calling it bare is still meaningless and should be flagged.
		expect(unknownCodesFor('{% import "macros" as forms %}{{ forms() }}')).toEqual([
			'unknown-function',
		]);
	});
});
