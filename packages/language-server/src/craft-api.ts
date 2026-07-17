/**
 * URLs into Craft's generated class reference at `docs.craftcms.com/api`.
 *
 * The reference is generated per major, one page per class, named after the
 * fully-qualified name: `craft\web\Request` → `craft-web-request.html`.
 *
 * Anchors are the interesting part, because the reference only anchors what a
 * class *declares*. `craft\web\Request` declares `queryStringWithoutPath`, so
 * `#property-querystringwithoutpath` exists on its page; it inherits
 * `queryString` from `yii\web\Request`, and there is no anchor for it anywhere —
 * the reference documents Craft, so it has no `yii-*` pages at all.
 *
 * That splits members in two, and this module is where the split lives:
 *
 * - Declared by a `craft\*` class → that class's page, anchored at the member.
 *   The declaring class is what picks the page, not the class being dotted into:
 *   `craft.app.sites` is declared on `craft\base\ApplicationTrait`, and its
 *   anchor is on the trait's page rather than `craft\web\Application`'s, which
 *   carries only the four components `Application` itself declares.
 * - Inherited from `yii\*` → the page of the Craft class being dotted into,
 *   anchored at the section that lists it. A link one section away from the
 *   answer beats a link to a page that 404s.
 *
 * These URLs are *derived*, never stored. A pack that baked them in would carry
 * ~40 bytes per member for a string that is a pure function of three fields it
 * already has, and would have to bake one major's answer in for both — which is
 * how a Craft 4 project ends up reading Craft 5's signatures. The project's own
 * major picks the version here, at the point where the project is known.
 */

export type CraftMajor = 4 | 5;

/** The major the class model is generated from, and the reference it names. */
export const GENERATED_MAJOR: CraftMajor = 5;

export interface MemberUrlTarget {
	readonly major: CraftMajor;
	/** Craft class being dotted into — the fallback page for inherited members. */
	readonly objectClass: string;
	/** Class that actually declares the member; may be a parent, trait or Yii's. */
	readonly declaringClass: string;
	readonly kind: 'property' | 'method';
	readonly name: string;
}

/** True for a class Craft's reference has a page for. */
export function isCraftClass(fqn: string): boolean {
	return fqn.startsWith('craft\\');
}

export function apiPageUrl(major: CraftMajor, fqn: string): string {
	return `https://docs.craftcms.com/api/v${major}/${fqn.replace(/\\/g, '-').toLowerCase()}.html`;
}

export function apiMemberUrl({
	major,
	objectClass,
	declaringClass,
	kind,
	name,
}: MemberUrlTarget): string {
	if (isCraftClass(declaringClass)) {
		return `${apiPageUrl(major, declaringClass)}#${kind}-${name.toLowerCase()}`;
	}

	const section = kind === 'property' ? 'public-properties' : 'public-methods';
	return `${apiPageUrl(major, objectClass)}#${section}`;
}

/**
 * The major to derive links for, from the version the project locked.
 *
 * Anything the model was not generated against — a Craft 6, an unreadable
 * version — falls back to the generated major: the reference that exists beats a
 * guess at a URL that may not.
 */
export function craftMajor(version: string | undefined): CraftMajor {
	const major =
		version === undefined ? Number.NaN : Number.parseInt(version.replace(/^v/i, ''), 10);
	return major === 4 ? 4 : GENERATED_MAJOR;
}
