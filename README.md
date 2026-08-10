# OpenViking for OpenClaw with per-agent account isolation

This repository is a focused fork of the OpenViking OpenClaw context-engine plugin, based on upstream plugin version **2026.7.15**.

The fork keeps the upstream context-engine behavior while routing each OpenClaw agent to a separate OpenViking account/API key. Release **2026.7.15-isolation.7** adds configurable per-agent resource routing on top of the guarded resource-management support introduced in `isolation.6`.

## Design goals

- Preserve existing OpenViking/OpenClaw behavior when optional fork features are disabled.
- Keep each OpenClaw agent in a separate OpenViking account.
- Never guess another agent when tenant attribution is missing.
- Keep destructive resource deletion explicitly gated.
- Let OpenViking own resource parsing, tree construction, semantic summaries, vector indexing, deletion, and consistency work.
- Let the plugin choose resource destinations without allowing an embedding model or reranker to generate Viking URIs.
- Fail closed on routing infrastructure failures instead of disguising them as semantic uncertainty.

## Compatibility

| Component | Version |
| --- | --- |
| Forked OpenViking OpenClaw plugin | 2026.7.15 |
| This release | 2026.7.15-isolation.7 |
| Minimum OpenClaw | 2026.5.27 |
| Base plugin minimum OpenViking | 0.4.4 |
| Recommended/tested OpenViking | 0.4.12 |

The automatic resource router is designed and audited against OpenViking **0.4.12**, including its `parent` + `create_parent` resource-import behavior. Keep `resourceRouting.enabled=false` on older deployments unless equivalent server behavior has been verified.

## Release highlights

### Per-agent account isolation

Each OpenClaw agent selects its own OpenViking API key and therefore its own OpenViking account. Sessions, memories, skills, resources, and account-level namespaces remain separated by the server-side account boundary.

### Guarded `remove_resource`

The optional destructive tool can delete descendants of `viking://resources/`, but never the `viking://resources` root. OpenViking remains responsible for physical deletion, vector cleanup, memory-reference cleanup, and semantic refresh.

### Automatic resource routing

When enabled, `add_resource` can classify a short agent-provided semantic summary into a user-controlled per-agent YAML taxonomy:

```text
agent summary
    |
    v
BGE-style embedding
    |
    v
cosine top-K against cached category embeddings
    |
    +-- confident ------------------------------------+
    |                                                  |
    +-- close candidates -> conditional reranker ------+
                                                       |
                                                       v
                                            validated category key
                                                       |
                                                       v
                                            plugin-built trusted URI
                                                       |
                                                       v
                                      OpenViking parent + create_parent
```

The taxonomy may be deeply nested, but classification is **not hierarchical**. All routeable categories are flattened into one candidate set. A bad decision at a parent level therefore cannot permanently exclude a better child candidate.

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

Isolation is enforced by the OpenViking account/API-key boundary rather than by peer folders inside one shared account.

## Build and verify

```bash
npm ci
npm run verify
npm run typecheck
```

`npm run verify` performs a clean TypeScript build and runs the complete Vitest suite, including the existing baseline tests and resource-routing tests. OpenClaw loads `dist/`, so rebuild after source changes.

Before publishing a release, also inspect package contents:

```bash
npm pack --dry-run
```

The package must contain `resource-routing/default-taxonomy.yaml` and the compiled routing runtime.

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

## Core OpenClaw configuration

