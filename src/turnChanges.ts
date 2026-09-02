/**
 * What a turn actually changed on disk, for the keep-or-undo card in the chat.
 *
 * Every file the turn touched was snapshotted before Kiro ran. Comparing those
 * snapshots against what is there now is the only honest way to know what
 * changed: Kiro sometimes rewrites a file with exactly what it already held,
 * and a rejected review restores the original. Offering to undo either would
 * be offering to undo nothing.
 *
 * Free of any `vscode` import so it can be exercised on its own — see
 * `test/turnChanges.test.js`.
 */

export interface FileSnapshotLike {
  full: string;
  exists: boolean;
  content: string;
}

export interface TurnChange {
  path: string;
  /** Shown in the card; the caller supplies something workspace-relative. */
  label?: string;
  kind: "created" | "modified" | "deleted";
}

/**
 * The files that differ from their pre-turn snapshot.
 *
 * `readNow` returns undefined when the file cannot be read at all. That file
 * is left out rather than guessed at — claiming a change we cannot see would
 * put a file in the undo list that we might then restore wrongly.
 */
export function changedSinceBaseline(
  baselines: readonly FileSnapshotLike[] | undefined,
  readNow: (full: string) => FileSnapshotLike | undefined
): TurnChange[] {
  const out: TurnChange[] = [];

  for (const before of baselines ?? []) {
    const now = readNow(before.full);
    if (!now) continue;

    if (!before.exists && now.exists) {
      out.push({ path: before.full, kind: "created" });
      continue;
    }
    if (before.exists && !now.exists) {
      out.push({ path: before.full, kind: "deleted" });
      continue;
    }
    if (before.exists && now.exists && before.content !== now.content) {
      out.push({ path: before.full, kind: "modified" });
    }
  }
  return out;
}

/** The card's one-line summary. One file is worth naming; several are not. */
export function describeChange(changes: readonly TurnChange[]): string {
  if (changes.length === 0) return "";
  if (changes.length === 1) {
    return `Kiro changed ${changes[0].label ?? changes[0].path}.`;
  }
  return `Kiro changed ${changes.length} files.`;
}
