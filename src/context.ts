import * as vscode from "vscode";
import { ContentBlock } from "./kiroSession";

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
  languageId: string;
  startLine: number;
  endLine: number;
  text: string;
  hasSelection: boolean;
}

const MAX_SELECTION_CHARS = 12000;

/** Read the active editor's selection, or the file if nothing is selected. */
export function readSelection(): SelectionContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme === "output") {
    return undefined;
  }

  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const text = hasSelection ? editor.document.getText(selection) : "";

  return {
    relativePath: vscode.workspace.asRelativePath(editor.document.uri),
    languageId: editor.document.languageId,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    text: text.length > MAX_SELECTION_CHARS ? text.slice(0, MAX_SELECTION_CHARS) : text,
    hasSelection,
  };
}

function fileUri(fsPath: string): string {
  return vscode.Uri.file(fsPath).toString();
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
  includeSelection: boolean
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const notes: string[] = [message.trim()];

  const files = attachments.filter((a) => a.kind === "file" && a.path);
  const folders = attachments.filter((a) => a.kind === "folder" && a.path);
  const images = attachments.filter((a) => a.kind === "image" && a.data);

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
      notes.push(
        "",
        `I am looking at ${selection.relativePath}, lines ${selection.startLine} to ${selection.endLine}:`,
        "```" + selection.languageId,
        selection.text,
        "```"
      );
    } else {
      notes.push("", `I am looking at ${selection.relativePath}.`);
    }
  }

  blocks.push({ type: "text", text: notes.join("\n").trim() });

  for (const f of [...files, ...folders]) {
    blocks.push({
      type: "resource_link",
      uri: fileUri(f.path as string),
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

/** Let the user pick files from the workspace. */
export async function pickFiles(): Promise<Attachment[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: "Attach to chat",
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return (uris ?? []).map((uri) => toAttachment(uri, false));
}

export async function pickFolders(): Promise<Attachment[]> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: false,
    canSelectFolders: true,
    openLabel: "Attach to chat",
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return (uris ?? []).map((uri) => toAttachment(uri, true));
}

/** Quick, keyboard-friendly search across the workspace. */
export async function quickPickWorkspaceFiles(): Promise<Attachment[]> {
  const found = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,.git,dist,out,build,vendor,.next}/**",
    3000
  );
  if (found.length === 0) {
    vscode.window.showInformationMessage("No files found in this folder.");
    return [];
  }
  const items = found
    .map((uri) => ({
      label: vscode.workspace.asRelativePath(uri),
      uri,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Attach files to the chat",
    placeHolder: "Type to filter, Space to tick, Enter to attach",
  });
  return (picked ?? []).map((p) => toAttachment(p.uri, false));
}

/** Turn dropped URIs into attachments, telling files and folders apart. */
export async function attachmentsFromUris(uris: vscode.Uri[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const uri of uris) {
    if (uri.scheme !== "file") continue;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const isFolder = (stat.type & vscode.FileType.Directory) !== 0;
      out.push(toAttachment(uri, isFolder));
    } catch {
      // Unreadable or gone. Skip it rather than attaching something broken.
    }
  }
  return out;
}

function toAttachment(uri: vscode.Uri, isFolder = false): Attachment {
  const label = vscode.workspace.asRelativePath(uri);
  return {
    id: `${uri.fsPath}:${isFolder ? "d" : "f"}`,
    kind: isFolder ? "folder" : "file",
    label,
    path: uri.fsPath,
  };
}
