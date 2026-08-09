import { sanitizeOpenVikingAgentIdHeader } from "./identity-routing.js";

/**
 * Context the host passes to a context-engine factory.
 *
 * OpenClaw resolves the engine per agent run and supplies the agent's own
 * directories (`run-loop.ts` and `compact.queued.ts` both pass them), so the
 * factory context identifies the agent even when the session-level hooks do
 * not carry `agentId` or a `agent:<id>:…` session key.
 */
export type ContextEngineFactoryContext = {
  agentDir?: unknown;
  workspaceDir?: unknown;
};

/** `…/agents/<agentId>/agent` — the layout OpenClaw uses for agent state. */
const AGENT_DIR_PATTERN = /(?:^|[/\\])agents[/\\]([^/\\]+)(?:[/\\]|$)/;
/** `…/workspace/<agentId>` — the default per-agent workspace layout. */
const WORKSPACE_DIR_PATTERN = /(?:^|[/\\])workspaces?[/\\]([^/\\]+)[/\\]?$/;

function matchAgentId(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const captured = pattern.exec(trimmed)?.[1]?.trim();
  if (!captured || captured === "." || captured === "..") {
    return undefined;
  }
  return sanitizeOpenVikingAgentIdHeader(captured) || undefined;
}

/**
 * Derive the OpenClaw agent id from the factory context.
 *
 * `agentDir` wins: it is agent state by definition. `workspaceDir` is only
 * consulted when it follows the per-agent workspace layout, because a
 * workspace can equally well be a project checkout shared by several agents,
 * and guessing wrong here would file one agent's memory under another's name.
 */
export function agentIdFromFactoryContext(
  ctx: ContextEngineFactoryContext | undefined,
): string | undefined {
  if (!ctx) {
    return undefined;
  }
  return (
    matchAgentId(ctx.agentDir, AGENT_DIR_PATTERN) ??
    matchAgentId(ctx.workspaceDir, WORKSPACE_DIR_PATTERN)
  );
}
