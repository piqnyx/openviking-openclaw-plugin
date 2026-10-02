// Canonical ContextEngine lifecycle service: assemble / afterTurn / compact / commit orchestration.
import { DEFAULT_PHASE2_POLL_TIMEOUT_MS } from "../client.js";
import { buildAutoRecallContext, prepareRecallQuery } from "../auto-recall.js";
import { toJsonLog } from "../memory-ranking.js";
import { openClawSessionToOvStorageId, resolveOpenVikingActorPeerId, resolveOpenVikingMessagePeerId, sanitizeOpenVikingPeerId, } from "../routing/identity-routing.js";
import { extractNewTurnMessages } from "../text-utils.js";
import { estimateAgentMessageTokens, estimateTextTokens } from "../token-estimator.js";
import { convertToAgentMessages, mergeConsecutiveAssistants, sanitizeAgentMessagesForProvider, toRoleId, } from "./context-message-adapter.js";
export function totalExtractedMemories(memories) {
    if (!memories || typeof memories !== "object") {
        return 0;
    }
    return Object.values(memories).reduce((sum, count) => sum + (count ?? 0), 0);
}
const BUDGET_UNLIMITED = -1;
const ARCHIVE_BUDGET_RATIO = 0.15;
const ARCHIVE_BUDGET_CAP = 8_000;
const RESERVED_MIN = 20_000;
const RESERVED_RATIO = 0.15;
const PHASE2_POLL_INTERVAL_MS = 800;
const PHASE2_POLL_MAX_MS = DEFAULT_PHASE2_POLL_TIMEOUT_MS;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * After wait=false commit, Phase2 runs on the server. Poll task until completed/failed/timeout
 * so logs show memories_extracted (otherwise it looks like "nothing was saved").
 */
