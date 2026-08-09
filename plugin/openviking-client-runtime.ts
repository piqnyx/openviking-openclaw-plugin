import { OpenVikingClient } from "../client.js";
import type { HttpTransport } from "../adapters/http-transport.js";
import { resolveOpenVikingRequestHeaders } from "../request-headers.js";
import { SYSTEM_AGENT_ID, type AgentKeyResolver } from "../agent-keys.js";

type Logger = {
  info: (message: string) => void;
};

type ClientRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
  peer_role: "none" | "assistant" | "person";
  peer_prefix: string;
  timeoutMs: number;
  accountId?: string;
  userId?: string;
  headers?: Record<string, string>;
  logFindRequests: boolean;
};

export function createOpenVikingClientRuntime(options: {
  cfg: ClientRuntimeConfig;
  rawPeerPrefix: unknown;
  agentKeys: AgentKeyResolver;
  logger: Logger;
  transport?: HttpTransport;
}) {
  const { cfg, logger, agentKeys } = options;

  if (cfg.logFindRequests) {
    logger.info(
      "openviking: routing debug logging enabled (config logFindRequests, or env OPENVIKING_LOG_ROUTING=1 / OPENVIKING_DEBUG=1)",
    );
  }

  const verboseRoutingInfo = (message: string) => {
    if (cfg.logFindRequests) {
      logger.info(message);
    }
  };

  verboseRoutingInfo(
    `openviking: loaded plugin config peer_role="${cfg.peer_role}" peer_prefix="${cfg.peer_prefix}" ` +
      `(raw peer_prefix=${JSON.stringify(options.rawPeerPrefix ?? "(missing)")}; ` +
      `${
        cfg.peer_prefix
          ? 'non-empty → assistant peer_id is <peer_prefix>_<ctx.agentId> when peer_role="assistant", or <peer_prefix>_main when ctx.agentId is unknown'
          : 'empty → assistant peer_id follows OpenClaw ctx.agentId when peer_role="assistant", or "main" when ctx.agentId is unknown'
      })`,
  );

  const routingDebugLog = cfg.logFindRequests
    ? (msg: string) => {
        logger.info(msg);
      }
    : undefined;

  /**
   * One client per OpenViking account, built lazily and kept for the process
   * lifetime. Credentials are immutable per client, so the pool key is the
   * account label rather than the agent id: agents without a dedicated key all
   * share the single system client.
   */
  const clients = new Map<string, Promise<OpenVikingClient>>();

  const buildClient = (apiKey: string): OpenVikingClient =>
    new OpenVikingClient(
      cfg.baseUrl,
      apiKey,
      cfg.peer_prefix,
      cfg.timeoutMs,
      cfg.accountId,
      cfg.userId,
      routingDebugLog,
      {
        transport: options.transport,
        headers: resolveOpenVikingRequestHeaders({
          headers: cfg.headers,
        }),
      },
    );

  /**
   * Resolve the OpenViking client for one OpenClaw agent.
   *
   * `undefined` (and the {@link SYSTEM_AGENT_ID} sentinel) mean the caller has
   * no agent context — startup health checks, or a session whose agent could
   * not be established. Those go to the system account, never to another
   * agent's.
   */
  const getClient = (agentId: string | undefined): Promise<OpenVikingClient> => {
    const resolution = agentKeys.resolve(agentId);
    const requested = agentId?.trim();
    if (requested && requested !== SYSTEM_AGENT_ID && !resolution.attributed) {
      verboseRoutingInfo(
        `openviking: agent "${requested}" has no entry in the agent key file → system account`,
      );
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
