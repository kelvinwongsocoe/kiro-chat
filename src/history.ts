/**
 * Past chats: naming them, grouping them by day, and working out which ones
 * belong to the folder that is open.
 *
 * Kept free of any `vscode` import so it can be exercised on its own — see
 * `test/history.test.js`. The records themselves are stored by the provider
 * in the extension's globalState; nothing here touches storage.
 */

import { samePath } from "./paths";

/** One turn as the webview records it. */
export interface HistoryItem {
  role: string;
  text?: string;
  attachments?: { kind: string; label: string }[];
  selection?: string;
  tools?: { title: string; status: string }[];
}

export interface ChatRecord {
  /** Ours, and stable across saves. */
  id: string;
  /** Kiro's, so the conversation can actually be resumed. */
  sessionId?: string;
  /** The folder the chat happened in. Kiro binds a session to it. */
  cwd: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  history: HistoryItem[];
}

const MAX_TITLE = 60;

/**
 * Name a chat after the first thing the user said. A message that carried
 * only attachments still counts — "screenshot.png" says more about the chat
 * than "New chat" does.
 */
export function titleFrom(history: HistoryItem[]): string {
  for (const item of history ?? []) {
    if (item?.role !== "user") continue;

    const firstLine = String(item.text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (firstLine) return clip(firstLine);

    const labels = (item.attachments ?? []).map((a) => a.label).filter(Boolean);
    if (labels.length > 0) return clip(labels.join(", "));
  }
  return "New chat";
}

function clip(text: string): string {
  if (text.length <= MAX_TITLE) return text;
  return text.slice(0, MAX_TITLE - 1).trimEnd() + "…";
}

export interface DayGroup {
  label: string;
  records: ChatRecord[];
}

/**
 * Group into Today, Yesterday, then a plain date. The boundary is midnight,
 * not a rolling 24 hours: a chat at 11pm last night is Yesterday even though
 * it was only twelve hours ago, which is what a person means by it.
 */
export function groupByDay(records: ChatRecord[], now: number): DayGroup[] {
  const startOfDay = (time: number) => {
    const d = new Date(time);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = startOfDay(now);
  const DAY = 24 * 60 * 60 * 1000;

  const groups = new Map<number, ChatRecord[]>();
  for (const record of records ?? []) {
    const day = startOfDay(record.updatedAt);
    const bucket = groups.get(day);
    if (bucket) bucket.push(record);
    else groups.set(day, [record]);
  }

  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([day, list]) => ({
      label:
        day === today
          ? "Today"
          : day === today - DAY
            ? "Yesterday"
            : new Date(day).toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
              }),
      records: [...list].sort((a, b) => b.updatedAt - a.updatedAt),
    }));
}

/** Chats that belong to the open folder. With no folder open, none do. */
export function forWorkspace(
  records: ChatRecord[],
  cwd: string | undefined
): ChatRecord[] {
  if (!cwd) return [];
  // Whole-path equality, so "kiro-chat-old" is never mistaken for "kiro-chat".
  return (records ?? []).filter((record) => samePath(record.cwd, cwd));
}

/** Keep the newest `max` chats and drop the rest. */
export function pruneHistory(records: ChatRecord[], max: number): ChatRecord[] {
  return [...(records ?? [])]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, max));
}

/** Save a chat, replacing any earlier save of the same one. */
export function upsertRecord(records: ChatRecord[], record: ChatRecord): ChatRecord[] {
  const rest = (records ?? []).filter((r) => r.id !== record.id);
  return [record, ...rest];
}
