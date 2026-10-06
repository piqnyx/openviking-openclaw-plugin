// Canonical ContextEngine lifecycle service: assemble / afterTurn / compact / commit orchestration.
import { DEFAULT_PHASE2_POLL_TIMEOUT_MS, type OpenVikingClient, type OVMessage } from "../client.js";
import type { EffectiveQueryConfig } from "../query-config.js";
import { buildAutoRecallContext, prepareRecallQuery } from "../auto-recall.js";
import { toJsonLog } from "../memory-ranking.js";
import {
  openClawSessionToOvStorageId,
  resolveOpenVikingActorPeerId,
  resolveOpenVikingMessagePeerId,
  sanitizeOpenVikingPeerId,
  type OpenVikingPeerRole,
} from "../routing/identity-routing.js";
import { priceBodyOf, toOpenAiMessages, type PriceHandle } from "../price-handle.js";
import { floorTail, longestTailWithin, turnStarts } from "../tail-by-weight.js";
import { extractNewTurnMessages } from "../text-utils.js";
import { estimateAgentMessageTokens, estimateTextTokens } from "../token-estimator.js";
import {
  convertToAgentMessages,
  mergeConsecutiveAssistants,
  sanitizeAgentMessagesForProvider,
  toRoleId,
  type AgentMessage,
} from "./context-message-adapter.js";

type ExtractedTurnMessage = ReturnType<typeof extractNewTurnMessages>["messages"][number];

export type ContextEngineLifecycleLogger = {
  info: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type CommitOpenVikingSessionParams = {
  sessionId: string;
  sessionKey?: string;
  getClient: (agentId: string | undefined) => Promise<Pick<OpenVikingClient, "commitSession">>;
  /** Resolves which OpenViking account this session's data belongs to. */
  resolveAgentId: (sessionId: string, sessionKey?: string, ovSessionId?: string) => string;
  logger: ContextEngineLifecycleLogger;
  rememberSessionAgentId?: (ctx: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    ovSessionId?: string;
  }) => void;
  isBypassedSession: (params: { sessionId?: string; sessionKey?: string }) => boolean;
};

export type CompactOpenVikingSessionResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

export type AssembleOpenVikingSessionResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

type AssembleBuiltContext = {
  sanitized: AgentMessage[];
  archive: { messages: AgentMessage[]; tokens: number };
  session: { messages: AgentMessage[]; tokens: number };
  budgets: { archiveMemory: number; sessionContext: number; reserved: number };
  instruction: { text: string; tokens: number };
};

export type AssembleOpenVikingSessionParams = {
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  tokenBudget: number;
  runtimeContext?: Record<string, unknown>;
  /** The host's runtime settings; the model's name is read off them for the price handle. */
  runtimeSettings?: unknown;
  isMainAssemble: boolean;
  cfg: any;
  getClient: (agentId: string | undefined) => Promise<OpenVikingClient>;
  /** The proxy's price handle (PLAN-gorizont 4а); the recovery path cuts the live tail by it (4б). */
  priceHandle?: Pick<PriceHandle, "price" | "url">;
  logger: ContextEngineLifecycleLogger;
  resolveAgentId: (sessionId: string, sessionKey?: string, ovSessionId?: string) => string;
  rememberSessionAgentId?: (ctx: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    ovSessionId?: string;
  }) => void;
  isBypassedSession: (params: { sessionId?: string; sessionKey?: string }) => boolean;
  queryConfigStore?: {
    getEffective(params: {
      agentId?: string;
      sessionId?: string;
      sessionKey?: string;
      ovSessionId?: string;
    }): Promise<EffectiveQueryConfig>;
  };
  traceRecorder?: unknown;
  diag: (stage: string, sessionId: string, data: Record<string, unknown>) => void;
  roughEstimate: (messages: AgentMessage[]) => number;
  messageDigest: (messages: AgentMessage[]) => Array<{role: string; content: string; tokens: number; truncated: boolean}>;
  extractAgentMessageText: (message: AgentMessage | undefined) => string;
  hasAutoRecallBlock: (message: AgentMessage | undefined) => boolean;
  prependRecallToLatestUserMessage: (messages: AgentMessage[], recallBlock: string) => AgentMessage[];
};

type CompactClient = Pick<OpenVikingClient, "commitSession" | "getSessionContext">;

export type CompactOpenVikingSessionParams = {
  sessionId: string;
  sessionKey?: string;
  tokenBudget: number;
  currentTokenCount?: unknown;
  force?: boolean;
  compactionTarget?: "budget" | "threshold";
  /**
   * Recent messages the commit keeps live (Vit, 2026-10-04): the host's
   * automatic compaction keeps commitKeepRecentCount of them, so the window
   * after it is the summary and the recent turns, not the summary alone; a
   * manual /compact passes 0 and archives everything.
   */
  keepRecentCount?: number;
  customInstructions?: string;
  getClient: (agentId: string | undefined) => Promise<CompactClient>;
  logger: ContextEngineLifecycleLogger;
  resolveAgentId: (sessionId: string, sessionKey?: string, ovSessionId?: string) => string;
  isBypassedSession: (params: { sessionId?: string; sessionKey?: string }) => boolean;
  diag: (stage: string, sessionId: string, data: Record<string, unknown>) => void;
};

type AfterTurnClient = Pick<
  OpenVikingClient,
  "addSessionMessage" | "getSession" | "getSessionContext" | "commitSession" | "getTask"
>;

export type AfterTurnOpenVikingSessionParams = {
  sessionId: string;
  sessionKey?: string;
  messages?: AgentMessage[];
  prePromptMessageCount?: number;
  isHeartbeat?: boolean;
  runtimeContext?: Record<string, unknown>;
  /** The host's runtime settings; the model's name is read off them for the price handle. */
  runtimeSettings?: unknown;
  cfg: {
    autoCapture: boolean;
    /** X: the weight of the window, by the counter, at which the recorded turn pours the session off. */
    pourOffAtTokens: number;
    /** K: the weight of the newest messages that stay live; whole turns; an upper bound. */
    keepRecentTokens: number;
    /** Never fewer messages than this stay live. */
    keepRecentFloor: number;
    logFindRequests: boolean;
    peer_role?: OpenVikingPeerRole;
  };
  getClient: (agentId: string | undefined) => Promise<AfterTurnClient>;
  logger: ContextEngineLifecycleLogger;
  resolveAgentId: (sessionId: string, sessionKey?: string, ovSessionId?: string) => string;
  rememberSessionAgentId?: (ctx: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    ovSessionId?: string;
  }) => void;
  isBypassedSession: (params: { sessionId?: string; sessionKey?: string }) => boolean;
  diag: (stage: string, sessionId: string, data: Record<string, unknown>) => void;
  /** The proxy's price handle (PLAN-gorizont 4а): the pour-off by weight (4б) asks it. */
  priceHandle?: Pick<PriceHandle, "price" | "url">;
};

export function totalExtractedMemories(memories?: Record<string, number>): number {
  if (!memories || typeof memories !== "object") {
    return 0;
  }
  return Object.values(memories).reduce((sum, count) => sum + (count ?? 0), 0);
}

type ContextBudgets = {
  archiveMemory: number;
  sessionContext: number;
  reserved: number;
};

const ARCHIVE_BUDGET_RATIO = 0.15;
/**
 * The budget the server is asked for the session's context (PLAN-gorizont 4а).
 *
 * The server fits its messages to the budget by its own estimate, which is not
 * in the counter's units; so does the plugin's rough estimate. The window is
 * not cut by either: whatever the server has not archived is the window, whole,
 * and only the proxy's counter says what it weighs -- by that the plugin pours
 * off (4б). A budget this large makes the server cut nothing.
 */
export const NO_TRIM_TOKEN_BUDGET = 1_000_000_000;
const ARCHIVE_BUDGET_CAP = 8_000;
const RESERVED_MIN = 20_000;
const RESERVED_RATIO = 0.15;
const PHASE2_POLL_INTERVAL_MS = 2_000;
const PHASE2_POLL_MAX_MS = DEFAULT_PHASE2_POLL_TIMEOUT_MS;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After wait=false commit, Phase2 runs on the server. Poll task until completed/failed/timeout
 * so logs show memories_extracted (otherwise it looks like "nothing was saved").
 */
