import { OpenVikingRequestError, type OpenVikingClient, type OVMessage } from "../client.js";
import { fromBookmarkTurn, readBranchSinceBookmark, type BranchMemory, type SessionTranscriptReader } from "./branch-reader.js";
import type { CatchUpBookmarks } from "./catch-up-bookmarks.js";
import { planTranscriptCatchUp, type CatchUpMessage } from "./transcript-catch-up.js";

/** What «догнать» needs of the server: the write, and the session's live messages with their row ids. */
export type CatchUpClient = {
  addSessionMessage: OpenVikingClient["addSessionMessage"];
  addSessionMessages: OpenVikingClient["addSessionMessages"];
  getSessionContext(
    sessionId: string,
    tokenBudget?: number,
  ): Promise<{ messages?: OVMessage[]; stats?: { totalArchives?: number } } | null | undefined>;
};

export type CatchUpOutcome =
  | { kind: "wrote"; written: number; lost: number; heldQuestion?: string }
  | { kind: "stopped"; written: number; error: string }
  | { kind: "skipped"; reason: string };

// Two memories of reading (PLAN-krug П2): the fenced one serves only the main assemble -- its cursor
// stays before the current question, so the next turns' fences are ahead of it; the open one serves
// the reads without a fence (mid-turn, the queue), whose cursor may pass the current question.
// `dirty`: a write stopped or the catch-up failed -- what Viking holds is asked of the server next
// time, not of this memory (a write answered late may have landed meanwhile; PLAN-krug П1').
type SessionState = {
  fenced?: BranchMemory;
  open?: BranchMemory;
  held: Set<string>;
  dirty?: boolean;
  /** The rows whose write failed last, how many times in a row, and since when (PLAN-krug К15, К15б). */
  failing?: { ids: string; times: number; since: number };
  /** PLAN-krug 7г: the bookmark last put on disk, so an unchanged one is not written again. */
  saved?: string;
  /** PLAN-krug 7г: the bookmark read from disk once for this process -- null: none there, or not on the branch. */
  fromDisk?: string | null;
};

type CatchUpParams = {
  client: CatchUpClient;
  ovSessionId: string;
  reader: SessionTranscriptReader;
  /** PLAN-krug П3': hold a trailing question with nothing after it (mid-turn only). */
  holdTrailingQuestion: boolean;
  /** Which memory of reading: the main assemble's fenced one, the open one, or none (a reset). */
  memory: "fenced" | "open" | "none";
  /** The session's live messages the caller has just read (the main assemble reads them anyway). */
  remainder?: { messages?: OVMessage[]; totalArchives?: number };
  peerIdOf: (role: "user" | "assistant") => string | undefined;
  logger: { info: (message: string) => void; warn?: (message: string) => void };
};

// The server cuts nothing at this budget (as NO_TRIM_TOKEN_BUDGET of the lifecycle service).
const WHOLE_REMAINDER = 1_000_000_000;
// The same request will never pass: a refusal of the request itself, not of the moment.
const REFUSED_STATUSES = new Set([400, 413, 422]);
const MAX_SESSIONS = 256;
// What the session's rows Viking holds, by id, newest last: shared by both memories and not cut to
// either one's rows -- a retry's fenced read must not forget what the open read wrote.
const MAX_HELD_IDS = 4096;
// A write that fails this many times in a row on the same rows, over at least this long, is lost
// loudly, and the rest go on: rows the server always fails on must not hold every row after them
// (PLAN-krug П9', К15) -- yet the catch-up runs before every model call of a turn, so five failures
// can come within seconds; a short failure of the server's writes must lose nothing (Вит 09.11, К15б).
const MAX_TRIES = 5;
const LOSS_AFTER_MS = 30 * 60_000;
// The server takes up to this many messages a request, appended under one lock, all or none
// (routers/sessions.py 110-114, 541-590).
const MAX_BATCH = 100;

