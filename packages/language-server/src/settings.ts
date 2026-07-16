export type UnknownNamesSetting = 'off' | 'hint' | 'warning' | 'error';

export interface TwigToolboxSettings {
	diagnostics: {
		unknownNames: UnknownNamesSetting;
		ignoredNames: string[];
	};
}

export const DEFAULT_SETTINGS: TwigToolboxSettings = {
	diagnostics: {
		unknownNames: 'off',
		ignoredNames: [],
	},
};

export function normalizeSettings(value: unknown): TwigToolboxSettings {
	const diagnostics = readRecord(value)?.diagnostics ?? value;
	const diagnosticSettings = readRecord(diagnostics);
	const unknownNames = normalizeUnknownNames(diagnosticSettings?.unknownNames);
	const ignoredNames = Array.isArray(diagnosticSettings?.ignoredNames)
		? diagnosticSettings.ignoredNames.filter((name): name is string => typeof name === 'string')
		: DEFAULT_SETTINGS.diagnostics.ignoredNames;

	return {
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
