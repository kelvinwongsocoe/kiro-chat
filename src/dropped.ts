/**
 * Turning whatever a drag left behind into real paths.
 *
 * VS Code offers dragged Explorer items under several formats at once, and
 * they are shaped differently: `text/uri-list` is a newline-separated list of
 * `file://` URIs, `resourceurls` is a JSON array of encoded strings, and
 * `text/plain` is usually a bare path. The webview hands over everything it
 * could read and this works out what was actually meant, because reading only
 * one format is how a drop ends up looking as though it did nothing.
 *
 * Free of any `vscode` import so it can be exercised on its own — see
 * `test/dropped.test.js`.
 */

import { normalisePath } from "./paths";

/** A path that looks like something on disk rather than a sentence. */
function looksLikePath(text: string): boolean {
  // A Windows drive, a UNC share, or a POSIX absolute path.
  return /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text) || /^\//.test(text);
}

function fromFileUri(text: string): string | undefined {
  if (!/^file:\/\//i.test(text)) return undefined;
  try {
    // Two rounds of decoding: the drive colon arrives as %253A in the JSON
    // array format, having been encoded once as a URI and again as a string.
    let path = decodeURIComponent(text.replace(/^file:\/\//i, ""));
    if (/%[0-9a-f]{2}/i.test(path)) path = decodeURIComponent(path);
    // "/c:/x" -> "c:/x"
    path = path.replace(/^\/([a-zA-Z]:)/, "$1");
    return path.replace(/\//g, "\\");
  } catch {
    return undefined;
  }
}

function collect(value: unknown, into: string[], depth = 0): void {
  if (depth > 3) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1);
    return;
  }
  const text = String(value ?? "").trim();
  if (!text) return;

  // A JSON array of paths or urls, which is how `resourceurls` arrives.
  if (text.startsWith("[")) {
    try {
      collect(JSON.parse(text), into, depth + 1);
      return;
    } catch {
      // Not JSON after all; fall through and treat it as text.
    }
  }

  // A uri-list, or anything else that arrived as several lines.
  if (text.includes("\n")) {
    for (const line of text.split(/\r?\n/)) collect(line, into, depth + 1);
    return;
  }

  if (text.startsWith("#")) return; // uri-list comment

  const decoded = /%[0-9a-f]{2}/i.test(text) ? safeDecode(text) : text;
  const fromUri = fromFileUri(decoded);
  if (fromUri) {
    into.push(fromUri);
    return;
  }

  // Anything with a scheme that is not a file — untitled:, https:, and the
  // rest — has nothing on disk to attach.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded) && !looksLikePath(decoded)) return;

  if (looksLikePath(decoded)) into.push(decoded);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Every path the drag described, in the order they were dropped and without
 * repeats — the same file usually arrives under two or three formats at once,
 * and attaching it twice sends it to Kiro twice.
 */
export function parseDroppedPaths(values: unknown[]): string[] {
  const found: string[] = [];
  collect(values ?? [], found);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of found) {
    const key = normalisePath(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}
