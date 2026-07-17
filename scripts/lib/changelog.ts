import type { CatalogEntryKind } from '../../packages/language-server/src/catalog';
import { compareVersions } from '../../packages/language-server/src/catalog';

/**
 * Release notes, read for the one fact they carry that nothing else does: which
 * version each tag, filter, function, test and global first shipped in.
 *
 * Both projects keep a changelog whose headings are versions and whose lines are
 * prose, and prose is where this could go wrong. "Added the `|money` Twig
 * filter" names a filter; "Add `SupportDefinedTestInterface` for expression
 * nodes supporting the `defined` test" names an interface and mentions a test
 * that is twelve years old. A parser that took every backticked name near a kind
 * word would date `defined` to 3.21 and gate it out of every project.
 *
 * So the grammar is anchored rather than searched: the verb, an optional
 * article, the names, the kind — adjacent, in that order, or no claim at all.
 * Every line here is a line someone wrote by hand, and a version this cannot be
 * sure of is a version the caller is better off not having: the fallbacks it
 * declines to override (a `<Since>` badge, the 4-vs-5 diff, no gating at all)
 * are all coarse rather than wrong.
 */

/** First version of one major that has each name, by kind. */
export type ChangelogVersions = Record<CatalogEntryKind, Map<string, string>>;

/** One release heading and the lines under it. */
interface Release {
	readonly version: string;
	readonly lines: readonly string[];
}

/** A line's claim: these names, of this kind, arrived here. */
interface Claim {
	readonly kind: CatalogEntryKind;
	readonly names: readonly string[];
}

const KIND_BY_WORD: Record<string, CatalogEntryKind> = {
	filter: 'filters',
	function: 'functions',
	tag: 'tags',
	test: 'tests',
	variable: 'globals',
};

/**
 * Craft's `CHANGELOG-v4.md` / `CHANGELOG-v5.md`.
 *
 * `- Added the `|money` Twig filter.` — Craft writes these to a house style
 * consistent enough to parse, including the sigils (`|filter`, `function()`,
 * `{% tag %}`) that say which kind a name is even where the prose does not.
 */
