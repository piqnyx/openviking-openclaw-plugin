# Configurable resource routing

This fork can route `add_resource` imports into an agent-specific OpenViking resource taxonomy without allowing a model to generate `viking://` URIs.

The router is intentionally deterministic at the trust boundary:

1. the OpenClaw agent supplies a short semantic `summary`;
2. BGE-M3 embeds that summary;
3. cosine similarity selects the configured top candidates from the validated taxonomy;
4. when the leading candidates are close enough, BGE-reranker-v2-m3 reranks only that candidate set;
5. plugin code accepts only a validated semantic category key and resolves it to a trusted `viking://resources/...` parent URI;
6. OpenViking performs the actual resource import with `create_parent=true` for category-based routing.

Neither the embedder nor the reranker can supply an arbitrary URI.

## Per-agent isolation

Resource routing follows the same account-per-agent model as the rest of this fork. Every configured agent has its own:

- OpenViking account/API key;
- `viking://resources` tree;
- taxonomy YAML file;
- taxonomy embedding cache;
- routing audit JSONL file.

The default file templates are:

```text
~/.openclaw/{agentId}.yaml
~/.openclaw/openviking/resource-routing-cache/{agentId}.json
~/.openclaw/openviking/resource-routing-audit/{agentId}.jsonl
```

For example, agents `main` and `igor` normally use:

```text
~/.openclaw/main.yaml
~/.openclaw/igor.yaml
```

Changing a taxonomy is a restart operation in the initial implementation. There is no filesystem watcher or hot reload.

## Default taxonomy

The repository ships a starter taxonomy at:

```text
routing/default-resource-taxonomy.yaml
```

It contains general-purpose branches for:

- projects;
- documents;
- code;
- web material;
- images, audio, and video;
- datasets and structured data;
- reference material;
- communications;
- operations;
- security;
- tests and fixtures;
- `__INBOX__` fallback.

The starter tree is intentionally uneven in depth. Taxonomies do not need identical depth across branches.

Copy the starter taxonomy to each agent's configured taxonomy path and customize it independently for that agent.

## Taxonomy schema

A taxonomy is YAML with `schemaVersion: 1`, one fallback semantic key, and an arbitrarily nested `categories` tree.

Example:

```yaml
schemaVersion: 1
fallback: inbox

categories:
  inbox:
    segment: __INBOX__
    description: >
      Resources that cannot be classified confidently into a more specific category.

  projects:
    segment: projects
    description: >
      Materials tied to a concrete project or implementation effort.
    children:
      project-openclaw:
        segment: openclaw
        description: >
          OpenClaw project material, configuration, implementation and operation.
        children:
          project-openviking:
            segment: openviking
            description: >
              OpenViking integration, memory, resources and routing work for OpenClaw.
```

Each mapping key such as `project-openviking` is a stable **semantic category key**. It is not an OpenViking URI and does not need to equal the visible directory segment.

For the example above the plugin compiles:

```text
semantic key: project-openviking
segment:      openviking
URI:          viking://resources/projects/openclaw/openviking
```

### Category fields

Each category supports:

| Field | Required | Meaning |
| --- | --- | --- |
| mapping key | yes | Globally unique semantic category key. |
| `segment` | yes | One safe `viking://resources` path segment. |
| `description` | yes | Human/semantic description embedded for routing. |
| `routeable` | no | Whether the category itself can receive resources. Defaults to `true`. |
| `children` | no | Nested child category mapping. |

A category with `routeable: false` is organizational only. Its routeable descendants are still candidates.

Semantic keys must be globally unique across the whole taxonomy, not merely unique among siblings.

The fallback key must exist and refer to a routeable category.

## Flat semantic candidate set

The YAML remains a tree for humans and for the final OpenViking directory structure, but classification is **not hierarchical**.

At load time the plugin flattens every routeable category into one candidate set. A query is compared directly with all routeable category embeddings. The router does not first choose a top-level branch and then descend one level at a time.

This avoids making an early wrong branch decision impossible to recover from.

## `add_resource` routing precedence

Routing precedence is strict:

1. explicit `to`;
2. explicit `parent`;
3. explicit semantic `category`;
4. automatic routing.

Explicit routing never invokes the embedding or reranker services.

`to`, `parent`, and `category` are mutually exclusive.

For an explicit semantic `category`, the model supplies only an existing semantic key. The plugin validates the key and resolves the URI itself.

## Automatic routing summary

Automatic routing requires `summary`.

The agent should inspect or read enough of the resource to understand its actual content unless that content is already established in the conversation. It must not guess from a filename or path.

The default semantic input is:

```text
{{summary}}
```

The tested baseline intentionally uses summary-only routing. Filename/path/MIME metadata is not automatically appended to the semantic query because earlier tests showed that technical metadata can pull routing toward irrelevant categories.

A good summary is one short sentence describing what the resource is and what it is useful for. When provenance is semantically part of the resource type, it should be stated naturally, for example `online technical article`, `email thread`, `meeting transcript`, or `terminal screenshot`. Do not put raw paths, storage locations, or MIME strings into the summary.

