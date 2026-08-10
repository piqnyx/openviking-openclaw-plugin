# OpenViking for OpenClaw with per-agent account isolation

This repository is a focused fork of the OpenViking OpenClaw context-engine plugin, based on upstream plugin version **2026.7.15**.

The fork keeps the upstream context-engine behavior while routing each OpenClaw agent to a separate OpenViking account/API key. Release **2026.7.15-isolation.7** adds configurable per-agent resource routing on top of the guarded `remove_resource` support introduced in `isolation.6`.

## Design goals

- Preserve upstream OpenViking/OpenClaw behavior unless a change is required for per-agent account isolation, resource routing, or guarded resource removal.
- Keep each OpenClaw agent in a separate OpenViking account.
- Keep each agent's resource taxonomy, routing cache, and routing audit separate.
- Route unattributed traffic to a dedicated system account instead of guessing another agent.
- Let models select only trusted semantic category candidates; never accept model-generated OpenViking URIs.
- Send semantically uncertain automatic imports to a configured fallback category while keeping infrastructure failures fail-closed.
- Keep destructive resource deletion disabled unless explicitly enabled.
- Let OpenViking perform creation/deletion, vector cleanup, resource-memory reference cleanup, and semantic refresh using its own server-side implementation.

## Compatibility

| Component | Version |
| --- | --- |
| Forked OpenViking OpenClaw plugin | 2026.7.15 |
| This release | 2026.7.15-isolation.7 |
| Minimum OpenClaw | 2026.5.27 |
| Minimum OpenViking for this release | 0.4.4 |
| Recommended/tested OpenViking | 0.4.12 |

`remove_resource` relies on the OpenViking filesystem DELETE API with `wait`/`timeout` support and semantic cleanup status. Resource routing uses the normal OpenViking resource import API with `parent` and `create_parent=true`. OpenViking 0.4.12 is the deployment target used for the implementation audit and live routing smoke tests.

## Changes from upstream

The isolation layer is intentionally narrow:

| Area | Change |
| --- | --- |
| `agent-keys.ts` | Loads the per-agent API-key map and enforces fail-closed key rules. |
| `plugin/openviking-client-runtime.ts` | Maintains one OpenViking client per configured account instead of one shared client. |
| `plugin/openviking-session-routing-runtime.ts` | Sends unresolved sessions to the system account instead of guessing `main`. |
| `config.ts`, `openclaw.plugin.json` | Add `agentKeysFile` and related configuration. |
| Runtime call sites | Pass the resolved OpenClaw agent ID to client selection. |

Release `isolation.6` added the guarded resource-removal path:

| Area | Change |
| --- | --- |
| `client.ts` | Adds the OpenViking `removeResource()` client call and a resource-only destructive URI guard. |
| `plugin/openviking-import-tools.ts` | Registers the agent-facing `remove_resource` tool. |
| `config.ts`, `registries/openviking-tools.ts` | Add the explicit destructive-tool gate and the `resource_manage` tool group. |
| Plugin manifest/schema | Expose `enableRemoveResourceTool` and `remove_resource`. |
| Tests | Cover API contract, destructive boundary, per-agent routing, wait behavior, and configuration gating. |

Release `isolation.7` adds configurable resource routing:

| Area | Change |
| --- | --- |
| `routing/default-resource-taxonomy.yaml` | Ships a starter nested taxonomy with 87 routeable categories and a visible `__INBOX__` fallback. |
| `routing/resource-taxonomy.ts` | Strictly validates per-agent YAML and compiles semantic category keys to trusted `viking://resources/...` URIs. |
| `routing/resource-routing-*` | Adds model clients, cosine retrieval, conditional reranking, embedding cache, audit, config parsing, and the per-agent routing service. |
| `plugin/openviking-import-tools.ts` | Adds agent-provided semantic `summary`, explicit semantic `category`, automatic routing, actionable validation errors, and fail-closed infrastructure handling. |
| `client.ts` | Adds `create_parent` parity for resource imports. |
| `plugin-config.ts`, `openclaw.plugin.json` | Add the `resourceRouting` configuration section while preserving the existing OpenViking config schema. |
| `docs/resource-routing.md` | Documents the taxonomy schema, configuration, routing policy, cache/audit behavior, failure semantics, security boundary, and rollout. |
| Tests / CI | Cover routing config, taxonomy validation, model responses, cache invalidation, decisions, audit, tool behavior, startup preload, and create-parent parity. |