async function pollPhase2ExtractionOutcome(
  client: AfterTurnClient,
  taskId: string,
  logger: ContextEngineLifecycleLogger,
  sessionLabel: string,
): Promise<void> {
  const deadline = Date.now() + PHASE2_POLL_MAX_MS;
  let stageSeen: string | null | undefined;
  try {
    while (Date.now() < deadline) {
      await sleep(PHASE2_POLL_INTERVAL_MS);
      const task = await client.getTask(taskId).catch((e) => {
        logger.warn?.(`openviking: phase2 getTask failed task_id=${taskId}: ${String(e)}`);
        return null;
      });
      if (!task) {
        return;
      }
      if (typeof task.stage === "string" && task.stage && task.stage !== stageSeen) {
        stageSeen = task.stage;
        logger.info(`openviking: phase2 task_id=${taskId} session=${sessionLabel} stage: ${task.stage}`);
      }
      const { status } = task;
      if (status === "completed") {
        logger.info(
          `openviking: phase2 completed task_id=${taskId} session=${sessionLabel} ` +
            `result=${toJsonLog(task.result ?? {})}`,
        );
        return;
      }
      if (status === "failed") {
        logger.warn?.(
          `openviking: phase2 failed task_id=${taskId} session=${sessionLabel} error=${task.error ?? "unknown"}`,
        );
        return;
      }
    }
    logger.warn?.(
      `openviking: phase2 poll timeout (${PHASE2_POLL_MAX_MS / 1000}s) task_id=${taskId} session=${sessionLabel} — ` +
        `check GET /api/v1/tasks/${taskId}`,
    );
  } catch (e) {
    logger.warn?.(`openviking: phase2 poll exception task_id=${taskId}: ${String(e)}`);
  }
}

function allocateContextBudget(totalBudget: number, instructionTokens = 0): ContextBudgets {
  const reserveFloor = totalBudget >= RESERVED_MIN * 2 ? RESERVED_MIN : 0;
  const reserved = Math.min(totalBudget, Math.max(totalBudget * RESERVED_RATIO, reserveFloor));
  const usableBudget = Math.max(totalBudget - reserved - instructionTokens, 0);
  const archiveMemory = Math.min(usableBudget * ARCHIVE_BUDGET_RATIO, ARCHIVE_BUDGET_CAP);
  const sessionContext = Math.max(usableBudget - archiveMemory, 0);
  return { archiveMemory, sessionContext, reserved };
}

function buildSystemPromptAddition(): string {
  return [
    "## Session Context Guide",
    "",
    "Your conversation history includes two layers:",
    "",
    "1. **[Session History Summary]** — A compressed summary of all prior turns",
    "   in this session. It is organized into structured sections (Key Facts,",
    "   Timeline, People, etc.). Use it for background and continuity.",
    "   The summary is lossy: specific details (exact dates, numbers, names,",
    "   small events) may have been compressed away.",
    "",
    "2. **Active messages** — The most recent uncompressed turns.",
    "",
    "**Rules:**",
    "- When active messages conflict with the Summary, trust active messages",
    "  as the newer source of truth.",
    "- Do not fabricate details the Summary does not state explicitly.",
    "- **CRITICAL: Before answering 'no information' or 'not mentioned',",
    "  you MUST carefully re-read EVERY section of the [Session History Summary].",
    "  The answer may be expressed with different wording than the question.",
    "  Look for synonyms, related facts, and indirect references.**",
    "- If the Summary mentions a topic but lacks the specific detail asked,",
    "  use the `ov_archive_search` tool to grep the original archived messages",
    "  for the exact detail. Try 2-3 different keywords extracted from the question.",
    "- Only conclude information is unavailable AFTER both checking the Summary",
    "  thoroughly AND searching the archives with at least 2 keyword variations.",
  ].join("\n");
}

function buildInstructionPrompt(): { text: string; tokens: number } {
  const text = buildSystemPromptAddition();
  return { text, tokens: estimateTextTokens(text) };
}

function buildArchiveMemory(
  archiveOverview: string | undefined,
  _preAbstracts: Array<{ archive_id: string; abstract: string }>,
  _budget: number,
  roughEstimate: (messages: AgentMessage[]) => number,
): { messages: AgentMessage[]; tokens: number } {
  const messages: AgentMessage[] = [];

  if (archiveOverview) {
    messages.push({
      role: "user",
      content: `[Session History Summary]\n${archiveOverview}`,
    });
  }

  return { messages, tokens: roughEstimate(messages) };
}

/**
 * The server's live messages as the model sees them: all of them. What the
 * server has not archived is the window (PLAN-gorizont 4а); the rough estimate
 * is kept for the diagnostics only and cuts nothing.
 */
function buildSessionContext(
  ovMessages: OVMessage[],
  roughEstimate: (messages: AgentMessage[]) => number,
): { messages: AgentMessage[]; tokens: number } {
  const raw = ovMessages.flatMap((m) => convertToAgentMessages(m));
  const messages = mergeConsecutiveAssistants(raw);
  return { messages, tokens: roughEstimate(messages) };
}

function buildAssembledContext(
  overview: string | undefined,
  preAbstracts: Array<{ archive_id: string; abstract: string }>,
  ovMessages: OVMessage[],
  tokenBudget: number,
  ovSessionId: string,
  logger: ContextEngineLifecycleLogger,
  roughEstimate: (messages: AgentMessage[]) => number,
): AssembleBuiltContext {
  const hasArchives = Boolean(overview) || preAbstracts.length > 0;
  const instruction = hasArchives ? buildInstructionPrompt() : { text: "", tokens: 0 };

  // 4-layer context partitioning:
  //   Instruction — system prompt guide (Archive Index / Session History usage)
  //   Archive     — session history summary + per-archive one-line abstracts
  //   Session     — active OV messages converted to AgentMessage format
  //   Reserved    — headroom for model output (not consumed here)
  const budgets = allocateContextBudget(tokenBudget, instruction.tokens);
  const archive = buildArchiveMemory(overview, preAbstracts, budgets.archiveMemory, roughEstimate);
  const session = buildSessionContext(ovMessages, roughEstimate);
  const assembled = [...archive.messages, ...session.messages];

  logger.info(
    `openviking: assemble entering session content for ${ovSessionId}: ` +
      JSON.stringify(assembled.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content.substring(0, 100) : "[complex]",
      })), null, 2),
  );

  const sanitized = sanitizeAgentMessagesForProvider(assembled);

  return { sanitized, archive, session, budgets, instruction };
}

export async function commitOpenVikingSession({
  sessionId,
  sessionKey,
  getClient,
  resolveAgentId,
  logger,
  rememberSessionAgentId,
  isBypassedSession,
}: CommitOpenVikingSessionParams): Promise<boolean> {
  const ovId = openClawSessionToOvStorageId(sessionId, sessionKey);
  if (isBypassedSession({ sessionId, sessionKey })) {
    logger.warn?.(
      `openviking: commit skipped because session is bypassed (sessionId=${sessionId}, sessionKey=${sessionKey ?? "none"})`,
    );
    return false;
  }
  try {
    rememberSessionAgentId?.({
      sessionId,
      sessionKey,
      ovSessionId: ovId,
    });
    const client = await getClient(resolveAgentId(sessionId, sessionKey, ovId));
    const commitResult = await client.commitSession(ovId, {
      wait: true,
      keepRecentCount: 0,
    });
    const memCount = totalExtractedMemories(commitResult.memories_extracted);
    if (commitResult.status === "failed") {
      logger.warn?.(`openviking: commit Phase 2 failed for session=${sessionId}: ${commitResult.error ?? "unknown"}`);
      return false;
    }
    if (commitResult.status === "timeout") {
      logger.warn?.(`openviking: commit Phase 2 timed out for session=${sessionId}, task_id=${commitResult.task_id ?? "none"}`);
      return false;
    }
    logger.info(
      `openviking: committed OV session=${sessionId} ovId=${ovId}, archived=${commitResult.archived ?? false}, memories=${memCount}, task_id=${commitResult.task_id ?? "none"}, trace_id=${commitResult.trace_id ?? "none"}`,
    );
    return true;
  } catch (err) {
    logger.warn?.(`openviking: commit failed for session=${sessionId}: ${String(err)}`);
    return false;
  }
}

