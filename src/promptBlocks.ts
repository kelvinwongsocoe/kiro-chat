/**
 * Turning what the user attached and highlighted into the blocks Kiro reads.
 *
 * This is the last place the user's own text is handled before it leaves, so
 * getting it wrong means Kiro answers about something the user never showed
 * it. Kept free of any `vscode` import — the URI maker is passed in — so the
 * decisions here can be exercised on their own; see `test/promptBlocks.test.js`.
 */

/** Something the user attached to the next message. */
export interface Attachment {
  id: string;
  kind: "file" | "folder" | "image";
  /** Short label shown on the chip. */
  label: string;
  /** Full path, for files and folders. */
  path?: string;
  /** Base64 payload, for images. */
  data?: string;
  mimeType?: string;
}

/** Where the caret is right now, sent along automatically. */
export interface SelectionContext {
  relativePath: string;
  /** Full path on disk, so the file itself can be attached. Empty for
   *  untitled and other documents that are not on disk. */
  fsPath: string;
  languageId: string;
  startLine: number;
  endLine: number;
  text: string;
  hasSelection: boolean;
  /** True when `text` is only the front of a longer selection. */
  truncated?: boolean;
}

export interface ContentBlock {
  type: string;
  text?: string;
  uri?: string;
  name?: string;
  data?: string;
  mimeType?: string;
}

export const MAX_SELECTION_CHARS = 12000;

/**
 * The document schemes a selection may be read from.
 *
 * Everything else in the editor is a view of something rather than a file the
 * user is working on: the change-review diff (`kiro-change-review`), git's
 * read-only sides (`git`, `gitfs`), search results, output panes. Reading a
 * selection from those told Kiro "I am looking at
 * /a1b2c3/chat.js (Working Tree), lines 5 to 9" — a path that exists nowhere,
 * about a file it would then fail to open. Reviewing a change and then asking
 * a question about it is an ordinary thing to do, so this was easy to hit.
 */
const READABLE_SCHEMES = new Set(["file", "untitled", "vscode-remote", "vscode-vfs"]);

export function canReadSelectionFrom(scheme: string | undefined): boolean {
  return READABLE_SCHEMES.has(String(scheme ?? ""));
}

/**
 * A fence long enough that the selected code cannot end it early.
 *
 * Markdown closes a fenced block on the first line of at least as many
 * backticks as opened it. Code that contains ``` — a markdown file, a
 * template literal, a docstring — therefore broke out of the block, and
 * everything after it read as prose. Kiro was being handed the user's code as
 * instructions. CommonMark allows any number of backticks, so count the
 * longest run present and beat it.
 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of String(text ?? "").match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** Cut an over-long selection, and say that it was cut. */
export function clipSelection(
  text: string,
  max = MAX_SELECTION_CHARS
): { text: string; truncated: boolean } {
  const value = String(text ?? "");
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

/**
 * Build the message Kiro receives.
 *
 * Files and folders go as resource_link blocks plus a plain-text list of paths.
 * Kiro reports embeddedContext as false, meaning it will not take file contents
 * inlined in the prompt, so it reads them itself through fs/read_text_file. The
 * text list is what makes the paths visible to the model either way.
 */
export function buildBlocks(
  message: string,
  attachments: Attachment[],
  selection: SelectionContext | undefined,
  includeSelection: boolean,
  toUri: (fsPath: string) => string
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const notes: string[] = [message.trim()];

  const list = attachments ?? [];
  const files = list.filter((a) => a.kind === "file" && a.path);
  const folders = list.filter((a) => a.kind === "folder" && a.path);
  const images = list.filter((a) => a.kind === "image" && a.data);

  if (files.length > 0) {
    notes.push("", "Files to look at:");
    for (const f of files) {
      notes.push(`- ${f.path}`);
    }
  }
  if (folders.length > 0) {
    notes.push("", "Folders to look at:");
    for (const f of folders) {
      notes.push(`- ${f.path}`);
    }
  }

  if (includeSelection && selection) {
    if (selection.hasSelection) {
      const fence = fenceFor(selection.text);
      // Saying the range without saying it was cut claims the block holds all
      // of those lines, so an answer about "the end of the selection" would be
      // about code Kiro never saw.
      const range = selection.truncated
        ? `lines ${selection.startLine} to ${selection.endLine} (only the first ${selection.text.length} characters are shown)`
        : `lines ${selection.startLine} to ${selection.endLine}`;
      notes.push(
        "",
        `I am looking at ${selection.relativePath}, ${range}:`,
        fence + selection.languageId,
        selection.text,
        fence
      );
    } else {
      notes.push("", `I am looking at ${selection.relativePath}.`);
    }
  }

  blocks.push({ type: "text", text: notes.join("\n").trim() });

  for (const f of [...files, ...folders]) {
    blocks.push({
      type: "resource_link",
      uri: toUri(f.path as string),
      name: f.label,
    });
  }

  for (const img of images) {
    blocks.push({
      type: "image",
      data: img.data as string,
      mimeType: img.mimeType ?? "image/png",
    });
  }

  return blocks;
}
