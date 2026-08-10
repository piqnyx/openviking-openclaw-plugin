---
name: openviking-context-database
description: >
  Use OpenViking from OpenClaw through the openviking context-engine plugin: long-term memory,
  session archives, resource and Agent Skill import, semantic recall, recall trace debugging,
  and externalized tool-result recovery. Prefer this skill when the user wants to use, query,
  debug, or operate OpenViking context from an OpenClaw agent. For first-time plugin installation,
  follow the plugin README.
version: 2026.7.15-isolation.7
metadata:
  openclaw:
    requires:
      plugin: "@openviking/openclaw-plugin"
  emoji: "🦣"
tags:
  - openviking
  - context-engine
  - memory
  - resources
  - skills
  - recall-trace
---

# OpenViking Context Database — OpenClaw Plugin Operator Skill

Use this skill after `@openviking/openclaw-plugin` is installed and configured. It describes the current OpenClaw plugin implementation, not the standalone OpenViking Python SDK.

## Scope and Safety Rules

- The plugin is **remote-only**. It talks to an existing OpenViking server through HTTP and does not start or manage `openviking-server`.
- Do not invent OpenViking REST endpoints. Use the registered OpenClaw tools and commands described below.
- The agent-visible `add_resource` tool is disabled by default (`enableAddResourceTool=false`). Do not use `add_resource` during search, retrieval, URI reading, or search-result optimization. Use `ov_search` and `ov_read` in those flows.
- When automatic resource routing is enabled, provide a concise semantic `summary`; never invent taxonomy category keys or `viking://` destinations.
- `remove_resource` is destructive. Use it only for an explicit user deletion request, never delete `viking://resources` itself, and use `recursive=true` only when deleting a non-empty resource subtree is intended.
- Use manual `/add-resource`, or `add_resource` only when it is explicitly enabled and the user explicitly asks to import, add, upload, save, or index a resource.
- Use `add_skill` only when the user explicitly asks to import, add, install, or register an Agent Skill into OpenViking.
- For local files and directories, pass the local path to the plugin tool. The plugin uploads them through `/api/v1/resources/temp_upload`; do not send raw local filesystem paths to a remote server yourself.
- Never log or echo API keys. The plugin sends API keys as `X-API-Key` / setup probe headers and masks them in setup output.

## Current Architecture

OpenClaw owns agent execution, prompts, and tool invocation. OpenViking owns long-lived context:

| Layer | Current behavior |
|---|---|
| `assemble` | Rebuilds compressed session history from OpenViking and injects relevant recall into the latest user message. |
| `afterTurn` | Appends only the new turn to the OpenViking session; may trigger async commit when `pending_tokens >= tokenBudget * commitTokenThresholdRatio`. |
| `compact` | Runs `commit(wait=true)`, waits for archive/extraction completion, and reads back latest archive overview. |
| Tools | Memory recall/store/forget, archive search/expand, resource/skill import/search, recall trace query, tool-result list/search/read. |

Long-term memories are usually extracted on `/compact` or on threshold-triggered commit. A fact mentioned in a fresh conversation may still be present as recent session context before it becomes a long-term memory.

## Configuration Quick Reference

Read status first:

```bash
openclaw openviking status --json
openclaw config get plugins.entries.openviking.config
openclaw config get plugins.slots.contextEngine
```

Core config lives under `plugins.entries.openviking.config`:

