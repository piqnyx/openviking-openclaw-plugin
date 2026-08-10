import { homedir } from "node:os";
import { join, resolve } from "node:path";

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateResourceRoutingAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!AGENT_ID_RE.test(normalized)) {
    throw new Error(`invalid agent id for resource routing path: ${JSON.stringify(agentId)}`);
  }
  return normalized;
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
