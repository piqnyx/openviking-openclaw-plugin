// Команда «вспомнить по запросу» (dist/recall-cli.js): то, что auto-recall положил бы перед
// сообщением на ходе, -- для того, кто зовёт память не из шлюза. Дайджест новостей читает
// каждый пост против памяти так же, как ход Эвы (digest PLAN.md, этап 2).
//
// Закрепляется: блок команды равен блоку, который ход (assemble с подмешиванием) кладёт
// перед тем же сообщением; запросы к Викингу и к перестановке те же; короткий или пустой
// запрос и выключенный recall не ищутся; без записи плагина, без agentId, в старом локальном
// режиме -- ошибка; собранная команда как процесс: запрос со stdin, JSON на stdout, сбой --
// код 1 и причина в stderr. Код хода не тронут: тест гонит настоящий assembleOpenVikingSession.

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createOpenVikingClientRuntime } from "../plugin/openviking-client-runtime.js";
import { loadAgentKeys } from "../agent-keys.js";
import { openVikingPluginConfigSchema } from "../plugin-config.js";
import { RuntimeQueryConfigStore } from "../query-config.js";
import { runRecallCommand } from "../recall-cli.js";
import { assembleOpenVikingSession } from "../services/context-lifecycle-service.js";

const POST = "В России не хватает автомехаников: сервисы ищут мастеров по коробкам передач";
const MEMORIES = [
  { uri: "viking://user/memories/people/serega.md", level: 2, score: 0.52, category: "people", abstract: "Серёга -- автомеханик" },
  { uri: "viking://user/memories/places/grigoleti.md", level: 2, score: 0.31, category: "places", abstract: "Вит живёт в Григолети" },
];
const CONTENT: Record<string, string> = {
  "viking://user/memories/people/serega.md": "Серёга, друг Вита, работает автомехаником, возится с коробками передач.",
  // Long on purpose: both fit the static budget (4096), only the first fits a session's 1000.
  "viking://user/memories/places/grigoleti.md": `Вит живёт в Григолети, у моря. ${"Тихо, сосны, ветер. ".repeat(140)}`,
};

// A request as the server sees it: where, what, under whose key and for which peer.
type Call = { url: string; body: unknown; key?: string | null; peer?: string | null };