| Field | Default | Purpose |
|---|---:|---|
| `baseUrl` | `http://127.0.0.1:1933` | OpenViking HTTP endpoint. Can also come from `OPENVIKING_BASE_URL` / `OPENVIKING_URL`. |
| `apiKey` | empty | Optional API key. Can also come from `OPENVIKING_API_KEY`. |
| `peer_role` | `assistant` | Peer identity mode: `none`, `assistant`, or `person`. Session messages use body `peer_id`; data-plane recall/search uses `X-OpenViking-Actor-Peer`. |
| `peer_prefix` | empty | Optional prefix for assistant `peer_id` / actor peer values when `peer_role=assistant`. |
| `accountId` / `userId` | empty | Advanced tenant identity headers for root-key or trusted deployments. |
| `targetUri` | `viking://user/memories` | Default search scope for legacy targeted memory search. |
| `autoCapture` | `true` | Append sanitized turn text to OpenViking sessions. |
| `captureMode` | `semantic` | `semantic` or `keyword`; affects server-side extraction filtering. |
| `captureMaxLength` | `24000` | Max sanitized text length per captured turn. |
| `autoRecall` | `true` | Run recall before replies and inject relevant context. |
| `recallTargetTypes` | `user,agent` | Default target types when `targetUri` is omitted. Allowed: `resource`, `user`, `agent`. |
| `recallResources` | `false` | Compatibility shortcut that appends `resource` to default recall targets when `recallTargetTypes` is unset. |
| `recallLimit` | `6` | Max selected recall items. |
| `recallScoreThreshold` | `0.15` | Min score after post-processing. |
| `recallMaxInjectedChars` | `4000` | Total injected character cap; complete memories that do not fit are skipped. |
| `commitTokenThresholdRatio` | `0.5` | Async-commit threshold as a fraction (0-1) of the model context window (e.g. 0.5 = 50%); `0` commits every turn. |
| `commitKeepRecentCount` | `10` | Recent messages kept live after afterTurn commit. Compact always uses `0`. |
| `bypassSessionPatterns` | empty | Glob-like session keys that completely bypass OpenViking (`*` segment, `**` multi-segment). |
| `emitStandardDiagnostics` | `false` | Emit structured `openviking: diag {...}` lines. |
| `logFindRequests` | `false` | Log routing for find/session writes. Also enabled by `OPENVIKING_LOG_ROUTING=1` or `OPENVIKING_DEBUG=1`. |
| `traceRecall` | `false` | Record recall traces in memory. |
| `traceRecallPersist` | `false` | Persist recall traces as local JSONL files. |
| `traceRecallDir` | `~/.openclaw/openviking/recall-traces` | Recall trace directory when persistence is enabled. |
| `resourceRouting.enabled` | `false` | Enable per-agent YAML taxonomy routing for `add_resource`. |
| `resourceRouting.fallbackCategory` | `inbox` | Existing routeable semantic key used for semantic uncertainty. |
| `resourceRouting.retrieval.topK` | `2` | Cosine candidates retained for possible reranking. |
| `resourceRouting.logDecisions` | `false` | Emit compact category/score/timing decisions without source or summary content. |

Normal setup command:

```bash
openclaw openviking setup --base-url <OPENVIKING_URL> --api-key <API_KEY> --json
```

Useful variants:

```bash
openclaw openviking setup --base-url <URL> --api-key <KEY> --peer-prefix openclaw-prod --json
openclaw openviking setup --base-url <URL> --api-key <ROOT_KEY> --account-id <ACCOUNT_ID> --user-id <USER_ID> --json
openclaw openviking setup --base-url <URL> --api-key <KEY> --recall-target-types resource --json
openclaw openviking setup --base-url <URL> --api-key <KEY> --allow-offline --json
openclaw openviking setup --base-url <URL> --api-key <KEY> --force-slot --json
```

## Automatic Resource Routing

When `plugins.entries.openviking.config.resourceRouting.enabled=true`, each OpenClaw agent uses its own YAML taxonomy (default `~/.openclaw/{agentId}.yaml`). The packaged starter is `resource-routing/default-taxonomy.yaml`.

The routing contract is:

1. explicit `to`;
2. explicit `parent`;
3. explicit existing taxonomy `category`;
4. automatic classification from a short semantic `summary`.