/**
 * PLAN-krug Р1, шаг 7б: «догнать» for one session -- what Viking holds (the row ids of its live
 * messages; after a write, what this process wrote), what to write (`planTranscriptCatchUp` over
 * the rows the model sees), and the write itself: one message at a time, one catch-up per session
 * at a time. A refused message is lost loudly and not tried again; a passing trouble stops the
 * catch-up, and the next one resumes from the same row after reading what Viking holds.
 *
 * Never the whole conversation again: an empty remainder while archives exist (a reset or a compaction
 * kept nothing) gives its bookmark from disk (PLAN-krug 7г), none there -- a loud skip; live messages with
 * no row ids (a session written before row ids) -- a loud skip, as long as this process knows nothing of
 * the session (Вит 10.11: no such sessions are left at the rollout).
 *
 * The state lives with this function, made once per plugin registration (PLAN-krug К18): the gateway
 * builds an engine for each logical turn, the registration hands each the same memory.
 */
export function createSessionCatchUp(options: { now?: () => number; bookmarks?: CatchUpBookmarks } = {}) {
  const now = options.now ?? Date.now;
  const bookmarks = options.bookmarks;
  const states = new Map<string, SessionState>();
  const locks = new Map<string, Promise<unknown>>();

  // By recency of use (PLAN-krug П8): a touch moves the session to the end, and the one left
  // untouched longest goes first -- not the main chat because it was the first one seen.
  const stateOf = (ovSessionId: string): SessionState => {
    const state = states.get(ovSessionId) ?? { held: new Set<string>() };
    states.delete(ovSessionId);
    states.set(ovSessionId, state);
    if (states.size > MAX_SESSIONS) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) {
        states.delete(oldest);
      }
    }
    return state;
  };

  const exclusive = async <T>(ovSessionId: string, run: () => Promise<T>): Promise<T> => {
    const previous = locks.get(ovSessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    const settled = current.catch(() => undefined);
    locks.set(ovSessionId, settled);
    try {
      return await current;
    } finally {
      if (locks.get(ovSessionId) === settled) {
        locks.delete(ovSessionId);
      }
    }
  };

  return async function catchUpSession(params: CatchUpParams): Promise<CatchUpOutcome> {
    return await exclusive(params.ovSessionId, async () => {
      const state = stateOf(params.ovSessionId);
      try {
        const outcome = await catchUpUnderLock(params, state, now, bookmarks);
        // PLAN-krug К19: only a call that wrote took the server's ids into memory; a skip leaves the
        // memory as it was, dirty included, or a write the server accepted late goes in again. К13: a
        // reset (no memory) leaves it dirty -- its session is archived next.
        state.dirty =
          outcome.kind === "stopped" || (outcome.kind === "skipped" && state.dirty === true) || params.memory === "none";
        return outcome;
      } catch (error) {
        state.dirty = true;
        throw error;
      }
    });
  };
}

