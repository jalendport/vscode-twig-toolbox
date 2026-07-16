import { describe, expect, it } from 'vitest';
import { TWIG_VERSION, isImplemented } from './index';

describe('parser placeholder', () => {
	it('targets Twig 3', () => {
		expect(TWIG_VERSION).toBe('3.x');
	});

	it('reports that no parser is implemented yet', () => {
		expect(isImplemented()).toBe(false);
	});
});
