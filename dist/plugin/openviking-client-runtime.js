import { OpenVikingClient } from "../client.js";
import { resolveOpenVikingRequestHeaders } from "../request-headers.js";
import { SYSTEM_AGENT_ID } from "../agent-keys.js";
export function createOpenVikingClientRuntime(options) {
    const { cfg, logger, agentKeys } = options;
    if (cfg.logFindRequests) {
        logger.info("openviking: routing debug logging enabled (config logFindRequests, or env OPENVIKING_LOG_ROUTING=1 / OPENVIKING_DEBUG=1)");
    }
    const verboseRoutingInfo = (message) => {
        if (cfg.logFindRequests) {
            logger.info(message);
        }
    };
    verboseRoutingInfo(`openviking: loaded plugin config peer_role="${cfg.peer_role}" peer_prefix="${cfg.peer_prefix}" ` +
        `(raw peer_prefix=${JSON.stringify(options.rawPeerPrefix ?? "(missing)")}; ` +
        `${cfg.peer_prefix
            ? 'non-empty → assistant peer_id is <peer_prefix>_<ctx.agentId> when peer_role="assistant", or <peer_prefix>_main when ctx.agentId is unknown'
            : 'empty → assistant peer_id follows OpenClaw ctx.agentId when peer_role="assistant", or "main" when ctx.agentId is unknown'})`);
    const routingDebugLog = cfg.logFindRequests
        ? (msg) => {
            logger.info(msg);
        }
        : undefined;
    /**
     * One client per OpenViking account, built lazily and kept for the process
     * lifetime. Credentials are immutable per client, so the pool key is the
     * account label rather than the agent id: agents without a dedicated key all
     * share the single system client.
     */
    const clients = new Map();
    const buildClient = (apiKey) => new OpenVikingClient(cfg.baseUrl, apiKey, cfg.peer_prefix, cfg.timeoutMs, cfg.accountId, cfg.userId, routingDebugLog, {
        transport: options.transport,
        headers: resolveOpenVikingRequestHeaders({
            headers: cfg.headers,
        }),
    });
    /**
     * Resolve the OpenViking client for one OpenClaw agent.
     *
     * `undefined` (and the {@link SYSTEM_AGENT_ID} sentinel) mean the caller has
     * no agent context — startup health checks, or a session whose agent could
     * not be established. Those go to the system account, never to another
     * agent's.
     */
    const getClient = (agentId) => {
        const resolution = agentKeys.resolve(agentId);
        const requested = agentId?.trim();
        if (requested && requested !== SYSTEM_AGENT_ID && !resolution.attributed) {
            verboseRoutingInfo(`openviking: agent "${requested}" has no entry in the agent key file → system account`);
        }
        const cached = clients.get(resolution.account);
        if (cached) {
            return cached;
        }
        verboseRoutingInfo(`openviking: opening client for account "${resolution.account}"`);
        const created = Promise.resolve(buildClient(resolution.apiKey));
        clients.set(resolution.account, created);
        return created;
    };
    return {
        getClient,
        verboseRoutingInfo,
    };
}