async function catchUpUnderLock(
  params: CatchUpParams,
  state: SessionState,
  now: () => number,
  bookmarks: CatchUpBookmarks | undefined,
): Promise<CatchUpOutcome> {
  // A reset (no memory) takes the server's ids always (PLAN-krug К13).
  let held = await heldIds(params, state, { fromServer: state.dirty === true || params.memory === "none" }, bookmarks);
  if (held.kind === "skipped") {
    return skippedLoudly(params, held.reason);
  }
  // An open read with no memory of its own starts where the fenced one stopped: that cursor is
  // before the current question, good for a read without a fence (not the other way round).
  const memoryIn =
    params.memory === "fenced" ? state.fenced : params.memory === "open" ? (state.open ?? state.fenced) : undefined;
  const read = await readBranchSinceBookmark({
    reader: params.reader,
    seenIds: held.ids,
    ...(memoryIn ? { memory: memoryIn } : {}),
  });
  if (read.kind !== "rows") {
    const reason = read.kind === "missing" ? "transcript_missing" : `transcript_unavailable:${read.reason}`;
    return { kind: "skipped", reason };
  }
  // Viking holds rows, yet none of them is on the branch: this memory may be out of date (the rows it
  // knows left the branch) -- the server says what it holds; when not even its rows are on the branch,
  // nothing is written: never the whole conversation again (PLAN-krug П1', П5).
  if (held.ids.size > 0 && !holdsAnyOf(read.visible, held.ids)) {
    if (!held.fromServer) {
      held = await heldIds(params, state, { fromServer: true }, bookmarks);
      if (held.kind === "skipped") {
        return skippedLoudly(params, held.reason);
      }
    }
    if (held.ids.size > 0 && !holdsAnyOf(read.visible, held.ids)) {
      if (held.fromDisk) {
        // Not tried again in this process: the branch is not read on every call only to miss again.
        state.fromDisk = null;
      }
      return skippedLoudly(params, "bookmark_not_on_branch");
    }
  }
  const plan = planTranscriptCatchUp({ rows: read.visible, seenIds: held.ids, holdTrailingQuestion: params.holdTrailingQuestion });
  const written = await writeInOrder(params, plan.messages, held.ids, state, now);
  if (params.memory !== "none") {
    state[params.memory] = { cursor: read.memory.cursor, rows: fromBookmarkTurn(read.memory.rows, held.ids) };
  }
  state.held = new Set([...held.ids].slice(-MAX_HELD_IDS));
  await saveBookmark(params, state, read.visible, held.ids, bookmarks);
  // The question waiting for its turn's continuation, named in the journal (PLAN-krug П9).
  return written.kind === "wrote" && plan.heldQuestionId ? { ...written, heldQuestion: plan.heldQuestionId } : written;
}

/**
 * PLAN-krug 7г: the newest row of the branch Viking holds -- what this call wrote or found written (checked
 * with the server whenever the memory is not trusted, a reset's call among them, right before its archive) --
 * goes to disk, after every call that read the branch, whether it wrote or not. A disk that fails costs the
 * bookmark, never the catch-up.
 */
async function saveBookmark(
  params: Pick<CatchUpParams, "ovSessionId" | "logger">,
  state: SessionState,
  rows: readonly { firstEntryId: string }[],
  ids: ReadonlySet<string>,
  bookmarks: CatchUpBookmarks | undefined,
): Promise<void> {
  if (!bookmarks) {
    return;
  }
  let newest: string | undefined;
  for (let index = rows.length - 1; index >= 0 && newest === undefined; index -= 1) {
    const id = rows[index]?.firstEntryId;
    if (id !== undefined && ids.has(id)) {
      newest = id;
    }
  }
  if (!newest || newest === state.saved) {
    return;
  }
  try {
    await bookmarks.set(params.ovSessionId, newest);
    state.saved = newest;
  } catch (error) {
    params.logger.warn?.(
      `openviking: the catch-up bookmark of session=${params.ovSessionId} could not be saved: ${String(error)}`,
    );
  }
}

function holdsAnyOf(rows: readonly { firstEntryId: string }[], ids: ReadonlySet<string>): boolean {
  return rows.some((row) => ids.has(row.firstEntryId));
}

function skippedLoudly(params: Pick<CatchUpParams, "ovSessionId" | "logger">, reason: string): CatchUpOutcome {
  params.logger.warn?.(
    `openviking: catch-up of session=${params.ovSessionId} skipped (${reason}): ` +
      "Viking holds none of the gateway's rows by id, and the whole conversation is never written again",
  );
  return { kind: "skipped", reason };
}

async function heldIds(
  params: Pick<CatchUpParams, "client" | "ovSessionId" | "remainder" | "logger">,
  state: SessionState,
  options: { fromServer: boolean },
  bookmarks: CatchUpBookmarks | undefined,
): Promise<
  { kind: "held"; ids: Set<string>; fromServer: boolean; fromDisk?: boolean } | { kind: "skipped"; reason: string }
