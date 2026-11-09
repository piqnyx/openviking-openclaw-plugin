import { OpenVikingRequestError, type OpenVikingClient, type OVMessage } from "../client.js";
import { fromBookmarkTurn, readBranchSinceBookmark, type BranchMemory, type SessionTranscriptReader } from "./branch-reader.js";
import { planTranscriptCatchUp, type CatchUpMessage } from "./transcript-catch-up.js";

/** What «догнать» needs of the server: the write, and the session's live messages with their row ids. */
export type CatchUpClient = {
  addSessionMessage: OpenVikingClient["addSessionMessage"];
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
type SessionState = { fenced?: BranchMemory; open?: BranchMemory; held: Set<string>; dirty?: boolean };

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

/**
 * PLAN-krug Р1, шаг 7б: «догнать» for one session -- what Viking holds (the row ids of its live
 * messages; after a write, what this process wrote), what to write (`planTranscriptCatchUp` over
 * the rows the model sees), and the write itself: one message at a time, one catch-up per session
 * at a time. A refused message is lost loudly and not tried again; a passing trouble stops the
 * catch-up, and the next one resumes from the same row after reading what Viking holds.
 *
 * Never the whole conversation again: an empty remainder while archives exist (a compaction kept
 * nothing) or live messages with no row ids (a session written before row ids) give no bookmark --
 * a loud skip, as long as this process knows nothing of the session (7г handles both).
 *
 * The state lives with this function, made once per plugin registration (PLAN-krug К18): the gateway
 * builds an engine for each logical turn, the registration hands each the same memory.
 */
export function createSessionCatchUp() {
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
        const outcome = await catchUpUnderLock(params, state);
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

async function catchUpUnderLock(params: CatchUpParams, state: SessionState): Promise<CatchUpOutcome> {
  // A reset (no memory) takes the server's ids always (PLAN-krug К13).
  let held = await heldIds(params, state, { fromServer: state.dirty === true || params.memory === "none" });
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
      held = await heldIds(params, state, { fromServer: true });
      if (held.kind === "skipped") {
        return skippedLoudly(params, held.reason);
      }
    }
    if (held.ids.size > 0 && !holdsAnyOf(read.visible, held.ids)) {
      return skippedLoudly(params, "bookmark_not_on_branch");
    }
  }
  const plan = planTranscriptCatchUp({ rows: read.visible, seenIds: held.ids, holdTrailingQuestion: params.holdTrailingQuestion });
  const written = await writeInOrder(params, plan.messages, held.ids);
  if (params.memory !== "none") {
    state[params.memory] = { cursor: read.memory.cursor, rows: fromBookmarkTurn(read.memory.rows, held.ids) };
  }
  state.held = new Set([...held.ids].slice(-MAX_HELD_IDS));
  // The question waiting for its turn's continuation, named in the journal (PLAN-krug П9).
  return written.kind === "wrote" && plan.heldQuestionId ? { ...written, heldQuestion: plan.heldQuestionId } : written;
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
): Promise<{ kind: "held"; ids: Set<string>; fromServer: boolean } | { kind: "skipped"; reason: string }> {
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
    return { kind: "skipped", reason: "empty_remainder_with_archives" };
  }
  return { kind: "held", ids, fromServer: true };
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
  params: {
    client: CatchUpClient;
    ovSessionId: string;
    peerIdOf: (role: "user" | "assistant") => string | undefined;
    logger: { warn?: (message: string) => void };
  },
  messages: CatchUpMessage[],
  held: Set<string>,
): Promise<CatchUpOutcome> {
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
      if (error instanceof OpenVikingRequestError && REFUSED_STATUSES.has(error.status)) {
        params.logger.warn?.(
          `openviking: the server refused gateway rows ${message.sourceIds.join(",")} of session=` +
            `${params.ovSessionId} (${text}); they are not in Viking and are not tried again`,
        );
        lost += 1;
      } else {
        params.logger.warn?.(
          `openviking: catch-up of session=${params.ovSessionId} stopped at gateway rows ` +
            `${message.sourceIds.join(",")} (${text}); the next catch-up resumes there`,
        );
        return { kind: "stopped", written, error: text };
      }
    }
    for (const id of message.sourceIds) {
      held.add(id);
    }
  }
  return { kind: "wrote", written, lost };
}

/** The engine's «догнать», one per engine (one per gateway process). */
export type SessionCatchUp = ReturnType<typeof createSessionCatchUp>;
