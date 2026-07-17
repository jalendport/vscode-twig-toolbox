import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PhpClassIndex } from '../../scripts/lib/php-class';

/**
 * Inheritance factoring, as tests.
 *
 * The catalog stores every member exactly once, on the class that declares it,
 * and names the parent for the rest. That is what makes the class model
 * affordable: `craft\base\Element` has ~250 members and eight element types
 * inherit them, and a model that flattened them into each cost 1.6 MB and was
 * dropped for it.
 *
 * The split it turns on is `members()` versus `ownMembers()`, and the two have
 * to disagree in exactly one way — the parent's. Everything else about them is
 * shared, which is why the fixtures below are the smallest thing that can tell
 * them apart: a parent, a trait, a narrowing child, and a framework base the
 * walk must refuse to enter.
 */

const STOP_AT = new Set(['vendor\\base\\Component']);

function fixture(files: Record<string, string>): PhpClassIndex {
	const root = mkdtempSync(join(tmpdir(), 'php-class-'));
	for (const [path, contents] of Object.entries(files)) {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	}
	return new PhpClassIndex([{ prefix: 'app\\', directory: root }]);
}

const index = fixture({
	'base/Element.php': `<?php
namespace app\\base;

/**
 * An element.
 *
 * @property string $title the element title
 * @property-read string $url
 */
abstract class Element extends Component
{
    public function getUrl(): string {}
    public function hasErrors(): bool {}
}
`,
	'base/Component.php': `<?php
namespace app\\base;

class Component extends \\vendor\\base\\Component
{
    public function attachBehavior(): void {}
}
`,
	'elements/Entry.php': `<?php
namespace app\\elements;

use app\\base\\Element;
use app\\models\\Section;

/**
 * An entry.
 *
 * @property Section|null $section the entry section
 */
class Entry extends Element
{
    use HasAuthor;

    public function getSection(): Section {}
}
`,
	'elements/HasAuthor.php': `<?php
namespace app\\elements;

/**
 * @property string $author the entry author
 */
trait HasAuthor
{
    public function getAuthorName(): string {}
}
`,
	'models/Section.php': `<?php
namespace app\\models;

class Section
{
    public string $handle;
}
`,
});

describe('own members versus inherited members', () => {
	/**
	 * The whole point, in one assertion. `Entry` declares four things; the ~four
	 * it gets from `Element` are `Element`'s to store, and if they show up here
	 * the catalog has quietly gone back to being a flatten.
	 */
	it('leaves the parent’s members to the parent', () => {
		const own = index.ownMembers('app\\elements\\Entry', { stopAt: STOP_AT });

		expect(names(own).sort()).toEqual(['author', 'getAuthorName', 'getSection', 'section']);
		expect(names(own)).not.toContain('title');
		expect(names(own)).not.toContain('hasErrors');
	});

	it('still reports the parent’s members when asked for everything', () => {
		const all = names(index.members('app\\elements\\Entry', { stopAt: STOP_AT }));

		expect(all).toContain('section');
		expect(all).toContain('title');
		expect(all).toContain('hasErrors');
	});

	/**
	 * A trait is folded in rather than named, because a class uses several and
	 * `extends` is one link. It still remembers the trait as the declarer — that
	 * is what the documentation link is derived from, and it is not recoverable
	 * once the member is sitting on the class.
	 */
	it('folds a trait’s members in, remembering the trait declared them', () => {
		const own = index.ownMembers('app\\elements\\Entry', { stopAt: STOP_AT });
		const author = own.find((member) => member.name === 'author');
		const section = own.find((member) => member.name === 'section');

		expect(author?.declaringClass).toBe('app\\elements\\HasAuthor');
		expect(section?.declaringClass).toBe('app\\elements\\Entry');
	});

	it('names the parent it factors against', () => {
		expect(index.parentOf('app\\elements\\Entry', { stopAt: STOP_AT })).toBe(
			'app\\base\\Element',
		);
		expect(index.parentOf('app\\base\\Element', { stopAt: STOP_AT })).toBe(
			'app\\base\\Component',
		);
	});

	/**
	 * The chain has to end somewhere, and a class whose parent is on the stop list
	 * has no parent as far as the model is concerned. Reporting one would leave
	 * `extends` pointing at the object plumbing the stop list exists to keep out.
	 */
	it('reports no parent at a class the walk stops at', () => {
		const stopAt = new Set(['app\\base\\Component']);

		expect(index.parentOf('app\\base\\Element', { stopAt })).toBeUndefined();
		expect(names(index.members('app\\base\\Element', { stopAt }))).not.toContain(
			'attachBehavior',
		);
		// Without the stop, the same walk reaches it — so the stop is what did it.
		expect(names(index.members('app\\base\\Element', { stopAt: STOP_AT }))).toContain(
			'attachBehavior',
		);
	});

	/** The framework base at the end of the chain is the stop list's whole job. */
	it('reports no parent when the parent is the framework’s', () => {
		expect(index.parentOf('app\\base\\Component', { stopAt: STOP_AT })).toBeUndefined();
	});

	it('reports no parent for a class that has none', () => {
		expect(index.parentOf('app\\models\\Section', { stopAt: STOP_AT })).toBeUndefined();
	});

	it('resolves a member’s type through the file’s imports', () => {
		const section = index
			.ownMembers('app\\elements\\Entry', { stopAt: STOP_AT })
			.find((member) => member.name === 'section');

		expect(section?.typeClass).toBe('app\\models\\Section');
	});
});

/**
 * The bug this reader shipped with, kept fixed.
 *
 * `@property` lines run in long uninterrupted blocks, and most carry no trailing
 * summary. A summary pattern that can cross a newline reads the *next* property
 * line as this one's prose and consumes it — which silently drops every other
 * property in the run. It cost `craft\elements\Asset` ten of its documented
 * properties, `dataUrl` among them, and nothing failed.
 */
describe('docblock property runs', () => {
	const runs = fixture({
		'Runs.php': `<?php
namespace app;

/**
 * A class.
 *
 * @property-read string $first
 * @property-read string $second
 * @property-read string $third the third one
 * @property-read string $fourth
 * @method string doFirst()
 * @method string doSecond()
 */
class Runs {}
`,
	});

	it('reads every property in a run of them', () => {
		expect(names(runs.ownMembers('app\\Runs'))).toEqual(
			expect.arrayContaining(['first', 'second', 'third', 'fourth']),
		);
	});

	it('reads every method in a run of them', () => {
		expect(names(runs.ownMembers('app\\Runs'))).toEqual(
			expect.arrayContaining(['doFirst', 'doSecond']),
		);
	});

	it('still takes the summary that is actually on the line', () => {
		const third = runs.ownMembers('app\\Runs').find((member) => member.name === 'third');

		expect(third?.summary).toBe('the third one');
	});

	it('gives a property with no summary no summary at all', () => {
		const second = runs.ownMembers('app\\Runs').find((member) => member.name === 'second');

		expect(second?.summary).toBeUndefined();
	});
});

function names(members: readonly { name: string }[]): string[] {
	return members.map((member) => member.name);
}
