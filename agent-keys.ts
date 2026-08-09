import { readFileSync, statSync } from "node:fs";

/**
 * Per-agent OpenViking credential routing.
 *
 * The upstream plugin holds a single API key for the whole gateway, so every
 * OpenClaw agent talks to OpenViking as the same tenant. This fork keeps one
 * OpenViking account per OpenClaw agent instead: the plugin still believes it
 * owns the server exclusively (run it with `peer_role: "none"` so no peer
 * subtree is created), while the server sees a different account/user per
 * agent and keeps their file systems, memories and resources fully separate.
 *
 * The map lives outside `openclaw.json` in a dedicated secrets file so the
 * keys never sit next to regular configuration. The plugin's own `apiKey`
 * (the one configured in `openclaw.json`) is the system fallback: anything
 * that cannot be attributed to a concrete agent lands in that account instead
 * of leaking into another agent's space.
 */

/**
 * Sentinel agent id meaning "identity could not be established".
 *
 * Upstream silently falls back to the literal agent id `main` whenever a
 * session cannot be resolved (see `routing/identity-routing.ts`), which under
 * per-agent credentials would push unattributable traffic into the `main`
 * agent's account. Routing that case through this sentinel keeps "unknown"
 * and "main" distinct.
 */
export const SYSTEM_AGENT_ID = "__system__";

/** Agent ids are sanitized to this charset before they ever reach the map. */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export type AgentKeysLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type AgentKeyResolution = {
  /** Key to send as `X-API-Key`. */
  apiKey: string;
  /** Stable label for the credential, used for client pooling and logs. */
  account: string;
  /** False when the request fell back to the system account. */
  attributed: boolean;
};

export type AgentKeyResolver = {
  resolve: (agentId: string | undefined) => AgentKeyResolution;
  /** Agent names that have a dedicated key, sorted. Never includes secrets. */
  agentNames: string[];
  /** Absolute path the map was read from, or undefined when unconfigured. */
  sourcePath?: string;
};

/**
 * Parse the `agent = key` secrets file.
 *
 * Format is deliberately boring so it can be written by hand and diffed:
 *
 *   # comment
 *   [agents]          ; optional section header, ignored
 *   main = ov-...
 *   igor = ov-...
 *
 * Values may be wrapped in single or double quotes. Blank lines are ignored.
 */
export function parseAgentKeysConf(text: string, sourceLabel: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator < 0) {
      throw new Error(
        `${sourceLabel}:${lineNo}: expected "<agent> = <api key>", got ${JSON.stringify(rawLine)}`,
      );
    }

    const name = line.slice(0, separator).trim();
    const value = stripQuotes(line.slice(separator + 1).trim());

    if (!name) {
      throw new Error(`${sourceLabel}:${lineNo}: missing agent name`);
    }
    if (!AGENT_NAME_PATTERN.test(name)) {
      throw new Error(
        `${sourceLabel}:${lineNo}: agent name ${JSON.stringify(name)} must match [A-Za-z0-9_-]+ ` +
          "(it has to equal the OpenClaw agent id)",
      );
    }
    if (name === SYSTEM_AGENT_ID) {
      throw new Error(
        `${sourceLabel}:${lineNo}: ${SYSTEM_AGENT_ID} is reserved; configure the system key as ` +
          "the plugin's own apiKey in openclaw.json",
      );
    }
    if (!value) {
      throw new Error(`${sourceLabel}:${lineNo}: agent ${JSON.stringify(name)} has an empty key`);
    }
    if (entries.has(name)) {
      throw new Error(`${sourceLabel}:${lineNo}: agent ${JSON.stringify(name)} is defined twice`);
    }

    entries.set(name, value);
  }

  return entries;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Reject credential maps that cannot deliver isolation.
 *
 * Two agents sharing one key is not a cosmetic mistake: it silently merges
 * their memories, so it fails the load instead of degrading quietly.
 */
