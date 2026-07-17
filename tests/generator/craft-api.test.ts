import { describe, expect, it } from 'vitest';

import {
	apiMemberUrl,
	apiPageUrl,
	isCraftClass,
} from '../../packages/language-server/src/craft-api';

/**
 * The link policy, as tests.
 *
 * These are the two cases the whole `craft.app.*` model turns on, and they are
 * checked here rather than against the catalog because they are a rule, not a
 * scrape: every one of the ~1,300 member links in the pack is one of these two
 * shapes, and the pack is only right if the rule is.
 *
 * Every URL below was checked against the published reference. That is not
 * incidental — an anchor is either on the page or it is not, and a link policy
 * derived from how documentation generators "usually" work is a guess.
 */

describe('class reference pages', () => {
	it('names a page after the fully-qualified class', () => {
		expect(apiPageUrl(5, 'craft\\web\\Request')).toBe(
			'https://docs.craftcms.com/api/v5/craft-web-request.html',
		);
	});

	it('publishes the same page per major', () => {
		expect(apiPageUrl(4, 'craft\\web\\Request')).toBe(
			'https://docs.craftcms.com/api/v4/craft-web-request.html',
		);
	});

	it('lowercases a class whose name is not', () => {
		expect(apiPageUrl(5, 'craft\\config\\GeneralConfig')).toBe(
			'https://docs.craftcms.com/api/v5/craft-config-generalconfig.html',
		);
	});

	it('knows which classes the reference documents', () => {
		expect(isCraftClass('craft\\web\\Request')).toBe(true);
		expect(isCraftClass('yii\\web\\Request')).toBe(false);
	});
});

describe('members a Craft class declares', () => {
	// `craft\web\Request` declares this one, so its page anchors it.
	it('anchors a property on the declaring class’s page', () => {
		expect(
			apiMemberUrl({
				major: 5,
				objectClass: 'craft\\web\\Request',
				declaringClass: 'craft\\web\\Request',
				kind: 'property',
				name: 'queryStringWithoutPath',
			}),
		).toBe(
			'https://docs.craftcms.com/api/v5/craft-web-request.html#property-querystringwithoutpath',
		);
	});

	it('anchors a method by name', () => {
		expect(
			apiMemberUrl({
				major: 5,
				objectClass: 'craft\\web\\Request',
				declaringClass: 'craft\\web\\Request',
				kind: 'method',
				name: 'getFullPath',
			}),
		).toBe('https://docs.craftcms.com/api/v5/craft-web-request.html#method-getfullpath');
	});

	/**
	 * The declaring class picks the page, not the class being dotted into.
	 *
	 * `craft.app.sites` is declared on `ApplicationTrait`, and the reference
	 * anchors it on the trait's page — `craft-web-application.html` carries only
	 * the four components `Application` declares itself. Anchoring this one on
	 * the object's page would be a link to a page without the anchor on it.
	 */
	it('follows a member declared on a trait to the trait’s page', () => {
		expect(
			apiMemberUrl({
				major: 5,
				objectClass: 'craft\\web\\Application',
				declaringClass: 'craft\\base\\ApplicationTrait',
				kind: 'property',
				name: 'sites',
			}),
		).toBe('https://docs.craftcms.com/api/v5/craft-base-applicationtrait.html#property-sites');
	});
});

describe('members inherited from Yii', () => {
	/**
	 * `queryString` is `yii\web\Request`'s. The reference has no `yii-*` pages
	 * and no anchor for it on Craft's page, so the link goes to the section of
	 * the Craft page that lists it — one scroll from the answer, rather than a
	 * 404.
	 */
	it('falls back to the section anchor on the Craft class’s page', () => {
		expect(
			apiMemberUrl({
				major: 5,
				objectClass: 'craft\\web\\Request',
				declaringClass: 'yii\\web\\Request',
				kind: 'property',
				name: 'queryString',
			}),
		).toBe('https://docs.craftcms.com/api/v5/craft-web-request.html#public-properties');
	});

	it('sends an inherited method to the methods section', () => {
		expect(
			apiMemberUrl({
				major: 5,
				objectClass: 'craft\\web\\Request',
				declaringClass: 'yii\\web\\Request',
				kind: 'method',
				name: 'getHeaders',
			}),
		).toBe('https://docs.craftcms.com/api/v5/craft-web-request.html#public-methods');
	});

	it('keeps the fallback on the page of the class being dotted into', () => {
		expect(
			apiMemberUrl({
				major: 4,
				objectClass: 'craft\\web\\User',
				declaringClass: 'yii\\web\\User',
				kind: 'property',
				name: 'isGuest',
			}),
		).toBe('https://docs.craftcms.com/api/v4/craft-web-user.html#public-properties');
	});
});
