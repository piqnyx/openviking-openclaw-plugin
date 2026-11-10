/** The reader the gateway handed with this call, when it handed one. */
export function transcriptReaderOf(runtimeContext) {
    const candidate = runtimeContext?.readSessionTranscript;
    return candidate &&
        typeof candidate.readVisiblePage === "function" &&
        typeof candidate.selectModelVisible === "function"
        ? candidate
        : undefined;
}
// Small pages, and the event loop handed back between them (PLAN-krug П7): the gateway's read is
// synchronous inside its promise, so a long branch read at once would hold the whole gateway.
const PAGE_MESSAGES = 64;
const PAGE_BYTES = 1024 * 1024;
// A branch that keeps moving while it is read: give up for this call, read again on the next one.
const MAX_RESETS_PER_READ = 2;
/**
 * PLAN-krug 7б: the branch from the start of the turn of the newest row Viking holds (by the id the
 * row was first written under) to its end -- from where `memory` stopped, or from the branch's
 * start; a moved branch (`reset`) is read again from its start. Older rows are not kept: a turn's
 * start (a user row) is where a heartbeat exchange and a tool round can begin, so the rows the
 * model sees after the bookmark, and the inputs of their tool results, are all in what is kept.
 */
export async function readBranchSinceBookmark(params) {
    let rows = params.memory ? [...params.memory.rows] : [];
    let cursor = params.memory?.cursor;
    let maxBytes = PAGE_BYTES;
    let resets = 0;
    for (;;) {
        const page = await params.reader.readVisiblePage({
            ...(cursor ? { cursor } : {}),
            maxMessages: PAGE_MESSAGES,
            maxBytes,
        });
        if (page.kind === "missing") {
            return { kind: "missing" };
        }
        if (page.kind === "unavailable") {
            return { kind: "unavailable", reason: page.reason };
        }
        if (page.kind === "reset") {
            resets += 1;
            if (resets > MAX_RESETS_PER_READ) {
                return { kind: "unavailable", reason: `branch_moving:${page.reason}` };
            }
            rows = [];
            cursor = page.cursor;
            continue;
        }
        if (page.rows.length === 0 && page.hasMore) {
            // The next row is bigger than the page: read it alone, whole.
            if (page.requiredBytes !== undefined && page.requiredBytes > maxBytes) {
                maxBytes = page.requiredBytes;
                continue;
            }
            return { kind: "unavailable", reason: "page_stalled" };
        }
        rows = fromBookmarkTurn([...rows, ...page.rows], params.seenIds);
        cursor = page.cursor;
        maxBytes = PAGE_BYTES;
        if (!page.hasMore) {
            break;
        }
        await new Promise((resolve) => setImmediate(resolve));
    }
    return {
        kind: "rows",
        memory: { cursor: cursor ?? "", rows },
        visible: params.reader.selectModelVisible(rows),
    };
}
/** The rows from the start of the turn of the newest one Viking holds; all of them when none. */
export function fromBookmarkTurn(rows, seenIds) {
    let seen = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const candidate = rows[index];
        if (candidate && seenIds.has(candidate.firstEntryId)) {
            seen = index;
            break;
        }
    }
    if (seen === -1) {
        return rows;
    }
    for (let index = seen; index >= 0; index -= 1) {
        const role = rows[index]?.message?.role;
        if (role === "user") {
            return rows.slice(index);
        }
    }
    return rows;
}
/**
 * PLAN-krug К13б: the reader for a reset, made of the before_reset event -- its messages, taken before
 * the reset, each named by its transcript row (`__openclaw.id`; `originalEntryId` when the gateway
 * re-appended it), and the gateway's model view of them. A reset keeps the session id, so the
 * transcript is not read later: the new conversation is already writing into it. None from an older
 * gateway (no model view), nor without a row to write (the gateway failed to take the messages) -- the
 * reset then only archives.
 */
export function resetEventReader(event) {
    const messages = event?.messages;
    const select = event?.selectModelVisible;
    if (!Array.isArray(messages) || typeof select !== "function") {
        return undefined;
    }
    const rows = messages.flatMap((message) => {
        const meta = message?.__openclaw;
        if (!meta || typeof meta.id !== "string" || !meta.id) {
            return [];
        }
        const firstEntryId = typeof meta.originalEntryId === "string" && meta.originalEntryId ? meta.originalEntryId : meta.id;
        return [{ entryId: meta.id, firstEntryId, message }];
    });
    if (rows.length === 0) {
        return undefined;
    }
    return {
        readVisiblePage: async () => ({ kind: "page", cursor: "", rows, hasMore: false }),
        selectModelVisible: select,
    };
}