> {
  // What this process wrote is current while its memory is clean; the server is asked when the
  // process knows nothing, when the memory is dirty or out of date, or when the caller read it anyway.
  if (!params.remainder && state.held.size > 0 && !options.fromServer) {
    return { kind: "held", ids: new Set(state.held), fromServer: false };
  }
  const remainder = params.remainder ?? (await readServerRemainder(params.client, params.ovSessionId));
  const messages = remainder.messages ?? [];
  const ids = new Set(state.held);
  const seenTwice = new Set<string>();
  const seenOnce = new Set<string>();
  for (const message of messages) {
    for (const id of message.source_message_ids ?? []) {
      if (seenOnce.has(id)) {
        seenTwice.add(id);
      }
      seenOnce.add(id);
      ids.add(id);
    }
  }
  if (seenTwice.size > 0) {
    // A write answered after the client gave up may have landed and then been written again (the
    // server waits up to 30 s for the session lock; PLAN-krug Р1, «отложено до замера»).
    params.logger.warn?.(
      `openviking: Viking holds gateway rows twice in session=${params.ovSessionId} (${[...seenTwice].join(",")}): ` +
        "a write answered late was written again",
    );
  }
  if (ids.size > 0) {
    return { kind: "held", ids, fromServer: true };
  }
  if (messages.length > 0) {
    return { kind: "skipped", reason: "live_messages_without_row_ids" };
  }
  // Fresh only on the server's own word: no messages and no archives, both said.
  if (remainder.messages === undefined || remainder.totalArchives === undefined) {
    return { kind: "skipped", reason: "remainder_without_messages_or_archive_count" };
  }
  if (remainder.totalArchives > 0) {
    // PLAN-krug 7г: everything archived (a reset, a manual compaction) and nothing in memory -- where the
    // catch-up stopped is on disk (read once for this process); the caller checks the row is on the branch,
    // as any bookmark.
    if (state.fromDisk === undefined) {
      state.fromDisk = (await savedBookmark(params, bookmarks)) ?? null;
    }
    if (state.fromDisk) {
      return { kind: "held", ids: new Set([state.fromDisk]), fromServer: true, fromDisk: true };
    }
    return { kind: "skipped", reason: "empty_remainder_with_archives" };
  }
  return { kind: "held", ids, fromServer: true };
}

async function savedBookmark(
  params: Pick<CatchUpParams, "ovSessionId" | "logger">,
  bookmarks: CatchUpBookmarks | undefined,
): Promise<string | undefined> {
  if (!bookmarks) {
    return undefined;
  }
  try {
    return await bookmarks.get(params.ovSessionId);
  } catch (error) {
    params.logger.warn?.(
      `openviking: the catch-up bookmark of session=${params.ovSessionId} could not be read: ${String(error)}`,
    );
    return undefined;
  }
}

async function readServerRemainder(
  client: CatchUpClient,
  ovSessionId: string,
): Promise<{ messages?: OVMessage[]; totalArchives?: number }> {
  try {
    const context = await client.getSessionContext(ovSessionId, WHOLE_REMAINDER);
    return { messages: context?.messages, totalArchives: context?.stats?.totalArchives };
  } catch (error) {
    // A session Viking was never written to: every read answers NOT_FOUND, the first write
    // creates it (server routers/sessions.py, reads with auto_create=False, writes with True).
    if (error instanceof OpenVikingRequestError && error.status === 404 && error.code === "NOT_FOUND") {
      return { messages: [], totalArchives: 0 };
    }
    throw error;
  }
}

