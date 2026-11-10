import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * PLAN-krug 7г: where «догнать» stopped, kept on disk -- for each Viking session, the newest gateway row
 * Viking is known to hold. A session reset (and a manual compaction) archives the whole session: the
 * remainder is empty, and once the process restarts, nothing else says where to go on from.
 */
export type CatchUpBookmarks = {
  get(ovSessionId: string): Promise<string | undefined>;
  set(ovSessionId: string, rowId: string): Promise<void>;
};

/** Beside the plugin's recall traces (config.ts, `traceRecallDir` by default). */
export const DEFAULT_CATCH_UP_BOOKMARKS_PATH = path.join(homedir(), ".openclaw", "openviking", "catch-up-bookmarks.json");

const MAX_ENTRIES = 1024;

type BookmarksFile = { sessions: Record<string, { row: string; at: number }> };

async function readBookmarks(file: string): Promise<BookmarksFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<BookmarksFile>;
    return parsed && typeof parsed.sessions === "object" && parsed.sessions ? { sessions: parsed.sessions } : { sessions: {} };
  } catch {
    // Missing or spoilt: no bookmark -- the catch-up skips loudly, as it did without the file.
    return { sessions: {} };
  }
}

/**
 * Each change reads the file again and changes one session (two writers -- a plugin registered again, the
 * old process while a new one starts -- do not undo each other's sessions), then writes a temporary file
 * and renames it over the old one (a reader never sees half a file).
 */
export function createFileCatchUpBookmarks(
  file: string,
  options: { maxEntries?: number; now?: () => number } = {},
): CatchUpBookmarks {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const now = options.now ?? Date.now;
  return {
    async get(ovSessionId) {
      const entry = (await readBookmarks(file)).sessions[ovSessionId];
      return typeof entry?.row === "string" && entry.row ? entry.row : undefined;
    },
    async set(ovSessionId, rowId) {
      const data = await readBookmarks(file);
      data.sessions[ovSessionId] = { row: rowId, at: now() };
      const kept = Object.entries(data.sessions)
        .sort(([, left], [, right]) => (right.at ?? 0) - (left.at ?? 0))
        .slice(0, maxEntries);
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temp, JSON.stringify({ sessions: Object.fromEntries(kept) }), "utf8");
      await rename(temp, file);
    },
  };
}