Example without automatic resource routing:

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
          "enableRemoveResourceTool": true
        }
      }
    }
  }
}
```

Important fields:

- `apiKey` is the system-account key used only when a request cannot be attributed to a configured agent.
- `agentKeysFile` maps exact OpenClaw agent IDs to dedicated OpenViking API keys.
- `peer_prefix` should normally remain empty for the account-per-agent deployment model.
- `enableAddResourceTool` and `enableRemoveResourceTool` are independent safety gates.
- Enabling a tool through `enabledTools` or a tool group does not bypass its safety gate.

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

The plugin refuses unsafe key maps, including duplicate agent IDs, malformed entries, shared agent keys, an agent key equal to the system key, and explicitly configured key files that cannot be read. A key file readable by users other than its owner produces a permissions warning. Restart the gateway after changing the file.

## Resource routing

`resourceRouting` is optional and defaults to disabled. When disabled, the historical `add_resource` path remains the active behavior and no taxonomy, cache, embedder, reranker, or routing service is used.

### Per-agent taxonomy files

The default path template is:

```text
~/.openclaw/{agentId}.yaml
```

For agents named `main` and `igor`, that resolves to:

```text
~/.openclaw/main.yaml
~/.openclaw/igor.yaml
```

A starter taxonomy is shipped with the plugin:

```text
resource-routing/default-taxonomy.yaml
```

Copy it once for each agent and edit those copies:

```bash
cp resource-routing/default-taxonomy.yaml ~/.openclaw/main.yaml
cp resource-routing/default-taxonomy.yaml ~/.openclaw/igor.yaml
```

The taxonomy is intentionally per-agent because each agent has its own isolated OpenViking resources.

### YAML schema

Minimal example:

```yaml
schemaVersion: 1

categories:
  inbox:
    segment: __INBOX__
    description: Resources that cannot be confidently classified elsewhere.

  projects:
    segment: projects
    description: Materials tied to a specific project.
    children:
      openclaw:
        segment: openclaw
        description: OpenClaw implementation, configuration, operation and documentation.
        children:
          openviking:
            segment: openviking
            description: OpenViking integration, memory, resources and resource routing for OpenClaw.

  organization-only:
    segment: organization
    description: A grouping branch that must never be selected directly.
    routeable: false
    children:
      leaf:
        segment: leaf
        description: A real routing destination below the grouping branch.
```

Each category has:

- a globally unique **semantic key**, represented by the YAML mapping key such as `openviking`;
- a `segment`, used only by trusted plugin code to build the Viking URI;
- a semantic `description`, embedded during cache construction;
- optional `routeable: false`; the default is `true`;
- optional nested `children`.

A category may be routeable **and** contain children. That allows a directory to contain resources directly while also containing more specific subdirectories. Tree depth does not need to be uniform.

### Taxonomy validation rules

The parser is deliberately strict:

- `schemaVersion` must be `1`;
- unknown fields are rejected;
- semantic keys must be safe stable identifiers and unique across the complete tree;
- destination URIs must be unique;
- each `segment` must contain only safe letters/numbers/marks plus `_`, `-`, and `.`;
- `.` / `..`, dot-prefixed or dot-suffixed segments, separators, query syntax, leading/trailing whitespace, and other unsafe path material are rejected;
- each **individual segment** is limited to **50 Unicode characters**, matching the OpenViking 0.4.12 semantic segment-sanitization bound; this is not a 50-character limit on the full `viking://resources/...` path;
- category descriptions are limited to 4000 characters;
- YAML duplicate keys are rejected;
- YAML aliases/anchors and merge-key tricks are not supported;
- reused/cyclic node objects are rejected by the programmatic parser.

The plugin does **not** impose a small artificial taxonomy nesting-depth limit. The parser walks the tree iteratively rather than recursively, so deep valid trees are not rejected merely because of the JavaScript call stack. The final URI still has to be usable by the deployed OpenViking/storage stack; the plugin does not invent an undocumented whole-URI length limit of its own.

### Fallback category

Fallback is configured by **semantic key**, not by URI:

```jsonc
{
  "fallbackCategory": "inbox"
}
```

The default taxonomy maps the semantic key `inbox` to the visible root folder:

```text
viking://resources/__INBOX__
```

At startup the configured fallback must exist in that agent's taxonomy and must be routeable. Otherwise automatic routing for that agent is unavailable.

### Routing configuration

Full example using the tested local llama.cpp services:

