import { describe, expect, it } from 'vitest';
import { isInside } from './workspace';

describe('isInside', () => {
	it('accepts the root itself and files nested at any depth, on POSIX paths', () => {
		expect(isInside('/home/project', '/home/project')).toBe(true);
		expect(isInside('/home/project/templates/index.twig', '/home/project')).toBe(true);
		expect(isInside('/home/project/a/b/c/index.twig', '/home/project')).toBe(true);
	});

	it('rejects paths outside the root, including sibling directories with a shared prefix', () => {
		expect(isInside('/home/other/index.twig', '/home/project')).toBe(false);
		expect(isInside('/home/project-legacy/index.twig', '/home/project')).toBe(false);
		expect(isInside('/home', '/home/project')).toBe(false);
	});

	it('tolerates a trailing separator on the root', () => {
		expect(isInside('/home/project/index.twig', '/home/project/')).toBe(true);
	});

	// Windows paths use `\` — this must hold even when the test itself runs on
	// POSIX, since the platform running the comparison is not what decides
	// which separator the paths being compared use.
	it('accepts the root itself and files nested at any depth, on Windows-style paths', () => {
		expect(isInside('C:\\Users\\dev\\project', 'C:\\Users\\dev\\project')).toBe(true);
		expect(
			isInside('C:\\Users\\dev\\project\\templates\\index.twig', 'C:\\Users\\dev\\project'),
		).toBe(true);
		expect(
			isInside('C:\\Users\\dev\\project\\a\\b\\c\\index.twig', 'C:\\Users\\dev\\project'),
		).toBe(true);
	});

	it('rejects Windows paths outside the root, including a shared-prefix sibling', () => {
		expect(isInside('C:\\Users\\dev\\other\\index.twig', 'C:\\Users\\dev\\project')).toBe(
			false,
		);
		expect(
			isInside('C:\\Users\\dev\\project-legacy\\index.twig', 'C:\\Users\\dev\\project'),
		).toBe(false);
	});

	it('tolerates a trailing separator on a Windows-style root', () => {
		expect(isInside('C:\\Users\\dev\\project\\index.twig', 'C:\\Users\\dev\\project\\')).toBe(
			true,
		);
	});
});