async function pollPhase2ExtractionOutcome(client, taskId, logger, sessionLabel) {
    const deadline = Date.now() + PHASE2_POLL_MAX_MS;
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
            const { status } = task;
            if (status === "completed") {
                logger.info(`openviking: phase2 completed task_id=${taskId} session=${sessionLabel} ` +
                    `result=${toJsonLog(task.result ?? {})}`);
                return;
            }
            if (status === "failed") {
                logger.warn?.(`openviking: phase2 failed task_id=${taskId} session=${sessionLabel} error=${task.error ?? "unknown"}`);
                return;
            }
        }
        logger.warn?.(`openviking: phase2 poll timeout (${PHASE2_POLL_MAX_MS / 1000}s) task_id=${taskId} session=${sessionLabel} — ` +
            `check GET /api/v1/tasks/${taskId}`);
    }
    catch (e) {
        logger.warn?.(`openviking: phase2 poll exception task_id=${taskId}: ${String(e)}`);
    }
}
function allocateContextBudget(totalBudget, instructionTokens = 0) {
    const reserveFloor = totalBudget >= RESERVED_MIN * 2 ? RESERVED_MIN : 0;
    const reserved = Math.min(totalBudget, Math.max(totalBudget * RESERVED_RATIO, reserveFloor));
    const usableBudget = Math.max(totalBudget - reserved - instructionTokens, 0);
    const archiveMemory = Math.min(usableBudget * ARCHIVE_BUDGET_RATIO, ARCHIVE_BUDGET_CAP);
    const sessionContext = Math.max(usableBudget - archiveMemory, 0);
    return { archiveMemory, sessionContext, reserved };
}
function buildSystemPromptAddition() {
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
function buildInstructionPrompt() {
    const text = buildSystemPromptAddition();
    return { text, tokens: estimateTextTokens(text) };
}
function buildArchiveMemory(archiveOverview, _preAbstracts, _budget, roughEstimate) {
    const messages = [];
    if (archiveOverview) {
        messages.push({
            role: "user",
            content: `[Session History Summary]\n${archiveOverview}`,
        });
    }
    return { messages, tokens: roughEstimate(messages) };
}
function buildSessionContext(ovMessages, budget, roughEstimate) {
    const raw = ovMessages.flatMap((m) => convertToAgentMessages(m));
    const messages = mergeConsecutiveAssistants(raw);
    const tokens = roughEstimate(messages);
    if (budget === BUDGET_UNLIMITED || tokens <= budget) {
        return { messages, tokens };
    }
    const trimmed = [...messages];
    while (trimmed.length > 0 && roughEstimate(trimmed) > budget) {
        trimmed.shift();
    }
    return { messages: trimmed, tokens: roughEstimate(trimmed) };
}
function buildAssembledContext(overview, preAbstracts, ovMessages, tokenBudget, ovSessionId, logger, roughEstimate) {
    const hasArchives = Boolean(overview) || preAbstracts.length > 0;
    const instruction = hasArchives ? buildInstructionPrompt() : { text: "", tokens: 0 };
    // 4-layer context partitioning:
    //   Instruction — system prompt guide (Archive Index / Session History usage)
    //   Archive     — session history summary + per-archive one-line abstracts
    //   Session     — active OV messages converted to AgentMessage format
    //   Reserved    — headroom for model output (not consumed here)
    const budgets = allocateContextBudget(tokenBudget, instruction.tokens);
    const archive = buildArchiveMemory(overview, preAbstracts, budgets.archiveMemory, roughEstimate);
    const sessionBudget = Math.max(tokenBudget - budgets.reserved - instruction.tokens - archive.tokens, 0);
    const session = buildSessionContext(ovMessages, sessionBudget, roughEstimate);
    const assembled = [...archive.messages, ...session.messages];
    logger.info(`openviking: assemble entering session content for ${ovSessionId}: ` +
        JSON.stringify(assembled.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content.substring(0, 100) : "[complex]",
        })), null, 2));
    const sanitized = sanitizeAgentMessagesForProvider(assembled);
    return { sanitized, archive, session, budgets, instruction };
}
export async function commitOpenVikingSession({ sessionId, sessionKey, getClient, resolveAgentId, logger, rememberSessionAgentId, isBypassedSession, }) {
    const ovId = openClawSessionToOvStorageId(sessionId, sessionKey);
    if (isBypassedSession({ sessionId, sessionKey })) {
        logger.warn?.(`openviking: commit skipped because session is bypassed (sessionId=${sessionId}, sessionKey=${sessionKey ?? "none"})`);
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
        logger.info(`openviking: committed OV session=${sessionId} ovId=${ovId}, archived=${commitResult.archived ?? false}, memories=${memCount}, task_id=${commitResult.task_id ?? "none"}, trace_id=${commitResult.trace_id ?? "none"}`);
        return true;
    }
    catch (err) {
        logger.warn?.(`openviking: commit failed for session=${sessionId}: ${String(err)}`);
        return false;
    }
}
function assemblePassthrough(params) {
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
function isSessionNotFoundError(err) {
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
function isNotFoundError(err) {
    return String(err).includes("[NOT_FOUND]");
}
/** A moment as milliseconds: a number (seconds or milliseconds) or a date in text. */
function momentMs(value) {
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
async function findLastClosedArchive(client, ovSessionId, totalArchives, logger) {
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
                .filter((moment) => moment !== undefined);
            return {
                archiveId,
                overview,
                turnStamps: [...new Set(moments)].sort((left, right) => left - right),
            };
        }
        catch (err) {
            if (isNotFoundError(err)) {
                continue;
            }
            logger.warn?.(`openviking: looking for the last closed archive of session=${ovSessionId} ` +
                `stopped at ${archiveId}: ${String(err)}`);
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
function boundaryBeforeArchiveEnd(liveMessages, turnStamps) {
    if (turnStamps.length < 2) {
        return -1;
    }
    // The FIRST place each moment stands at. Two messages may carry one moment, and
    // the later of them may open the next turn: cutting at the first gives a
    // message of this turn again, cutting at the last would leave that one out.
    const placeOf = new Map();
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
function describeBoundarySearch(liveMessages, turnStamps, boundary) {
    const timeKinds = {};
    const moments = [];
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
        let offMs = null;
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
function boundarySearchInWords(search) {
    const turns = Array.isArray(search.lastTurns) ? search.lastTurns : [];
    const offs = turns.map((turn) => turn.offMs).filter((off) => off !== null);
    return (`looked for ${String(search.archiveTurns)} turns of the archive among ` +
        `${String(search.liveWithTime)} live messages with a time, ` +
        (offs.length > 0
            ? `for its last ${offs.length} the nearest live messages stand ${offs.join(", ")} ms off`
            : "none of them has one"));
}
/**
 * The longest run of messages at the end of `messages` that fits `budget`.
 * Counted message by message from the newest, then checked as a whole, because
 * the estimate of a list is a little more than the sum of its parts.
 */
function newestWithinBudget(messages, budget, roughEstimate) {
    let start = messages.length;
    let spent = 0;
    while (start > 0) {
        const cost = roughEstimate([messages[start - 1]]);
        if (spent + cost > budget) {
            break;
        }
        spent += cost;
        start -= 1;
    }
    let kept = messages.slice(start);
    while (kept.length > 0 && roughEstimate(kept) > budget) {
        kept = kept.slice(1);
    }
    return kept;
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
async function assembleWithoutFreshSummary(params) {
    const { diag, logger, roughEstimate, ovSessionId, reason, liveMessages, originalTokens, tokenBudget, extra } = params;
    if (originalTokens <= tokenBudget) {
        return assemblePassthrough({ diag, ovSessionId, reason, liveMessages, originalTokens, extra });
    }
    let archive = null;
    if (params.client && typeof params.totalArchives === "number" && params.totalArchives >= 1) {
        try {
            archive = await findLastClosedArchive(params.client, ovSessionId, params.totalArchives, logger);
        }
        catch (err) {
            logger.warn?.(`openviking: looking for the last closed archive of session=${ovSessionId} broke: ${String(err)}`);
        }
    }
    const instruction = archive ? buildInstructionPrompt() : { text: "", tokens: 0 };
    const budgets = allocateContextBudget(tokenBudget, instruction.tokens);
    const summary = buildArchiveMemory(archive?.overview, [], budgets.archiveMemory, roughEstimate);
    const sessionBudget = Math.max(tokenBudget - budgets.reserved - instruction.tokens - summary.tokens, 0);
    const boundary = archive ? boundaryBeforeArchiveEnd(liveMessages, archive.turnStamps) : -1;
    const boundaryFound = boundary >= 0;
    const search = archive ? describeBoundarySearch(liveMessages, archive.turnStamps, boundary) : null;
    const tail = boundaryFound ? liveMessages.slice(boundary + 1) : liveMessages.slice();
    let kept = newestWithinBudget(tail, sessionBudget, roughEstimate);
    if (!archive) {
        // Nothing stands before the tail, so it has to open with the user's turn.
        const firstUser = kept.findIndex((message) => message?.role === "user");
        kept = firstUser >= 0 ? kept.slice(firstUser) : [];
    }
    const droppedMessages = tail.length - kept.length;
    let messages;
    try {
        messages = sanitizeAgentMessagesForProvider([...summary.messages, ...kept]);
    }
    catch (err) {
        logger.warn?.(`openviking: the recovered context of session=${ovSessionId} could not be put in order, ` +
            `handing it over as it is: ${String(err)}`);
        messages = [...summary.messages, ...kept];
    }
    const estimatedTokens = roughEstimate(messages) + instruction.tokens;
    const tokensSaved = originalTokens - estimatedTokens;
    logger.warn?.(`openviking: no fresh summary for session=${ovSessionId} (${reason}): the transcript is ` +
        `${originalTokens} tokens against a budget of ${tokenBudget}, so it was assembled from ` +
        `${archive ? `the summary of ${archive.archiveId}` : "no summary (no closed archive in reach)"} ` +
        `and ${kept.length} live messages` +
        (boundaryFound
            ? " from the turn the archive ends in"
            : " by budget, where the archive ends could not be told") +
        (droppedMessages > 0 ? `; dropped ${droppedMessages} oldest that did not fit` : "") +
        (search && !boundaryFound ? `; ${boundarySearchInWords(search)}` : ""));
    diag("assemble_result", ovSessionId, {
        passthrough: false,
        recovered: true,
        reason,
        archiveId: archive?.archiveId ?? null,
        boundaryFound,
        ...(search ? { boundary: search } : {}),
        tailMessages: tail.length,
        droppedMessages,
        outputMessagesCount: messages.length,
        inputTokenEstimate: originalTokens,
        estimatedTokens,
        tokensSaved,
        savingPct: originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0,
        archiveTokens: summary.tokens,
        instructionTokens: instruction.tokens,
        sessionBudget,
        tokenBudget,
        ...extra,
    });
    return {
        messages,
        estimatedTokens,
        ...(instruction.text ? { systemPromptAddition: instruction.text } : {}),
    };
}
export async function assembleOpenVikingSession({ sessionId, sessionKey, messages, tokenBudget, runtimeContext, isMainAssemble, cfg, getClient, logger, resolveAgentId, rememberSessionAgentId, isBypassedSession, queryConfigStore, traceRecorder, diag, roughEstimate, messageDigest, extractAgentMessageText, hasAutoRecallBlock, prependRecallToLatestUserMessage, }) {
    const ovSessionId = openClawSessionToOvStorageId(sessionId, sessionKey);
    const sender = extractRuntimeSenderId(runtimeContext);
    const latestMessage = messages.at(-1);
    const isTransformContextAssemble = !isMainAssemble;
    const originalTokens = roughEstimate(messages);
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
            logger.info(`openviking: recall query truncated (` +
                `chars=${recallQuery.originalChars}->${recallQuery.finalChars})`);
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
                traceRecorder: traceRecorder,
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
        }
        catch (err) {
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
        const client = await getClient(resolveAgentId(sessionId ?? sessionKey ?? ovSessionId, sessionKey, ovSessionId));
        const ctx = await client.getSessionContext(ovSessionId, tokenBudget);
        const preAbstracts = ctx?.pre_archive_abstracts ?? [];
        const hasArchives = !!ctx?.latest_archive_overview || preAbstracts.length > 0;
        const activeCount = ctx?.messages?.length ?? 0;
        if (!ctx || (!hasArchives && activeCount === 0)) {
            return await assembleWithoutFreshSummary({
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
        const { sanitized, archive, session, budgets, instruction } = buildAssembledContext(ctx.latest_archive_overview, preAbstracts, ctx.messages, tokenBudget, ovSessionId, logger, roughEstimate);
        if (sanitized.length === 0 && messages.length > 0) {
            return await assembleWithoutFreshSummary({
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
    }
    catch (err) {
        if (isSessionNotFoundError(err)) {
            const errorMessage = String(err);
            logger.info(`openviking: assemble skipped because OV session does not exist ` +
                `(session=${ovSessionId}, tokenBudget=${tokenBudget}, agentId=${resolveAgentId(ovSessionId)})`);
            return await assembleWithoutFreshSummary({
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
        logger.warn?.(`openviking: assemble failed for session=${ovSessionId}, ` +
            `tokenBudget=${tokenBudget}, agentId=${resolveAgentId(ovSessionId)}: ${String(err)}`);
        diag("assemble_error", ovSessionId, {
            error: String(err),
            tokenBudget,
            agentId: resolveAgentId(ovSessionId),
            senderIdFound: sender.found,
            senderId: sender.senderId ?? null,
        });
        if (originalTokens <= tokenBudget) {
            return { messages, estimatedTokens: originalTokens };
        }
        return await assembleWithoutFreshSummary({
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
function normalizeTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const timestampMs = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
        return new Date(timestampMs).toISOString();
    }
    return undefined;
}
function pickLatestCreatedAt(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
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
function extractRuntimeSenderId(runtimeContext) {
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
function extractRuntimeAgentId(runtimeContext) {
    if (!runtimeContext) {
        return undefined;
    }
    const agentId = runtimeContext.agentId;
    return typeof agentId === "string" && agentId.trim() ? agentId.trim() : undefined;
}
function isToolOnlyMessage(msg) {
    return msg.role === "assistant" && msg.parts.length > 0 && msg.parts.every((part) => part.type === "tool");
}
function coalesceConsecutiveToolMessages(messages) {
    const result = [];
    let pendingTools;
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
function messageDigest(messages, maxCharsPerMsg = 2000) {
    return messages.map((msg) => {
        const m = msg;
        const role = String(m.role ?? "unknown");
        const raw = m.content;
        let text;
        if (typeof raw === "string") {
            text = raw;
        }
        else if (Array.isArray(raw)) {
            text = raw
                .map((b) => {
                if (b.type === "text")
                    return String(b.text ?? "");
                if (b.type === "toolCall")
                    return `[toolCall: ${String(b.name)}(${JSON.stringify(b.arguments ?? {}).slice(0, 200)})]`;
                if (b.type === "toolResult")
                    return `[toolResult: ${JSON.stringify(b.content ?? "").slice(0, 200)}]`;
                return `[${String(b.type)}]`;
            })
                .join("\n");
        }
        else {
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
export async function afterTurnOpenVikingSession({ sessionId, sessionKey, messages: rawMessages, prePromptMessageCount, isHeartbeat, tokenBudget, runtimeContext, cfg, getClient, logger, resolveAgentId, rememberSessionAgentId, isBypassedSession, diag, }) {
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
        const start = typeof prePromptMessageCount === "number" && prePromptMessageCount >= 0
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
        const turnMessages = messages.slice(start);
        const newMessages = turnMessages.filter((m) => {
            const role = m.role;
            return role === "user" || role === "assistant";
        });
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
                    return { type: "text", text: cleaned };
                }
                return {
                    type: "tool",
                    tool_id: part.toolCallId,
                    tool_name: part.toolName,
                    tool_input: part.toolInput,
                    tool_output: part.toolOutput,
                    tool_status: part.toolStatus,
                };
            });
            if (ovParts.length > 0) {
                await client.addSessionMessage(ovSessionId, msg.role, ovParts, undefined, createdAt, resolveOpenVikingMessagePeerId({
                    peerRole: cfg.peer_role ?? "assistant",
                    role: msg.role,
                    personPeerId: senderRoleId,
                    assistantPeerId: agentId,
                }));
            }
        }
        const session = await client.getSession(ovSessionId);
        const pendingTokens = session.pending_tokens ?? 0;
        const commitTokenThreshold = Math.floor(tokenBudget * cfg.commitTokenThresholdRatio);
        if (pendingTokens < commitTokenThreshold) {
            diag("afterTurn_skip", ovSessionId, {
                reason: "below_threshold",
                pendingTokens,
                commitTokenThreshold,
                commitTokenThresholdRatio: cfg.commitTokenThresholdRatio,
                tokenBudget,
                senderIdFound: sender.found,
                senderId: sender.senderId ?? null,
            });
            return;
        }
        const commitResult = await client.commitSession(ovSessionId, {
            wait: false,
            keepRecentCount: cfg.commitKeepRecentCount,
        });
        logger.info(`openviking: committed session=${ovSessionId}, ` +
            `status=${commitResult.status}, archived=${commitResult.archived ?? false}, ` +
            `task_id=${commitResult.task_id ?? "none"}, trace_id=${commitResult.trace_id ?? "none"}`);
        diag("afterTurn_commit", ovSessionId, {
            pendingTokens,
            commitTokenThreshold,
            commitTokenThresholdRatio: cfg.commitTokenThresholdRatio,
            tokenBudget,
            status: commitResult.status,
            archived: commitResult.archived ?? false,
            taskId: commitResult.task_id ?? null,
            extractedMemories: totalExtractedMemories(commitResult.memories_extracted),
            senderIdFound: sender.found,
            senderId: sender.senderId ?? null,
        });
        if (commitResult.task_id && cfg.logFindRequests) {
            logger.info(`openviking: Phase2 memory extraction runs asynchronously on the server (task_id=${commitResult.task_id}). ` +
                "memories_extracted appears only after that task completes — not in this immediate response.");
            void pollPhase2ExtractionOutcome(client, commitResult.task_id, logger, ovSessionId);
        }
    }
    catch (err) {
        logger.warn?.(`openviking: afterTurn failed: ${String(err)}`);
        const sender = extractRuntimeSenderId(runtimeContext);
        diag("afterTurn_error", sessionId ?? "(unknown)", {
            error: String(err),
            senderIdFound: sender.found,
            senderId: sender.senderId ?? null,
        });
    }
}
function validTokenCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined;
}
function compactFailureResult(reason, tokensBefore, details) {
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
export async function compactOpenVikingSession({ sessionId, sessionKey, tokenBudget, currentTokenCount, force, compactionTarget, customInstructions, getClient, logger, resolveAgentId, isBypassedSession, diag, }) {
    const ovSessionId = openClawSessionToOvStorageId(sessionId, sessionKey);
    diag("compact_entry", ovSessionId, {
        tokenBudget,
        force: force ?? false,
        currentTokenCount: currentTokenCount ?? null,
        compactionTarget: compactionTarget ?? null,
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
    let preCommitEstimatedTokens;
    if (typeof tokensBeforeOriginal !== "number") {
        try {
            const preCtx = await client.getSessionContext(ovSessionId, tokenBudget);
            if (typeof preCtx.estimatedTokens === "number" && Number.isFinite(preCtx.estimatedTokens)) {
                preCommitEstimatedTokens = preCtx.estimatedTokens;
            }
        }
        catch (preCtxErr) {
            logger.info(`openviking: compact pre-ctx fetch failed for session=${ovSessionId}, ` +
                `tokenBudget=${tokenBudget}, agentId=${agentId}: ${String(preCtxErr)}`);
        }
    }
    const tokensBefore = tokensBeforeOriginal ?? preCommitEstimatedTokens ?? -1;
    try {
        logger.info(`openviking: compact committing session=${ovSessionId} (wait=true, tokenBudget=${tokenBudget})`);
        const commitResult = await client.commitSession(ovSessionId, {
            wait: true,
            keepRecentCount: 0,
        });
        const memCount = totalExtractedMemories(commitResult.memories_extracted);
        if (commitResult.status === "failed") {
            logger.warn?.(`openviking: compact commit Phase 2 failed for session=${ovSessionId}: ${commitResult.error ?? "unknown"}`);
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
            logger.warn?.(`openviking: compact commit Phase 2 timed out for session=${ovSessionId}, task_id=${commitResult.task_id ?? "none"}`);
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
        logger.info(`openviking: compact committed session=${ovSessionId}, archived=${commitResult.archived ?? false}, memories=${memCount}, task_id=${commitResult.task_id ?? "none"}, trace_id=${commitResult.trace_id ?? "none"}`);
        if (!commitResult.archived) {
            logger.info(`openviking: compact no archive for session=${ovSessionId}, ` +
                `tokensBefore=${tokensBefore}, tokensAfter=${tokensBefore}`);
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
        let tokensAfter;
        let contextFetchError;
        try {
            const ctx = await client.getSessionContext(ovSessionId, tokenBudget);
            logger.info(`openviking: compact getSessionContext raw result for ${ovSessionId}: ` +
                JSON.stringify(ctx, null, 2));
            if (typeof ctx.latest_archive_overview === "string") {
                summary = ctx.latest_archive_overview.trim();
            }
            if (typeof ctx.estimatedTokens === "number" && Number.isFinite(ctx.estimatedTokens)) {
                tokensAfter = ctx.estimatedTokens;
            }
            logger.info(`openviking: compact restored session content for ${ovSessionId}: ` +
                `messages=${ctx.messages?.length ?? 0}, ` +
                `latestArchiveOverview=${summary.length > 0 ? "present" : "empty"} (${summary.length} chars), ` +
                `preArchiveAbstracts=${ctx.pre_archive_abstracts?.length ?? 0}, ` +
                `estimatedTokens=${ctx.estimatedTokens}`);
            if (summary.length > 0) {
                logger.info(`openviking: compact latest_archive_overview for ${ovSessionId}: ${summary.substring(0, 200)}...`);
            }
            if (ctx.messages && ctx.messages.length > 0) {
                const msgSummary = ctx.messages.map((m) => {
                    const role = m.role ?? "unknown";
                    let textPreview = "";
                    if (m.content) {
                        textPreview = m.content.substring(0, 80);
                    }
                    else if (m.parts && m.parts.length > 0) {
                        const textPart = m.parts.find((p) => p.type === "text");
                        textPreview = textPart?.text?.substring(0, 80) ?? JSON.stringify(m.parts).substring(0, 80);
                    }
                    return { role, textPreview };
                });
                logger.info(`openviking: compact restored messages for ${ovSessionId}: ` +
                    JSON.stringify(msgSummary));
            }
        }
        catch (ctxErr) {
            contextFetchError = String(ctxErr);
            logger.info(`openviking: compact context fetch failed for session=${ovSessionId}, ` +
                `tokenBudget=${tokenBudget}, agentId=${agentId}: ${contextFetchError}`);
        }
        logger.info(`openviking: compact tokens session=${ovSessionId}, ` +
            `tokensBefore=${tokensBefore}, tokensAfter=${tokensAfter ?? "unknown"}, ` +
            `latestArchiveId=${firstKeptEntryId || "none"}`);
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
    }
    catch (err) {
        const errorMessage = String(err);
        if (isSessionNotFoundError(err)) {
            logger.info(`openviking: compact skipped because OV session does not exist ` +
                `(session=${ovSessionId}, agentId=${agentId})`);
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
