/** One line in a proposed full-file replacement. Newline bytes stay attached. */
export interface DiffRow {
  kind: "equal" | "delete" | "insert";
  raw: string;
  text: string;
  ending: "LF" | "CRLF" | "CR" | "";
  oldLine?: number;
  newLine?: number;
  /** Present only for a line the user can accept or reject. */
  changeId?: number;
}

export interface DiffHunk {
  id: number;
  oldStart: number;
  newStart: number;
  rows: DiffRow[];
}

export interface ReviewDiff {
  rows: DiffRow[];
  hunks: DiffHunk[];
  changeCount: number;
  additions: number;
  deletions: number;
}

interface Edit {
  kind: "equal" | "delete" | "insert";
  raw: string;
}

/**
 * Keep line endings in the tokens. That makes every partial application an
 * exact combination of the old and proposed bytes, including a final newline.
 */
function tokens(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function endingOf(raw: string): DiffRow["ending"] {
  if (raw.endsWith("\r\n")) return "CRLF";
  if (raw.endsWith("\n")) return "LF";
  if (raw.endsWith("\r")) return "CR";
  return "";
}

function textOf(raw: string): string {
  return raw.replace(/\r\n$|\r$|\n$/, "");
}

/** Myers' line diff. Its memory grows with edit distance rather than N x M. */
function editsBetween(before: string, after: string): Edit[] {
  const oldLines = tokens(before);
  const newLines = tokens(after);
  const maximum = oldLines.length + newLines.length;
  let frontier = new Map<number, number>();
  frontier.set(1, 0);
  const trace: Map<number, number>[] = [];

  for (let distance = 0; distance <= maximum; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? -1;
      const right = frontier.get(diagonal - 1) ?? -1;
      let oldIndex: number;

      if (diagonal === -distance || (diagonal !== distance && right < down)) {
        oldIndex = Math.max(0, down);
      } else {
        oldIndex = Math.max(0, right + 1);
      }

      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < oldLines.length &&
        newIndex < newLines.length &&
        oldLines[oldIndex] === newLines[newIndex]
      ) {
        oldIndex++;
        newIndex++;
      }
      frontier.set(diagonal, oldIndex);

      if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
        return backtrack(trace, oldLines, newLines);
      }
    }
  }

  return [];
}

function backtrack(
  trace: Map<number, number>[],
  oldLines: string[],
  newLines: string[]
): Edit[] {
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;
  const reversed: Edit[] = [];

  for (let distance = trace.length - 1; distance >= 0; distance--) {
    const frontier = trace[distance];
    const diagonal = oldIndex - newIndex;
    const down = frontier.get(diagonal + 1) ?? -1;
    const right = frontier.get(diagonal - 1) ?? -1;
    const previousDiagonal =
      diagonal === -distance || (diagonal !== distance && right < down)
        ? diagonal + 1
        : diagonal - 1;
    const previousOld = Math.max(0, frontier.get(previousDiagonal) ?? 0);
    const previousNew = previousOld - previousDiagonal;

    while (oldIndex > previousOld && newIndex > previousNew) {
      reversed.push({ kind: "equal", raw: oldLines[oldIndex - 1] });
      oldIndex--;
      newIndex--;
    }

    if (distance === 0) break;
    if (oldIndex === previousOld) {
      reversed.push({ kind: "insert", raw: newLines[newIndex - 1] });
      newIndex--;
    } else {
      reversed.push({ kind: "delete", raw: oldLines[oldIndex - 1] });
      oldIndex--;
    }
  }

  return reversed.reverse();
}

/** Build line numbers and compact, three-context-line review hunks. */
export function buildReviewDiff(before: string, after: string, context = 3): ReviewDiff {
  let oldLine = 1;
  let newLine = 1;
  let changeId = 0;
  let additions = 0;
  let deletions = 0;

  const rows = editsBetween(before, after).map((edit): DiffRow => {
    const row: DiffRow = {
      ...edit,
      text: textOf(edit.raw),
      ending: endingOf(edit.raw),
    };
    if (edit.kind !== "insert") row.oldLine = oldLine++;
    if (edit.kind !== "delete") row.newLine = newLine++;
    if (edit.kind !== "equal") {
      row.changeId = changeId++;
      if (edit.kind === "insert") additions++;
      else deletions++;
    }
    return row;
  });

  const changedAt = rows
    .map((row, index) => (row.changeId === undefined ? -1 : index))
    .filter((index) => index >= 0);
  const spans: Array<{ start: number; end: number }> = [];

  for (const index of changedAt) {
    const previous = spans[spans.length - 1];
    if (!previous || index - previous.end > context * 2 + 1) {
      spans.push({ start: index, end: index });
    } else {
      previous.end = index;
    }
  }

  const hunks = spans.map((span, id): DiffHunk => {
    const visible = rows.slice(
      Math.max(0, span.start - context),
      Math.min(rows.length, span.end + context + 1)
    );
    return {
      id,
      oldStart: visible.find((row) => row.oldLine !== undefined)?.oldLine ?? 0,
      newStart: visible.find((row) => row.newLine !== undefined)?.newLine ?? 0,
      rows: visible,
    };
  });

  return { rows, hunks, changeCount: changeId, additions, deletions };
}

/** Produce the file made from exactly the changed lines the user selected. */
export function applySelectedLines(
  before: string,
  after: string,
  diff: ReviewDiff,
  selectedIds: ReadonlySet<number>
): string {
  if (diff.changeCount === 0 || selectedIds.size === diff.changeCount) return after;
  if (selectedIds.size === 0) return before;

  let result = "";
  for (const row of diff.rows) {
    if (row.kind === "equal") result += row.raw;
    else if (row.kind === "delete" && !selectedIds.has(row.changeId!)) result += row.raw;
    else if (row.kind === "insert" && selectedIds.has(row.changeId!)) result += row.raw;
  }
  return result;
}