async function writeInOrder(
  params: WriteParams,
  messages: CatchUpMessage[],
  held: Set<string>,
  state: Pick<SessionState, "failing">,
  now: () => number,
): Promise<CatchUpOutcome> {
  let written = 0;
  let lost = 0;
  for (let start = 0; start < messages.length; start += MAX_BATCH) {
    const chunk = messages.slice(start, start + MAX_BATCH);
    const firstIds = chunk[0]!.sourceIds.join(",");
    // One request a chunk (PLAN-krug К17); a chunk that failed before goes one by one, where the rows
    // that fail are counted on their own (К15).
    if (chunk.length > 1 && state.failing?.ids !== firstIds) {
      try {
        await params.client.addSessionMessages(
          params.ovSessionId,
          chunk.map((message) => ({
            role: message.role,
            parts: message.parts,
            createdAt: message.createdAt,
            peerId: params.peerIdOf(message.role),
            sourceMessageIds: message.sourceIds,
          })),
        );
        written += chunk.length;
        for (const message of chunk) {
          for (const id of message.sourceIds) {
            held.add(id);
          }
        }
        continue;
      } catch (error) {
        if (!isRefusal(error)) {
          const text = error instanceof Error ? error.message : String(error);
          state.failing = { ids: firstIds, times: 1, since: now() };
          params.logger.warn?.(
            `openviking: catch-up of session=${params.ovSessionId} stopped at the chunk of gateway rows from ` +
              `${firstIds} (${text}); the next catch-up writes it one by one`,
          );
          return { kind: "stopped", written, error: text };
        }
        // The server refused something in it before writing any: one by one, loud only for the bad.
      }
    }
    const one = await writeOneByOne(params, chunk, held, state, now);
    written += one.written;
    lost += one.lost;
    if (one.error !== undefined) {
      return { kind: "stopped", written, error: one.error };
    }
  }
  return { kind: "wrote", written, lost };
}

async function writeOneByOne(
  params: WriteParams,
  messages: CatchUpMessage[],
  held: Set<string>,
  state: Pick<SessionState, "failing">,
  now: () => number,
): Promise<{ written: number; lost: number; error?: string }> {
  let written = 0;
  let lost = 0;
  for (const message of messages) {
    try {
      await params.client.addSessionMessage(
        params.ovSessionId,
        message.role,
        message.parts,
        undefined,
        message.createdAt,
        params.peerIdOf(message.role),
        message.sourceIds,
      );
      written += 1;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (isRefusal(error)) {
        params.logger.warn?.(
          `openviking: the server refused gateway rows ${message.sourceIds.join(",")} of session=` +
            `${params.ovSessionId} (${text}); they are not in Viking and are not tried again`,
        );
        lost += 1;
      } else {
        const ids = message.sourceIds.join(",");
        const at = now();
        const failing =
          state.failing?.ids === ids
            ? { ids, times: state.failing.times + 1, since: state.failing.since }
            : { ids, times: 1, since: at };
        if (failing.times < MAX_TRIES || at - failing.since < LOSS_AFTER_MS) {
          state.failing = failing;
          params.logger.warn?.(
            `openviking: catch-up of session=${params.ovSessionId} stopped at gateway rows ` +
              `${ids} (${text}); the next catch-up resumes there`,
          );
          return { written, lost, error: text };
        }
        state.failing = undefined;
        params.logger.warn?.(
          `openviking: the server failed gateway rows ${ids} of session=${params.ovSessionId} ${failing.times} times ` +
            `in a row over ${Math.round((at - failing.since) / 60_000)} minutes (${text}); they are not in Viking ` +
            "and are not tried again",
        );
        lost += 1;
      }
    }
    for (const id of message.sourceIds) {
      held.add(id);
    }
  }
  return { written, lost };
}

type WriteParams = {
  client: CatchUpClient;
  ovSessionId: string;
  peerIdOf: (role: "user" | "assistant") => string | undefined;
  logger: { warn?: (message: string) => void };
};

/** A refusal on the merits (the request itself is bad): not tried again. */
function isRefusal(error: unknown): boolean {
  return error instanceof OpenVikingRequestError && REFUSED_STATUSES.has(error.status);
}

/** The «догнать» of one plugin registration, shared by every engine it builds (PLAN-krug К18). */
export type SessionCatchUp = ReturnType<typeof createSessionCatchUp>;