```jsonc
{
  "resourceRouting": {
    "enabled": true,

    "taxonomyFile": "~/.openclaw/{agentId}.yaml",
    "cacheFile": "~/.openclaw/cache/openviking-resource-routing/{agentId}.json",
    "auditFile": "~/.openclaw/logs/openviking-resource-routing/{agentId}.jsonl",

    "semanticInputTemplate": "{{summary}}",
    "fallbackCategory": "inbox",
    "failurePolicy": "error",
    "logDecisions": false,

    "embedding": {
      "baseUrl": "http://127.0.0.1:18081",
      "endpointPath": "/v1/embeddings",
      "model": "bge-m3",
      "dimensions": 1024,
      "timeoutMs": 30000,
      "apiKey": "",
      "headers": {},
      "cacheKey": ""
    },

    "reranker": {
      "baseUrl": "http://127.0.0.1:18080",
      "endpointPath": "/v1/rerank",
      "model": "bge-reranker-v2-m3",
      "timeoutMs": 3000,
      "apiKey": "",
      "headers": {}
    },

    "retrieval": {
      "topK": 2,
      "minScore": 0.64,
      "rerankBelowMargin": 0.06
    },

    "audit": {
      "enabled": true,
      "includeSummaryPreview": false,
      "summaryPreviewChars": 240
    }
  }
}
```

The endpoints are configurable and may point at other compatible services. `baseUrl`, `endpointPath`, `model`, `apiKey`, custom headers, and timeouts are not tied to the local defaults. Nested `apiKey` and header values may use `${ENV_NAME}` expansion so secrets do not need to be stored literally in `openclaw.json`.

`embedding.dimensions` must match the returned dense embedding dimension exactly.

`embedding.cacheKey` is an operator-controlled cache revision. It is normally empty. Change it when self-hosted embedding weights change behind the same `baseUrl` and `model` name so the category cache is deliberately invalidated and rebuilt.

### Retrieval settings

`retrieval.topK` is the number of best cosine candidates retained after the embedding stage. When the top candidates are close enough to require reranking, the reranker receives this retained candidate set. It is configurable from `1` to `1000`.

The tested starting baseline is:

```text
topK = 2
minScore = 0.64
rerankBelowMargin = 0.06
```

These are calibration defaults, not universal truths. Increasing `topK` lets the reranker consider more alternatives but increases reranking latency. Tune the values with real routing audit data rather than treating the defaults as sacred constants.

### Semantic input

For automatic routing the agent must provide `summary`: one concise sentence describing **what the resource is about and what it is useful for**.

The default semantic input is deliberately:

```text
{{summary}}
```

Filename, source path, MIME type, and other technical metadata are **not** automatically mixed into the embedding query. Testing found summary-only routing materially more reliable for the intended taxonomy.

A custom `semanticInputTemplate` may explicitly add supported metadata later, for example:

```text
{{summary}}
Source kind: {{sourceKind}}
```

Supported template fields are `summary`, `filename`, `extension`, `mimeType`, `sourceKind`, `source`, `reason`, `instruction`, and `agentId`. The template must contain `{{summary}}`. Malformed and unknown placeholders are rejected at config parse time.

Routing summaries are capped at 4000 characters. If automatic routing is required and `summary` is missing or empty, `add_resource` returns an actionable validation error and does **not** call OpenViking.

### `summary` is not `reason`

Do not automatically copy a routing summary into OpenViking `reason`.

They have different semantics:

- `summary` is input only to this plugin's category router;
- `reason` is an OpenViking resource-import field that can participate in OpenViking's normal memory-extraction pipeline and create/update memories that reference the resource;
- `instruction` is an OpenViking semantic-processing instruction.

The router preserves caller-supplied `reason` and `instruction` but does not invent either one.

### Routing priority

`add_resource` resolves destination intent in this order:

1. explicit `to`;
2. explicit `parent`;
3. explicit semantic `category` key;
4. automatic routing from `summary`.

`to` and `parent` are mutually exclusive legacy OpenViking inputs. Supplying either one skips category and automatic routing; supplying both is passed through unchanged and rejected by the existing OpenViking client validation, preserving the pre-routing contract rather than silently choosing one. Explicit legacy `to`/`parent` values are not normalized or rewritten by the router.

Explicit `category` never asks the embedding or reranker services. The plugin loads the agent's validated taxonomy, resolves that exact category key to a trusted URI, and uses `create_parent=true`.

Automatic routing and explicit category selection never accept a model-generated URI. Only plugin code converts a known taxonomy key into `viking://resources/...`.

### Semantic uncertainty versus infrastructure failure

These cases are intentionally different.

**Semantic uncertainty** means the routing stack is healthy but cannot confidently classify the summary, for example because the best cosine score is below `minScore`. The resource is still imported into the configured fallback category such as `__INBOX__`.

**Infrastructure failure** includes conditions such as:

- embedder HTTP failure or timeout;
- malformed embedding response;
- embedding dimension mismatch;
- reranker failure when reranking is required;
- malformed reranker response;
- missing/invalid taxonomy;
- missing/non-routeable fallback key;
- corrupt cache that cannot be rebuilt;
- an internally selected category that is not part of the validated taxonomy.

Infrastructure failure is fail-closed: the plugin does **not** call OpenViking `add_resource`. The tool reports the routing failure and the plugin emits a warning so the model service or configuration can be repaired instead of silently filling the inbox with hidden failures.

### Category embedding cache

Category descriptions are embedded once and cached per agent. Cache correctness is based on:

- canonical taxonomy SHA-256;
- embedding model identity (`model + baseUrl + endpointPath`);
- optional `embedding.cacheKey`;
- configured embedding dimensions;
- cache schema version;
- exact routeable category-key set.

The cache is not trusted merely because its timestamp looks recent. A stale, malformed, wrong-model, wrong-dimension, or incomplete cache is rebuilt.

Cache files are written through a temporary file and atomic rename with private `0600` file mode on POSIX systems. Prepared vectors remain in memory for the running plugin process.

Taxonomy v1 is **restart-only**: edit an agent YAML file, then restart the gateway. On restart the taxonomy hash is compared with the cache; changed semantic routing data triggers a rebuild.

The first startup after a new taxonomy, model, dimensions, or cache key may therefore take longer than a normal routed resource request.

### Routing diagnostics

Two complementary diagnostics are available.

Per-agent JSONL audit is enabled by default when resource routing is enabled. By default it stores hashes rather than raw provenance:

- timestamp and agent ID;
- source SHA-256;
- summary SHA-256;
- taxonomy hash and embedding model identity;
- cosine candidates and scores;
- whether reranking ran and its candidate scores;
- final category and fallback reason;
- embedding/reranker/total latency;
- success or routing error.

Raw summary preview is opt-in through `audit.includeSummaryPreview=true` and is bounded by `summaryPreviewChars`. On POSIX, the audit writer enforces `0600` even when appending to a pre-existing file that had broader permissions.

`resourceRouting.logDecisions=true` additionally writes one compact decision line through the normal OpenClaw plugin logger. It contains category keys, scores, fallback/reranker state, and timing, but not source paths, summary text, or API keys.

Routing infrastructure failures are warning-logged even when `logDecisions=false`.

### `create_parent`

OpenViking 0.4.12 supports `parent` with `create_parent=true`. Automatic routing and explicit semantic category routing use this so a taxonomy path such as:

```text
viking://resources/projects/openclaw/openviking
```

can be created by OpenViking when its directories do not exist yet. OpenViking's own directory creation path creates missing parent directories before the requested target, so nested taxonomy branches do not require the plugin to create one directory at a time.

The plugin does not create folders in Qdrant or manipulate vectors directly.

## `add_resource`

The agent-visible tool remains gated by `enableAddResourceTool`.

When resource routing is disabled, its historical behavior remains active. `create_parent` is the only additive field added to the agent-visible import surface for OpenViking 0.4.12 parent-creation support.

When routing is enabled, additional parameters are exposed:

| Parameter | Required | Description |
| --- | --- | --- |
| `source` | Yes | Local path, media attachment path, directory, public URL, or Git URL. |
| `to` | No | Exact target Viking URI. Mutually exclusive with `parent`; skips category/automatic routing. |
| `parent` | No | Exact parent Viking URI. Mutually exclusive with `to`; skips category/automatic routing. |
| `category` | No | Exact semantic key already present in the current agent taxonomy. |
| `summary` | Automatic only | Concise semantic content/purpose summary. Required only when no explicit destination/category is supplied. |
| `create_parent` | No | Create an explicitly supplied parent if missing. Automatic/category routing sets it internally. |
| `reason` | No | OpenViking reason/note. Not the routing summary. |
| `instruction` | No | OpenViking semantic-processing instruction. |
| `wait` | No | Wait for processing completion. |
| `timeout` | No | Timeout in seconds when `wait=true`. |

The `source` field remains the same top-level input used by existing OpenClaw/agent-permissions local-path authorization. Resource routing runs after that permission boundary and does not make a protected local path readable merely because `add_resource` itself is approved.

