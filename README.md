# OpenViking for OpenClaw with per-agent account isolation

This repository is a focused fork of the OpenViking OpenClaw context-engine plugin, based on upstream plugin version **2026.7.15**.

The fork keeps the upstream context-engine behavior while routing each OpenClaw agent to a separate OpenViking account/API key. Release **2026.7.15-isolation.8** keeps the configurable per-agent resource routing introduced in `isolation.7` and hardens the agent-facing mutation lifecycle on top of the guarded `remove_resource` support introduced in `isolation.6`.

## Design goals

- Preserve upstream OpenViking/OpenClaw behavior unless a change is required for per-agent account isolation, resource routing, or guarded resource removal.
- Keep each OpenClaw agent in a separate OpenViking account.
- Keep each agent's resource taxonomy, routing cache, and routing audit separate.
- Route unattributed traffic to a dedicated system account instead of guessing another agent.
- Keep the OpenViking server in control of tenant boundaries and resource processing.
- Keep agent-facing destructive tools fail-closed and explicit.
- Keep long-running OpenViking processing asynchronous at the agent boundary so transport timeouts cannot silently encourage duplicate mutations.

## Version matrix

| Component | Version |
| --- | --- |
| Forked OpenViking OpenClaw plugin | 2026.7.15 |
| This release | 2026.7.15-isolation.8 |
| Minimum OpenClaw | 2026.5.27 |
| Minimum OpenViking for this release | 0.4.4 |
| Recommended/tested OpenViking | 0.4.12 |

## Release history

Release `isolation.6` added the guarded resource-removal path:

| Area | Change |
| --- | --- |
| Agent account isolation | One OpenViking account/API key per OpenClaw agent. |
| Unknown agent handling | Unattributed traffic goes to the system account instead of `main`. |
| `remove_resource` | Agent-visible guarded deletion for descendants of `viking://resources/`. |
| Plugin manifest/schema | Expose `enableRemoveResourceTool` and `remove_resource`. |
| Tests | Cover API contract, destructive boundary, per-agent routing, wait behavior, and configuration gating. |

Release `isolation.7` added configurable resource routing. Release `isolation.8` hardens the agent-facing mutation lifecycle:

| Area | Change |
| --- | --- |
| `resourceRouting` config | Optional per-agent semantic routing using an operator-owned YAML taxonomy. |
| Local embedding/reranker | BGE-M3 candidate retrieval plus conditional BGE-reranker-v2-m3. |
| Trusted destination resolution | Models can select only known category keys; code resolves category keys to trusted `viking://resources/...` URIs. |
| Cache / preload | Per-agent embedding cache, startup preload, and serialized live routing during preload. |
| Audit | Per-agent JSONL routing audit with owner-only file mode. |
| `add_resource` | Supports automatic routing, explicit category selection, and `create_parent` parity. |
| `docs/resource-routing.md` | Documents the taxonomy schema, configuration, routing policy, cache/audit behavior, failure semantics, security boundary, and rollout. |
| Tests / CI | Cover routing config, taxonomy validation, model responses, cache invalidation, decisions, audit, tool behavior, startup preload, and create-parent parity. |

Release `isolation.8` changes only the agent-facing mutation contract, not the low-level OpenViking client:

| Area | Change |
| --- | --- |
| `plugin/openviking-import-tools.ts` | Removes `wait`/`timeout` from agent-visible `add_resource`, `remove_resource`, and `add_skill`; all three submit with `wait=false`. |
| Mutation error handling | A transport failure without an HTTP response is reported as outcome-unknown and must not be retried automatically. |
| `remove_resource` | Treats OpenViking `NOT_FOUND` as already absent and returns queued semantic-refresh state without making the agent wait. |
| Result reporting | Async imports report accepted/queued semantics and preserve OpenViking `task_id` when present. |
| Manual/internal API | Low-level client and slash-command wait/timeout controls remain available for deliberate operator workflows. |

The memory/session/account-isolation path is not replaced by resource routing. Automatic resource classification is confined to `add_resource` when no explicit destination was supplied.

## Account model

The fork routes each OpenClaw agent to a separate OpenViking API key from `agentKeysFile`. The plugin-level `apiKey` remains a system fallback for traffic that cannot be attributed to an agent.

The mapping file format is intentionally simple:

```text
main = ov-...
igor = ov-...
agent-test1 = ov-...
```

