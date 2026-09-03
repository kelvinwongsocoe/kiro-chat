import * as vscode from "vscode";
import { ContentBlock } from "./kiroSession";
import {
  Attachment,
  buildBlocks as buildPromptBlocks,
  canReadSelectionFrom,
  clipSelection,
  SelectionContext,
} from "./promptBlocks";

export { Attachment, SelectionContext };

/** Read the active editor's selection, or the file if nothing is selected. */
export function readSelection(): SelectionContext | undefined {
  const editor = vscode.window.activeTextEditor;
  // A diff, a git side, a search result or an output pane is a *view* of
  // something, not a file the user is working on. Its path leads nowhere.
  if (!editor || !canReadSelectionFrom(editor.document.uri.scheme)) {
    return undefined;
  }

  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const clipped = clipSelection(hasSelection ? editor.document.getText(selection) : "");

  return {
    relativePath: vscode.workspace.asRelativePath(editor.document.uri),
    // Untitled and virtual documents have nothing on disk to attach.
    fsPath: editor.document.uri.scheme === "file" ? editor.document.uri.fsPath : "",
    languageId: editor.document.languageId,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    text: clipped.text,
    hasSelection,
    truncated: clipped.truncated,
  };
}

/** Build the message Kiro receives. The shaping lives in `promptBlocks`. */
export function buildBlocks(
  message: string,
  attachments: Attachment[],
  selection: SelectionContext | undefined,
  includeSelection: boolean
): ContentBlock[] {
  return buildPromptBlocks(message, attachments, selection, includeSelection, (fsPath) =>
    vscode.Uri.file(fsPath).toString()
  ) as ContentBlock[];
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