OpenViking itself decides how an imported source becomes a resource tree. Large Markdown documents, directories, repositories, web collections, and other sources may produce multiple children and semantic artifacts below the selected parent. A taxonomy destination directory may simultaneously contain directly imported resources and nested taxonomy/resource directories.

OpenViking generates resource semantic artifacts such as `.abstract.md` and `.overview.md` during its own semantic-processing stage. The router does not fabricate those fields, and it does not copy `summary` into `reason` or `instruction`.

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

It refuses the root itself, memories/sessions/skills/other namespaces, empty path segments, raw `.`/`..`, raw backslash separators, and ambiguous raw `?` suffixes.

The validator intentionally does not percent-decode Viking URI path components because OpenViking 0.4.12 treats those percent sequences as literal path data.

To clear all resources, list `viking://resources` first and remove its top-level children individually.

### Recursive deletion and consistency

`recursive` defaults to `false`. A non-empty directory therefore requires `recursive=true`; the plugin does not silently promote a failed non-recursive request.

The agent-facing tool defaults `wait` to `true`. OpenViking remains responsible for filesystem deletion, vector-index cleanup, resource-memory reference cleanup, and semantic refresh.

Known semantic states on the tested server are:

- `complete`: waited semantic refresh completed;
- `queued`: consistency work is still pending;
- `failed`: the resource was removed but semantic refresh reported a failure.

The plugin performs no blind retry for `queued` or `failed` and never deletes Qdrant records itself.

## Tool groups

`remove_resource` belongs to:

```text
resource_manage
```

The import group remains:

```text
import = add_resource, add_skill
```

This keeps destructive resource management separate from ingestion.

## Agent attribution diagnostics

The plugin resolves the agent from OpenClaw context/session identity and selects that agent's OpenViking client/API key.

If attribution fails, the request uses the dedicated system OpenViking account. It is never silently assigned to another configured agent.

Existing tenant-routing diagnostics can be enabled with:

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

## Post-start checks

After installing or updating the plugin:

1. confirm per-agent credentials loaded;
2. confirm the `openviking` context engine is active;
3. confirm normal recall still works for existing data;
4. if resource routing is enabled, confirm every configured agent reports a taxonomy/cache initialization result;
5. import a disposable resource with automatic routing and inspect its actual `root_uri`/parent in OpenViking;
6. verify a second agent cannot list/search/read that first agent's resource;
7. test a semantically uncertain summary and confirm it is imported into the configured inbox;
8. stop or misconfigure the routing model endpoint and confirm the import is blocked rather than sent to inbox;
9. verify explicit `to`, explicit `parent`, and explicit `category` each bypass automatic classification as documented;
10. verify `remove_resource` still requires the external approval policy expected by the OpenClaw deployment and that the OpenViking root cannot be deleted.

Useful narrow startup log check:

```bash
grep -aE 'openviking: (per-agent credentials loaded|resource routing ready|resource routing unavailable|resource routing failed)' /tmp/openclaw/openclaw-$(date +%F).log | tail -n 30
```

## Updating an existing linked installation

For an existing checkout:

```bash
npm ci
npm run verify
npm run typecheck
```

Rebuild and restart the OpenClaw gateway so it loads the new `dist/` files.

For production replacement, keep the previous working source directory and existing agent-key file intact until the new checkout has passed startup and smoke checks. The release is designed so `resourceRouting.enabled=false` preserves the historical resource-import path.

## Rollback

Use a normal Git rollback rather than manipulating OpenViking/Qdrant data.

When this feature is squash-merged, the resource-routing release is represented by one commit in `main`, so it can be reverted with one normal `git revert <release-commit>` if necessary. Existing OpenViking resources and vectors do not need to be deleted to roll back plugin code.

For an immediate deployment rollback, point the linked plugin back at the previously verified checkout, rebuild if required, and restart the gateway.

## Minimal tool profiles

When OpenClaw uses a restrictive tool profile, plugin tools must also be allowed by the relevant OpenClaw tool policy. Enabling a tool in this plugin does not override OpenClaw's own tool, filesystem, local-input, or sandbox permissions.

## License

MIT, matching the upstream OpenViking OpenClaw plugin.