function assemblePassthrough(
  params: Pick<AssembleOpenVikingSessionParams, "diag"> & {
    ovSessionId: string;
    reason: string;
    liveMessages: AgentMessage[];
    originalTokens: number;
    extra?: Record<string, unknown>;
  },
): AssembleOpenVikingSessionResult {
  const { diag, ovSessionId, reason, liveMessages, originalTokens, extra } = params;
  diag("assemble_result", ovSessionId, {
    passthrough: true,
    reason,
    outputMessagesCount: liveMessages.length,
    inputTokenEstimate: originalTokens,
    estimatedTokens: originalTokens,
    tokensSaved: 0,
    savingPct: 0,
    ...extra,
  });
  return { messages: liveMessages, estimatedTokens: originalTokens };
}

function isSessionNotFoundError(err: unknown): boolean {
  const errorMessage = String(err);
  return errorMessage.includes("[NOT_FOUND]") && errorMessage.includes("Session not found");
}

/**
 * How many archives back the last closed one is looked for. A server that has
 * just failed an extraction has its newest archive failed, and a storm may fail
 * several in a row; beyond this many the summary is given up on and the live
 * tail alone is assembled.
 */
const RECOVERY_ARCHIVE_PROBES = 8;

/** `turnStamps`: the moments of the turns seen in the archive, each once, oldest first. */
type ClosedArchive = { archiveId: string; overview: string; turnStamps: number[] };

type RecoveryClient = Pick<OpenVikingClient, "getSessionArchive">;

function isNotFoundError(err: unknown): boolean {
  return String(err).includes("[NOT_FOUND]");
}

/** A moment as milliseconds: a number (seconds or milliseconds) or a date in text. */
function momentMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * The newest archive the server will hand out -- a closed one with a summary --
 * looking back from the newest. A failed or pending archive answers NOT_FOUND
 * and the next older one is asked; any other trouble ends the search, because a
 * server that cannot answer will not answer the next request either.
 */
async function findLastClosedArchive(
  client: RecoveryClient,
  ovSessionId: string,
  totalArchives: number,
  logger: ContextEngineLifecycleLogger,
): Promise<ClosedArchive | null> {
  const newest = Math.floor(totalArchives);
  const oldest = Math.max(1, newest - RECOVERY_ARCHIVE_PROBES + 1);
  for (let index = newest; index >= oldest; index -= 1) {
    const archiveId = `archive_${String(index).padStart(3, "0")}`;
    try {
      const archive = await client.getSessionArchive(ovSessionId, archiveId);
      const overview = typeof archive?.overview === "string" ? archive.overview.trim() : "";
      if (!overview) {
        continue;
      }
      const moments = (archive.messages ?? [])
        .map((message) => momentMs(message?.created_at))
        .filter((moment): moment is number => moment !== undefined);
      return {
        archiveId,
        overview,
        turnStamps: [...new Set(moments)].sort((left, right) => left - right),
      };
    } catch (err) {
      if (isNotFoundError(err)) {
        continue;
      }
      logger.warn?.(
        `openviking: looking for the last closed archive of session=${ovSessionId} ` +
          `stopped at ${archiveId}: ${String(err)}`,
      );
      return null;
    }
  }
  return null;
}

/**
 * Where in the live transcript the tail begins: the index of the last message
 * of a turn BEFORE the one the archive ends in -- the latest such turn the live
 * transcript knows -- or -1 when that cannot be told.
 *
 * The plugin stamps every message of a turn with one moment, that of the turn's
 * last message (`pickLatestCreatedAt`), and the server hands it back as it got
 * it. The archive is cut by a count of messages (`keep_recent_count`), not by
 * turns, so it may end in the middle of a turn -- and the stamp of its last
 * message then names a live message that comes AFTER the archive's end. Cutting
 * there would leave out what the archive never took. So the turn the archive
 * ends in is given whole, and the cut is made where the turn before it ended.
 *
 * The moment is matched exactly and the cut is made by place, not by time: a
 * message sent while the model was still answering stands later in the
 * transcript with an earlier time, and "everything older than" would take it
 * for archived.
 *
 * Not every turn of an archive has a counterpart in the transcript the gateway
 * hands over (29.09.2026, the live server: the moment looked for stood nowhere,
 * the nearest live message was the archive's last turn, 5838 ms on). Such a
 * turn is stepped over and the one before it is tried, back to the archive's
 * oldest. That only moves the cut earlier: more of what the summary already
 * covers is given again, nothing is left out. No match at all -- a lone turn in
 * the archive, a transcript without times -- is no boundary, and the caller
 * then takes more rather than less.
 */
function boundaryBeforeArchiveEnd(liveMessages: AgentMessage[], turnStamps: number[]): number {
  if (turnStamps.length < 2) {
    return -1;
  }
  // The FIRST place each moment stands at. Two messages may carry one moment, and
  // the later of them may open the next turn: cutting at the first gives a
  // message of this turn again, cutting at the last would leave that one out.
  const placeOf = new Map<number, number>();
  for (let index = 0; index < liveMessages.length; index += 1) {
    const moment = momentMs(liveMessages[index]?.timestamp);
    if (moment !== undefined && !placeOf.has(moment)) {
      placeOf.set(moment, index);
    }
  }
  for (let turn = turnStamps.length - 2; turn >= 0; turn -= 1) {
    const place = placeOf.get(turnStamps[turn]);
    if (place !== undefined) {
      return place;
    }
  }
  return -1;
}

/** How many of the archive's last turns the diagnostics show. */
const BOUNDARY_TURNS_SHOWN = 6;

/**
 * What the search for the boundary had to go on, in numbers alone -- no text of
 * the conversation. Written into the diagnostics of every recovery, so that a
 * boundary not found on a live server explains itself: how many live messages
 * carry a time at all and of what kind, which turn the cut was made at, and for
 * the archive's last turns, oldest first, how far off the nearest live message
 * stands. The archive's very last turn takes no part in the search but is shown.
 */
function describeBoundarySearch(
  liveMessages: AgentMessage[],
  turnStamps: number[],
  boundary: number,
): Record<string, unknown> {
  const timeKinds: Record<string, number> = {};
  const moments: number[] = [];
  for (const message of liveMessages) {
    const raw = message?.timestamp;
    const kind = raw === null ? "null" : typeof raw;
    timeKinds[kind] = (timeKinds[kind] ?? 0) + 1;
    const moment = momentMs(raw);
    if (moment !== undefined) {
      moments.push(moment);
    }
  }
  const lastTurns = turnStamps.slice(-BOUNDARY_TURNS_SHOWN).map((stamp) => {
    let offMs: number | null = null;
    for (const moment of moments) {
      const off = moment - stamp;
      if (offMs === null || Math.abs(off) < Math.abs(offMs)) {
        offMs = off;
      }
    }
    return { at: new Date(stamp).toISOString(), offMs };
  });
  const matchedAt = boundary >= 0 ? momentMs(liveMessages[boundary]?.timestamp) : undefined;
  const matchedRole = boundary >= 0 ? liveMessages[boundary]?.role : null;
  return {
    archiveTurns: turnStamps.length,
    liveMessages: liveMessages.length,
    liveWithTime: moments.length,
    timeKinds,
    matched: matchedAt === undefined ? null : new Date(matchedAt).toISOString(),
    matchedIndex: boundary >= 0 ? boundary : null,
    matchedRole: typeof matchedRole === "string" ? matchedRole : null,
    lastTurns,
  };
}

function boundarySearchInWords(search: Record<string, unknown>): string {
  const turns = Array.isArray(search.lastTurns) ? (search.lastTurns as Array<{ offMs: number | null }>) : [];
  const offs = turns.map((turn) => turn.offMs).filter((off): off is number => off !== null);
  return (
    `looked for ${String(search.archiveTurns)} turns of the archive among ` +
    `${String(search.liveWithTime)} live messages with a time, ` +
    (offs.length > 0
      ? `for its last ${offs.length} the nearest live messages stand ${offs.join(", ")} ms off`
      : "none of them has one")
  );
}

/**
 * The longest run of messages at the end of `messages` that fits `budget`.
 * Counted message by message from the newest, then checked as a whole, because
 * the estimate of a list is a little more than the sum of its parts.
 */