Automatic routing embeds summary-only by default, compares it with cached embeddings of all routeable taxonomy categories, keeps configurable cosine `topK`, and conditionally reranks close candidates. Models never produce Viking URIs; the plugin converts only validated taxonomy keys to trusted `viking://resources/...` parents and uses OpenViking `create_parent=true`.

Semantic uncertainty routes to the configured fallback key, normally `inbox -> viking://resources/__INBOX__`, and the resource is still imported. Infrastructure failures such as a dead embedder/reranker, malformed model output, dimension mismatch, invalid taxonomy, or unrebuildable cache are fail-closed: `add_resource` is not called.

`summary` is routing input only. Do not copy it into OpenViking `reason`; a non-empty `reason` has separate memory-extraction semantics.

Taxonomy YAML is strict: no aliases/anchors, unique semantic keys and destination URIs, safe segments, at most 50 Unicode characters per segment, and a 4096-character plugin cap for the compiled resource URI. A routeable category may also have children, so a resource directory may contain direct resources and more specific subdirectories. Taxonomy changes take effect after gateway restart.

## Tool Selection Guide

| User intent | Use |
|---|---|
| “What did I say before?”, preferences, decisions, known facts | `memory_recall` |
| “Remember this now” | `memory_store` |
| “Forget X” | `memory_forget` |
| Summary lacks an exact command/path/snippet from old chat | `ov_archive_search`, then `ov_archive_expand` if needed |
| Import docs, PDFs, local dirs, URLs, Git repos, media attachments | manual `/add-resource`; `add_resource` only if `enableAddResourceTool=true` |
| Delete an imported OpenViking resource or subtree | `remove_resource` only for an explicit deletion request and only below `viking://resources/` |
| Import/register an Agent Skill | `add_skill` |
| Search imported resources or skills | `ov_search` |
| Read an exact `viking://...` hit from `ov_search` or recall trace | `ov_read` |
| Explain why recall/search returned something | `ov_recall_trace` |
| A previous tool result shows only a preview/ref | `openviking_tool_result_list`, `openviking_tool_result_search`, `openviking_tool_result_read` |

## Tool Interface Reference

### `memory_recall`

Semantic search over memories/resources. Use archive tools for session history.

| Parameter | Required | Description |
|---|---|---|
| `query` | Yes | Search query. |
| `limit` | No | Max selected results. Defaults to `recallLimit`. |
| `scoreThreshold` | No | Score threshold `0..1`. Defaults to `recallScoreThreshold`. |
| `targetUri` | No | Exact search URI. If set, only this URI is searched. |
| `resourceTypes` | No | Array of `resource`, `user`, `agent`; used only when `targetUri` is omitted. |

Notes: when `targetUri` is omitted, the plugin resolves a search plan from `resourceTypes` or configured `recallTargetTypes`, fetches more candidates than requested, deduplicates, filters leaf memories, reranks, and respects `recallMaxInjectedChars`.

### `memory_store`

Persist text immediately by writing a session and committing with `wait=true`.

| Parameter | Required | Description |
|---|---|---|
| `text` | Yes | Information source text. |
| `role` | No | Session role, default `user`. |
| `sessionId` | No | Existing OpenViking/OpenClaw session reference. If omitted, a temporary `memory-store-*` session is created. |

### `memory_forget`

Delete a memory.

| Parameter | Required | Description |
|---|---|---|
| `uri` | No | Exact `viking://user/.../memories/...` memory URI. Non-memory URIs are refused. |
| `query` | No | Search query when `uri` is unknown. |
| `targetUri` | No | Search scope URI, default `targetUri`. |
| `limit` | No | Search limit, default `5`. |
| `scoreThreshold` | No | Search threshold, default `recallScoreThreshold`. |

If query mode finds multiple candidates, report candidates and ask the user to choose the exact URI; do not delete ambiguous memories.

### `ov_archive_search`

Keyword grep across archived original conversation messages of the current session.