export function parseCraftChangelog(markdown: string, major: number): ChangelogVersions {
	return collect(readReleases(markdown, /^##\s+(\d[\d.]*)\s+-\s/, major), readCraftClaim);
}

/**
 * Twig's `CHANGELOG`.
 *
 * Looser prose than Craft's, and the same grammar underneath: ` * Add the
 * `invoke` filter`. The looseness is all in what it declines — "Add support for
 * named arguments to the `block` and `attribute` functions" is a line about two
 * functions that predate this file, and it names them right where a claim would.
 */
export function parseTwigChangelog(text: string, major: number): ChangelogVersions {
	return collect(
		readReleases(text, /^#\s+(\d[\d.]*)(?:-[A-Za-z0-9.]+)?\s+\(/, major),
		readTwigClaim,
	);
}

/**
 * The earliest release claiming each name wins.
 *
 * A name is claimed twice when a release backports it: Craft 5.9.0 added
 * `uuid()` and says so in two of its own entries. Earliest is both the true
 * answer and the safe one — it errs towards offering a name a project might not
 * have, rather than hiding one it does.
 */
function collect(
	releases: readonly Release[],
	readClaim: (line: string) => Claim | undefined,
): ChangelogVersions {
	const versions = emptyVersions();

	for (const release of releases) {
		for (const line of release.lines) {
			const claim = readClaim(line);
			if (claim === undefined) {
				continue;
			}
			for (const name of claim.names) {
				const known = versions[claim.kind].get(name);
				if (known === undefined || compareVersions(release.version, known) < 0) {
					versions[claim.kind].set(name, release.version);
				}
			}
		}
	}

	return versions;
}

/**
 * Releases of `major`, in file order.
 *
 * The major check is not ceremony: these files are per-major by convention, and
 * a `4.x` heading appearing in `CHANGELOG-v5.md` would silently date Craft 5
 * names to Craft 4 versions. The convention holds today; the check is what makes
 * that a fact rather than an assumption.
 */
function readReleases(text: string, heading: RegExp, major: number): Release[] {
	const releases: Release[] = [];
	let current: { version: string; lines: string[] } | undefined;

	for (const line of text.split('\n')) {
		const match = heading.exec(line);
		if (match !== null) {
			const version = match[1] as string;
			current = versionMajor(version) === major ? { version, lines: [] } : undefined;
			if (current !== undefined) {
				releases.push(current);
			}
			continue;
		}
		current?.lines.push(line);
	}

	return releases;
}

/** `- Added the `|money` Twig filter.` */
function readCraftClaim(line: string): Claim | undefined {
	const opening = /^[-*]\s+Added\s+(?:an?|the)\s+(?:new\s+)?(?=`)/.exec(line);
	if (opening === null) {
		return undefined;
	}

	const read = readNames(line.slice(opening[0].length), craftName);
	if (read === undefined) {
		return undefined;
	}

	// `global Twig variable` is the only kind Craft names with a word that means
	// something else on its own, so it is the only one that must carry it.
	const kind = /^\s+(global\s+)?Twig\s+(filter|function|tag|test|variable)s?\b/.exec(read.rest);
	if (kind === null) {
		return undefined;
	}
	const word = kind[2] as string;
	if (word === 'variable' && kind[1] === undefined) {
		return undefined;
	}

	return { kind: KIND_BY_WORD[word] as CatalogEntryKind, names: read.names };
}

/** ` * Add the `invoke` filter` */
function readTwigClaim(line: string): Claim | undefined {
	// Twig writes its notes in the imperative ("Add the `invoke` filter") and
	// occasionally slips into the past tense, and drops the article as often as
	// not — so both, and the article optional.
	const opening = /^\s*\*\s+Add(?:ed)?\s+(?:(?:an?|the)\s+)?(?:new\s+)?(?=`)/.exec(line);
	if (opening === null) {
		return undefined;
	}

	const read = readNames(line.slice(opening[0].length), twigName);
	if (read === undefined) {
		return undefined;
	}

	const kind = /^\s+(filter|function|tag|test)s?\b/.exec(read.rest);
	if (kind === null) {
		return undefined;
	}

	return { kind: KIND_BY_WORD[kind[1] as string] as CatalogEntryKind, names: read.names };
}

/**
 * The run of backticked names a claim opens with, and what follows them.
 *
 * All or nothing: one name in the run that does not normalise to an identifier
 * means the line is not the shape this thinks it is, and the whole line is
 * dropped rather than the parts of it that happened to parse. That is what
 * refuses `` `heading()`/`h()` and `h1()`…`h6()` `` — the ellipsis is a range
 * written for a human, and reading it literally would claim two of the six.
 */
function readNames(
	text: string,
	normalize: (raw: string) => string | undefined,
): { names: string[]; rest: string } | undefined {
	const names: string[] = [];
	let rest = text;

	for (;;) {
		const match = /^`([^`]+)`/.exec(rest);
		if (match === null) {
			return undefined;
		}

		const name = normalize(match[1] as string);
		if (name === undefined) {
			return undefined;
		}
		names.push(name);
		rest = rest.slice(match[0].length);

		const separator = /^(?:\s*,\s*|\s*\/\s*|\s*,?\s+and\s+)(?=`)/.exec(rest);
		if (separator === null) {
			return { names, rest };
		}
		rest = rest.slice(separator[0].length);
	}
}

/**
 * `|money`, `uuid()`, `{% dd %}`, `primarySite` — Craft writes a name the way a
 * template does, and the sigils come off to leave the name the catalog keys on.
 */
function craftName(raw: string): string | undefined {
	const tag = /^\{%[-~]?\s*([A-Za-z_][A-Za-z0-9_]*)[\s\S]*%\}$/.exec(raw);
	const cleaned = tag?.[1] ?? raw.replace(/^\|/, '').replace(/\(\)$/, '');
	return identifier(cleaned);
}

function twigName(raw: string): string | undefined {
	return identifier(raw.replace(/^\|/, '').replace(/\(\)$/, ''));
}

function identifier(value: string): string | undefined {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : undefined;
}

function versionMajor(version: string): number {
	return Number.parseInt(version.split('.')[0] as string, 10);
}

function emptyVersions(): ChangelogVersions {
	return {
		tags: new Map(),
		filters: new Map(),
		functions: new Map(),
		tests: new Map(),
		globals: new Map(),
	};
}