// What the Viking server and the reranker answer; every request is recorded.
function answer(url: string, body: unknown, calls: Call[], headers?: Headers): { status: number; json: unknown } {
  calls.push({
    url: url.replace(/^https?:\/\/[^/]+/, ""),
    body,
    ...(headers ? { key: headers.get("X-API-Key"), peer: headers.get("X-OpenViking-Actor-Peer") } : {}),
  });
  if (url.endsWith("/health")) return { status: 200, json: { status: "ok" } };
  if (url.includes("/api/v1/search/find")) {
    const asked = body as { context_type?: string };
    return {
      status: 200,
      json: { status: "ok", result: asked.context_type === "memory" ? { memories: MEMORIES, total: 2 } : { resources: [], total: 0 } },
    };
  }
  if (url.includes("/api/v1/content/read")) {
    const uri = decodeURIComponent(url.split("uri=")[1] ?? "");
    return { status: 200, json: { status: "ok", result: CONTENT[uri] ?? "" } };
  }
  if (url.endsWith("/v2/rerank")) {
    const docs = (body as { documents: unknown[] }).documents;
    // The floor (0.3) is for the best one only: above it, the top `keep` go in, the second too.
    return { status: 200, json: { results: docs.map((_, index) => ({ index, relevance_score: index === 0 ? 0.9 : 0.2 })) } };
  }
  return { status: 404, json: { status: "error", error: { message: `unexpected ${url}` } } };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeFetch(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const reply = answer(url, body, calls, new Headers(init?.headers));
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

// The agent key file the plugin reads, as on the server: one key per agent, mode 0600.
const KEYS_DIR = mkdtempSync(join(tmpdir(), "viking-recall-keys-"));
const KEYS_FILE = join(KEYS_DIR, "secrets.conf");
writeFileSync(KEYS_FILE, "main = agent-key-main\n");
chmodSync(KEYS_FILE, 0o600);
afterAll(() => rmSync(KEYS_DIR, { recursive: true, force: true }));

// A runtime query config with a smaller budget for Vit's Telegram session, as /ov commands leave it.
const RUNTIME_FILE = join(KEYS_DIR, "runtime-query-config.json");
writeFileSync(RUNTIME_FILE, JSON.stringify({
  schemaVersion: "1.0",
  updatedAt: 1,
  claws: {},
  sessions: { "key:agent:main:telegram:direct:8248439450": { params: { maxInjectedChars: 1000 }, updatedAt: 1 } },
}));

const rawConfig = (overrides: Record<string, unknown> = {}) => ({
  mode: "remote",
  baseUrl: "http://viking.test",
  apiKey: "system-key",
  agentKeysFile: KEYS_FILE,
  peer_role: "none",
  autoRecall: true,
  recallRerank: { enabled: true, baseUrl: "http://rerank.test", model: "cohere/rerank-v3.5", keep: 5, floor: 0.3, candidates: 50, timeoutMs: 5000 },
  recallTargetTypes: ["user", "agent", "resource"],
  recallLimit: 5,
  recallScoreThreshold: 0.45,
  recallMaxInjectedChars: 4096,
  recallPreferAbstract: false,
  ...overrides,
});
const gatewayConfig = (config: Record<string, unknown>) => ({ plugins: { entries: { openviking: { enabled: true, config } } } });
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** The turn: the context engine's transform-context assemble with recall, as the gateway runs it. */
async function turnRecall(text: string, overrides: Record<string, unknown>): Promise<string | null> {
  const cfg = openVikingPluginConfigSchema.parse(rawConfig(overrides));
  const { getClient } = createOpenVikingClientRuntime({
    cfg,
    rawPeerPrefix: undefined,
    agentKeys: loadAgentKeys({ filePath: cfg.agentKeysFile, systemApiKey: cfg.apiKey, logger: quiet }),
    logger: quiet,
  });
  let injected: string | null = null;
  await assembleOpenVikingSession({
    sessionId: "9478e347-6bdc-44f5-a4e0-207fe7e4b6e3",
    sessionKey: "agent:main:telegram:direct:8248439450",
    messages: [{ role: "user", content: text, timestamp: 1 } as never],
    tokenBudget: 200_000,
    runtimeContext: { senderId: "8248439450" },
    isMainAssemble: false,
    cfg,
    getClient,
    logger: quiet,
    resolveAgentId: () => "main",
    isBypassedSession: () => false,
    queryConfigStore: new RuntimeQueryConfigStore({ staticConfig: cfg, path: cfg.runtimeQueryConfigPath || undefined }) as never,
    diag: () => {},
    roughEstimate: () => 0,
    messageDigest: () => [],
    extractAgentMessageText: (message) => String((message as { content?: unknown })?.content ?? ""),
    hasAutoRecallBlock: () => false,
    prependRecallToLatestUserMessage: (messages, block) => {
      injected = block;
      return messages;
    },
  });
  return injected;
}

describe("the recall command", () => {
  // Two turns: as on the server (peer_role none), and with an assistant peer and a message that
  // carries an injected memory block -- the cases where the peer header and the query cleaning show.
  it.each([
    ["peer_role none, a plain message", POST, { peer_role: "none" }],
    ["peer_role assistant, a message with an injected block", `${POST}\n<openviking-context>старая память</openviking-context>`, { peer_role: "assistant" }],
    ["a session with its own budget in the runtime query config", POST, { runtimeQueryConfigPath: RUNTIME_FILE }],
  ])("gives the block a turn puts before the same message, with the same requests: %s", async (_name, text, overrides) => {
    const calls = fakeFetch();
    const turn = await turnRecall(text, overrides);
    const turnCalls = calls.splice(0);
    const command = await runRecallCommand({
      gatewayConfig: gatewayConfig(rawConfig(overrides)),
      request: { agentId: "main", prompt: text, sessionKey: "agent:main:telegram:direct:8248439450", senderId: "8248439450" },
      logger: quiet,
    });

    expect(turn, "ход ничего не вспомнил -- сравнивать не с чем").toBeTruthy();
    expect(command.block).toBe(turn);
    expect(calls).toEqual(turnCalls);
    expect(command.block).toContain("Серёга, друг Вита, работает автомехаником");
    expect(command.memoryCount).toBe("runtimeQueryConfigPath" in overrides ? 1 : 2);
    expect(calls.some((call) => call.url === "/v2/rerank")).toBe(true);
    // The agent's own key, not the system one.
    expect(calls.find((call) => call.url === "/api/v1/search/find")?.key).toBe("agent-key-main");
    expect(JSON.stringify(calls)).not.toContain("старая память");
  });

  it("does not search a query under five characters, an empty one, or with recall off", async () => {
    const calls = fakeFetch();
    for (const [prompt, config] of [["ок", rawConfig()], ["    ", rawConfig()], [POST, rawConfig({ autoRecall: false })]] as const) {
      const result = await runRecallCommand({ gatewayConfig: gatewayConfig(config), request: { agentId: "main", prompt }, logger: quiet });
      expect(result.block).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("refuses a config without the plugin, a legacy local mode, and a request without an agent", async () => {
    await expect(runRecallCommand({ gatewayConfig: { plugins: { entries: {} } }, request: { agentId: "main", prompt: POST }, logger: quiet }))
      .rejects.toThrow(/openviking/);
    await expect(runRecallCommand({ gatewayConfig: gatewayConfig(rawConfig({ mode: "local" })), request: { agentId: "main", prompt: POST }, logger: quiet }))
      .rejects.toThrow(/remote mode only/);
    await expect(runRecallCommand({ gatewayConfig: gatewayConfig(rawConfig()), request: { prompt: POST }, logger: quiet }))
      .rejects.toThrow(/agentId/);
  });
});

// The built command as the digest calls it: a process, stdin in, JSON out.
const CLI = fileURLToPath(new URL("../dist/recall-cli.js", import.meta.url));

function run(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("the built recall command", () => {
  it("reads the request on stdin and prints the recall as JSON; a failure exits 1", async () => {
    const calls: Call[] = [];
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const reply = answer(`http://local${request.url}`, raw ? JSON.parse(raw) : undefined, calls);
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.json));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dir = mkdtempSync(join(tmpdir(), "viking-recall-cli-"));
    try {
      const port = (server.address() as { port: number }).port;
      const configPath = join(dir, "openclaw.json");
      writeFileSync(configPath, JSON.stringify(gatewayConfig(rawConfig({
        baseUrl: `http://127.0.0.1:${port}`,
        recallRerank: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, model: "cohere/rerank-v3.5", keep: 5, floor: 0.3, candidates: 50, timeoutMs: 5000 },
      }))));

      const ok = await run(["--config", configPath], JSON.stringify({ agentId: "main", prompt: POST }));
      expect(ok.code, ok.stderr).toBe(0);
      const printed = JSON.parse(ok.stdout);
      expect(printed.block).toContain("Серёга, друг Вита, работает автомехаником");
      expect(printed.memoryCount).toBe(2);
      expect(calls.some((call) => call.url.startsWith("/api/v1/search/find"))).toBe(true);

      writeFileSync(configPath, JSON.stringify({ plugins: { entries: {} } }));
      const failed = await run(["--config", configPath], JSON.stringify({ agentId: "main", prompt: POST }));
      expect(failed.code).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toMatch(/openviking/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
