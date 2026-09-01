import * as vscode from "vscode";
import { ContentBlock, KiroSession } from "./kiroSession";
import { filesFromReferences } from "./references";

/**
 * Kiro in VS Code's own chat box, as `@kiro`.
 *
 * This exists because a webview cannot accept a dropped file. VS Code sets
 * `pointer-events: none` on every webview iframe for the duration of any drag
 * in the window, so no drop ever reaches the panel and nothing the panel does
 * can change that. The native chat box is ordinary workbench DOM, so dragging
 * a file onto it works — the file arrives here as a ChatPromptReference.
 *
 * It shares the panel's Kiro session on purpose. The conversation is the same
 * conversation whichever box it was typed into, so credits, context and memory
 * stay in one place instead of a second agent running alongside.
 */
export const PARTICIPANT_ID = "kiroChat.participant";

/** How long to let a turn run before assuming Kiro has stopped answering. */
const MAX_SILENCE_MS = 120000;

function blocksFor(request: vscode.ChatRequest): ContentBlock[] {
  const notes: string[] = [request.prompt.trim()];
  const blocks: ContentBlock[] = [];

  const files = filesFromReferences(request.references as any);
  const whole = files.filter((f) => f.startLine === undefined);
  const ranges = files.filter((f) => f.startLine !== undefined);

  if (whole.length > 0) {
    notes.push("", "Files to look at:");
    for (const f of whole) notes.push(`- ${f.path}`);
  }
  for (const range of ranges) {
    notes.push("", `I am looking at ${range.path}, lines ${range.startLine} to ${range.endLine}.`);
  }

  blocks.push({ type: "text", text: notes.join("\n").trim() });

  // Kiro reports embeddedContext as false — it will not take file contents
  // inlined in a prompt — so the paths go across as links it can open itself.
  for (const f of files) {
    blocks.push({
      type: "resource_link",
      uri: vscode.Uri.file(f.path).toString(),
      name: f.path,
    });
  }
  return blocks;
}

export function registerParticipant(
  extensionUri: vscode.Uri,
  session: KiroSession,
  output: vscode.OutputChannel
): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    const files = filesFromReferences(request.references as any);
    output.appendLine(
      `@kiro asked: "${request.prompt.slice(0, 80)}" with ${files.length} reference(s).`
    );

    // Show what came along, so an attachment that did not survive the trip is
    // visible rather than silently missing.
    for (const f of files) {
      stream.reference(vscode.Uri.file(f.path));
    }

    if (!request.prompt.trim() && files.length === 0) {
      stream.markdown("Ask me something, or attach a file and tell me what to do with it.");
      return {};
    }

    const cancel = token.onCancellationRequested(() => session.cancel());
    const idle = setTimeout(() => session.cancel(), MAX_SILENCE_MS);

    try {
      await session.sendTo(blocksFor(request), {
        onText: (text) => stream.markdown(text),
        onTool: (tool) => stream.progress(`${tool.title} — ${tool.status}`),
        // Kiro's thinking is noise in a chat answer; the panel shows it.
      });
      return {};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`@kiro failed: ${message}`);
      stream.markdown(`Kiro could not answer: ${message}`);
      return { errorDetails: { message } };
    } finally {
      clearTimeout(idle);
      cancel.dispose();
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
  // Says plainly that @kiro exists. Without this there is no way to tell
  // "the participant is not registered" from "you dropped on the wrong thing".
  output.appendLine(
    `Registered @kiro in VS Code's chat (${PARTICIPANT_ID}). Drag files onto the ` +
      "chat box there — the Kiro Chat panel is a webview and cannot accept a drop."
  );
  return participant;
}
