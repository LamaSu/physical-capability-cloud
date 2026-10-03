/**
 * Device intake — one iterative walk over arrays and objects, shared by the
 * secret scan (strings) and the key checks (keys). Internal to the intake
 * module; nothing here is exported through intake/index.ts.
 *
 * It descends into arrays and into every other non-null object (own
 * enumerable string keys, so a class instance is walked too, not skipped). An
 * array's elements are walked by index (a number), and any NAMED own enumerable
 * property on an array (JSON has none, but a JavaScript caller can attach one)
 * is a key like any object key: visited and walked (astra pack 120f). It
 * is iterative, so depth cannot overflow the stack, and each frame links to its
 * parent so a path is only built when a visitor asks for it. An object reachable
 * twice, or through a cycle, is visited once.
 */

/** One path step: an object key (a string, whatever it looks like) or an array index (a number). */
export type WalkPathSegment = string | number;

interface WalkFrame {
  node: unknown;
  parent: WalkFrame | null;
  key: WalkPathSegment;
}

function pathOf(frame: WalkFrame): WalkPathSegment[] {
  const segments: WalkPathSegment[] = [];
  for (let f: WalkFrame | null = frame; f !== null && f.parent !== null; f = f.parent) segments.push(f.key);
  return segments.reverse();
}

export interface WalkVisitor {
  /** A string value, with the path to it. Array indices are numbers; object keys are strings, even "123". */
  string?: (text: string, path: () => WalkPathSegment[]) => void;
  /** An object key (array indices are not keys), with the path to it, the key last. */
  key?: (key: string, path: () => WalkPathSegment[]) => void;
}

/** Is `key` an index of an array of this length (a canonical decimal below the length)? */
function isArrayIndex(key: string, length: number): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < length;
}

export function walkValue(root: unknown, visitor: WalkVisitor): void {
  const seen = new Set<object>();
  const stack: WalkFrame[] = [{ node: root, parent: null, key: "" }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = frame.node;
    if (typeof node === "string") {
      visitor.string?.(node, () => pathOf(frame));
      continue;
    }
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      // Named properties first onto the stack, so the indices are walked before them.
      const named = Object.keys(node).filter((k) => !isArrayIndex(k, node.length));
      for (const key of named) visitor.key?.(key, () => [...pathOf(frame), key]);
      for (let i = named.length - 1; i >= 0; i--) {
        const key = named[i]!;
        stack.push({ node: (node as unknown as Record<string, unknown>)[key], parent: frame, key });
      }
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], parent: frame, key: i });
      continue;
    }
    const entries = Object.entries(node);
    for (const [key] of entries) {
      visitor.key?.(key, () => [...pathOf(frame), key]);
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      stack.push({ node: entry[1], parent: frame, key: entry[0] });
    }
  }
}
