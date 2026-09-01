/**
 * Files attached in VS Code's own chat box — dragged in from the Explorer,
 * `#`-mentioned, or picked with the paperclip — arrive as ChatPromptReference
 * values.
 *
 * They are not one shape. A whole file is a Uri; a selected range is a
 * Location wrapping a Uri and a Range; and some references are plain strings
 * with nothing on disk behind them at all.
 *
 * Free of any `vscode` import so it can be exercised on its own — see
 * `test/references.test.js`. Only the shapes are needed, not the classes.
 */

import { normalisePath } from "./paths";

export interface PromptRef {
  id?: string;
  value?: unknown;
  modelDescription?: string;
}

export interface RefFile {
  path: string;
  /** One-based, as people count them. Absent for a whole file. */
  startLine?: number;
  endLine?: number;
}

interface UriLike {
  fsPath: string;
  scheme?: string;
}

function asUri(value: unknown): UriLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as UriLike;
  if (typeof candidate.fsPath !== "string" || !candidate.fsPath) return undefined;
  // Untitled and virtual documents have nothing on disk for Kiro to open.
  if (candidate.scheme && candidate.scheme !== "file") return undefined;
  return candidate;
}

function asLocation(value: unknown): RefFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { uri?: unknown; range?: any };
  const uri = asUri(candidate.uri);
  if (!uri) return undefined;

  const start = candidate.range?.start?.line;
  const end = candidate.range?.end?.line;
  if (typeof start !== "number" || typeof end !== "number") return { path: uri.fsPath };

  // Editor lines are zero-based; people count from one.
  return { path: uri.fsPath, startLine: start + 1, endLine: end + 1 };
}

/**
 * Every file the chat request pointed at, in order and without repeats.
 *
 * A whole file and a range inside that same file are different requests, so
 * they are kept apart — collapsing them would quietly drop the lines the user
 * actually pointed at.
 */
export function filesFromReferences(refs: PromptRef[] | undefined): RefFile[] {
  const out: RefFile[] = [];
  const seen = new Set<string>();

  for (const ref of refs ?? []) {
    const value = ref?.value;
    const found = asLocation(value) ?? (asUri(value) ? { path: asUri(value)!.fsPath } : undefined);
    if (!found) continue;

    const key = `${normalisePath(found.path)}#${found.startLine ?? ""}-${found.endLine ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found);
  }
  return out;
}
