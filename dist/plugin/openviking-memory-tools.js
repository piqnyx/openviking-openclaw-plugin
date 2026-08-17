import { Type } from "@sinclair/typebox";
import { clampScore, postProcessMemories } from "../memory-ranking.js";
import { resolveOpenVikingMessagePeerId, } from "../routing/identity-routing.js";
import { isMemoryUri } from "../routing/memory-uri.js";
function totalCommitMemories(r) {
    const m = r.memories_extracted;
    if (!m || typeof m !== "object")
        return 0;
    return Object.values(m).reduce((sum, n) => sum + (n ?? 0), 0);
}
export function registerOpenVikingMemoryTools(deps) {
    deps.registerTool((ctx) => ({
        name: "memory_store",
        label: "Memory Store (OpenViking)",
        description: "Store text in OpenViking long-term memory. Call this ONLY when the user gives a direct instruction to remember something — 'запомни', 'запиши', 'сохрани', 'не забудь', 'remember this', 'save this', 'store this', 'take a note'. The instruction must come from the user in this conversation. Do NOT call it on your own initiative: not because a fact seems important, not to be safe, not at the end of a task, not to summarise what was discussed, and not because you inferred the user would want it kept. Ordinary conversation is already captured automatically, so calling this without being asked only creates duplicates. If you think something is worth storing but were not asked, say so and let the user decide instead of calling this tool.",
        parameters: Type.Object({
            text: Type.String({ description: "Information to store as memory source text" }),
            role: Type.Optional(Type.String({ description: "Session role, default user" })),
            sessionId: Type.Optional(Type.String({ description: "Existing OpenViking session ID" })),
        }),
        async execute(_toolCallId, params) {
            if (deps.isBypassedSession(ctx)) {
                return deps.makeBypassedToolResult("memory_store");
            }
            const session = deps.resolvePluginSessionRouting(ctx);
            const { text } = params;
            const role = typeof params.role === "string"
                ? params.role
                : "user";
            const explicitSessionId = typeof params.sessionId === "string" &&
                params.sessionId.trim()
                ? deps.normalizeSessionId(params.sessionId)
                : undefined;
            if (deps.logFindRequests) {
                deps.logger.info?.(`openviking: memory_store invoked (textLength=${text?.length ?? 0}, sessionId=${explicitSessionId ?? "auto"})`);
            }
            let sessionId = explicitSessionId;
            let usedTempSession = false;
            try {
                const client = await deps.getClient(session.agentId);
                if (!sessionId) {
                    sessionId = deps.createTempSessionId();
                    usedTempSession = true;
                }
                const peerId = resolveOpenVikingMessagePeerId({
                    peerRole: deps.peerRole,
                    role,
                    personPeerId: session.actorPeerId,
                    assistantPeerId: session.actorPeerId,
                });
                await client.addSessionMessage(sessionId, role, [{ type: "text", text }], undefined, undefined, peerId);
                const commitResult = await client.commitSession(sessionId, {
                    wait: true,
                    keepRecentCount: 0,
                });
                const memoriesCount = totalCommitMemories(commitResult);
                if (commitResult.status === "failed") {
                    deps.logger.warn(`openviking: memory_store commit failed (sessionId=${sessionId}): ${commitResult.error ?? "unknown"}`);
                    return {
                        content: [{ type: "text", text: `Memory extraction failed for session ${sessionId}: ${commitResult.error ?? "unknown"}` }],
                        details: {
                            action: "failed",
                            sessionId,
                            status: "failed",
                            error: commitResult.error,
                            usedTempSession,
                        },
                    };
                }
                if (commitResult.status === "timeout") {
                    deps.logger.warn(`openviking: memory_store commit timed out (sessionId=${sessionId}), task_id=${commitResult.task_id ?? "none"}. Memories may still be extracting in background.`);
                    return {
                        content: [{ type: "text", text: `Memory extraction timed out for session ${sessionId}. It may still complete in the background (task_id=${commitResult.task_id ?? "none"}).` }],
                        details: {
                            action: "timeout",
                            sessionId,
                            status: "timeout",
                            taskId: commitResult.task_id,
                            usedTempSession,
                        },
                    };
                }
                if (memoriesCount === 0) {
                    deps.logger.warn(`openviking: memory_store committed but 0 memories extracted (sessionId=${sessionId}). ` +
                        "Check OpenViking server logs for embedding/extract errors (e.g. 401 API key, or extraction pipeline).");
                }
                else {
                    deps.logger.info?.(`openviking: memory_store committed, memories=${memoriesCount}`);
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `Stored in OpenViking session ${sessionId} and committed ${memoriesCount} memories.`,
                        },
                    ],
                    details: {
                        action: "stored",
                        sessionId,
                        memoriesCount,
                        status: commitResult.status,
                        archived: commitResult.archived ?? false,
                        usedTempSession,
                    },
                };
            }
            catch (err) {
                deps.logger.warn(`openviking: memory_store failed: ${String(err)}`);
                throw err;
            }
        },
    }), { name: "memory_store" });
    deps.registerTool((ctx) => ({
        name: "memory_forget",
        label: "Memory Forget (OpenViking)",
        description: "Forget memory by URI, or search then delete when a strong single match is found.",
        parameters: Type.Object({
            uri: Type.Optional(Type.String({ description: "Exact memory URI to delete" })),
            query: Type.Optional(Type.String({ description: "Search query to find memory URI" })),
            targetUri: Type.Optional(Type.String({ description: "Search scope URI (default: plugin config)" })),
            limit: Type.Optional(Type.Number({ description: "Search limit (default: 5)" })),
            scoreThreshold: Type.Optional(Type.Number({ description: "Minimum score (0-1, default: plugin config)" })),
        }),
        async execute(_toolCallId, params) {
            if (deps.isBypassedSession(ctx)) {
                return deps.makeBypassedToolResult("memory_forget");
            }
            const session = deps.resolvePluginSessionRouting(ctx);
            const client = await deps.getClient(session.agentId);
            const uri = params.uri;
            if (uri) {
                if (!isMemoryUri(uri)) {
                    return {
                        content: [{ type: "text", text: `Refusing to delete non-memory URI: ${uri}` }],
                        details: { action: "rejected", uri },
                    };
                }
                await client.deleteUri(uri, session.actorPeerId);
                return {
                    content: [{ type: "text", text: `Forgotten: ${uri}` }],
                    details: { action: "deleted", uri },
                };
            }
            const query = params.query;
            if (!query) {
                return {
                    content: [{ type: "text", text: "Provide uri or query." }],
                    details: { error: "missing_param" },
                };
            }
            const limit = typeof params.limit === "number"
                ? Math.max(1, Math.floor(params.limit))
                : 5;
            const scoreThreshold = typeof params.scoreThreshold === "number"
                ? Math.max(0, Math.min(1, params.scoreThreshold))
                : deps.defaultRecallScoreThreshold;
            const targetUri = typeof params.targetUri === "string"
                ? params.targetUri
                : deps.defaultTargetUri;
            const requestLimit = Math.max(limit * 4, 20);
            const result = await client.find(query, {
                targetUri,
                limit: requestLimit,
                scoreThreshold: 0,
                // Только записи: описания каталогов в отзыве фактов — шум.
                level: [2],
            }, session.actorPeerId);
            const candidates = postProcessMemories(result.memories ?? [], {
                limit: requestLimit,
                scoreThreshold,
                leafOnly: true,
            }).filter((item) => isMemoryUri(item.uri));
            if (candidates.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No matching leaf memory candidates found. Try a more specific query.",
                        },
                    ],
                    details: { action: "none", scoreThreshold },
                };
            }
            const top = candidates[0];
            if (candidates.length === 1 && clampScore(top.score) >= 0.85) {
                await client.deleteUri(top.uri, session.actorPeerId);
                return {
                    content: [{ type: "text", text: `Forgotten: ${top.uri}` }],
                    details: { action: "deleted", uri: top.uri, score: top.score ?? 0 },
                };
            }
            const list = candidates
                .map((item) => `- ${item.uri} (${(clampScore(item.score) * 100).toFixed(0)}%)`)
                .join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: `Found ${candidates.length} candidates. Specify uri:\n${list}`,
                    },
                ],
                details: { action: "candidates", candidates, scoreThreshold, requestLimit },
            };
        },
    }), { name: "memory_forget" });
}
