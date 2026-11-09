import type { BranchRow } from "./transcript-catch-up.js";

/**
 * The gateway's read-only reader of the session's own transcript, handed in the runtime context
 * as `readSessionTranscript` (gateway PLAN-krug 5б): forward pages of the visible branch, and the
 * gateway's own rule of which rows the model history keeps.
 */
export type SessionTranscriptReader = {
  readVisiblePage(limits?: {
    cursor?: string;
    maxMessages?: number;
    maxBytes?: number;
  }): Promise<SessionTranscriptPage>;
  /** Judges a whole run of rows: a heartbeat poll goes or stays together with its reply. */
  selectModelVisible<T extends { message: unknown }>(rows: T[]): T[];
};

export type SessionTranscriptPage =
  | { kind: "page"; cursor: string; rows: BranchRow[]; hasMore: boolean; requiredBytes?: number }
  | { kind: "reset"; cursor: string; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "missing" };

/** What a session keeps between reads: where reading stopped, and the rows from the bookmark's turn. */
export type BranchMemory = { cursor: string; rows: BranchRow[] };

/** The reader the gateway handed with this call, when it handed one. */
export function transcriptReaderOf(
  runtimeContext: Record<string, unknown> | undefined,
): SessionTranscriptReader | undefined {
  const candidate = runtimeContext?.readSessionTranscript as Partial<SessionTranscriptReader> | undefined;
  return candidate &&
    typeof candidate.readVisiblePage === "function" &&
    typeof candidate.selectModelVisible === "function"
    ? (candidate as SessionTranscriptReader)
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
export async function readBranchSinceBookmark(params: {
  reader: SessionTranscriptReader;
  seenIds: ReadonlySet<string>;
  memory?: BranchMemory;
}): Promise<
  | { kind: "rows"; memory: BranchMemory; visible: BranchRow[] }
  | { kind: "missing" }
  | { kind: "unavailable"; reason: string }
> {
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
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return {
    kind: "rows",
    memory: { cursor: cursor ?? "", rows },
    visible: params.reader.selectModelVisible(rows),
  };
}

/** The rows from the start of the turn of the newest one Viking holds; all of them when none. */
export function fromBookmarkTurn(rows: BranchRow[], seenIds: ReadonlySet<string>): BranchRow[] {
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
    const role = (rows[index]?.message as { role?: unknown } | undefined)?.role;
    if (role === "user") {
      return rows.slice(index);
    }
  }
  return rows;
}

/**
 * The rows of messages that carry their transcript row id (`__openclaw.id`, and `originalEntryId`
 * when the gateway re-appended the row) -- the `before_reset` event's messages. Messages with no id
 * (an older gateway) are not rows.
 */
export function rowsOfTranscriptMessages(messages: readonly unknown[]): BranchRow[] {
  return messages.flatMap((message): BranchRow[] => {
    const meta = (message as { __openclaw?: { id?: unknown; originalEntryId?: unknown } } | null)?.__openclaw;
    if (!meta || typeof meta.id !== "string" || !meta.id) {
      return [];
    }
    const firstEntryId = typeof meta.originalEntryId === "string" && meta.originalEntryId ? meta.originalEntryId : meta.id;
    return [{ entryId: meta.id, firstEntryId, message }];
  });
}

/**
 * A reader over rows already in hand, as one page; it keeps every row -- there is no gateway rule of
 * what the model sees here, the caller says so loudly when it writes any.
 */
export function fixedBranchReader(rows: BranchRow[]): SessionTranscriptReader {
  return {
    readVisiblePage: async () => ({ kind: "page", cursor: "", rows, hasMore: false }),
    selectModelVisible: (candidates) => candidates,
  };
}
