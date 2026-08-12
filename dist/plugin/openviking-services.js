export function createOpenVikingService({ cfg, getClient, logger, recallTraceHttpRoutesRegistered, registerRecallTraceRoutes, preloadResourceRouting, }) {
    let resourceRoutingPreloadStarted = false;
    return {
        id: "openviking",
        start: async (ctx) => {
            const runtimeRouteRegistered = registerRecallTraceRoutes(ctx);
            const routeRegistered = recallTraceHttpRoutesRegistered || runtimeRouteRegistered;
            await (await getClient(undefined)).healthCheck().catch(() => { });
            logger.info(`openviking: initialized (url: ${cfg.baseUrl}, targetUri: ${cfg.targetUri}, search: hybrid endpoint)`);
            if (routeRegistered) {
                logger.info("openviking: registered recall trace Gateway routes");
            }
            else {
                logger.warn?.("openviking: recall trace Gateway route adapter unavailable; use ov_recall_trace tool or /ov-recall-trace command");
            }
            // OpenClaw may invoke plugin register() more than once while constructing
            // runtime surfaces. The gateway service start lifecycle is the single place
            // where expensive startup work belongs. Keep preload asynchronous so service
            // startup itself is not held hostage by a cold CPU embedding cache.
            if (preloadResourceRouting && !resourceRoutingPreloadStarted) {
                resourceRoutingPreloadStarted = true;
                void preloadResourceRouting().catch((error) => {
                    logger.error(`openviking: resource routing startup preload failed: ${error instanceof Error ? error.message : String(error)}`);
                });
            }
        },
        stop: () => {
            logger.info("openviking: stopped");
        },
    };
}