Agent names must match `[A-Za-z0-9_-]+`. Duplicate keys are rejected because sharing a key would merge two agents' OpenViking accounts.

The key mapping file should be owner-only (`chmod 600`). The plugin warns if it is readable by group or others.

### Recommended peer mode

With one OpenViking account per OpenClaw agent, use:

```json
{
  "peer_role": "none"
}
```

Per-peer subtrees are redundant when the account itself already isolates the agent.

## Core configuration

A minimal plugin configuration looks like:

```json
{
  "baseUrl": "http://127.0.0.1:1933",
  "apiKey": "${OPENVIKING_API_KEY}",
  "agentKeysFile": "/path/to/openviking-agent-keys.conf",
  "peer_role": "none",
  "autoCapture": true,
  "autoRecall": true
}
```

The exact OpenClaw nesting depends on your OpenClaw installation; these keys are the OpenViking plugin configuration fields.

### Relevant tool gates

`add_resource` and `remove_resource` are deliberately opt-in:

```json
{
  "enableAddResourceTool": true,
  "enableRemoveResourceTool": true
}
```

The explicit safety flags still win over `enabledTools`. For example, `enabledTools: "all"` does not activate `remove_resource` unless `enableRemoveResourceTool` is also `true`.

### Tool selectors

Supported selector groups include:

- `default`
- `all`
- `memory`
- `resource_query`
- `resource_manage`
- `import`
- `recall_trace`
- `archive`
- `tool_result`

`resource_manage` currently contains `remove_resource`.

## Configurable resource routing

Release `2026.7.15-isolation.8` can automatically place new `add_resource` imports into an agent-specific YAML taxonomy.

The agent supplies one short semantic `summary`. The tested default pipeline uses BGE-M3 for embedding retrieval and BGE-reranker-v2-m3 only when the leading embedding candidates are sufficiently close. The models never generate a URI. The plugin validates the taxonomy, accepts only a known semantic category key/candidate, resolves that key to a trusted `viking://resources/...` parent, and calls OpenViking with `create_parent=true` when automatic/category routing selects a parent.

Resource routing is disabled by default. When disabled, `add_resource` keeps the existing behavior.

See [`docs/resource-routing.md`](docs/resource-routing.md) for the complete configuration and taxonomy contract.

### Routing configuration example

```json
{
  "resourceRouting": {
    "enabled": true,
    "taxonomyDir": "/home/openclaw/.openclaw/resource-taxonomy",
    "cacheDir": "/home/openclaw/.openclaw/resource-routing-cache",
    "auditDir": "/home/openclaw/.openclaw/resource-routing-audit",
    "embedding": {
      "baseUrl": "http://127.0.0.1:8090",
      "model": "BAAI/bge-m3",
      "timeoutMs": 10000,
      "topK": 5
    },
    "reranker": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:8091",
      "model": "BAAI/bge-reranker-v2-m3",
      "timeoutMs": 10000,
      "topN": 5,
      "triggerMargin": 0.08,
      "triggerMinTop1": 0.3
    },
    "fallbackCategory": "other"
  }
}
```

Taxonomy files are loaded per agent from `<taxonomyDir>/<agent>.yaml`.

Example:

```yaml
version: 1
categories:
  - key: guides
    uri: viking://resources/documents/guides
    description: Setup guides, runbooks, and operating procedures.
    examples:
      - OpenClaw installation guide
      - Incident recovery runbook

  - key: other
    uri: viking://resources/other
    description: Fallback for resources that do not fit another category.
```

### Explicit routing

An agent can bypass automatic classification by supplying one of:

- `to`
- `parent`
- `category`

`category` must be an existing taxonomy key. The model never supplies the trusted URI itself in this mode; the plugin resolves the category key to its configured URI.

Explicit `to`, `parent`, and `category` are mutually exclusive.

### Automatic routing

When routing is enabled and none of `to`, `parent`, or `category` is supplied, the agent must provide a short semantic `summary` based on the actual resource content.

The tool description explicitly tells the agent not to invent the summary from a filename/path. It should inspect or already know enough of the content to state what the resource is about and what it is useful for.

The routing service then:

1. loads and validates the current agent taxonomy;
2. loads or rebuilds the per-agent category-embedding cache;
3. retrieves the top embedding candidates;
4. optionally reranks only when the configured ambiguity rule triggers;
5. deterministically falls back when confidence is insufficient;
6. resolves the selected category key to a trusted URI in code;
7. records the decision in an owner-only per-agent JSONL audit file.