If automatic routing is required and `summary` is missing or blank, `add_resource` rejects the call before contacting a model or OpenViking and tells the agent to inspect the resource, provide a semantic summary, and retry.

## Configurable semantic input template

`semanticInputTemplate` defaults to:

```text
{{summary}}
```

Advanced deployments can explicitly include additional fields:

```text
{{summary}}
Source kind: {{sourceKind}}
```

Supported placeholders are:

```text
summary
filename
extension
mimeType
sourceKind
source
reason
instruction
agentId
```

`{{summary}}` is mandatory even in a customized template.

Changing the default summary-only input should be treated as a routing-model change and calibrated on real resources before deployment.

## Plugin configuration

All routing mechanism settings live inside the existing OpenViking plugin configuration under `resourceRouting`.

Example:

```jsonc
{
  "plugins": {
    "entries": {
      "openviking": {
        "config": {
          "resourceRouting": {
            "enabled": true,
            "taxonomyFile": "/home/openclaw/.openclaw/{agentId}.yaml",
            "cacheFile": "/home/openclaw/.openclaw/openviking/resource-routing-cache/{agentId}.json",
            "semanticInputTemplate": "{{summary}}",

            "embedding": {
              "baseUrl": "http://127.0.0.1:18081",
              "model": "bge-m3",
              "dimensions": 1024,
              "timeoutMs": 3000,
              "apiKey": "${RESOURCE_EMBEDDING_API_KEY}",
              "headers": {
                "X-Custom-Header": "${RESOURCE_EMBEDDING_HEADER}"
              }
            },

            "reranker": {
              "baseUrl": "http://127.0.0.1:18080",
              "model": "bge-reranker-v2-m3",
              "timeoutMs": 3000,
              "apiKey": "${RESOURCE_RERANKER_API_KEY}",
              "headers": {}
            },

            "retrieval": {
              "topK": 2,
              "minScore": 0.64,
              "rerankBelowMargin": 0.06
            },

            "fallbackCategory": "inbox",
            "failurePolicy": "error",

            "audit": {
              "enabled": true,
              "file": "/home/openclaw/.openclaw/openviking/resource-routing-audit/{agentId}.jsonl",
              "summaryPreviewChars": 240
            }
          }
        }
      }
    }
  }
}
```

The local BGE URLs/models shown above are defaults, not hard requirements. A deployment can point at different compatible embedding/reranking services, models, authentication keys, and custom HTTP headers.

`apiKey` and header values support `${ENV_VAR}` expansion. Missing referenced environment variables are configuration errors.

### Routing defaults

| Setting | Default |
| --- | --- |
| `enabled` | `false` |
| embedding `baseUrl` | `http://127.0.0.1:18081` |
| embedding `model` | `bge-m3` |
| embedding `dimensions` | `1024` |
| reranker `baseUrl` | `http://127.0.0.1:18080` |
| reranker `model` | `bge-reranker-v2-m3` |
| HTTP timeout | `3000 ms` |
| `topK` | `2` |
| `minScore` | `0.64` |
| `rerankBelowMargin` | `0.06` |
| `fallbackCategory` | `inbox` |
| `failurePolicy` | `error` |
| `semanticInputTemplate` | `{{summary}}` |
| audit | enabled |

The tested `0.64` score and `0.06` margin are starting defaults, not universal model constants. Tune them from routing audit data collected on real resources.

## Embedding and reranking policy

For automatic routing:

1. embed `semanticInputTemplate` rendered from the resource summary;
2. calculate cosine similarity against cached category embeddings;
3. select the configured `topK` candidates;
4. if top-1 is below `minScore`, choose the configured fallback category;
5. otherwise compare top-1 and top-2 similarity;
6. if their difference is less than `rerankBelowMargin`, rerank the candidate set;
7. otherwise accept top-1;
8. resolve the final semantic key through the validated taxonomy;
9. import under the resulting trusted parent URI with `create_parent=true`.

The default `topK=2` was chosen because larger rerank candidate sets increased latency substantially in testing without enough quality benefit to justify using them by default.

## Semantic uncertainty versus infrastructure failure

These cases are deliberately different.

### Semantic uncertainty

If the embedding score is below `minScore`, automatic routing selects the configured fallback semantic category, normally `inbox`.

The resource import continues normally under that fallback category.

The fallback is not hard-coded to `inbox`: `fallbackCategory` selects the semantic key, and that key must exist in each agent taxonomy.

The visible directory name is controlled by the fallback category `segment`. The bundled taxonomy uses:

```text
__INBOX__
```

so uncertain resources stand out in the OpenViking panel.

A resource can also reach `inbox` through normal semantic classification. In that case the decision is not marked as threshold fallback; the audit distinguishes these cases.

### Infrastructure failure

Examples include:

- embedding service unavailable;
- reranker unavailable when policy requires reranking;
- HTTP timeout;
- malformed model response;
- embedding dimension mismatch;
- missing or invalid taxonomy;
- fallback key mismatch;
- invalid category result;
- corrupt cache that cannot be rebuilt.

