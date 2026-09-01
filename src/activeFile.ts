/**
 * The file you are looking at rides along with your message, the way Copilot
 * Chat does it, so Kiro can open it without being asked.
 *
 * Free of any `vscode` import so it can be exercised on its own — see
 * `test/activeFile.test.js`.
 */

import { samePath } from "./paths";

/** What the editor is showing right now. */
export interface ActiveFile {
  /** Full path on disk. */
  path: string;
  /** How it is named on the chip, relative to the folder. */
  label: string;
}

/** The shape the rest of the code passes around for an attachment. */
export interface FileAttachment {
  id: string;
  kind: "file";
  label: string;
  path: string;
}

/**
 * Marked out with its own id prefix so the panel can tell the automatic one
 * from a file the user attached by hand.
 */
export function activeFileAttachment(active: ActiveFile): FileAttachment {
  return {
    id: `active:${active.path}`,
    kind: "file",
    label: active.label,
    path: active.path,
  };
}

/**
 * What actually goes with the message: whatever the user attached, plus the
 * file they are looking at.
 *
 * Attaching the same file twice sends it to Kiro twice, so a file already
 * attached by hand wins and the automatic one is dropped.
 */
export function attachmentsForMessage<T extends { path?: string }>(
  attachments: T[],
  active: ActiveFile | undefined,
  include: boolean
): (T | FileAttachment)[] {
  const mine = attachments ?? [];
  if (!include || !active?.path) return mine;
  if (mine.some((a) => samePath(a.path, active.path))) return mine;
  return [...mine, activeFileAttachment(active)];
}
