import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const cacheRoot = join(repoRoot, '.cache');

export interface CheckoutOptions {
	readonly directory: string;
	readonly repository: string;
	/** Full commit SHA. Nothing here accepts a branch: a moving ref is not a pin. */
	readonly ref: string;
	/** Cone-mode paths. Omit to check out the whole tree. */
	readonly sparsePaths?: readonly string[];
}

/**
 * A pinned, offline-repeatable checkout in `.cache/`.
 *
 * Blobless and shallow because these repos are large and the generators read a
 * few dozen files out of them; sparse because checking out all of `craftcms/cms`
 * to read `src/web/twig` is minutes of I/O for nothing. Re-running against an
 * existing checkout is cheap and lands on the same commit, which is what makes
 * `npm run generate:craft` deterministic rather than merely repeatable-today.
 *
 * A ref already in `.cache/` is not fetched again. Every ref here is a full
 * commit SHA, so "already have it" is the whole question — there is no newer
 * version of a commit to miss, and re-running the generators on a plane or a
 * train should not be a network operation.
 */
export function ensureCheckout({
	directory,
	repository,
	ref,
	sparsePaths,
}: CheckoutOptions): string {
	mkdirSync(cacheRoot, { recursive: true });

	if (!existsSync(join(directory, '.git'))) {
		run('git', ['clone', '--filter=blob:none', '--no-checkout', repository, directory]);
	}

	if (sparsePaths !== undefined && sparsePaths.length > 0) {
		run('git', ['sparse-checkout', 'set', '--cone', ...sparsePaths], directory);
	}

	if (!hasCommit(directory, ref)) {
		run('git', ['fetch', '--depth', '1', 'origin', ref], directory);
	}
	run('git', ['checkout', '--detach', ref], directory);

	return directory;
}

/** Whether the checkout already has `ref`'s commit object. */
function hasCommit(directory: string, ref: string): boolean {
	try {
		execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
			cwd: directory,
			stdio: 'ignore',
		});
		return true;
	} catch {
		return false;
	}
}

function run(command: string, args: readonly string[], cwd?: string): void {
	execFileSync(command, [...args], {
		...(cwd === undefined ? {} : { cwd }),
		stdio: 'inherit',
	});
}