The memory/session/account-isolation path is not replaced by resource routing. Automatic resource classification is confined to `add_resource` when no explicit destination was supplied.

## Account model

Create one OpenViking account/user for every OpenClaw agent plus a system fallback account. For example:

```text
openclaw-system / agent-system
openclaw-main   / agent-main
openclaw-igor   / agent-igor
openclaw-kate   / agent-kate
```

The plugin normally runs with:

```jsonc
{
  "peer_role": "none",
  "peer_prefix": ""
}
```

Isolation is therefore enforced by the OpenViking account/API-key boundary rather than by peer folders inside one shared account.

## Build and verify

```bash
npm ci
npm run verify
npm run typecheck
```

`npm run verify` performs a clean TypeScript build and runs the Vitest suite. `npm run typecheck` checks the full TypeScript project, including tests.

OpenClaw loads `dist/`, so rebuild after any source change.

## OpenClaw installation

Register the checked-out plugin directory as a linked plugin:

```bash
openclaw plugins install --link /path/to/openviking-openclaw-plugin --force
```

The plugin ID remains `openviking`, matching upstream. Do not register the upstream plugin and this fork at the same time because both use the same plugin ID and context-engine slot.

If a fresh installation is disabled until configuration is present:

```bash
openclaw plugins enable openviking
```

## OpenClaw configuration

Example:

```jsonc
{
  "plugins": {
    "slots": {
      "contextEngine": "openviking"
    },
    "entries": {
      "openviking": {
        "config": {
          "baseUrl": "http://127.0.0.1:1933",
          "peer_role": "none",
          "peer_prefix": "",
          "apiKey": "<system-account-api-key>",
          "agentKeysFile": "/home/openclaw/memory/secrets/openviking-keys/secrets.conf",
          "enableAddResourceTool": true,
          "enableRemoveResourceTool": true,
          "resourceRouting": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

Important fields:

- `apiKey` is the system-account key used only when an OpenClaw request cannot be attributed to a configured agent.
- `agentKeysFile` maps OpenClaw agent IDs to their dedicated OpenViking API keys.
- `peer_prefix` should remain empty for the account-per-agent deployment model.
- `enableAddResourceTool` must expose the agent-facing `add_resource` tool if automatic routing is to be used through agent tools.
- `enableRemoveResourceTool` is `false` unless explicitly set to `true`.
- `resourceRouting.enabled` is `false` unless explicitly set to `true`.

Enabling `remove_resource` through `enabledTools`, `enabledTools: "all"`, or a tool group does **not** bypass the destructive safety flag. `enableRemoveResourceTool: true` is required. `disabledTools` still wins and can disable it again.

## Configurable resource routing

Release `2026.7.15-isolation.7` can automatically place new `add_resource` imports into an agent-specific YAML taxonomy.

The agent supplies one short semantic `summary`. The tested default pipeline uses BGE-M3 for embedding retrieval and BGE-reranker-v2-m3 only when the leading embedding candidates are sufficiently close. The models never generate a URI. The plugin validates the taxonomy, accepts only a known semantic category key/candidate, resolves that key to a trusted `viking://resources/...` parent, and calls OpenViking with `create_parent=true` when automatic/category routing selects a parent.

Destination precedence is:

```text
explicit to > explicit parent > explicit category > automatic routing
```

Explicit routing does not depend on the local routing models. Automatic routing does.

### Per-agent taxonomy

The default taxonomy path template is:

```text
~/.openclaw/{agentId}.yaml
```

For example:

```text
~/.openclaw/main.yaml
~/.openclaw/igor.yaml
```