| Parameter | Required | Description |
|---|---|---|
| `query` | Yes | Single keyword or short phrase; prefer names, dates, file paths, commands, or distinctive nouns. |
| `archiveId` | No | Restrict to one archive, e.g. `archive_002`. |

Try at least two concrete keyword variants before concluding archived detail is unavailable.

### `ov_archive_expand`

| Parameter | Required | Description |
|---|---|---|
| `archiveId` | Yes | Archive ID from `[Archive Index]`, e.g. `archive_002`. |

Use after an archive search or when the `[Archive Index]` already identifies the archive likely to contain exact detail.

### `add_resource`

Import resources into `viking://resources/...`. The agent tool is disabled by default and must only be used for explicit import/index requests.

When resource routing is disabled, the historical import behavior remains active. When routing is enabled, destination priority is explicit `to`, explicit `parent`, explicit existing semantic `category`, then automatic routing from `summary`.

| Parameter | Required | Description |
|---|---|---|
| `source` | Yes | Local path, OpenClaw media attachment path, directory path, public URL, or Git URL. |
| `to` | No | Exact target URI. Do not combine with `parent`. |
| `parent` | No | Exact parent below `viking://resources`. |
| `category` | No | Existing semantic category key from the current agent taxonomy. Never invent one. |
| `summary` | Automatic only | One concise sentence describing semantic content and purpose. |
| `create_parent` | No | Create an explicit parent when missing. Category/automatic routing sets this internally. |
| `reason` | No | OpenViking reason/note. This is not the routing summary. |
| `instruction` | No | OpenViking semantic-processing instruction. |
| `wait` | No | Wait for processing completion. |
| `timeout` | No | Timeout in seconds when `wait=true`. |

If automatic routing needs a summary and none is supplied, retry with a concise semantic summary. Semantic uncertainty may route to the configured `__INBOX__`; an infrastructure routing error must instead be reported to the user and the resource must not be imported.

The `source` field remains the local-input permission selector. Routing does not bypass filesystem policy or make an otherwise protected local path readable.

### `remove_resource`

Delete a resource descendant below `viking://resources/`. This is destructive and must only be used for an explicit user deletion request.

| Parameter | Required | Description |
|---|---|---|
| `uri` | Yes | Exact descendant URI below `viking://resources/`. The root itself is forbidden. |
| `recursive` | No | Required when intentionally deleting a non-empty directory tree. Default false. |
| `wait` | No | Agent tool defaults to true so semantic cleanup can complete before subsequent work. |
| `timeout` | No | Server-side wait timeout in seconds. |

Do not use blind retries for `queued` or `failed` semantic cleanup results. Inspect state deliberately. The plugin never manipulates Qdrant directly.

### `add_skill`

Import Agent Skills into `viking://user/skills/...`.

| Parameter | Required | Description |
|---|---|---|
| `source` | No | Local `SKILL.md` path or skill directory. Exactly one of `source` or `data` is required. |
| `data` | No | Raw `SKILL.md` content or an MCP tool dict. Exactly one of `source` or `data` is required. |
| `wait` | No | Wait for processing completion. |
| `timeout` | No | Timeout in seconds when `wait=true`. |

Agent Skill best practice: a skill should have precise frontmatter (`name`, trigger-oriented `description`, useful `tags`), clear scope boundaries, explicit “when not to use” guidance if needed, and executable steps with concrete parameters. Keep secrets out of skill content.

### `ov_search`

| Parameter | Required | Description |
|---|---|---|
| `query` | Yes | Search query. |
| `uri` | No | Search URI. Defaults to resources plus agent skills. |
| `limit` | No | Max results per scope, default `10`. |

Use after importing resources/skills, or when the user asks to search OpenViking-managed knowledge.

Important: `ov_search` returns OpenViking virtual URIs such as `viking://resources/project-docs/api.md#chunk-3`. These are not local file paths. Do not use filesystem read tools for them; call `ov_read` with the exact URI when full content is needed.