/** The model's name off the host's runtime settings, for the price handle. */
function modelOf(runtimeSettings: unknown): string | undefined {
  if (!runtimeSettings || typeof runtimeSettings !== "object") {
    return undefined;
  }
  const model = (runtimeSettings as { model?: unknown }).model;
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const { resolved, requested } = model as { resolved?: unknown; requested?: unknown };
  const name = typeof resolved === "string" && resolved.trim() ? resolved : requested;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

type TailByWeight = {
  /** The index the kept tail starts at. */
  start: number;
  /** Its weight by the handle; null without a price. */
  weight: number | null;
  /** Whether the handle weighed the tails, or the floor alone chose. */
  priced: boolean;
  /** How many tails the handle was asked about. */
  asked: number;
};

/**
 * The tail of a list of messages that stays live (PLAN-gorizont 4б): whole
 * turns, not shorter than the floor, the longest whose weight by the handle is
 * not above the cap. Without a price -- no handle, no model -- the floor alone:
 * the shortest tail by whole turns that is not shorter than it, and a warning.
 * Null when no tail is eligible: there is nothing to cut.
 */
async function tailByWeight(params: {
  starts: number[];
  total: number;
  floor: number;
  cap: number;
  weigh: ((start: number) => Promise<number | null>) | null;
}): Promise<TailByWeight | null> {
  const { total, floor, cap, weigh } = params;
  // The whole list is always a candidate: its first message may be the rest of
  // a turn the archive ended in the middle of, and that rest is not to be lost.
  const starts = params.starts.includes(0) ? params.starts : [0, ...params.starts];
  if (weigh) {
    const chosen = await longestTailWithin({ starts, total, floor, cap, weigh });
    return chosen ? { ...chosen, priced: true } : null;
  }
  const start = floorTail(starts, total, floor);
  return start === null ? null : { start, weight: null, priced: false, asked: 0 };
}

/**
 * Assembly without a fresh summary (28.09.2026).
 *
 * The server could not be used as it answered: its newest archive is failed and
 * it gives no summary while that is so, or it has nothing, or it did not answer
 * at all. A live transcript that fits the budget goes out as it is, as it always
 * did. One that does not fit never goes out whole -- no key would serve it, and
 * the chat would stand still until somebody mended the session by hand. It is
 * assembled instead from the summary of the last closed archive and everything
 * said after that archive ended, in order and without a gap; what still does not
 * fit is cut from the old end and counted.
 *
 * The messages after the archive are taken from the live transcript, not from
 * the server: the server will not hand out the messages of a failed archive, and
 * the live transcript has them all. Where the tail begins is told by
 * `boundaryBeforeArchiveEnd`; a boundary that cannot be told means more is
 * taken, never less: an overlap with the summary costs tokens, a gap costs the
 * thread of the conversation.
 *
 * Trouble with the server does not stop it: the archive not found, not
 * answered for, or unreadable still leaves the live tail within the budget.
 */
async function assembleWithoutFreshSummary(params: {
  diag: AssembleOpenVikingSessionParams["diag"];
  logger: ContextEngineLifecycleLogger;
  roughEstimate: (messages: AgentMessage[]) => number;
  ovSessionId: string;
  reason: string;
  liveMessages: AgentMessage[];
  originalTokens: number;
  tokenBudget: number;
  keepRecentTokens: number;
  keepRecentFloor: number;
  priceHandle?: Pick<PriceHandle, "price" | "url">;
  runtimeSettings?: unknown;
  client?: RecoveryClient;
  totalArchives?: number;
  extra?: Record<string, unknown>;
}): Promise<AssembleOpenVikingSessionResult> {
  const { diag, logger, roughEstimate, ovSessionId, reason, liveMessages, originalTokens, tokenBudget, extra } =
    params;
  const keepRecentTokens = params.keepRecentTokens;
  const keepRecentFloor = params.keepRecentFloor;
  if (liveMessages.length <= keepRecentFloor) {
    // Not more than the floor: it stays whole whatever it weighs.
    return assemblePassthrough({ diag, ovSessionId, reason, liveMessages, originalTokens, extra });
  }
  const model = modelOf(params.runtimeSettings);
  const weighLive =
    params.priceHandle && model
      ? async (messages: AgentMessage[]) => {
          const verdict = await params.priceHandle!.price({
            model,
            messages: [...toOpenAiMessages(messages), { role: "user", content: "x" }],
          });
          return verdict ? verdict.charge : null;
        }
      : null;
  if (weighLive) {
    // The whole live transcript under K goes as it is, as it always did when it fit.
    const whole = await weighLive(liveMessages);
    if (whole !== null && whole <= keepRecentTokens) {
      return assemblePassthrough({
        diag, ovSessionId, reason, liveMessages, originalTokens,
        extra: { ...extra, liveWeight: whole, keepRecentTokens },
      });
    }
  }

  let archive: ClosedArchive | null = null;
  if (params.client && typeof params.totalArchives === "number" && params.totalArchives >= 1) {
    try {
      archive = await findLastClosedArchive(params.client, ovSessionId, params.totalArchives, logger);
    } catch (err) {
      logger.warn?.(
        `openviking: looking for the last closed archive of session=${ovSessionId} broke: ${String(err)}`,
      );
    }
  }

  const instruction = archive ? buildInstructionPrompt() : { text: "", tokens: 0 };
  const budgets = allocateContextBudget(tokenBudget, instruction.tokens);
  const summary = buildArchiveMemory(archive?.overview, [], budgets.archiveMemory, roughEstimate);

  const boundary = archive ? boundaryBeforeArchiveEnd(liveMessages, archive.turnStamps) : -1;
  const boundaryFound = boundary >= 0;
  const search = archive ? describeBoundarySearch(liveMessages, archive.turnStamps, boundary) : null;
  const tail = boundaryFound ? liveMessages.slice(boundary + 1) : liveMessages.slice();

  // The tail by weight (PLAN-gorizont 4б): the live part of the window is never
  // heavier than K by the handle, whole turns, never fewer than the floor. The
  // estimate of characters cut here before; it is not in the counter's units.
  const weigh = weighLive ? (start: number) => weighLive(tail.slice(start)) : null;
  if (!weigh) {
    logger.warn?.(
      `openviking: no fresh summary for session=${ovSessionId} and no price ` +
        `(${params.priceHandle ? "the model is not named" : "no price handle"}): ` +
        `the live tail is cut by the floor of ${keepRecentFloor} messages alone`,
    );
  }
  const chosen = await tailByWeight({
    starts: turnStarts(tail),
    total: tail.length,
    floor: keepRecentFloor,
    cap: keepRecentTokens,
    weigh,
  });
  let kept = chosen ? tail.slice(chosen.start) : tail.slice();
  if (!archive) {
    // Nothing stands before the tail, so it has to open with the user's turn.
    const firstUser = kept.findIndex((message) => message?.role === "user");
    kept = firstUser >= 0 ? kept.slice(firstUser) : [];
  }
  const droppedMessages = tail.length - kept.length;

  let messages: AgentMessage[];
  try {
    messages = sanitizeAgentMessagesForProvider([...summary.messages, ...kept]);
  } catch (err) {
    logger.warn?.(
      `openviking: the recovered context of session=${ovSessionId} could not be put in order, ` +
        `handing it over as it is: ${String(err)}`,
    );
    messages = [...summary.messages, ...kept];
  }
  const estimatedTokens = roughEstimate(messages) + instruction.tokens;
  const tokensSaved = originalTokens - estimatedTokens;

  logger.warn?.(
    `openviking: no fresh summary for session=${ovSessionId} (${reason}): the transcript is ` +
      `${originalTokens} tokens against a budget of ${tokenBudget}, so it was assembled from ` +
      `${archive ? `the summary of ${archive.archiveId}` : "no summary (no closed archive in reach)"} ` +
      `and ${kept.length} live messages` +
      (boundaryFound
        ? " from the turn the archive ends in"
        : " by budget, where the archive ends could not be told") +
      (droppedMessages > 0
        ? `; dropped ${droppedMessages} oldest ${chosen?.priced ? `above ${keepRecentTokens} by the counter` : "beyond the floor, unweighed"}`
        : "") +
      (search && !boundaryFound ? `; ${boundarySearchInWords(search)}` : ""),
  );
  diag("assemble_result", ovSessionId, {
    passthrough: false,
    recovered: true,
    reason,
    archiveId: archive?.archiveId ?? null,
    boundaryFound,
    ...(search ? { boundary: search } : {}),
    tailMessages: tail.length,
    droppedMessages,
    keptWeight: chosen?.weight ?? null,
    priced: chosen?.priced ?? false,
    priceAsked: chosen?.asked ?? 0,
    keepRecentTokens,
    keepRecentFloor,
    outputMessagesCount: messages.length,
    inputTokenEstimate: originalTokens,
    estimatedTokens,
    tokensSaved,
    savingPct: originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0,
    archiveTokens: summary.tokens,
    instructionTokens: instruction.tokens,
    tokenBudget,
    ...extra,
  });

  return {
    messages,
    estimatedTokens,
    ...(instruction.text ? { systemPromptAddition: instruction.text } : {}),
  };
}

export async function assembleOpenVikingSession({
  sessionId,
  sessionKey,
  messages,
  tokenBudget,
  runtimeContext,
  runtimeSettings,
  isMainAssemble,
  cfg,
  getClient,
  priceHandle,
  logger,
  resolveAgentId,
  rememberSessionAgentId,
  isBypassedSession,
  queryConfigStore,
  traceRecorder,
  diag,
  roughEstimate,
  messageDigest,
  extractAgentMessageText,
  hasAutoRecallBlock,
  prependRecallToLatestUserMessage,
}: AssembleOpenVikingSessionParams): Promise<AssembleOpenVikingSessionResult> {
  const ovSessionId = openClawSessionToOvStorageId(sessionId, sessionKey);
  const sender = extractRuntimeSenderId(runtimeContext);
  const latestMessage = messages.at(-1);
  const isTransformContextAssemble = !isMainAssemble;
  const originalTokens = roughEstimate(messages);
  // What the recovery path cuts the live tail by (PLAN-gorizont 4б).
  const recoveryBits = {
    keepRecentTokens: typeof cfg?.keepRecentTokens === "number" ? cfg.keepRecentTokens : 150_000,
    keepRecentFloor: typeof cfg?.keepRecentFloor === "number" ? cfg.keepRecentFloor : 20,
    ...(priceHandle ? { priceHandle } : {}),
    ...(runtimeSettings !== undefined ? { runtimeSettings } : {}),
  };

  rememberSessionAgentId?.({
    sessionId,
    sessionKey,
    agentId: extractRuntimeAgentId(runtimeContext),
    ovSessionId,
  });
  diag("assemble_entry", ovSessionId, {
    messagesCount: messages.length,
    inputTokenEstimate: originalTokens,
    tokenBudget,
    sessionKey: sessionKey ?? null,
    senderIdFound: sender.found,
    senderId: sender.senderId ?? null,
    messages: messageDigest(messages),
  });

  if (isBypassedSession({ sessionId, sessionKey })) {
    return assemblePassthrough({ diag, ovSessionId, reason: "session_bypassed", liveMessages: messages, originalTokens });
  }

  if (isTransformContextAssemble) {
    if (latestMessage?.role !== "user") {
      return assemblePassthrough({
        diag,
        ovSessionId,
        reason: "transform_context_non_user_tail",
        liveMessages: messages,
        originalTokens,
        extra: { latestRole: latestMessage?.role ?? null },
      });
    }
    if (!cfg.autoRecall) {
      return assemblePassthrough({ diag, ovSessionId, reason: "transform_context_auto_recall_disabled", liveMessages: messages, originalTokens });
    }
    if (hasAutoRecallBlock(latestMessage)) {
      return assemblePassthrough({ diag, ovSessionId, reason: "transform_context_recall_already_injected", liveMessages: messages, originalTokens });
    }

    const recallQuery = prepareRecallQuery(extractAgentMessageText(latestMessage));
    if (!recallQuery.query || recallQuery.query.length < 5) {
      return assemblePassthrough({ diag, ovSessionId, reason: "transform_context_empty_recall_query", liveMessages: messages, originalTokens });
    }
    if (recallQuery.truncated) {
      logger.info(
        `openviking: recall query truncated (` +
          `chars=${recallQuery.originalChars}->${recallQuery.finalChars})`,
      );
    }

    try {
      const routingRef = sessionId ?? sessionKey ?? ovSessionId;
      const agentId = resolveAgentId(routingRef, sessionKey, ovSessionId);
      const client = await getClient(agentId);
      const actorPeerId = resolveOpenVikingActorPeerId({
        peerRole: cfg.peer_role ?? "assistant",
        personPeerId: sanitizeOpenVikingPeerId(sender.senderId),
        assistantPeerId: agentId,
      });
      const queryConfig = await queryConfigStore?.getEffective({
        agentId,
        sessionId,
        sessionKey,
        ovSessionId,
      });
      const recall = await buildAutoRecallContext({
        cfg,
        queryConfig,
        client,
        agentId,
        actorPeerId,
        queryText: recallQuery.query,
        logger,
        verbose: (message) => logger.info(message),
        traceRecorder: traceRecorder as never,
        sessionId,
        sessionKey,
        ovSessionId,
        queryTruncated: recallQuery.truncated,
        rawUserTextPreview: recallQuery.query,
      });

      if (!recall.block) {
        return assemblePassthrough({
          diag,
          ovSessionId,
          reason: "transform_context_no_recall_hits",
          liveMessages: messages,
          originalTokens,
          extra: { memoryCount: recall.memoryCount },
        });
      }

      const withRecall = prependRecallToLatestUserMessage(messages, recall.block);
      const estimatedTokens = roughEstimate(withRecall);
      diag("assemble_result", ovSessionId, {
        passthrough: false,
        phase: "transform_context",
        outputMessagesCount: withRecall.length,
        inputTokenEstimate: originalTokens,
        estimatedTokens,
        autoRecallMemoryCount: recall.memoryCount,
        autoRecallTokens: recall.estimatedTokens,
        messages: messageDigest(withRecall),
      });
      return { messages: withRecall, estimatedTokens };
    } catch (err) {
      logger.warn?.(`openviking: auto-recall failed: ${String(err)}`);
      return assemblePassthrough({
        diag,
        ovSessionId,
        reason: "transform_context_recall_failed",
        liveMessages: messages,
        originalTokens,
        extra: { error: String(err) },
      });
    }
  }

  try {
    const client = await getClient(
      resolveAgentId(sessionId ?? sessionKey ?? ovSessionId, sessionKey, ovSessionId),
    );
    const ctx = await client.getSessionContext(ovSessionId, NO_TRIM_TOKEN_BUDGET);

    const preAbstracts = ctx?.pre_archive_abstracts ?? [];
    const hasArchives = !!ctx?.latest_archive_overview || preAbstracts.length > 0;
    const activeCount = ctx?.messages?.length ?? 0;

    if (!ctx || (!hasArchives && activeCount === 0)) {
      return await assembleWithoutFreshSummary({
        ...recoveryBits,
        diag,
        logger,
        roughEstimate,
        ovSessionId,
        reason: "no_ov_data",
        liveMessages: messages,
        originalTokens,
        tokenBudget,
        client,
        totalArchives: ctx?.stats?.totalArchives,
        extra: { archiveCount: 0, activeCount: 0 },
      });
    }
    if (!hasArchives && ctx.messages.length < messages.length) {
      return await assembleWithoutFreshSummary({
        ...recoveryBits,
        diag,
        logger,
        roughEstimate,
        ovSessionId,
        reason: "ov_msgs_fewer_than_input",
        liveMessages: messages,
        originalTokens,
        tokenBudget,
        client,
        totalArchives: ctx.stats?.totalArchives,
        extra: { archiveCount: 0, activeCount },
      });
    }

    const { sanitized, archive, session, budgets, instruction } = buildAssembledContext(
      ctx.latest_archive_overview,
      preAbstracts,
      ctx.messages,
      tokenBudget,
      ovSessionId,
      logger,
      roughEstimate,
    );

    if (sanitized.length === 0 && messages.length > 0) {
      return await assembleWithoutFreshSummary({
        ...recoveryBits,
        diag,
        logger,
        roughEstimate,
        ovSessionId,
        reason: "sanitized_empty",
        liveMessages: messages,
        originalTokens,
        tokenBudget,
        client,
        totalArchives: ctx.stats?.totalArchives,
        extra: { archiveCount: preAbstracts.length, activeCount },
      });
    }

    const assembledTokens = roughEstimate(sanitized) + instruction.tokens;
    const tokensSaved = originalTokens - assembledTokens;
    const savingPct = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;

    diag("assemble_result", ovSessionId, {
      passthrough: false,
      archiveCount: preAbstracts.length,
      activeCount,
      outputMessagesCount: sanitized.length,
      inputTokenEstimate: originalTokens,
      estimatedTokens: assembledTokens,
      tokensSaved,
      savingPct,
      archiveTokens: archive.tokens,
      archiveBudget: budgets.archiveMemory,
      sessionTokens: session.tokens,
      sessionBudget: budgets.sessionContext,
      reservedBudget: budgets.reserved,
      senderIdFound: sender.found,
      senderId: sender.senderId ?? null,
      messages: messageDigest(sanitized),
    });

    return {
      messages: sanitized,
      estimatedTokens: assembledTokens,
      ...(instruction.text ? { systemPromptAddition: instruction.text } : {}),
    };
  } catch (err) {
    if (isSessionNotFoundError(err)) {
      const errorMessage = String(err);
      logger.info(
        `openviking: assemble skipped because OV session does not exist ` +
          `(session=${ovSessionId}, tokenBudget=${tokenBudget}, agentId=${resolveAgentId(ovSessionId)})`,
      );
      return await assembleWithoutFreshSummary({
        ...recoveryBits,
        diag,
        logger,
        roughEstimate,
        ovSessionId,
        reason: "session_not_found",
        liveMessages: messages,
        originalTokens,
        tokenBudget,
        extra: {
          error: errorMessage,
          tokenBudget,
          agentId: resolveAgentId(ovSessionId),
          senderIdFound: sender.found,
          senderId: sender.senderId ?? null,
        },
      });
    }
    logger.warn?.(
      `openviking: assemble failed for session=${ovSessionId}, ` +
        `tokenBudget=${tokenBudget}, agentId=${resolveAgentId(ovSessionId)}: ${String(err)}`,
    );
    diag("assemble_error", ovSessionId, {
      error: String(err),
      tokenBudget,
      agentId: resolveAgentId(ovSessionId),
      senderIdFound: sender.found,
      senderId: sender.senderId ?? null,
    });
    // No shortcut by the rough estimate here (PLAN-gorizont 4б): the recovery
    // path passes the transcript through by its weight, or by the floor.
    return await assembleWithoutFreshSummary({
        ...recoveryBits,
      diag,
      logger,
      roughEstimate,
      ovSessionId,
      reason: "assemble_error",
      liveMessages: messages,
      originalTokens,
      tokenBudget,
      extra: { error: String(err) },
    });
  }
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestampMs = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return new Date(timestampMs).toISOString();
  }
  return undefined;
}

