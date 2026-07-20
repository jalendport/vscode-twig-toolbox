import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocumentStore } from './document-store';
import { filePathToUri } from './workspace';

describe('DocumentStore external entry cache', () => {
	it('evicts the least recently used external document past the cache cap', () => {
		const root = mkdtempSync(join(tmpdir(), 'twig-toolbox-document-store-'));
		try {
			const resolveCalls = new Map<string, number>();
			const store = new DocumentStore({
				resolveWorkspaceContext: (uri) => {
					resolveCalls.set(uri, (resolveCalls.get(uri) ?? 0) + 1);
					return {};
				},
			});

			const uris: string[] = [];
			for (let index = 0; index < 300; index++) {
				const path = join(root, `template-${index}.twig`);
				writeFileSync(path, `{{ ${index} }}`);
				uris.push(filePathToUri(path));
			}
			for (const uri of uris) {
				store.getParsedFile(uri);
			}

			// The first file touched is also the least recently used once 300
			// distinct files pushed it out past the ~256-entry cap — asking for
			// it again is a cache miss, so the workspace context is resolved a
			// second time.
			const first = uris[0]!;
			expect(resolveCalls.get(first)).toBe(1);
			store.getParsedFile(first);
			expect(resolveCalls.get(first)).toBe(2);

			// The most recently touched file is still cached: no second resolve.
			const last = uris[uris.length - 1]!;
			expect(resolveCalls.get(last)).toBe(1);
			store.getParsedFile(last);
			expect(resolveCalls.get(last)).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
