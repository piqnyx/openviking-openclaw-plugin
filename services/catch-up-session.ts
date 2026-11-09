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
  | { kind: "wrote"; written: number; lost: number }
  | { kind: "stopped"; written: number; error: string }
  | { kind: "skipped"; reason: string };

type SessionState = { memory?: BranchMemory; held: Set<string> };

// The server cuts nothing at this budget (as NO_TRIM_TOKEN_BUDGET of the lifecycle service).
const WHOLE_REMAINDER = 1_000_000_000;
// The same request will never pass: a refusal of the request itself, not of the moment.
const REFUSED_STATUSES = new Set([400, 413, 422]);
const MAX_SESSIONS = 256;

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
 * The state lives with the engine that made this function: one per gateway process.
 */
export function createSessionCatchUp() {
  const states = new Map<string, SessionState>();
  const locks = new Map<string, Promise<unknown>>();

  const stateOf = (ovSessionId: string): SessionState => {
    let state = states.get(ovSessionId);
    if (!state) {
      state = { held: new Set() };
      states.set(ovSessionId, state);
      if (states.size > MAX_SESSIONS) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined) {
          states.delete(oldest);
        }
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

  return async function catchUpSession(params: {
    client: CatchUpClient;
    ovSessionId: string;
    reader: SessionTranscriptReader;
    place: "settled" | "working";
    /** The session's live messages the caller has just read (the main assemble reads them anyway). */
    remainder?: { messages?: OVMessage[]; totalArchives?: number };
    peerIdOf: (role: "user" | "assistant") => string | undefined;
    logger: { info: (message: string) => void; warn?: (message: string) => void };
  }): Promise<CatchUpOutcome> {
    return await exclusive(params.ovSessionId, async () => {
      const state = stateOf(params.ovSessionId);
      const held = await heldIds(params, state);
      if (held.kind === "skipped") {
        params.logger.warn?.(
          `openviking: catch-up of session=${params.ovSessionId} skipped (${held.reason}): ` +
            "Viking holds none of the gateway's rows by id, and the whole conversation is never written again",
        );
        return held;
      }
      const read = await readBranchSinceBookmark({
        reader: params.reader,
        seenIds: held.ids,
        ...(state.memory ? { memory: state.memory } : {}),
      });
      if (read.kind !== "rows") {
        const reason = read.kind === "missing" ? "transcript_missing" : `transcript_unavailable:${read.reason}`;
        return { kind: "skipped", reason };
      }
      const plan = planTranscriptCatchUp({ rows: read.visible, seenIds: held.ids, place: params.place });
      const written = await writeInOrder(params, plan.messages, held.ids);
      state.memory = { cursor: read.memory.cursor, rows: fromBookmarkTurn(read.memory.rows, held.ids) };
      // Only the ids of rows still kept matter: the newest of them is the bookmark.
      const kept = new Set(state.memory.rows.map((row) => row.firstEntryId));
      state.held = new Set([...held.ids].filter((id) => kept.has(id)));
      return written;
    });
  };
}

async function heldIds(
  params: { client: CatchUpClient; ovSessionId: string; remainder?: { messages?: OVMessage[]; totalArchives?: number } },
  state: SessionState,
): Promise<{ kind: "held"; ids: Set<string> } | { kind: "skipped"; reason: string }> {
  // What this process wrote is current; the server is asked only when the process knows nothing,
  // or when the caller has read it anyway.
  if (!params.remainder && state.held.size > 0) {
    return { kind: "held", ids: new Set(state.held) };
  }
  const remainder = params.remainder ?? (await readServerRemainder(params.client, params.ovSessionId));
  const messages = remainder.messages ?? [];
  const ids = new Set(state.held);
  for (const message of messages) {
    for (const id of message.source_message_ids ?? []) {
      ids.add(id);
    }
  }
  if (ids.size > 0) {
    return { kind: "held", ids };
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
  return { kind: "held", ids };
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