A starter taxonomy is shipped at:

```text
routing/default-resource-taxonomy.yaml
```

Copy it to each agent's configured taxonomy path and edit each tree independently. Taxonomies may have arbitrary practical nesting depth; intermediate categories may themselves be valid destinations. Every routeable node has a globally unique stable semantic key, a URI segment, and a semantic description. The plugin compiles the tree to trusted URIs; users do not put arbitrary full OpenViking destination URIs into the taxonomy.

The starter taxonomy contains branches for projects, documents, code, web material, media, structured data, reference material, communications, operations, security, tests, and a visible `__INBOX__` destination.

### Summary contract

For automatic routing, `add_resource` requires `summary`.

The agent-facing tool instructs the model to inspect/read enough of the resource to understand it before summarizing, unless the content is already known from the conversation. The summary should state semantic content and purpose in one short sentence. Semantically meaningful provenance can be named naturally, for example `online article`, `email thread`, `meeting transcript`, or `terminal screenshot`. Raw filename/path/MIME/storage metadata is not automatically injected into the routing query.

The tested baseline intentionally uses:

```text
{{summary}}
```

as the semantic model input. `semanticInputTemplate` is configurable for deployments that deliberately want to experiment with additional metadata fields.

If automatic routing is required but `summary` is missing, the tool rejects the call before contacting routing models or OpenViking and tells the agent to provide the summary and retry.

### Default model endpoints and thresholds

With only:

```jsonc
{
  "resourceRouting": {
    "enabled": true
  }
}
```

the routing defaults are:

```text
Embedding endpoint: http://127.0.0.1:18081/v1/embeddings
Embedding model:    bge-m3
Embedding dims:     1024
Reranker endpoint:  http://127.0.0.1:18080/v1/rerank
Reranker model:     bge-reranker-v2-m3
Top K:              2
Minimum score:      0.64
Rerank margin:      0.06
Fallback key:       inbox
```

Embedding and reranker `baseUrl`, `model`, `apiKey`, custom HTTP `headers`, `timeoutMs`, embedding `dimensions`, retrieval thresholds, fallback key, paths, semantic input template, and audit settings are configurable under `plugins.entries.openviking.config.resourceRouting`.

The `apiKey` and header values support `${ENV_VAR}` expansion so provider secrets do not need to be committed into OpenClaw configuration.

### Cache, fallback, and errors

Taxonomy embeddings are cached per agent and held in RAM. Cache validity is based on the taxonomy hash plus embedding endpoint/model/credential/header identity, dimensions, schema version, and category keys. A missing, stale, or corrupt cache is safely recomputed and rewritten atomically. Editing a taxonomy/config requires a gateway restart in this release.

Semantic uncertainty and infrastructure failures are deliberately different:

- if the semantic top score is below the configured minimum, automatic routing selects the configured fallback category and still imports the resource;
- the fallback category is an ordinary routeable taxonomy key, normally `inbox` with visible segment `__INBOX__`;
- if embedder/reranker HTTP fails, a response is malformed, dimensions mismatch, taxonomy/config is invalid, or internal category consistency fails, the resource is **not imported**;
- infrastructure failures are returned to the agent explicitly instead of being disguised as an inbox classification.

Compact per-agent JSONL routing audit records can include taxonomy hash, model names, candidate scores, reranker use/results, final category, fallback reason, bounded summary preview/hash, source hash, and routing latency. The audit does not write raw source paths.

Full schema, validation rules, cache format, security boundary, calibration notes, examples, and rollout procedure are in [`docs/resource-routing.md`](docs/resource-routing.md).

## Agent key file

Default path:

```text
/home/openclaw/memory/secrets/openviking-keys/secrets.conf
```

Recommended permissions:

```bash
install -d -m 700 /home/openclaw/memory/secrets/openviking-keys
install -m 600 /dev/null /home/openclaw/memory/secrets/openviking-keys/secrets.conf
```

Example content:

```ini
main = <openclaw-main-api-key>
igor = <openclaw-igor-api-key>
kate = <openclaw-kate-api-key>
```

