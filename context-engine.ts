import type { OpenVikingClient } from "./client.js";
import type { MemoryOpenVikingConfig } from "./config.js";
import type { RuntimeQueryConfigStore } from "./query-config.js";
import {
  AUTO_RECALL_SOURCE_MARKER,
} from "./auto-recall.js";
import {
  compileSessionPatterns,
  getCaptureDecision,
  shouldBypassSession,
} from "./text-utils.js";
import type { RecallTraceEntry } from "./recall-trace.js";
import { estimateAgentMessageTokens, estimateAgentMessagesTokens } from "./token-estimator.js";
import { openClawSessionToOvStorageId } from "./routing/identity-routing.js";
import type { AgentMessage } from "./services/context-message-adapter.js";
import {
  assembleOpenVikingSession,
  afterTurnOpenVikingSession,
  compactOpenVikingSession,
  commitOpenVikingSession,
} from "./services/context-lifecycle-service.js";

type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  ownsCompaction: true;
  /**
   * Контракт, который OpenClaw требует от стороннего движка, иначе на каждом
   * ходу откатывается на legacy (src/agents/harness/context-engine-logical-turn.ts).
   * currentTurnFence — транскрипт для сборки обрезается перед записью текущего
   * хода; ровно так и работает assemble, он берёт messages до prePromptMessageCount.
   * turnAdvancementIdempotency — commitTurn можно повторять с тем же
   * advancementKey без задвоения; обеспечено защитой в captureTurnOnce.
   */
  transcriptSemantics?: {
    currentTurnFence?: "before-current-turn-entry-v1";
    turnAdvancementIdempotency?: "atomic-idempotent-v1";
  };
};

/**
 * Отпечаток одного хода: сессия, граница текущего хода и его сообщения.
 * Считается одинаково для afterTurn и commitTurn, потому что оба получают
 * messages и prePromptMessageCount от одного и того же хоста.
 */
export function turnFingerprint(
  sessionId: string,
  prePromptMessageCount: number | undefined,
  messages: readonly unknown[],
): string {
  const start = typeof prePromptMessageCount === "number" && prePromptMessageCount >= 0
    ? prePromptMessageCount
    : 0;
  const tail = messages.slice(start);
  let hash = 0x811c9dc5;
  const text = `${start}|${messages.length}|${JSON.stringify(tail)}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${sessionId}:${start}:${messages.length}:${hash.toString(16)}`;
}

// Ходы, уже принятые к записи. Ключей на сессию немного, но чат живёт долго,
// поэтому набор ограничен и старое вытесняется.
const CLAIMED_TURNS_PER_SESSION = 64;
const claimedTurns = new Map<string, Set<string>>();

/**
 * Пометить ход как забранный. Возвращает false, если его уже забрали раньше —
 * тогда повторную запись делать нельзя.
 */
export function claimTurn(sessionId: string, key: string): boolean {
  let seen = claimedTurns.get(sessionId);
  if (!seen) {
    seen = new Set<string>();
    claimedTurns.set(sessionId, seen);
    // Сессий тоже может накопиться: держим только последние.
    if (claimedTurns.size > 256) {
      const oldest = claimedTurns.keys().next().value;
      if (oldest !== undefined) claimedTurns.delete(oldest);
    }
  }
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > CLAIMED_TURNS_PER_SESSION) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
};

type IngestResult = {
  ingested: boolean;
};

type IngestBatchResult = {
  ingestedCount: number;
};

