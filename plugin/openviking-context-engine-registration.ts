import { agentIdFromFactoryContext, type ContextEngineFactoryContext } from "../routing/factory-agent-id.js";
import { SYSTEM_AGENT_ID } from "../agent-keys.js";
import type { HistoryForModel } from "../price-handle.js";
import { catchUpBookmarksPath, createFileCatchUpBookmarks } from "../services/catch-up-bookmarks.js";
import { createSessionCatchUp, type SessionCatchUp } from "../services/catch-up-session.js";
import { createResetBarrier, type ResetBarrier } from "../services/reset-barrier.js";

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
  TPriceHandle = unknown,
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
  /** The proxy's price handle (PLAN-gorizont 4а); none when the config names no address. */
  priceHandle?: TPriceHandle;
  /** PLAN-krug 7в.5: the gateway's view of history as the model gets it; absent on an older gateway. */
  historyForModel?: HistoryForModel;
  /** PLAN-krug К18: the «догнать» memory of this registration, the same for every engine it builds. */
  catchUp: SessionCatchUp;
  /** PLAN-krug К20: the reset's hold on its session, the same for every engine it builds. */
  resetBarrier: ResetBarrier;
};

export type OpenVikingContextEngineRegistrationDeps<
  TEngine,
  TCfg = unknown,
  TClient = unknown,
  TQueryConfigStore = unknown,
  TTraceRecorder = unknown,
  TLogger extends OpenVikingContextEngineLogger = OpenVikingContextEngineLogger,
  TPriceHandle = unknown,
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
  priceHandle?: TPriceHandle;
  createContextEngine: (params: OpenVikingContextEngineCreateParams<TCfg, TClient, TQueryConfigStore, TTraceRecorder, TLogger, TPriceHandle>) => TEngine;
  setContextEngineRef: (engine: TEngine) => void;
};

export function registerOpenVikingContextEngine<
  TEngine,
  TCfg,
  TClient,
  TQueryConfigStore,
  TTraceRecorder,
  TLogger extends OpenVikingContextEngineLogger,
  TPriceHandle = unknown,
>(
  deps: OpenVikingContextEngineRegistrationDeps<TEngine, TCfg, TClient, TQueryConfigStore, TTraceRecorder, TLogger, TPriceHandle>,
): void {
  if (typeof deps.api.registerContextEngine !== "function") {
    deps.logger.warn(
      "openviking: registerContextEngine is unavailable; context-engine behavior will not run",
    );
    return;
  }

  // PLAN-krug К18: the gateway builds an engine for each logical turn; the «догнать» memory is one per
  // registration and handed to each, or every turn reads the gateway's branch from its start again.
  // PLAN-krug 7г: where the catch-up stopped is kept on disk, for a session archived whole (a reset) once
  // the process restarts.
  const catchUp = createSessionCatchUp({ bookmarks: createFileCatchUpBookmarks(catchUpBookmarksPath()) });
  const resetBarrier = createResetBarrier();
  // PLAN-krug 7в.5: whether the gateway hands its view of history is said once for the process, not at every turn.
  let toldOfView = false;
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

    const historyForModel =
      typeof factoryCtx?.historyForModel === "function"
        ? (factoryCtx.historyForModel as HistoryForModel)
        : undefined;
    if (!toldOfView) {
      toldOfView = true;
      if (historyForModel) {
        deps.logger.info("openviking: tails are weighed through the gateway's view of history (PLAN-krug 7в.5)");
      } else {
        deps.logger.warn(
          "openviking: the gateway hands no view of history (older than PLAN-krug 7в.5): " +
            "tails are weighed as stored, without the timestamps the model gets before past questions",
        );
      }
    }

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
      ...(deps.priceHandle !== undefined ? { priceHandle: deps.priceHandle } : {}),
      ...(historyForModel ? { historyForModel } : {}),
      catchUp,
      resetBarrier,
    });
    deps.setContextEngineRef(contextEngine);
    return contextEngine;
  });
  deps.logger.info(
    "openviking: registered context-engine (assemble=archive+active+auto-recall, afterTurn=auto-capture, session→OV id=uuid-or-sha256 + diag/Phase2 options)",
  );
}
