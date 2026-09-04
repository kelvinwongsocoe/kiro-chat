/**
 * Deciding whether a path is really inside the folders the user opened.
 *
 * This backs `KiroSession.resolveInsideWorkspace`, which is the security
 * boundary every path Kiro asks for goes through. It used to compare the paths
 * as written: that defeats `../`, but it says nothing about a symlink or a
 * Windows junction sitting *inside* the workspace and pointing out of it. Such
 * a path resolves to an in-workspace string and sailed straight through, which
 * is not what "reading and writing is limited to your open folders" promises.
 *
 * Free of any `vscode` import so it can be exercised on its own — see
 * `test/workspaceBoundary.test.js` — and synchronous, because
 * `observeDirectFileWrite` runs inside a notification handler and cannot await.
 */

import * as path from "node:path";
import * as fs from "node:fs";

/**
 * `realpathSync.native` resolves junctions and canonicalises the drive-letter
 * case, which the JavaScript implementation does not always do on Windows. It
 * can throw on paths the JS one handles, so it is tried first, not trusted.
 */
function defaultRealpath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return fs.realpathSync(target);
  }
}

/**
 * Where a path really points, even when it does not exist yet.
 *
 * A file being created has no real path of its own, but the directory it lands
 * in does — and that is the part a link could redirect. So walk up to the
 * nearest ancestor that exists, resolve that, and put the remainder back on the
 * end. A path with no existing ancestor at all resolves to itself: there is
 * nothing that could be a link, so there is nothing to see through.
 */
export function realPathOf(
  target: string,
  resolve: (value: string) => string = defaultRealpath
): string {
  const absolute = path.resolve(target);
  let head = absolute;
  const tail: string[] = [];

  for (;;) {
    try {
      const real = resolve(head);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Whole-segment containment. `path.relative` is case-insensitive on Windows,
 * so this does not have to normalise the spelling itself.
 */
export function isInsideRoot(root: string, full: string): boolean {
  const relative = path.relative(root, full);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * True when `full` really lands inside one of `roots`.
 *
 * Both sides are resolved: a workspace folder reached through a link would
 * otherwise never contain anything, since every file under it resolves to the
 * link's target instead.
 */
export function isInsideAnyRoot(
  roots: readonly string[],
  full: string,
  resolve?: (value: string) => string
): boolean {
  const real = realPathOf(full, resolve);
  return roots.some((root) => isInsideRoot(realPathOf(root, resolve), real));
}