function pickLatestCreatedAt(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "";
    if (!role || role === "system") {
      continue;
    }
    const normalized = normalizeTimestamp(message.timestamp);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function extractRuntimeSenderId(runtimeContext: Record<string, unknown> | undefined): {
  found: boolean;
  senderId?: string;
} {
  if (runtimeContext) {
    const senderId = runtimeContext.senderId;
    if (typeof senderId === "string") {
      const trimmed = senderId.trim();
      if (trimmed) {
        return { found: true, senderId: trimmed };
      }
    }
  }
  return { found: false };
}

function extractRuntimeAgentId(runtimeContext: Record<string, unknown> | undefined): string | undefined {
  if (!runtimeContext) {
    return undefined;
  }
  const agentId = runtimeContext.agentId;
  return typeof agentId === "string" && agentId.trim() ? agentId.trim() : undefined;
}

function isToolOnlyMessage(msg: ExtractedTurnMessage): boolean {
  return msg.role === "assistant" && msg.parts.length > 0 && msg.parts.every((part) => part.type === "tool");
}

function coalesceConsecutiveToolMessages(messages: ExtractedTurnMessage[]): ExtractedTurnMessage[] {
  const result: ExtractedTurnMessage[] = [];
  let pendingTools: ExtractedTurnMessage | undefined;

  const flush = () => {
    if (pendingTools) {
      result.push(pendingTools);
      pendingTools = undefined;
    }
  };

  for (const msg of messages) {
    if (isToolOnlyMessage(msg)) {
      if (!pendingTools) {
        pendingTools = { role: "assistant", parts: [] };
      }
      pendingTools.parts.push(...msg.parts);
      continue;
    }
    flush();
    result.push(msg);
  }
  flush();
  return result;
}

function messageDigest(messages: AgentMessage[], maxCharsPerMsg = 2000): Array<{role: string; content: string; tokens: number; truncated: boolean}> {
  return messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    const role = String(m.role ?? "unknown");
    const raw = m.content;
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (Array.isArray(raw)) {
      text = (raw as Record<string, unknown>[])
        .map((b) => {
          if (b.type === "text") return String(b.text ?? "");
          if (b.type === "toolCall") return `[toolCall: ${String(b.name)}(${JSON.stringify(b.arguments ?? {}).slice(0, 200)})]`;
          if (b.type === "toolResult") return `[toolResult: ${JSON.stringify(b.content ?? "").slice(0, 200)}]`;
          return `[${String(b.type)}]`;
        })
        .join("\n");
    } else {
      text = JSON.stringify(raw) ?? "";
    }
    const truncated = text.length > maxCharsPerMsg;
    return {
      role,
      content: truncated ? text.slice(0, maxCharsPerMsg) + "..." : text,
      tokens: estimateAgentMessageTokens(msg),
      truncated,
    };
  });
}

