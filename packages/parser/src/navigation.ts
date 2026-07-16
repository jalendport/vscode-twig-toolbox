import type { AnyNode } from './ast';

/**
 * Offset → node lookup. Completions and hover both need "what am I inside, and
 * what encloses it"; `nodePathAt` answers both in one walk.
 */

function isNode(value: unknown): value is AnyNode {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as { type?: unknown; start?: unknown; end?: unknown };
	return (
		typeof candidate.type === 'string' &&
		typeof candidate.start === 'number' &&
		typeof candidate.end === 'number'
	);
}

function collect(value: unknown, out: AnyNode[]): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collect(item, out);
		}
		return;
	}
	if (isNode(value)) {
		out.push(value);
	}
}

/**
 * Direct child nodes, in source order.
 *
 * Discovered reflectively: every AST node reaches its children through plain
 * properties or arrays of them, so new node types need no registration here.
 * Plain `SourceRange` fields (`nameRange`, `operatorRange`…) are skipped because
 * they carry no `type`.
 */
export function childNodes(node: AnyNode): AnyNode[] {
	const out: AnyNode[] = [];
	for (const value of Object.values(node)) {
		collect(value, out);
	}
	return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Depth-first walk, parents before children. Return false to skip a subtree. */
export function visit(
	root: AnyNode,
	enter: (node: AnyNode, ancestors: AnyNode[]) => boolean | void,
): void {
	const ancestors: AnyNode[] = [];
	const walk = (node: AnyNode): void => {
		if (enter(node, ancestors) === false) {
			return;
		}
		ancestors.push(node);
		for (const child of childNodes(node)) {
			walk(child);
		}
		ancestors.pop();
	};
	walk(root);
}

/**
 * Chain of nodes containing `offset`, outermost first.
 *
 * Ranges are treated as closed on both ends so a cursor resting immediately
 * after a token still resolves inside it — `{{ user.| }}` must land on the
 * `MemberAccess`, which is the whole point of keeping incomplete nodes.
 */
export function nodePathAt(root: AnyNode, offset: number): AnyNode[] {
	if (offset < root.start || offset > root.end) {
		return [];
	}

	const path: AnyNode[] = [root];
	let current = root;
	for (;;) {
		let next: AnyNode | undefined;
		for (const child of childNodes(current)) {
			if (child.start <= offset && offset <= child.end) {
				// Later children win ties: at a shared boundary the cursor belongs
				// to the construct being typed, not the one just finished.
				next = child;
			}
		}
		if (next === undefined) {
			return path;
		}
		path.push(next);
		current = next;
	}
}

/** Innermost node containing `offset`, or undefined if outside the tree. */
export function nodeAt(root: AnyNode, offset: number): AnyNode | undefined {
	return nodePathAt(root, offset).at(-1);
}

/** Nearest ancestor (or `node` itself) matching `type`. */
export function findAncestor<T extends AnyNode['type']>(
	path: readonly AnyNode[],
	type: T,
): Extract<AnyNode, { type: T }> | undefined {
	for (let at = path.length - 1; at >= 0; at--) {
		const node = path[at];
		if (node?.type === type) {
			return node as Extract<AnyNode, { type: T }>;
		}
	}
	return undefined;
}
