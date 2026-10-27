#!/usr/bin/env node
/**
 * The recall command: what auto-recall would put before a user message on a turn, for
 * a caller outside the gateway. The news digest reads every post against memory the
 * way Eva's own turn would (digest PLAN.md, stage 2), so this takes the steps the
 * context engine takes on a turn (services/context-lifecycle-service.ts, the
 * transform-context assemble) with the same functions: prepareRecallQuery, the
 * client from createOpenVikingClientRuntime with the agent key file, the actor peer,
 * the effective query config, buildAutoRecallContext. The settings are read from the
 * gateway's own openclaw.json (plugins.entries.openviking.config) and parsed the
 * plugin's way. Nothing here is new logic; the turn's code is not touched.
 *
 *   node dist/recall-cli.js [--config ~/.openclaw/openclaw.json] < request.json
 *
 * The request on stdin: {"agentId": "main", "prompt": "...", "sessionKey"?: "...",
 * "senderId"?: "..."}. On stdout, one JSON object: {"query", "block", "memoryCount",
 * "estimatedTokens"} -- `block` is null when the prompt leaves nothing to search for
 * or nothing was found. The plugin's own log lines go to stderr. A failure exits 1
 * with the reason on stderr and nothing on stdout.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAgentKeys } from "./agent-keys.js";
import { buildAutoRecallContext, prepareRecallQuery } from "./auto-recall.js";
import { createOpenVikingClientRuntime } from "./plugin/openviking-client-runtime.js";
import { openVikingPluginConfigSchema } from "./plugin-config.js";
import { RuntimeQueryConfigStore } from "./query-config.js";
import { resolveOpenVikingActorPeerId, sanitizeOpenVikingPeerId } from "./routing/identity-routing.js";
const PLUGIN_ID = "openviking";
export async function runRecallCommand(params) {
    const { logger } = params;
    const entries = params.gatewayConfig
        ?.plugins?.entries;
    const entry = entries?.[PLUGIN_ID];
    if (!entry)
        throw new Error(`the gateway config has no plugins.entries["${PLUGIN_ID}"]`);
    const rawCfg = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
        ? entry.config
        : {};
    // The plugin migrates a legacy local mode in place when the gateway starts; a
    // command that guessed at that migration could recall differently, so it refuses.
    if (rawCfg.mode && rawCfg.mode !== "remote") {
        throw new Error(`plugins.entries.openviking.config.mode is "${String(rawCfg.mode)}"; the command reads remote mode only`);
    }
    const cfg = openVikingPluginConfigSchema.parse(rawCfg);
    const request = (params.request ?? {});
    if (typeof request.agentId !== "string" || !request.agentId.trim()) {
        throw new Error("the request has no agentId");
    }
    if (typeof request.prompt !== "string")
        throw new Error("the request has no prompt string");
    const agentId = request.agentId;
    const sessionKey = typeof request.sessionKey === "string" ? request.sessionKey : undefined;
    const senderId = typeof request.senderId === "string" ? request.senderId : undefined;
    // Recall off, or a query under five characters: buildAutoRecallContext finds nothing
    // and asks nothing, as on the turn.
    const recallQuery = prepareRecallQuery(request.prompt);
    const agentKeys = loadAgentKeys({ filePath: cfg.agentKeysFile, systemApiKey: cfg.apiKey, logger });
    const { getClient } = createOpenVikingClientRuntime({
        cfg,
        rawPeerPrefix: rawCfg.peer_prefix,
        agentKeys,
        logger,
    });
    const client = await getClient(agentId);
    const actorPeerId = resolveOpenVikingActorPeerId({
        peerRole: cfg.peer_role ?? "assistant",
        personPeerId: sanitizeOpenVikingPeerId(senderId),
        assistantPeerId: agentId,
    });
    // The store typed as the context engine hands it to the turn, and asked the same way;
    // it reads its file on the first question.
    const queryConfigStore = new RuntimeQueryConfigStore({
        staticConfig: cfg,
        path: cfg.runtimeQueryConfigPath || undefined,
    });
    const queryConfig = await queryConfigStore.getEffective({ agentId, sessionKey });
    const recall = await buildAutoRecallContext({
        cfg,
        queryConfig,
        client,
        agentId,
        actorPeerId,
        queryText: recallQuery.query,
        logger,
        verbose: (message) => logger.info(message),
        sessionKey,
        queryTruncated: recallQuery.truncated,
        rawUserTextPreview: recallQuery.query,
    });
    return {
        query: recallQuery.query,
        block: recall.block ?? null,
        memoryCount: recall.memoryCount,
        estimatedTokens: recall.estimatedTokens,
    };
}
function argument(argv, name) {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
}
async function main(argv) {
    const configPath = argument(argv, "--config") ?? join(homedir(), ".openclaw", "openclaw.json");
    const toStderr = (message) => process.stderr.write(`${message}\n`);
    try {
        const gatewayConfig = JSON.parse(readFileSync(configPath, "utf8"));
        const request = JSON.parse(readFileSync(0, "utf8"));
        const result = await runRecallCommand({
            gatewayConfig,
            request,
            logger: { info: toStderr, warn: toStderr, error: toStderr },
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    }
    catch (error) {
        toStderr(`openviking recall: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main(process.argv.slice(2));
}