The parser accepts blank lines, `#`/`;` comments, quoted values, and an optional `[agents]` section header.

The plugin refuses unsafe key maps, including:

- duplicate agent IDs;
- empty or malformed entries;
- two agents sharing the same API key;
- an agent key equal to the system key;
- configured agent keys without a system fallback key;
- an explicitly configured key file that cannot be read.

A key file readable by users other than its owner produces a permissions warning. The file is loaded at gateway startup, so restart the gateway after changing it.

## Agent attribution

The plugin resolves the agent from OpenClaw context and session identity, then selects that agent's OpenViking client/API key.

If attribution fails, the request is routed to the dedicated system OpenViking account. It is never silently assigned to another configured agent.

Routing diagnostics can be enabled with:

```jsonc
{
  "logFindRequests": true
}
```

or:

```bash
OPENVIKING_LOG_ROUTING=1
```

API keys are not written to routing logs.

## `remove_resource`

`remove_resource` deletes a file or directory below `viking://resources/` through the OpenViking filesystem API.

Example agent-level parameters:

```json
{
  "uri": "viking://resources/workspace",
  "recursive": true,
  "wait": true,
  "timeout": 900
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

### Waiting and consistency

The agent-facing tool defaults `wait` to `true`.

With `wait=true`, the plugin sends the DELETE request with OpenViking wait semantics and waits for that request to finish. OpenViking remains responsible for filesystem deletion, vector-index cleanup, resource-memory reference cleanup, and semantic refresh.

The plugin does not perform its own Qdrant deletion, reindex, relation repair, or semantic refresh.

The structured OpenViking result is propagated in tool `details`, including fields such as:

- `uri`;
- `estimated_deleted_count`;
- `memory_cleanup`;
- `semantic_root_uri`;
- `semantic_status`;
- `queue_status`.

Known semantic states on the tested OpenViking server are:

- `complete`: the waited semantic refresh completed;
- `queued`: consistency work was queued and is still pending, normally when `wait=false` was explicitly requested;
- `failed`: the resource was removed but semantic refresh reported a failure.

If the DELETE request itself fails or times out, the tool throws instead of returning a false success. Because OpenViking deletion is idempotent for valid URIs, callers can inspect the resource state and retry deliberately when necessary.

### Tool groups

`remove_resource` belongs to:

```text
resource_manage
```

The existing import group remains:

```text
import = add_resource, add_skill
```

This keeps destructive resource management separate from resource ingestion.

## Post-start checks

Confirm that per-agent credentials loaded:

```bash
grep -a "openviking: per-agent credentials loaded" /tmp/openclaw/openclaw-$(date +%F).log
```

Then verify, in this order:

1. the `openviking` context engine is loaded;
2. normal recall still works for an existing agent;
3. when resource routing is enabled, startup reports routing ready for each configured agent;
4. `add_resource` imports a disposable resource into the expected taxonomy destination for that agent;
5. another agent cannot see that resource through its own OpenViking account;
6. an intentionally ambiguous summary can be routed to the configured inbox without an infrastructure failure;
7. a routing infrastructure failure refuses the import instead of silently using inbox;
8. `remove_resource` removes the disposable resource;
9. a recursive test directory disappears together with its descendants;
10. a protected URI such as `viking://resources` is rejected before an HTTP DELETE is sent.

## Updating an existing linked installation

For an existing checkout:

```bash
npm ci
npm run verify
npm run typecheck
```

After rebuilding, restart the OpenClaw gateway so it loads the new `dist/` files.

For a production replacement, keep the previous working source directory and the existing agent-key file intact until the new checkout has passed startup and smoke checks. This makes rollback a registration/configuration change instead of a data-recovery exercise.

## Minimal tool profiles

When OpenClaw uses a restrictive tool profile, plugin tools must also be allowed by the relevant OpenClaw tool policy. Enabling a tool in this plugin does not override OpenClaw's own tool/sandbox permissions.

## License

MIT, matching the upstream OpenViking OpenClaw plugin.
