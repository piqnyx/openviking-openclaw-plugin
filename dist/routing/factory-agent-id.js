import { sanitizeOpenVikingAgentIdHeader } from "./identity-routing.js";
/** `…/agents/<agentId>/agent` — the layout OpenClaw uses for agent state. */
const AGENT_DIR_PATTERN = /(?:^|[/\\])agents[/\\]([^/\\]+)(?:[/\\]|$)/;
/** `…/workspace/<agentId>` — the default per-agent workspace layout. */
const WORKSPACE_DIR_PATTERN = /(?:^|[/\\])workspaces?[/\\]([^/\\]+)[/\\]?$/;
function matchAgentId(value, pattern) {
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
export function agentIdFromFactoryContext(ctx) {
    if (!ctx) {
        return undefined;
    }
    return (matchAgentId(ctx.agentDir, AGENT_DIR_PATTERN) ??
        matchAgentId(ctx.workspaceDir, WORKSPACE_DIR_PATTERN));
}
