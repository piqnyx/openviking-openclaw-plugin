# OpenViking for OpenClaw with per-agent account isolation

This repository is a focused fork of the OpenViking OpenClaw context-engine plugin, based on upstream plugin version **2026.7.15**.

The fork keeps the upstream context-engine behavior while routing each OpenClaw agent to a separate OpenViking account/API key. Release **2026.7.15-isolation.9** hardens agent-facing resource routing and deletion against speculative tool arguments while preserving the calibrated semantic router introduced in earlier isolation releases.

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
| This release | 2026.7.15-isolation.9 |
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

Release `isolation.7` added configurable resource routing. Release `isolation.8` hardens the agent-facing mutation lifecycle:

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

Release `isolation.8` changes only the agent-facing mutation contract, not the low-level OpenViking client:

| Area | Change |
| --- | --- |
| `plugin/openviking-import-tools.ts` | Removes `wait`/`timeout` from agent-visible `add_resource`, `remove_resource`, and `add_skill`; all three submit with `wait=false`. |
| Mutation error handling | A transport failure without an HTTP response is reported as outcome-unknown and must not be retried automatically. |
| `remove_resource` | Treats OpenViking `NOT_FOUND` as already absent and returns queued semantic-refresh state without making the agent wait. |
| Result reporting | Async imports report accepted/queued semantics and preserve OpenViking `task_id` when present. |
| Manual/internal API | Low-level client and slash-command wait/timeout controls remain available for deliberate operator workflows. |

Release `isolation.9` hardens resource mutation behavior for ordinary agent use:

| Area | Change |
| --- | --- |
| `add_resource` category override | `category` remains available only for an exact destination explicitly named by the user; tool and Skill guidance forbid the model from inferring or guessing it. |
| Invalid explicit category | Unknown, ambiguous, or organizational selectors are rejected without importing anything instead of silently creating an `_INBOX` resource. |
| `remove_resource` agent schema | Exposes only `uri`; the model no longer chooses recursive deletion. |
| Category deletion guard | Exact current taxonomy category/container URIs are protected from agent deletion. |
| Document deletion | A specific imported document/resource root is first removed non-recursively and retried exactly once with recursive deletion only for OpenViking's specific non-empty-directory precondition. |
| Tests | Adds regression coverage for stale/speculative arguments, category-root protection, and the internal recursive fallback. |

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

Release `2026.7.15-isolation.8` can route agent-initiated `add_resource` imports into a validated per-agent YAML taxonomy without allowing the model, embedder, or reranker to invent OpenViking paths.

The agent-facing import contract is intentionally small:

```text
source
summary
category
```

- `source` is required.
- `summary` is required only for automatic routing. It is one short semantic sentence based on known or inspected content: what the resource contains and what it is useful for.
- `category` is an optional explicit override. Prefer an existing full taxonomy path such as `code/source/javascript`; stable semantic keys remain accepted for compatibility.

The agent tool does **not** expose arbitrary `to`/`parent` URIs, `create_parent`, extraction instructions, parser filters, strictness controls, tags, or watch settings. Those lower-level controls remain available to deliberate manual/operator paths.

An explicit category selector is resolved only against the compiled taxonomy. A known writable path/key is used directly without routing-model calls. Unknown, ambiguous, or organizational selectors go to the configured fallback inbox; they never create new taxonomy paths.

Automatic routing embeds the summary once, compares it with cached semantic-category vectors, and conditionally reranks the retained candidates only when the leading cosine scores are close. Low semantic confidence goes to fallback. Embedding/reranker outages, malformed responses, invalid taxonomy, and other infrastructure failures remain fail-closed and do **not** import the resource.

The fallback category is writable but excluded from cosine and reranker candidates.

### Per-agent taxonomy and cache

Typical deployment paths are:

```text
~/.openclaw/openviking/categories/{agentId}.yaml
~/.openclaw/openviking/resource-routing-cache/{agentId}.json
~/.openclaw/openviking/resource-routing-audit/{agentId}.jsonl
```

The repository ships:

```text
routing/default-resource-taxonomy.yaml   generic starter taxonomy
examples/resource-taxonomy.ru.yaml       reviewed deep Russian taxonomy
examples/routing-cases.ru.json           Russian calibration/adversarial cases
tools/routing-taxonomy-audit.mjs         zero-model-call structural/semantic audit
tools/routing-probe.mjs                  read-only live embedding/reranker probe
```

The reviewed Russian example is intentionally a deep human-browsable tree. Structural parents are non-routeable; semantic destinations are leaves. Repeated visible directory names are safe because stable semantic keys and complete taxonomy paths remain unique.

### Category semantic documents

Each compiled category has a positive `embeddingText` made from:

1. its positive `description`;
2. positive descriptions of its ancestors;
3. its exact full taxonomy path.

An optional YAML `distinguishFrom` list contains boundary guidance for confusing neighboring classes. Those exclusion/boundary hints are **not** included in the category embedding. They are appended only to `rerankText`, so the bi-encoder is not polluted with mirrored negative language while the cross-encoder still receives precise disambiguation rules when needed.

The category cache therefore stores vectors for `semanticCategories` only, using `embeddingText`. `_INBOX` never receives a semantic-category vector.

### Summary language and provenance

`resourceRouting.summaryLanguage` supports:

```text
any   no language restriction; default
ru    require a genuinely Russian automatic-routing summary
```

For the packaged Russian taxonomy use `ru`. Technical product names, commands, protocols and identifiers may remain in their natural form.

When provenance or container form defines the semantic resource type, the summary should state it naturally, for example: saved web page/article, batch scraping/crawling result, delivered email/newsletter, exported chat/forum history, transcript, machine log, database dump, backup/archive bundle, or screenshot. Raw filename/path/MIME/storage metadata should not be copied into the semantic summary merely because it exists.

The default semantic input remains summary-only:

```text
{{summary}}
```

`semanticInputTemplate` is configurable, but changing it is a routing-model change and should be recalibrated.

### Default model settings

With no routing-model overrides, the code defaults are:

```text
Embedding base URL: http://127.0.0.1:18081
Embedding model:    bge-m3
Embedding dims:     1024
Reranker base URL:  http://127.0.0.1:18080
Reranker model:     bge-reranker-v2-m3
Top K:              2
Minimum score:      0.64
Rerank margin:      0.06
Fallback key:       inbox
```

Deployments may override these values. Thresholds must be calibrated against the final taxonomy and a freshly rebuilt category cache; numbers measured on an older taxonomy are not transferable.

### Cache lifecycle and tools

A cache is valid only when its taxonomy hash, embedding endpoint/model identity, dimensions and exact semantic-category key set match. Cold-cache construction is sequential, one category embedding request at a time, and the completed cache is written atomically only after every category succeeds.

Treat taxonomy changes as maintenance: install the changed taxonomy, remove the affected agent cache, restart the gateway, wait for `resource routing ready for agent <id>`, then audit/probe the rebuilt cache.

Read-only commands:

```bash
npm run routing:audit -- --agent main --language ru
npm run routing:probe -- --agent main --cases /path/to/routing-cases.ru.json --output /tmp/routing-probe.json
```

The audit makes zero model calls. The probe calls the configured embedding/reranker services using the production routing code but never imports, moves, or deletes OpenViking resources.

Full schema, routing decisions, preload lifecycle, audit format, security boundary and rollout details are in [`docs/resource-routing.md`](docs/resource-routing.md).

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