export async function afterTurnOpenVikingSession({
  sessionId,
  sessionKey,
  messages: rawMessages,
  prePromptMessageCount,
  isHeartbeat,
  runtimeContext,
  runtimeSettings,
  cfg,
  getClient,
  logger,
  resolveAgentId,
  rememberSessionAgentId,
  isBypassedSession,
  diag,
  priceHandle,
}: AfterTurnOpenVikingSessionParams): Promise<void> {
  if (!cfg.autoCapture) {
    return;
  }

  if (isHeartbeat) {
    return;
  }

  try {
    const sender = extractRuntimeSenderId(runtimeContext);
    const ovSessionId = openClawSessionToOvStorageId(sessionId, sessionKey);
    const runtimeAgentId = extractRuntimeAgentId(runtimeContext);
    if (runtimeAgentId) {
      rememberSessionAgentId?.({
        agentId: runtimeAgentId,
        sessionId,
        sessionKey,
        ovSessionId,
      });
    }
    const routingRef = sessionId ?? sessionKey ?? ovSessionId;
    const agentId = resolveAgentId(routingRef, sessionKey, ovSessionId);

    if (isBypassedSession({ sessionId, sessionKey })) {
      diag("afterTurn_skip", ovSessionId, {
        reason: "session_bypassed",
        totalMessages: rawMessages?.length ?? 0,
        senderIdFound: sender.found,
        senderId: sender.senderId ?? null,
      });
      return;
    }

    const messages = rawMessages ?? [];
    if (messages.length === 0) {
      diag("afterTurn_skip", ovSessionId, {
        reason: "no_messages",
        totalMessages: 0,
        senderIdFound: sender.found,
        senderId: sender.senderId ?? null,
      });
      return;
    }

    const start =
      typeof prePromptMessageCount === "number" && prePromptMessageCount >= 0
        ? prePromptMessageCount
        : 0;

    const { messages: extractedMessagesRaw, newCount } = extractNewTurnMessages(messages, start);
    const extractedMessages = coalesceConsecutiveToolMessages(extractedMessagesRaw);

    if (extractedMessages.length === 0) {
      diag("afterTurn_skip", ovSessionId, {
        reason: "no_new_turn_messages",
        totalMessages: messages.length,
        prePromptMessageCount: start,
        senderIdFound: sender.found,
        senderId: sender.senderId ?? null,
      });
      return;
    }

    const turnMessages = messages.slice(start) as AgentMessage[];
    const newMessages = turnMessages.filter((m: AgentMessage) => {
      const role = (m as Record<string, unknown>).role as string;
      return role === "user" || role === "assistant";
    }) as AgentMessage[];
    const newMsgFull = messageDigest(newMessages);
    const newTurnTokens = newMsgFull.reduce((sum, digest) => sum + digest.tokens, 0);

    diag("afterTurn_entry", ovSessionId, {
      totalMessages: messages.length,
      newMessageCount: newCount,
      prePromptMessageCount: start,
      newTurnTokens,
      senderIdFound: sender.found,
      senderId: sender.senderId ?? null,
      messages: newMsgFull,
    });

    const client = await getClient(agentId);
    const createdAt = pickLatestCreatedAt(turnMessages);
    const senderRoleId = toRoleId(sender.senderId);
    for (const msg of extractedMessages) {
      const ovParts = msg.parts.map((part) => {
        if (part.type === "text") {
          const cleaned = part.text
            .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
          return { type: "text" as const, text: cleaned };
        }
        return {
          type: "tool" as const,
          tool_id: part.toolCallId,
          tool_name: part.toolName,
          tool_input: part.toolInput,
          tool_output: part.toolOutput,
          tool_status: part.toolStatus,
        };
      });

      if (ovParts.length > 0) {
        await client.addSessionMessage(
          ovSessionId,
          msg.role,
          ovParts,
          undefined,
          createdAt,
          resolveOpenVikingMessagePeerId({
            peerRole: cfg.peer_role ?? "assistant",
            role: msg.role,
            personPeerId: senderRoleId,
            assistantPeerId: agentId,
          }),
        );
      }
    }

    // The pour-off by X (PLAN-gorizont 4б). The window's weight is the charge of
    // the turn's last request, as the proxy's counter made it and the host hands
    // it on; at X or above, the newest messages weighing up to K stay live and
    // the rest goes to the archive, its summary written in the background.
    const window = validTokenCount(runtimeContext?.currentTokenCount);
    const skip = (reason: string, extra: Record<string, unknown> = {}) =>
      diag("pour_skip", ovSessionId, {
        reason,
        window: window ?? null,
        pourOffAtTokens: cfg.pourOffAtTokens,
        senderIdFound: sender.found,
        senderId: sender.senderId ?? null,
        ...extra,
      });
    if (window === undefined) {
      skip("no_window_weight");
      return;
    }
    if (window < cfg.pourOffAtTokens) {
      skip("below_x");
      return;
    }

    const ctx = await client.getSessionContext(ovSessionId, NO_TRIM_TOKEN_BUDGET);
    const unsummarized = ctx?.stats?.unsummarizedArchives;
    if (typeof unsummarized !== "number") {
      logger.warn?.(
        `openviking: the server gives no stats.unsummarizedArchives for session=${ovSessionId} ` +
          "(a server older than image .3); pouring without the guard against a summary still being written",
      );
    } else if (unsummarized > 0) {
      // The summary of the last pour is not written yet: the server still hands
      // that archive's messages out raw, and the window will shrink when the
      // summary stands. Pouring again now would only queue another archive.
      skip("summary_pending", { unsummarizedArchives: unsummarized });
      return;
    }

    const pending = ctx?.messages ?? [];
    const model = modelOf(runtimeSettings);
    const weighed = new Map<number, number | null>();
    const weigh =
      priceHandle && model
        ? async (start: number) => {
            if (!weighed.has(start)) {
              const verdict = await priceHandle.price(priceBodyOf(model, pending.slice(start)));
              weighed.set(start, verdict ? verdict.charge : null);
            }
            return weighed.get(start) ?? null;
          }
        : null;
    if (!weigh) {
      logger.warn?.(
        `openviking: pouring session=${ovSessionId} without a price ` +
          `(${priceHandle ? "the model is not named by the host" : "no price handle"}): ` +
          `the floor of ${cfg.keepRecentFloor} messages by whole turns stays, the rest goes to the archive`,
      );
    }

    // K is an upper bound: never more than fits under X with the rest of the
    // window -- the window's weight less the weight of all the messages.
    let rest: number | null = null;
    let cap = cfg.keepRecentTokens;
    if (weigh && pending.length > 0) {
      const all = await weigh(0);
      if (all !== null) {
        rest = Math.max(0, window - all);
        cap = Math.min(cfg.keepRecentTokens, Math.max(0, cfg.pourOffAtTokens - rest));
      }
    }

    const chosen = await tailByWeight({
      starts: turnStarts(pending),
      total: pending.length,
      floor: cfg.keepRecentFloor,
      cap,
      weigh,
    });
    if (!chosen || chosen.start === 0) {
      // Nothing to pour: fewer messages than the floor, or all of them fit under
      // the cap -- the window is at X because of its constant part, not them.
      logger.warn?.(
        `openviking: session=${ovSessionId} weighs ${window} by the counter, at or above ${cfg.pourOffAtTokens}, ` +
          `and there is nothing to pour: ${pending.length} messages on the server` +
          (chosen ? ` weighing ${chosen.weight ?? "unweighed"} under the cap of ${cap}` : `, the floor is ${cfg.keepRecentFloor}`),
      );
      skip("nothing_to_pour", {
        pendingMessages: pending.length,
        keepRecentFloor: cfg.keepRecentFloor,
        rest,
        cap,
        allWeight: chosen?.weight ?? null,
      });
      return;
    }
    const keepRecentCount = pending.length - chosen.start;

    const commitResult = await client.commitSession(ovSessionId, {
      wait: false,
      keepRecentCount,
    });
    logger.info(
      `openviking: poured session=${ovSessionId}: window ${window} by the counter, ` +
        `kept ${keepRecentCount} newest messages` +
        (chosen.weight !== null ? ` weighing ${chosen.weight}` : " by the floor, unweighed") +
        ` under ${cap}, archiving ${chosen.start}; ` +
        `status=${commitResult.status}, archived=${commitResult.archived ?? false}, ` +
        `task_id=${commitResult.task_id ?? "none"}, trace_id=${commitResult.trace_id ?? "none"}`,
    );

    diag("pour_off", ovSessionId, {
      window,
      pourOffAtTokens: cfg.pourOffAtTokens,
      keepRecentTokens: cfg.keepRecentTokens,
      keepRecentFloor: cfg.keepRecentFloor,
      rest,
      cap,
      model: model ?? null,
      priced: chosen.priced,
      priceAsked: chosen.asked,
      pendingMessages: pending.length,
      keptMessages: keepRecentCount,
      keptWeight: chosen.weight,
      archivedMessages: chosen.start,
      status: commitResult.status,
      archived: commitResult.archived ?? false,
      taskId: commitResult.task_id ?? null,
      senderIdFound: sender.found,
      senderId: sender.senderId ?? null,
    });
    if (commitResult.task_id) {
      void pollPhase2ExtractionOutcome(client, commitResult.task_id, logger, ovSessionId);
    }
  } catch (err) {
    logger.warn?.(`openviking: afterTurn failed: ${String(err)}`);
    const sender = extractRuntimeSenderId(runtimeContext);
    diag("afterTurn_error", sessionId ?? "(unknown)", {
      error: String(err),
      senderIdFound: sender.found,
      senderId: sender.senderId ?? null,
    });
  }
}

function validTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function compactFailureResult(
  reason: string,
  tokensBefore: number,
  details: unknown,
): CompactOpenVikingSessionResult {
  return {
    ok: false,
    compacted: false,
    reason,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore,
      tokensAfter: undefined,
      details,
    },
  };
}

export async function compactOpenVikingSession({
  sessionId,
  sessionKey,
  tokenBudget,
  currentTokenCount,
  force,
  compactionTarget,
  keepRecentCount = 0,
  customInstructions,
  getClient,
  logger,
  resolveAgentId,
  isBypassedSession,
  diag,
}: CompactOpenVikingSessionParams): Promise<CompactOpenVikingSessionResult> {
  const ovSessionId = openClawSessionToOvStorageId(sessionId, sessionKey);
  diag("compact_entry", ovSessionId, {
    tokenBudget,
    force: force ?? false,
    currentTokenCount: currentTokenCount ?? null,
    compactionTarget: compactionTarget ?? null,
    keepRecentCount,
    hasCustomInstructions: typeof customInstructions === "string" &&
      customInstructions.trim().length > 0,
  });

  if (isBypassedSession({ sessionId, sessionKey })) {
    diag("compact_result", ovSessionId, {
      ok: true,
      compacted: false,
      reason: "session_bypassed",
    });
    return {
      ok: true,
      compacted: false,
      reason: "session_bypassed",
    };
  }

  const agentId = resolveAgentId(sessionId, sessionKey, ovSessionId);
  const client = await getClient(agentId);
  const tokensBeforeOriginal = validTokenCount(currentTokenCount);
  let preCommitEstimatedTokens: number | undefined;
  if (typeof tokensBeforeOriginal !== "number") {
    try {
      const preCtx = await client.getSessionContext(ovSessionId, NO_TRIM_TOKEN_BUDGET);
      if (typeof preCtx.estimatedTokens === "number" && Number.isFinite(preCtx.estimatedTokens)) {
        preCommitEstimatedTokens = preCtx.estimatedTokens;
      }
    } catch (preCtxErr) {
      logger.info(
        `openviking: compact pre-ctx fetch failed for session=${ovSessionId}, ` +
          `tokenBudget=${tokenBudget}, agentId=${agentId}: ${String(preCtxErr)}`,
      );
    }
  }

  const tokensBefore = tokensBeforeOriginal ?? preCommitEstimatedTokens ?? -1;

  try {
    logger.info(
      `openviking: compact committing session=${ovSessionId} (wait=true, tokenBudget=${tokenBudget}, keepRecentCount=${keepRecentCount})`,
    );
    const commitResult = await client.commitSession(ovSessionId, {
      wait: true,
      keepRecentCount,
    });
    const memCount = totalExtractedMemories(commitResult.memories_extracted);

    if (commitResult.status === "failed") {
      logger.warn?.(
        `openviking: compact commit Phase 2 failed for session=${ovSessionId}: ${commitResult.error ?? "unknown"}`,
      );
      diag("compact_result", ovSessionId, {
        ok: false,
        compacted: false,
        reason: "commit_failed",
        status: commitResult.status,
        archived: commitResult.archived ?? false,
        taskId: commitResult.task_id ?? null,
        error: commitResult.error ?? null,
      });
      return compactFailureResult("commit_failed", tokensBefore, { commit: commitResult });
    }

    if (commitResult.status === "timeout") {
      logger.warn?.(
        `openviking: compact commit Phase 2 timed out for session=${ovSessionId}, task_id=${commitResult.task_id ?? "none"}`,
      );
      diag("compact_result", ovSessionId, {
        ok: false,
        compacted: false,
        reason: "commit_timeout",
        status: commitResult.status,
        archived: commitResult.archived ?? false,
        taskId: commitResult.task_id ?? null,
      });
      return compactFailureResult("commit_timeout", tokensBefore, { commit: commitResult });
    }

    logger.info(
      `openviking: compact committed session=${ovSessionId}, archived=${commitResult.archived ?? false}, memories=${memCount}, task_id=${commitResult.task_id ?? "none"}, trace_id=${commitResult.trace_id ?? "none"}`,
    );

    if (!commitResult.archived && keepRecentCount > 0) {
      // Nothing older than the kept messages: the archive at the pending
      // threshold has just taken it, or the tail is all there is. The kept
      // messages stay live -- archiving them would leave the model a summary
      // alone -- and the host is told the session is already compacted: it
      // treats only that ("already compacted", "below threshold") as a
      // harmless skip, and any other reason drops the turn.
      const reason = `already compacted: nothing older than the last ${keepRecentCount} messages to archive`;
      logger.info(`openviking: compact ${reason} for session=${ovSessionId}, tokensBefore=${tokensBefore}`);
      diag("compact_result", ovSessionId, {
        ok: true,
        compacted: false,
        reason,
        status: commitResult.status,
        archived: false,
        keepRecentCount,
        tokensBefore,
      });
      return {
        ok: true,
        compacted: false,
        reason,
        result: {
          summary: "",
          tokensBefore,
          tokensAfter: tokensBefore >= 0 ? tokensBefore : undefined,
          details: {
            commit: commitResult,
          },
        },
      };
    }

    if (!commitResult.archived) {
      logger.info(
        `openviking: compact no archive for session=${ovSessionId}, ` +
          `tokensBefore=${tokensBefore}, tokensAfter=${tokensBefore}`,
      );
      diag("compact_result", ovSessionId, {
        ok: true,
        compacted: false,
        reason: "commit_no_archive",
        status: commitResult.status,
        archived: commitResult.archived ?? false,
        taskId: commitResult.task_id ?? null,
        memories: memCount,
        tokensBefore,
      });
      return {
        ok: true,
        compacted: false,
        reason: "commit_no_archive",
        result: {
          summary: "",
          tokensBefore,
          tokensAfter: tokensBefore >= 0 ? tokensBefore : undefined,
          details: {
            commit: commitResult,
          },
        },
      };
    }

    let summary = "";
    const firstKeptEntryId = commitResult.archive_uri?.split("/").pop() ?? "";
    let tokensAfter: number | undefined;
    let contextFetchError: string | undefined;

    try {
      const ctx = await client.getSessionContext(ovSessionId, NO_TRIM_TOKEN_BUDGET);
      logger.info(
        `openviking: compact getSessionContext raw result for ${ovSessionId}: ` +
          JSON.stringify(ctx, null, 2),
      );
      if (typeof ctx.latest_archive_overview === "string") {
        summary = ctx.latest_archive_overview.trim();
      }
      if (typeof ctx.estimatedTokens === "number" && Number.isFinite(ctx.estimatedTokens)) {
        tokensAfter = ctx.estimatedTokens;
      }
      logger.info(
        `openviking: compact restored session content for ${ovSessionId}: ` +
          `messages=${ctx.messages?.length ?? 0}, ` +
          `latestArchiveOverview=${summary.length > 0 ? "present" : "empty"} (${summary.length} chars), ` +
          `preArchiveAbstracts=${ctx.pre_archive_abstracts?.length ?? 0}, ` +
          `estimatedTokens=${ctx.estimatedTokens}`,
      );
      if (summary.length > 0) {
        logger.info(
          `openviking: compact latest_archive_overview for ${ovSessionId}: ${summary.substring(0, 200)}...`,
        );
      }
      if (ctx.messages && ctx.messages.length > 0) {
        const msgSummary = ctx.messages.map((m: { role?: string; content?: string; parts?: Array<{ type?: string; text?: string }> }) => {
          const role = m.role ?? "unknown";
          let textPreview = "";
          if (m.content) {
            textPreview = m.content.substring(0, 80);
          } else if (m.parts && m.parts.length > 0) {
            const textPart = m.parts.find((p: { type?: string }) => p.type === "text");
            textPreview = textPart?.text?.substring(0, 80) ?? JSON.stringify(m.parts).substring(0, 80);
          }
          return { role, textPreview };
        });
        logger.info(
          `openviking: compact restored messages for ${ovSessionId}: ` +
            JSON.stringify(msgSummary),
        );
      }
    } catch (ctxErr) {
      contextFetchError = String(ctxErr);
      logger.info(
        `openviking: compact context fetch failed for session=${ovSessionId}, ` +
          `tokenBudget=${tokenBudget}, agentId=${agentId}: ${contextFetchError}`,
      );
    }

    logger.info(
      `openviking: compact tokens session=${ovSessionId}, ` +
        `tokensBefore=${tokensBefore}, tokensAfter=${tokensAfter ?? "unknown"}, ` +
        `latestArchiveId=${firstKeptEntryId || "none"}`,
    );

    diag("compact_result", ovSessionId, {
      ok: true,
      compacted: true,
      reason: "commit_completed",
      status: commitResult.status,
      archived: commitResult.archived ?? false,
      taskId: commitResult.task_id ?? null,
      memories: memCount,
      tokensBefore,
      tokensAfter: tokensAfter ?? null,
      latestArchiveId: firstKeptEntryId || null,
      summaryPresent: summary.length > 0,
    });

    return {
      ok: true,
      compacted: true,
      reason: "commit_completed",
      result: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        tokensAfter,
        details: contextFetchError
          ? {
              commit: commitResult,
              contextError: contextFetchError,
            }
          : {
              commit: commitResult,
            },
      },
    };
  } catch (err) {
    const errorMessage = String(err);
    if (isSessionNotFoundError(err)) {
      logger.info(
        `openviking: compact skipped because OV session does not exist ` +
          `(session=${ovSessionId}, agentId=${agentId})`,
      );
      diag("compact_result", ovSessionId, {
        ok: true,
        compacted: false,
        reason: "session_not_found",
        error: errorMessage,
      });
      return {
        ok: true,
        compacted: false,
        reason: "session_not_found",
      };
    }
    logger.warn?.(`openviking: compact commit failed for session=${ovSessionId}: ${errorMessage}`);
    diag("compact_error", ovSessionId, {
      error: errorMessage,
    });
    return compactFailureResult("commit_error", tokensBefore, { error: errorMessage });
  }
}
