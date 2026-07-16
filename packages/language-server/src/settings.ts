export type UnknownNamesSetting = 'off' | 'hint' | 'warning' | 'error';

export interface TwigToolboxSettings {
	templateRoots: string[];
	diagnostics: {
		unknownNames: UnknownNamesSetting;
		ignoredNames: string[];
	};
}

export const DEFAULT_SETTINGS: TwigToolboxSettings = {
	templateRoots: [],
	diagnostics: {
		unknownNames: 'off',
		ignoredNames: [],
	},
};

export function normalizeSettings(value: unknown): TwigToolboxSettings {
	const root = readRecord(value);
	const diagnostics = root?.diagnostics ?? value;
	const diagnosticSettings = readRecord(diagnostics);
	const unknownNames = normalizeUnknownNames(diagnosticSettings?.unknownNames);
	const ignoredNames = Array.isArray(diagnosticSettings?.ignoredNames)
		? diagnosticSettings.ignoredNames.filter((name): name is string => typeof name === 'string')
		: DEFAULT_SETTINGS.diagnostics.ignoredNames;
	const templateRoots = Array.isArray(root?.templateRoots)
		? root.templateRoots.filter((path): path is string => typeof path === 'string')
		: DEFAULT_SETTINGS.templateRoots;

	return {
		templateRoots,
		diagnostics: {
			unknownNames,
			ignoredNames,
		},
	};
}

function normalizeUnknownNames(value: unknown): UnknownNamesSetting {
	return value === 'hint' || value === 'warning' || value === 'error'
		? value
		: DEFAULT_SETTINGS.diagnostics.unknownNames;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}