### `ov_read`

Read full content for one exact OpenViking virtual URI through `/api/v1/content/read`.

| Parameter | Required | Description |
|---|---|---|
| `uri` | Yes | Exact `viking://...` URI returned by `ov_search` or recall trace results. `openviking://...` aliases and local file paths are refused. |

### `ov_recall_trace`

| Parameter | Required | Description |
|---|---|---|
| `turn` | No | `latest` or `all`, default `latest`. |
| `traceId` | No | Exact trace ID. |
| `sessionId` / `sessionKey` / `ovSessionId` | No | Filter by OpenClaw/OpenViking session. |
| `source` | No | `auto_recall`, `memory_recall`, `ov_search`, or `ov_archive_search`. |
| `resourceTypes` | No | Array/string containing `resource`, `user`, `agent`. |
| `since` / `until` | No | Unix timestamp bounds in milliseconds. |
| `includeContent` | No | Read selected/displayed URI content previews on demand. |
| `limit` | No | Maximum traces to return, default `20`. |

Trace records exist only when `traceRecall=true`; persisted lookup requires `traceRecallPersist=true` and accessible trace files.

### Externalized tool-result tools

Use when a preview contains `viking://session/<session_id>/tool-results/<tool_result_id>`.

| Tool | Parameters |
|---|---|
| `openviking_tool_result_list` | `tool_name?`, `limit?` (default `50`) |
| `openviking_tool_result_search` | `tool_output_ref`, `query`, `limit?` (default `20`), `context_chars?` (default `300`) |
| `openviking_tool_result_read` | `tool_output_ref`, `offset?` (default `0`), `limit?` (default `20000`, `-1` accepted by server path for all remaining content) |

The plugin refuses to read/search a tool-result ref from another session.

## Slash Commands

```text
/add-resource ./README.md --to viking://resources/openviking-readme --wait
/add-skill ./skills/openviking-context-database --wait --timeout=30
/ov-search "OpenViking install" --uri viking://resources/openviking-readme --limit=5
/ov-recall-trace --turn latest --source auto_recall --include-content
```

Command parsers support quoted args and flags. Resource-only flags are rejected for skill imports.

## Troubleshooting

| Symptom | Likely cause | First action |
|---|---|---|
| `configured=false` | Setup did not persist config | Re-run `openclaw openviking setup ... --json`; branch on JSON `error`. |
| `slotActive=false` | Another context engine owns the slot or gateway has stale state | Inspect `plugins.slots.contextEngine`; use `--force-slot` only after user confirms. |
| `health.ok=false` | Server unreachable or wrong `baseUrl` / key | Check `baseUrl`, network, `/health`, and auth. |
| No long-term memory after a fresh fact | `/compact` or commit/extraction has not run, or server extraction failed | Use `memory_store` for explicit remember/save/store intents; otherwise run `/compact` or wait for threshold commit, then check OpenViking server logs. |
| Recall misses shared documents | `resource` target is not enabled | Use `memory_recall` with `resourceTypes:["resource"]` or configure `recallTargetTypes: ["resource"]`. |
| Summary lacks exact detail | Archive summary is too coarse | Use `ov_archive_search` with concrete keywords, then `ov_archive_expand`. |
| Large tool output preview is insufficient | Tool result was externalized | Use `openviking_tool_result_search/read` with the ref. |
| Need to explain recall behavior | Trace disabled or no trace for that turn | Enable `traceRecall`; optionally `traceRecallPersist`; query `ov_recall_trace`. |

## Reference Docs in This Repo

- `README.md` / `README_CN.md`: feature overview and quick start.
- `INSTALL.md` / `INSTALL-ZH.md`: install, upgrade, uninstall, and JSON setup handling.
- `INSTALL-AGENT.md`: agent-oriented installation workflow.
- `docs/openviking-openclaw-plugin-guide.md`: comprehensive Chinese operator/developer guide.