function assertKeysAreDistinct(
  entries: Map<string, string>,
  systemApiKey: string,
  sourceLabel: string,
): void {
  const seen = new Map<string, string>();
  for (const [name, key] of entries) {
    const owner = seen.get(key);
    if (owner) {
      throw new Error(
        `${sourceLabel}: agents ${JSON.stringify(owner)} and ${JSON.stringify(name)} share the ` +
          "same API key, which would merge their memories",
      );
    }
    seen.set(key, name);
  }
  const systemOwner = seen.get(systemApiKey);
  if (systemOwner) {
    throw new Error(
      `${sourceLabel}: agent ${JSON.stringify(systemOwner)} uses the same API key as the system ` +
        "fallback (plugin apiKey in openclaw.json)",
    );
  }
}

export type LoadAgentKeysOptions = {
  /** Absolute path to the secrets file. Empty/undefined disables per-agent routing. */
  filePath?: string;
  /** Plugin-level `apiKey` from openclaw.json; the system account's key. */
  systemApiKey: string;
  logger: AgentKeysLogger;
  /** Seam for tests. */
  readFile?: (path: string) => string;
  /** Seam for tests; returns the file mode bits, or undefined when unknown. */
  statMode?: (path: string) => number | undefined;
};

/**
 * Load the agent → key map once at plugin registration.
 *
 * Deliberately not watched for changes: adding an agent is a restart. Hot
 * swapping credentials in a long-lived process is a whole class of bugs in the
 * one place where a mistake means cross-agent leakage.
 */
export function loadAgentKeys(options: LoadAgentKeysOptions): AgentKeyResolver {
  const { logger, systemApiKey } = options;
  const filePath = options.filePath?.trim();
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const statMode = options.statMode ?? defaultStatMode;

  if (!filePath) {
    logger.warn(
      "openviking: agentKeysFile is not configured — every agent will use the plugin apiKey and " +
        "share one OpenViking account (no isolation)",
    );
    return systemOnlyResolver(systemApiKey);
  }

  let raw: string;
  try {
    raw = readFile(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`openviking: cannot read agentKeysFile ${filePath} (${message})`);
  }

  const entries = parseAgentKeysConf(raw, filePath);

  if (entries.size > 0 && !systemApiKey.trim()) {
    throw new Error(
      `openviking: agentKeysFile ${filePath} defines ${entries.size} agent key(s) but the plugin ` +
        "apiKey (system fallback account) is empty; unattributed requests would be sent " +
        "without credentials",
    );
  }

  assertKeysAreDistinct(entries, systemApiKey.trim(), filePath);

  const mode = statMode(filePath);
  if (mode !== undefined && (mode & 0o077) !== 0) {
    logger.warn(
      `openviking: agentKeysFile ${filePath} is readable beyond its owner ` +
        `(mode ${mode.toString(8).padStart(3, "0")}); chmod 600 it`,
    );
  }

  const agentNames = [...entries.keys()].sort();
  logger.info(
    `openviking: per-agent credentials loaded from ${filePath} ` +
      `(agents: ${agentNames.length > 0 ? agentNames.join(", ") : "none"}; ` +
      "everything else falls back to the system account)",
  );

  return {
    agentNames,
    sourcePath: filePath,
    resolve: (agentId) => {
      const name = agentId?.trim();
      if (!name || name === SYSTEM_AGENT_ID) {
        return { apiKey: systemApiKey, account: SYSTEM_AGENT_ID, attributed: false };
      }
      const apiKey = entries.get(name);
      if (!apiKey) {
        return { apiKey: systemApiKey, account: SYSTEM_AGENT_ID, attributed: false };
      }
      return { apiKey, account: name, attributed: true };
    },
  };
}

function systemOnlyResolver(systemApiKey: string): AgentKeyResolver {
  return {
    agentNames: [],
    resolve: () => ({ apiKey: systemApiKey, account: SYSTEM_AGENT_ID, attributed: false }),
  };
}

function defaultStatMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}