type CompactResult = {
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

type ContextEngine = {
  info: ContextEngineInfo;
  ingest: (params: { sessionId: string; message: AgentMessage; isHeartbeat?: boolean }) => Promise<IngestResult>;
  ingestBatch?: (params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }) => Promise<IngestBatchResult>;
  commitTurn?: (params: {
    advancementKey: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    sessionId: string;
    sessionKey?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<{ status: "committed" | "duplicate" }>;
  afterTurn?: (params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
    sessionKey?: string;
  }) => Promise<void>;
  assemble: (params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    prompt?: string;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<AssembleResult>;
  compact: (params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<CompactResult>;
};

export type ContextEngineWithCommit = ContextEngine & {
  /** Commit (archive + extract) the OV session. Returns true on success. */
  commitOVSession: (params: {
    sessionId: string;
    sessionKey?: string;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<boolean>;
};

type Logger = {
  info: (msg: string) => void;
  warn?: (msg: string) => void;
  error: (msg: string) => void;
};

function roughEstimate(messages: AgentMessage[]): number {
  return estimateAgentMessagesTokens(messages);
}

function msgTokenEstimate(msg: AgentMessage): number {
  return estimateAgentMessageTokens(msg);
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
      tokens: msgTokenEstimate(msg),
      truncated,
    };
  });
}

function extractAgentMessageText(message: AgentMessage | undefined): string {
  if (!message) {
    return "";
  }
  const raw = message.content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((block) => {
        if (!block || typeof block !== "object") {
          return "";
        }
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          return b.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function hasAutoRecallBlock(message: AgentMessage | undefined): boolean {
  return extractAgentMessageText(message).includes(AUTO_RECALL_SOURCE_MARKER);
}

function prependTextToMessageContent(content: unknown, text: string): unknown {
  if (typeof content === "string") {
    return `${text}\n\n${content}`;
  }
  if (Array.isArray(content)) {
    if (content.length === 0) {
      return [{ type: "text", text }];
    }
    const first = content[0];
    if (
      first &&
      typeof first === "object" &&
      (first as Record<string, unknown>).type === "text" &&
      typeof (first as Record<string, unknown>).text === "string"
    ) {
      return [
        {
          ...(first as Record<string, unknown>),
          text: `${text}\n\n${(first as Record<string, unknown>).text as string}`,
        },
        ...content.slice(1),
      ];
    }
    return [{ type: "text", text }, ...content];
  }
  return text;
}

function prependRecallToLatestUserMessage(messages: AgentMessage[], recallBlock: string): AgentMessage[] {
  const latest = messages.at(-1);
  if (!latest || latest.role !== "user" || hasAutoRecallBlock(latest)) {
    return messages;
  }
  return [
    ...messages.slice(0, -1),
    {
      ...latest,
      content: prependTextToMessageContent(latest.content, recallBlock),
    },
  ];
}

function emitDiag(log: Logger, stage: string, sessionId: string, data: Record<string, unknown>, enabled = true): void {
  if (!enabled) return;
  log.info(`openviking: diag ${JSON.stringify({ ts: Date.now(), stage, sessionId, data })}`);
}

function validTokenBudget(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return undefined;
}

export function createMemoryOpenVikingContextEngine(params: {
  id: string;
  name: string;
  version?: string;
  cfg: Required<MemoryOpenVikingConfig>;
  logger: Logger;
  getClient: (agentId: string | undefined) => Promise<OpenVikingClient>;
  /** Extra args help match hook-populated routing when OpenClaw provides sessionKey / OV session id. */
  resolveAgentId: (sessionId: string, sessionKey?: string, ovSessionId?: string) => string;
  rememberSessionAgentId?: (ctx: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    ovSessionId?: string;
  }) => void;
  queryConfigStore?: RuntimeQueryConfigStore;
  traceRecorder?: { record(entry: RecallTraceEntry): void; recordAndFlush?: (entry: RecallTraceEntry) => Promise<unknown> };
}): ContextEngineWithCommit {
  const {
    id,
    name,
    version,
    cfg,
    logger,
    getClient,
    resolveAgentId,
    rememberSessionAgentId,
    queryConfigStore,
    traceRecorder,
  } = params;

  const diagEnabled = cfg.emitStandardDiagnostics;
  const bypassSessionPatterns = compileSessionPatterns(cfg.bypassSessionPatterns);
  const diag = (stage: string, sessionId: string, data: Record<string, unknown>) =>
    emitDiag(logger, stage, sessionId, data, diagEnabled);

  const isBypassedSession = (params: { sessionId?: string; sessionKey?: string }): boolean =>
    shouldBypassSession(params, bypassSessionPatterns);

  async function doCommitOVSession(params: {
    sessionId: string;
    sessionKey?: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<boolean> {
    const { sessionId } = params;
    const { sessionKey } = resolveSessionIdentity(params);
    return commitOpenVikingSession({
      sessionId,
      sessionKey,
      getClient,
      resolveAgentId,
      logger,
      rememberSessionAgentId,
      isBypassedSession,
    });
  }

  function extractSessionKey(runtimeContext: Record<string, unknown> | undefined): string | undefined {
    if (!runtimeContext) {
      return undefined;
    }
    const key = runtimeContext.sessionKey;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  }

  function resolveSessionKey(params: {
    sessionKey?: string;
    runtimeContext?: Record<string, unknown>;
  }): string | undefined {
    const direct = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    if (direct) {
      return direct;
    }
    return extractSessionKey(params.runtimeContext);
  }

  function resolveSessionIdentity(params: {
    sessionId: string;
    sessionKey?: string;
    runtimeContext?: Record<string, unknown>;
  }): { sessionKey: string | undefined; ovSessionId: string } {
    const sessionKey = resolveSessionKey(params);
    return {
      sessionKey,
      ovSessionId: openClawSessionToOvStorageId(params.sessionId, sessionKey),
    };
  }

  return {
    info: {
      id,
      name,
      version,
      ownsCompaction: true,
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
    },

    commitOVSession: doCommitOVSession,

    // --- standard ContextEngine methods ---

    async ingest(): Promise<IngestResult> {
      return { ingested: false };
    },

    async ingestBatch(): Promise<IngestBatchResult> {
      return { ingestedCount: 0 };
    },

    async assemble(assembleParams): Promise<AssembleResult> {
      const tokenBudget = validTokenBudget(assembleParams.tokenBudget) ?? 128_000;
      const isMainAssemble =
        Object.prototype.hasOwnProperty.call(assembleParams, "availableTools") ||
        Object.prototype.hasOwnProperty.call(assembleParams, "citationsMode") ||
        Object.prototype.hasOwnProperty.call(assembleParams, "prompt");
      return assembleOpenVikingSession({
        sessionId: assembleParams.sessionId,
        sessionKey: resolveSessionKey(assembleParams),
        messages: assembleParams.messages,
        tokenBudget,
        runtimeContext: assembleParams.runtimeContext,
        isMainAssemble,
        cfg,
        getClient,
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
      });
    },

    async afterTurn(afterTurnParams): Promise<void> {
      const tokenBudget = validTokenBudget(afterTurnParams.tokenBudget) ?? 128_000;
      // Хост зовёт afterTurn безусловно, как только метод существует
      // (src/agents/harness/context-engine-lifecycle.ts), не глядя на commitTurn.
      // Поэтому один и тот же ход может прийти обоими путями — отпечаток
      // не даёт записать его дважды.
      const key = turnFingerprint(
        afterTurnParams.sessionId,
        afterTurnParams.prePromptMessageCount,
        afterTurnParams.messages,
      );
      if (!claimTurn(afterTurnParams.sessionId, key)) {
        diag("afterTurn_skip", afterTurnParams.sessionId, {
          reason: "already_committed_by_commitTurn",
        });
        return;
      }
      await afterTurnOpenVikingSession({
        sessionId: afterTurnParams.sessionId,
        sessionKey: resolveSessionKey(afterTurnParams),
        messages: afterTurnParams.messages,
        prePromptMessageCount: afterTurnParams.prePromptMessageCount,
        isHeartbeat: afterTurnParams.isHeartbeat,
        tokenBudget,
        runtimeContext: afterTurnParams.runtimeContext,
        cfg,
        getClient,
        logger,
        resolveAgentId,
        rememberSessionAgentId,
        isBypassedSession,
        diag,
      });
    },

    /**
     * Долговечный путь фиксации хода. Хост держит очередь в SQLite и повторяет
     * вызов с тем же advancementKey после сбоя, поэтому повтор обязан вернуть
     * "duplicate", а не записать ход второй раз.
     */
    async commitTurn(commitParams): Promise<{ status: "committed" | "duplicate" }> {
      const tokenBudget = validTokenBudget(commitParams.tokenBudget) ?? 128_000;
      const sessionId = commitParams.sessionId;
      if (!claimTurn(sessionId, `key:${commitParams.advancementKey}`)) {
        diag("commitTurn_duplicate", sessionId, {
          advancementKey: commitParams.advancementKey,
        });
        return { status: "duplicate" };
      }
      // Тот же ход мог прийти и через afterTurn — помечаем и его отпечаток,
      // чтобы вторая дорога не записала повтор.
      const contentKey = turnFingerprint(
        sessionId,
        commitParams.prePromptMessageCount,
        commitParams.messages,
      );
      const fresh = claimTurn(sessionId, contentKey);
      if (!fresh) {
        diag("commitTurn_duplicate", sessionId, { reason: "already_captured_by_afterTurn" });
        return { status: "duplicate" };
      }
      await afterTurnOpenVikingSession({
        sessionId,
        sessionKey: commitParams.sessionKey,
        messages: commitParams.messages,
        prePromptMessageCount: commitParams.prePromptMessageCount,
        isHeartbeat: commitParams.isHeartbeat,
        tokenBudget,
        runtimeContext: commitParams.runtimeContext,
        cfg,
        getClient,
        logger,
        resolveAgentId,
        rememberSessionAgentId,
        isBypassedSession,
        diag,
      });
      return { status: "committed" };
    },

    async compact(compactParams): Promise<CompactResult> {
      const tokenBudget = validTokenBudget(compactParams.tokenBudget) ?? 128_000;
      return compactOpenVikingSession({
        sessionId: compactParams.sessionId,
        sessionKey: resolveSessionKey(compactParams),
        tokenBudget,
        currentTokenCount: compactParams.currentTokenCount,
        force: compactParams.force,
        compactionTarget: compactParams.compactionTarget,
        customInstructions: compactParams.customInstructions,
        getClient,
        logger,
        resolveAgentId,
        isBypassedSession,
        diag,
      });
    },
  };
}
