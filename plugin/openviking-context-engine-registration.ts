import { agentIdFromFactoryContext, type ContextEngineFactoryContext } from "../routing/factory-agent-id.js";
import { SYSTEM_AGENT_ID } from "../agent-keys.js";

export type OpenVikingContextEngineRegistrationApi = {
  registerContextEngine?: (
    id: string,
    factory: (ctx?: ContextEngineFactoryContext) => unknown,
  ) => void;
};

export type OpenVikingContextEngineLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type OpenVikingContextEnginePluginInfo = {
  id: string;
  name: string;
};

export type OpenVikingContextEngineCreateParams<
  TCfg = unknown,
  TClient = unknown,
  TQueryConfigStore = unknown,
  TTraceRecorder = unknown,
  TLogger extends OpenVikingContextEngineLogger = OpenVikingContextEngineLogger,
> = {
  id: string;
  name: string;
  version: string;
  cfg: TCfg;
  logger: TLogger;
  getClient: (agentId: string | undefined) => Promise<TClient>;
  resolveAgentId: (sessionId: string, sessionKey?: string, ovSessionId?: string) => string;
  rememberSessionAgentId: (ctx: {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    ovSessionId?: string;
  }) => void;
  queryConfigStore: TQueryConfigStore;
  traceRecorder: TTraceRecorder;
};

export type OpenVikingContextEngineRegistrationDeps<
  TEngine,
  TCfg = unknown,
  TClient = unknown,
  TQueryConfigStore = unknown,
  TTraceRecorder = unknown,
  TLogger extends OpenVikingContextEngineLogger = OpenVikingContextEngineLogger,
> = {
  api: OpenVikingContextEngineRegistrationApi;
  plugin: OpenVikingContextEnginePluginInfo;
  version: string;
  cfg: TCfg;
  logger: TLogger;
  getClient: (agentId: string | undefined) => Promise<TClient>;
  resolveAgentId: (sessionId: string, sessionKey?: string, ovSessionId?: string) => string;
  rememberSessionAgentId: OpenVikingContextEngineCreateParams["rememberSessionAgentId"];
  queryConfigStore: TQueryConfigStore;
  traceRecorder: TTraceRecorder;
  createContextEngine: (params: OpenVikingContextEngineCreateParams<TCfg, TClient, TQueryConfigStore, TTraceRecorder, TLogger>) => TEngine;
  setContextEngineRef: (engine: TEngine) => void;
};

export function registerOpenVikingContextEngine<
  TEngine,
  TCfg,
  TClient,
  TQueryConfigStore,
  TTraceRecorder,
  TLogger extends OpenVikingContextEngineLogger,
>(
  deps: OpenVikingContextEngineRegistrationDeps<TEngine, TCfg, TClient, TQueryConfigStore, TTraceRecorder, TLogger>,
): void {
  if (typeof deps.api.registerContextEngine !== "function") {
    deps.logger.warn(
      "openviking: registerContextEngine is unavailable; context-engine behavior will not run",
    );
    return;
  }

  deps.api.registerContextEngine(deps.plugin.id, (factoryCtx) => {
    // OpenClaw resolves the engine once per agent run and hands the factory
    // that agent's directories. Session hooks do not always carry agentId or an
    // "agent:<id>:…" session key, so without this the run would be filed under
    // the system account. See routing/factory-agent-id.ts.
    const scopedAgentId = agentIdFromFactoryContext(factoryCtx);
    if (scopedAgentId) {
      deps.logger.info(
        `openviking: context-engine instance scoped to agent "${scopedAgentId}" (from factory context)`,
      );
    }

    const resolveAgentId: typeof deps.resolveAgentId = scopedAgentId
      ? (sessionId, sessionKey, ovSessionId) => {
          const resolved = deps.resolveAgentId(sessionId, sessionKey, ovSessionId);
          if (resolved !== SYSTEM_AGENT_ID) {
            return resolved;
          }
          // Teach the session resolver, so tool calls in this session — which
          // reach the plugin through a different path — resolve too.
          deps.rememberSessionAgentId({
            agentId: scopedAgentId,
            sessionId,
            sessionKey,
            ovSessionId,
          });
          return scopedAgentId;
        }
      : deps.resolveAgentId;

    const contextEngine = deps.createContextEngine({
      id: deps.plugin.id,
      name: deps.plugin.name,
      version: deps.version,
      cfg: deps.cfg,
      logger: deps.logger,
      getClient: deps.getClient,
      resolveAgentId,
      rememberSessionAgentId: deps.rememberSessionAgentId,
      queryConfigStore: deps.queryConfigStore,
      traceRecorder: deps.traceRecorder,
    });
    deps.setContextEngineRef(contextEngine);
    return contextEngine;
  });
  deps.logger.info(
    "openviking: registered context-engine (assemble=archive+active+auto-recall, afterTurn=auto-capture, session→OV id=uuid-or-sha256 + diag/Phase2 options)",
  );
}