## Routing diagnostics

The plugin can log account/session routing when `logFindRequests` is enabled or `OPENVIKING_LOG_ROUTING=1`/`OPENVIKING_DEBUG=1` is set.

```bash
OPENVIKING_LOG_ROUTING=1
```

API keys are not written to routing logs.

## Agent mutation lifecycle

The agent-facing mutation tools intentionally do not expose OpenViking's `wait` or `timeout` controls. Long-running parsing, VLM work, embeddings, semantic refresh, and index consistency are server-side jobs; keeping an LLM tool call open for them creates false timeout failures and encourages duplicate mutations.

The agent contract is therefore:

- `add_resource`: route/validate, submit with `wait=false`, return accepted state plus `root_uri`/`task_id` when OpenViking provides them;
- `add_skill`: submit with `wait=false` and return accepted state/task metadata;
- `remove_resource`: delete with `wait=false`; filesystem deletion is completed by OpenViking before the response while semantic refresh may continue with `semantic_status=queued`.

This restriction applies only to agent-visible tools. The low-level client and manual slash-command paths keep their explicit `wait`/`timeout` capabilities for operator workflows that deliberately need synchronous completion.

A network/transport timeout on a mutating request does not prove the server rejected the operation. If the client receives no HTTP response, the tool reports `outcome=unknown` and `retry_safe=false`; the agent is instructed to inspect OpenViking state before any retry. This avoids the classic failure mode where the first import was accepted, its response was lost, and a second automatic call creates a duplicate job.

## `remove_resource`

`remove_resource` deletes a file or directory below `viking://resources/` through the OpenViking filesystem API.

Example agent-level parameters:

```json
{
  "uri": "viking://resources/workspace",
  "recursive": true
}
```

### Safety boundary

The tool accepts only descendants of:

```text
viking://resources/
```

It refuses:

- `viking://resources` itself;
- memories, sessions, skills, and other namespaces;
- empty path segments;
- raw `.` or `..` path segments;
- raw backslash path separators;
- ambiguous raw `?` suffixes.

The validator intentionally does **not** percent-decode Viking URI path components. OpenViking treats percent sequences in the received Viking URI as literal path data; the plugin does not invent a second decoding step before a destructive operation.

To remove all resources, list `viking://resources` first and remove its top-level children individually. The root itself cannot be deleted through this tool.

### Recursive deletion

`recursive` defaults to `false`, matching the OpenViking API. A non-empty directory therefore requires:

```json
{
  "recursive": true
}
```

The plugin does not silently promote a failed non-recursive request into a recursive delete.

### Asynchronous consistency

The agent-facing tool always calls OpenViking with `wait=false`. OpenViking performs the filesystem deletion before returning, while semantic/index consistency work may remain queued. The plugin does not perform its own vector deletion, reindex, relation repair, or semantic refresh.

The structured OpenViking result is propagated in tool `details`, including fields such as `uri`, `estimated_deleted_count`, `memory_cleanup`, `semantic_root_uri`, `semantic_status`, and `queue_status` when the server returns them.

A successful asynchronous removal commonly returns `semantic_status=queued`. That means the requested resource was removed and semantic refresh continues on the server; it is not a deletion timeout.

OpenViking `NOT_FOUND` is treated as `resource_absent`, because the requested end state is already true. Transport failures without an HTTP response are different: the tool returns outcome-unknown and refuses to imply that an automatic retry is safe.

### Tool groups

`remove_resource` belongs to the `resource_manage` tool group.

## Development

Install dependencies:

```bash
npm ci --ignore-scripts
```

Run type checking:

```bash
npm run typecheck
```

Build and run tests:

```bash
npm run verify
```

The normal repository CI also rebuilds `dist/` and fails if tracked generated runtime files differ from source.

## Security notes

- Per-agent OpenViking keys must remain distinct.
- The system fallback API key must not be shared with any mapped agent.
- Keep the agent-key file owner-only.
- `remove_resource` remains disabled unless `enableRemoveResourceTool=true`.
- The resource root itself is not removable by the agent tool.
- Automatic resource routing accepts only taxonomy category keys and code-owned URIs.
- Resource routing failures are fail-closed; an automatic routing infrastructure error does not silently import into an arbitrary destination.
- Mutation transport failures without an HTTP response are treated as outcome-unknown; agent tools must not automatically repeat the mutation.
