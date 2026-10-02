import { AUTO_RECALL_SOURCE_MARKER, } from "./auto-recall.js";
import { compileSessionPatterns, shouldBypassSession, } from "./text-utils.js";
import { estimateAgentMessageTokens, estimateAgentMessagesTokens } from "./token-estimator.js";
import { openClawSessionToOvStorageId } from "./routing/identity-routing.js";
import { assembleOpenVikingSession, afterTurnOpenVikingSession, compactOpenVikingSession, commitOpenVikingSession, } from "./services/context-lifecycle-service.js";
/**
 * Отпечаток одного хода: сессия, граница текущего хода и его сообщения.
 * Считается одинаково для afterTurn и commitTurn, потому что оба получают
 * messages и prePromptMessageCount от одного и того же хоста.
 */
export function turnFingerprint(sessionId, prePromptMessageCount, messages) {
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
const claimedTurns = new Map();
/**
 * Пометить ход как забранный. Возвращает false, если его уже забрали раньше —
 * тогда повторную запись делать нельзя.
 */
export function claimTurn(sessionId, key) {
    let seen = claimedTurns.get(sessionId);
    if (!seen) {
        seen = new Set();
        claimedTurns.set(sessionId, seen);
        // Сессий тоже может накопиться: держим только последние.
        if (claimedTurns.size > 256) {
            const oldest = claimedTurns.keys().next().value;
            if (oldest !== undefined)
                claimedTurns.delete(oldest);
        }
    }
    if (seen.has(key))
        return false;
    seen.add(key);
    if (seen.size > CLAIMED_TURNS_PER_SESSION) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined)
            seen.delete(oldest);
    }
    return true;
}
function roughEstimate(messages) {
    return estimateAgentMessagesTokens(messages);
}
function msgTokenEstimate(msg) {
    return estimateAgentMessageTokens(msg);
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
            tokens: msgTokenEstimate(msg),
            truncated,
        };
    });
}
function extractAgentMessageText(message) {
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
            const b = block;
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
function hasAutoRecallBlock(message) {
    return extractAgentMessageText(message).includes(AUTO_RECALL_SOURCE_MARKER);
}
function prependTextToMessageContent(content, text) {
    if (typeof content === "string") {
        return `${text}\n\n${content}`;
    }
    if (Array.isArray(content)) {
        if (content.length === 0) {
            return [{ type: "text", text }];
        }
        const first = content[0];
        if (first &&
            typeof first === "object" &&
            first.type === "text" &&
            typeof first.text === "string") {
            return [
                {
                    ...first,
                    text: `${text}\n\n${first.text}`,
                },
                ...content.slice(1),
            ];
        }
        return [{ type: "text", text }, ...content];
    }
    return text;
}
function prependRecallToLatestUserMessage(messages, recallBlock) {
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
function emitDiag(log, stage, sessionId, data, enabled = true) {
    if (!enabled)
        return;
    log.info(`openviking: diag ${JSON.stringify({ ts: Date.now(), stage, sessionId, data })}`);
}
function validTokenBudget(raw) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return raw;
    }
    return undefined;
}
export function createMemoryOpenVikingContextEngine(params) {
    const { id, name, version, cfg, logger, getClient, resolveAgentId, rememberSessionAgentId, queryConfigStore, traceRecorder, } = params;
    const diagEnabled = cfg.emitStandardDiagnostics;
    const bypassSessionPatterns = compileSessionPatterns(cfg.bypassSessionPatterns);
    const diag = (stage, sessionId, data) => emitDiag(logger, stage, sessionId, data, diagEnabled);
    const isBypassedSession = (params) => shouldBypassSession(params, bypassSessionPatterns);
    async function doCommitOVSession(params) {
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
    function extractSessionKey(runtimeContext) {
        if (!runtimeContext) {
            return undefined;
        }
        const key = runtimeContext.sessionKey;
        return typeof key === "string" && key.trim() ? key.trim() : undefined;
    }
    function resolveSessionKey(params) {
        const direct = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
        if (direct) {
            return direct;
        }
        return extractSessionKey(params.runtimeContext);
    }
    function resolveSessionIdentity(params) {
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
        async ingest() {
            return { ingested: false };
        },
        async ingestBatch() {
            return { ingestedCount: 0 };
        },
        async assemble(assembleParams) {
            const tokenBudget = validTokenBudget(assembleParams.tokenBudget) ?? 128_000;
            const isMainAssemble = Object.prototype.hasOwnProperty.call(assembleParams, "availableTools") ||
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
        async afterTurn(afterTurnParams) {
            const tokenBudget = validTokenBudget(afterTurnParams.tokenBudget) ?? 128_000;
            // Хост зовёт afterTurn безусловно, как только метод существует
            // (src/agents/harness/context-engine-lifecycle.ts), не глядя на commitTurn.
            // Поэтому один и тот же ход может прийти обоими путями — отпечаток
            // не даёт записать его дважды.
            const key = turnFingerprint(afterTurnParams.sessionId, afterTurnParams.prePromptMessageCount, afterTurnParams.messages);
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
        async commitTurn(commitParams) {
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
            const contentKey = turnFingerprint(sessionId, commitParams.prePromptMessageCount, commitParams.messages);
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
        async compact(compactParams) {
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
