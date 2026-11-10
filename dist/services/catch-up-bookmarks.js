import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
/** In the gateway's state directory (`OPENCLAW_STATE_DIR`, as the plugin's setup reads it; else ~/.openclaw). */
export function catchUpBookmarksPath() {
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homedir(), ".openclaw");
    return path.join(stateDir, "openviking", "catch-up-bookmarks.json");
}
const MAX_ENTRIES = 1024;
async function readBookmarks(file) {
    try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        return parsed && typeof parsed.sessions === "object" && parsed.sessions ? { sessions: parsed.sessions } : { sessions: {} };
    }
    catch {
        // Missing or spoilt: no bookmark -- the catch-up skips loudly, as it did without the file.
        return { sessions: {} };
    }
}
/**
 * Each change reads the file again and changes one session, then writes a temporary file and renames it
 * over the old one (a reader never sees half a file). The changes of one store go one after another -- the
 * catch-up locks one session, and two sessions finishing at once would undo each other's change; another
 * writer (a plugin registered again, the old process while a new one starts) is rare, and a change it undoes
 * costs a loud skip or a row written again -- named (PLAN-krug 7г).
 */
export function createFileCatchUpBookmarks(file, options = {}) {
    const maxEntries = options.maxEntries ?? MAX_ENTRIES;
    const now = options.now ?? Date.now;
    let queue = Promise.resolve();
    const change = async (ovSessionId, rowId) => {
        const data = await readBookmarks(file);
        data.sessions[ovSessionId] = { row: rowId, at: now() };
        const kept = Object.entries(data.sessions)
            .sort(([, left], [, right]) => (right.at ?? 0) - (left.at ?? 0))
            .slice(0, maxEntries);
        await mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.${now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(temp, JSON.stringify({ sessions: Object.fromEntries(kept) }), "utf8");
        await rename(temp, file);
    };
    return {
        async get(ovSessionId) {
            const entry = (await readBookmarks(file)).sessions[ovSessionId];
            return typeof entry?.row === "string" && entry.row ? entry.row : undefined;
        },
        set(ovSessionId, rowId) {
            const done = queue.catch(() => undefined).then(() => change(ovSessionId, rowId));
            queue = done;
            return done;
        },
    };
}
