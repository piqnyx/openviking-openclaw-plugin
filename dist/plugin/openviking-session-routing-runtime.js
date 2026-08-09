import { SYSTEM_AGENT_ID } from "../agent-keys.js";
import { createSessionAgentResolver, openClawSessionToOvStorageId, resolveOpenVikingActorPeerId, sanitizeOpenVikingAgentIdHeader, sanitizeOpenVikingPeerId, } from "../routing/identity-routing.js";
export function createOpenVikingSessionRoutingRuntime(options) {
    const peerRole = options.peerRole ?? "assistant";
    const sessionAgentResolver = createSessionAgentResolver(options.peerPrefix);
    const unattributedSessionsWarned = new Set();
    const configAgentPrefix = options.peerPrefix.trim() === "default" ? "" : options.peerPrefix.trim();
    /**
     * The agent id a caller stated outright, normalized the same way the session
     * resolver normalizes remembered ids.
     *
     * The resolver can only answer from its session→agent map, and that map is
     * keyed by session aliases: a context that carries `agentId` but no session
     * identity yet remembers nothing and resolves to nothing. Reading the stated
     * id directly keeps those calls attributed instead of dropping them into the
     * system account.
     */
    const statedAgentId = (raw) => {
        const trimmed = typeof raw === "string" ? raw.trim() : "";
        if (!trimmed) {
            return undefined;
        }
        return sanitizeOpenVikingAgentIdHeader(configAgentPrefix ? `${configAgentPrefix}_${trimmed}` : trimmed);
    };
    /**
     * Warn once per session that its agent could not be established.
     *
     * Without per-agent credentials this case is harmless, so upstream does not
     * surface it. Here it decides which OpenViking account the data lands in,
     * so it has to be visible — but only once per session, since an unresolved
     * session stays unresolved for every call it makes.
     */
    const warnUnattributed = (sessionId, sessionKey, ovSessionId) => {
        const marker = ovSessionId || sessionId || sessionKey || "(no session)";
        if (unattributedSessionsWarned.has(marker)) {
            return;
        }
        unattributedSessionsWarned.add(marker);
        options.logger.warn(`openviking: no agent could be resolved for session ${marker} — routing to the system ` +
            "OpenViking account instead of guessing an agent");
    };
    const rememberSessionAgentId = (ctx) => {
        sessionAgentResolver.remember(ctx);
    };
    const resolveAgentId = (sessionId, sessionKey, ovSessionId) => {
        const sid = typeof sessionId === "string" ? sessionId.trim() : "";
        const sk = typeof sessionKey === "string" ? sessionKey.trim() : "";
        const ovSid = typeof ovSessionId === "string" ? ovSessionId.trim() : "";
        const result = sessionAgentResolver.resolve(sid, sk, ovSid);
        if (options.logFindRequests) {
            options.logger.info(`openviking: resolveAgentId ${JSON.stringify({
                sessionId: sid || "(empty)",
                sessionKey: sk || "(empty)",
                ovSessionId: ovSid || "(empty)",
                parsedConfigPeerPrefix: options.peerPrefix,
                mappedResolvedAgentId: result.mappedResolvedAgentId,
                resolvedBeforeSanitize: result.resolvedBeforeSanitize,
                resolved: result.resolved,
                branch: result.branch,
                aliases: result.aliases,
                fromExplicitBinding: result.fromExplicitBinding,
            })}`);
        }
        // Upstream falls back to the literal agent id "main" here. With one
        // OpenViking account per agent that would file unattributable traffic
        // under the main agent, so unresolved identity gets its own sentinel and
        // ends up in the system account.
        if (!result.fromExplicitBinding) {
            warnUnattributed(sid, sk, ovSid);
            return SYSTEM_AGENT_ID;
        }
        return result.resolved;
    };
    const resolvePluginSessionRouting = (ctx) => {
        const sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId.trim() : "";
        const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
        let ovSessionId = typeof ctx?.ovSessionId === "string" ? ctx.ovSessionId.trim() : "";
        if (!ovSessionId && (sessionId || sessionKey)) {
            ovSessionId = openClawSessionToOvStorageId(sessionId || undefined, sessionKey || undefined);
        }
        const session = {
            agentId: ctx?.agentId,
            sessionId: sessionId || undefined,
            sessionKey: sessionKey || undefined,
            ovSessionId: ovSessionId || undefined,
        };
        rememberSessionAgentId(session);
        const agentId = statedAgentId(ctx?.agentId) ??
            resolveAgentId(session.sessionId, session.sessionKey, session.ovSessionId);
        return {
            sessionId: session.sessionId,
            sessionKey: session.sessionKey,
            ovSessionId: session.ovSessionId,
            agentId,
            actorPeerId: resolveOpenVikingActorPeerId({
                peerRole,
                personPeerId: sanitizeOpenVikingPeerId(ctx?.requesterSenderId ?? ctx?.senderId),
                assistantPeerId: agentId,
            }),
        };
    };
    const toQueryConfigContext = (session) => ({
        peerId: session.agentId,
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ovSessionId: session.ovSessionId,
    });
    return {
        rememberSessionAgentId,
        resolveAgentId,
        resolvePluginSessionRouting,
        toQueryConfigContext,
    };
}
