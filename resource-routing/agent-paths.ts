import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_PLACEHOLDER = "{agentId}";

export function validateResourceRoutingAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!AGENT_ID_RE.test(normalized)) {
    throw new Error(`invalid agent id for resource routing path: ${JSON.stringify(agentId)}`);
  }
  return normalized;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return `${homedir()}${value.slice(1)}`;
  }
  return value;
}

export function resolveAgentScopedResourceRoutingPath(template: string, agentId: string): string {
  const normalizedAgentId = validateResourceRoutingAgentId(agentId);
  const normalizedTemplate = template.trim();
  if (!normalizedTemplate) {
    throw new Error("resource routing path template must not be empty");
  }
  if (!normalizedTemplate.includes(AGENT_PLACEHOLDER)) {
    throw new Error(`resource routing path template must contain ${AGENT_PLACEHOLDER}`);
  }
  const expanded = expandHome(normalizedTemplate.split(AGENT_PLACEHOLDER).join(normalizedAgentId));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

export function defaultResourceTaxonomyPath(agentId: string, openClawHome = join(homedir(), ".openclaw")): string {
  return resolve(openClawHome, `${validateResourceRoutingAgentId(agentId)}.yaml`);
}

export function defaultResourceRoutingCachePath(
  agentId: string,
  openClawHome = join(homedir(), ".openclaw"),
): string {
  return resolve(
    openClawHome,
    "cache",
    "openviking-resource-routing",
    `${validateResourceRoutingAgentId(agentId)}.json`,
  );
}

export function defaultResourceRoutingAuditPath(
  agentId: string,
  openClawHome = join(homedir(), ".openclaw"),
): string {
  return resolve(
    openClawHome,
    "logs",
    "openviking-resource-routing",
    `${validateResourceRoutingAgentId(agentId)}.jsonl`,
  );
}