Infrastructure failure is fail-closed:

```text
add_resource is NOT executed
```

The tool returns an explicit routing error and tells the agent/user to inspect the routing configuration/model services and retry.

Infrastructure failure is never silently converted into an INBOX import.

## Category embedding cache

Taxonomy category embeddings are not recomputed on every resource import or every restart.

The plugin computes a canonical taxonomy hash and stores a per-agent cache containing at least:

- cache schema version;
- taxonomy SHA-256;
- embedding model name;
- a secret-safe embedding endpoint identity hash;
- vector dimensions;
- category keys;
- vectors.

The endpoint identity hash includes routing-relevant endpoint identity such as base URL, model, API key value, and headers, but the secret values themselves are not stored in the cache.

A cache hit requires the taxonomy hash, embedding identity, dimensions, and category set to match.

When a cache is missing, stale, or safely recoverably corrupt, the plugin recomputes the taxonomy embeddings and atomically replaces the cache.

Cache writes use a temporary file, fsync, and atomic rename. Cache files are owner-only (`0600`).

The vectors are then retained in process memory for routing.

## Startup preload

When resource routing is enabled, the plugin preloads routing state for the agents listed in the existing per-agent OpenViking key map.

This validates each agent taxonomy and warms/rebuilds its category embedding cache during gateway startup instead of delaying the first automatic import.

A preload failure is logged per agent. It does not disable memory for other agents. Automatic routing for the affected agent remains fail-closed until the underlying taxonomy/model-service problem is fixed; a later route attempt can retry initialization.

## Routing audit

Routing audit is JSONL and enabled by default when routing is enabled.

Each successful decision records compact calibration evidence such as:

- timestamp;
- agent ID;
- source hash rather than raw source path;
- summary hash and bounded preview;
- taxonomy hash;
- embedding/reranker model names;
- embedding candidates and cosine scores;
- whether reranking was used;
- reranker scores when used;
- final category;
- threshold fallback reason when applicable;
- embedding/reranker/total decision latency;
- status/error code.

The audit is intentionally separate from the taxonomy and from OpenViking memory data. Its purpose is calibration and operational diagnosis.

Audit files are owner-only (`0600`).

## `create_parent`

OpenViking 0.4.12 supports `parent` plus `create_parent=true` for resource import.

This fork exposes that option through the OpenViking client and `add_resource` tool.

For automatic and semantic-category routing the plugin always supplies the trusted taxonomy parent and forces `create_parent=true`. OpenViking therefore creates missing taxonomy branches through its normal API.

For explicit `parent`, callers can choose `create_parent` themselves.

`create_parent` without a `parent` is rejected, and it cannot be combined with exact `to` routing.

No Qdrant data is manipulated directly by the plugin.

## Security boundary

Automatic routing treats model output as untrusted classification data.

The embedder and reranker operate only on a known candidate list. They do not generate URIs.

The plugin:

- validates the YAML taxonomy strictly;
- compiles semantic keys to trusted URIs itself;
- accepts only a category that exists in that validated taxonomy/candidate set;
- applies existing OpenViking URI/client validation;
- keeps existing per-agent API-key routing unchanged.

A model cannot use classification output to create `..`, another namespace, another agent's path, or arbitrary `viking://` data.

## Calibration baseline

The local deployment used during development runs:

- BGE-M3, 1024 dimensions, for embeddings;
- BGE-reranker-v2-m3 for conditional reranking;
- `topK=2`;
- `minScore=0.64`;
- `rerankBelowMargin=0.06`.

With the bundled 87-routeable-category taxonomy, a 27-case cross-branch calibration set produced:

```text
exact accuracy:  25/27 = 92.6%
branch accuracy: 26/27 = 96.3%
```

A correct parent/child branch result is tracked separately from exact-leaf accuracy because intermediate categories are intentionally routeable. The baseline is for initial deployment only; real audit data should drive later tuning.

The same server showed approximately:

```text
fresh taxonomy embedding startup: ~7 seconds
cached taxonomy startup:           ~20 ms
common embedding-only route:       tens to low hundreds of ms
conditional reranked route:        roughly 300-400 ms
```

These timings are deployment-specific, not API guarantees.

## Recommended rollout

For an existing OpenViking deployment with live data:

1. do not modify Qdrant directly;
2. install/build the plugin version containing resource routing;
3. copy/customize a taxonomy YAML for every isolated agent;
4. enable `resourceRouting` in the existing OpenViking plugin config;
5. restart the OpenClaw gateway;
6. confirm startup preload succeeds and cache files are created;
7. test `add_resource` first with a disposable resource;
8. verify the resulting tree in the OpenViking panel/`ov_list`;
9. test missing-summary guidance;
10. test semantic fallback to `__INBOX__`;
11. test an infrastructure failure separately and confirm no resource is imported;
12. keep existing `remove_resource` approval policy unchanged.

The router changes only placement of new resource imports. Enabling it does not rewrite or reindex existing OpenViking resources, memories, or Qdrant vectors.
