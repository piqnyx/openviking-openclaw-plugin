# Configurable resource routing

This fork can route agent-initiated `add_resource` imports into an agent-specific OpenViking resource taxonomy without allowing the model, embedder, or reranker to invent storage URIs.

The routing boundary is deliberately deterministic:

1. the agent inspects the resource and supplies a short semantic `summary`;
2. the configured embedding model embeds that summary;
3. cosine similarity compares it with cached **semantic category** embeddings;
4. the configured top candidates are reranked only when the top scores are close enough;
5. plugin code resolves the selected validated category to its trusted `viking://resources/...` URI;
6. a low-confidence classification goes to the configured fallback category;
7. OpenViking receives only the trusted parent URI and performs the asynchronous import.

The fallback is a writable destination, not a semantic candidate. Infrastructure failures are not converted into fallback imports.

## Per-agent isolation

Resource routing follows the same account-per-agent model as the rest of this fork. Every configured OpenClaw agent has its own:

- OpenViking account/API key;
- `viking://resources` tree;
- taxonomy YAML file;
- category embedding cache;
- routing audit JSONL file.

Typical file templates are:

```text
~/.openclaw/openviking/categories/{agentId}.yaml
~/.openclaw/openviking/resource-routing-cache/{agentId}.json
~/.openclaw/openviking/resource-routing-audit/{agentId}.jsonl
```

A `main` routing request never waits for an unrelated `igor` category cache to finish building. Router initialization is deduplicated per agent.

## Taxonomy schema

A taxonomy uses `schemaVersion: 1`, one fallback semantic key, and an arbitrarily nested `categories` tree.

```yaml
schemaVersion: 1
fallback: inbox

categories:
  inbox:
    segment: _INBOX
    description: Ресурсы, которые нельзя уверенно классифицировать автоматически.

  code:
    segment: code
    description: Исходный код и связанные с разработкой материалы.
    routeable: false
    children:
      code-source:
        segment: source
        description: Исходные тексты программ, разделённые по языкам.
        routeable: false
        children:
          code-source-javascript:
            segment: javascript
            description: Исходный код программных проектов на JavaScript и TypeScript.
```

Each YAML mapping key is a globally unique stable **semantic key**. A visible `segment` may repeat under different parents.

For the leaf above the compiler produces:

```text
key:         code-source-javascript
segment:     javascript
path:        code/source/javascript
uri:         viking://resources/code/source/javascript
parentKey:   code-source
```

The compiler maintains both `byKey` and `byPath` indexes. Two categories cannot resolve to the same URI. Repeated leaf names such as `code` are safe when their full paths differ.

### Category fields

| Field | Required | Meaning |
| --- | --- | --- |
| mapping key | yes | Globally unique stable semantic key. |
| `segment` | yes | One safe `viking://resources` path segment. |
| `description` | yes | Positive semantic meaning of this taxonomy node. |
| `distinguishFrom` | no | Boundary hints used by the reranker, never by the category embedding. |
| `routeable` | no | Whether the node can receive resources. Schema v1 defaults to `true`. |
| `children` | no | Nested child category mapping. |

For production taxonomies, organizational nodes should explicitly use `routeable: false`; semantic destinations should normally be leaves. The audit tool reports structural nodes that are accidentally writable.

The fallback key must exist and be routeable.

## Writable categories versus semantic categories

The compiled taxonomy deliberately separates two sets:

- `routeableCategories`: all validated destinations that may receive a resource, including fallback;
- `semanticCategories`: routeable categories eligible for embedding/cosine/reranking, **excluding fallback**.

This distinction is important. `_INBOX` is not a semantic topic and must never win cosine similarity as though “uncertain material” were ordinary content.

A taxonomy therefore needs at least one semantic category in addition to its fallback.

## Ancestry-aware embedding and reranker texts

A category embedding is not generated from the leaf description alone. The compiler builds two deterministic semantic documents for every category.

### `embeddingText`

`embeddingText` contains only positive semantic evidence:

1. the leaf `description`;
2. positive descriptions of all ancestors;
3. the exact full taxonomy path.

Conceptually:

```text
description: Исходный код программных проектов на JavaScript и TypeScript.
ancestors: code: Исходный код и связанные с разработкой материалы. > code/source: Исходные тексты программ, разделённые по языкам.
path: code/source/javascript
```

The cached category vector is generated from `embeddingText`.

### `distinguishFrom` and `rerankText`

Categories that are easy to confuse may declare boundary guidance separately:

```yaml
code-source-go:
  segment: go
  description: Исходный код программных проектов, сервисов и библиотек на Go.
  distinguishFrom:
    - Учебные и справочные материалы о языке относятся к docs/languages.
```

`distinguishFrom` is deliberately excluded from `embeddingText`. Contrastive phrases such as “not documentation” would otherwise add the competing topic to the bi-encoder vector and can make neighboring classes more similar.

For conditional reranking the compiler builds `rerankText` from `embeddingText` plus boundary hints. Boundary hints from structural ancestors are inherited, so a leaf receives relevant branch-level disambiguation without duplicating that prose into every leaf description.

The reranker therefore sees richer discrimination instructions only when cosine retrieval is ambiguous, while category embeddings remain positive and stable.

Changes to descriptions, `distinguishFrom`, ancestry, paths, routeability, or fallback change canonical taxonomy identity. A cache built for an incompatible taxonomy is rejected.

## Flat semantic candidate set

The YAML remains a tree for humans and for the OpenViking directory layout, but automatic classification is intentionally flat.

The query embedding is compared directly with every compiled `semanticCategory`. The router does not make an irreversible top-level branch decision and then descend the tree.

The ancestry-aware `embeddingText` supplies branch context while preserving the ability for a globally better leaf to beat a superficially similar leaf in another branch.

A hierarchical multi-stage classifier may be evaluated later if measurements justify its additional model calls and failure modes; it is not part of the current routing contract.

## Agent-facing `add_resource` contract

When `resourceRouting.enabled=true`, the agent-facing resource import tool is intentionally small:

```text
source
summary
category
```

`source` is required.

`summary` is required for automatic routing and omitted only when an explicit `category` override is supplied.

`category` is an optional explicit taxonomy selector. Prefer the full taxonomy path:

```text
code/source/javascript
```

Stable semantic keys such as `code-source-javascript` remain accepted for compatibility.

The agent-facing tool does **not** expose arbitrary `to` or `parent` URIs, `create_parent`, extraction instructions, parser filters, strictness controls, watch settings, or other low-level import knobs. Those remain available through lower-level/manual interfaces where a human can choose them deliberately.

### Explicit category behavior

An explicit selector is resolved only against the validated taxonomy.

- existing routeable path/key → import there;
- organizational path/key → fallback category;
- unknown path/key → fallback category;
- ambiguous selector → fallback category.

No unknown selector creates a new taxonomy path. The tool result reports the requested selector, selected category/path, whether fallback was used, and the fallback reason.

Explicit category resolution does not call the embedding or reranker services.

## Automatic routing summary

The default semantic input is summary-only:

```text
{{summary}}
```

The agent must inspect or read enough of the resource to understand its real content unless that content is already established in the conversation. It must not infer semantic content from filename or storage path alone.

A good summary is one short sentence describing **what the resource contains and what it is useful for**.

When provenance or container form defines the semantic type, state that fact naturally in the summary. Examples include:

- a saved web article or saved web page;
- a batch scraping/crawling result;
- an email message or delivered newsletter;
- an exported chat/forum history;
- a spoken-talk transcript;
- a machine log, database dump, backup, or archive bundle;
- a screenshot.

Do not copy raw filename, path, MIME type, storage URI, or unrelated technical metadata into the semantic summary.

This provenance rule matters because a local architecture document and scraped website documentation may contain nearly identical prose while belonging to different taxonomy branches.

## Summary language policy

`resourceRouting.summaryLanguage` controls language validation for automatic summaries:

```text
any   no language restriction; generic default
ru    require a genuinely Russian semantic summary
```

The default is `any` so the routing mechanism remains compatible with non-Russian taxonomies.

For a Russian taxonomy, configure:

```json
"summaryLanguage": "ru"
```

The Russian validator allows technical names and identifiers such as `OpenClaw`, `JavaScript`, `API`, commands, protocols, and model names, but rejects an English sentence containing only a token Cyrillic character.

Language validation applies to automatic routing only. It does not change taxonomy parsing or explicit category selection.

## Configurable semantic input template

`semanticInputTemplate` defaults to:

```text
{{summary}}
```

Advanced deployments may explicitly include additional fields, for example:

```text
{{summary}}
Source type: {{sourceKind}}
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

`{{summary}}` remains mandatory.

Changing the template changes query semantics and should be treated as a routing-model change requiring recalibration.

## Embedding and reranking policy

For automatic routing:

1. render the semantic input;
2. embed it once;
3. calculate cosine similarity against cached semantic-category vectors;
4. retain configured `topK` candidates;
5. if top-1 score is below `minScore`, choose fallback immediately;
6. otherwise compare top-1 and top-2 cosine scores;
7. if their gap is below `rerankBelowMargin`, rerank the entire retained candidate set using boundary-aware `rerankText` documents;
8. otherwise accept top-1;
9. resolve the selected key through the validated taxonomy;
10. import asynchronously under its trusted parent URI.

Fallback never appears in cosine or reranker candidates.

## Semantic uncertainty versus infrastructure failure

These states intentionally behave differently.

### Semantic uncertainty

If the best semantic candidate is below `minScore`, the plugin imports under the configured fallback category, normally `_INBOX`.

The decision is marked:

```text
fallback: true
fallbackReason: below_min_score
```

### Infrastructure failure

Examples include:

- embedding service unavailable;
- reranker unavailable when reranking is required;
- HTTP timeout;
- malformed model response;
- vector dimension mismatch;
- missing or invalid taxonomy;
- taxonomy/config fallback mismatch;
- corrupt cache that cannot be rebuilt.

Infrastructure failure is fail-closed:

```text
add_resource is NOT executed
```

A broken model service must not silently turn every resource into an inbox import.

## Category embedding cache

The cache is per agent and stores vectors only for `semanticCategories`.

A valid cache is tied to:

- cache schema version;
- canonical taxonomy hash;
- embedding model;
- secret-safe embedding endpoint identity;
- dimensions;
- exact ordered semantic-category key set.

The endpoint identity includes routing-relevant endpoint configuration but stores only its hash, not raw credentials.

### Cold-cache construction

A missing or stale cache is built **sequentially, one semantic category per embedding request**. This intentionally avoids sending a large taxonomy batch through one HTTP timeout on CPU-only local embedding services.

Nothing is persisted until every category succeeds. The completed cache is written owner-only and atomically.

A partial cache is never accepted.

### Taxonomy change operation

Treat taxonomy changes as maintenance:

1. install the changed plugin/taxonomy;
2. remove the affected agent cache file(s);
3. restart the OpenClaw gateway;
4. observe startup preload;
5. wait for `resource routing ready for agent <id>`;
6. verify the new cache with the audit/probe tools;
7. resume normal automatic imports.

The cache identity checks remain as a defensive backstop, but explicit cache deletion makes the maintenance intent obvious.

## Startup preload lifecycle

Resource routing preload is started from the OpenClaw gateway **service start lifecycle**, not directly from plugin registration.

This matters because OpenClaw may invoke plugin registration multiple times while constructing runtime surfaces. Expensive cold-cache work must not be duplicated for each registration pass.

The service has a one-shot preload guard. Agents are preloaded sequentially, while router promises remain deduplicated per agent.

Preload itself is asynchronous: gateway service startup is not blocked until the entire CPU embedding cache finishes. If an automatic route arrives during preload, it waits only for that agent's router initialization, not for unrelated agents.

A preload failure is logged per agent. Other agents continue working.

## Routing audit JSONL

A successful routing record can include:

- timestamp;
- agent ID;
- source hash rather than raw source path;
- summary hash and optional bounded preview;
- taxonomy hash;
- embedding/reranker model names;
- candidate key + full path + cosine score;
- reranker key + full path + score when used;
- final category;
- fallback and reason;
- model/total latency;
- status/error code.

Audit files are owner-only (`0600`).

`summaryPreviewChars=0` disables plaintext summary previews while retaining hashes and decision evidence. During calibration a bounded preview may be useful; after calibration privacy-sensitive deployments should consider setting it to zero.

## Read-only taxonomy audit

The repository provides:

```bash
npm run routing:audit -- --agent main --language ru
```

The taxonomy audit performs **zero model calls**. It reports structural/textual problems such as:

- total, routeable, semantic, and structural counts;
- fallback accidentally appearing in semantic ranking;
- writable structural parents;
- semantic non-leaf nodes;
- exact duplicate descriptions;
- repeated visible segments;
- unusually short descriptions;
- Russian-language violations when requested;
- lexically close semantic-category pairs.

If a valid cache already exists, the same command also reports the nearest category pairs by real cached embedding cosine similarity, still without making new model calls.

Repeated visible segments are informational rather than errors because full paths and semantic keys remain unique.

## Read-only routing probe

The routing probe executes the exact production query embedding, cosine and conditional reranking logic against an **existing valid cache** without importing, moving, or deleting OpenViking resources:

```bash
npm run routing:probe -- \
  --agent main \
  --cases /path/routing-cases.ru.json \
  --details mismatches
```

It reports:

- expected and selected category keys;
- selected full paths;
- cosine candidates and paths;
- reranker candidates and paths;
- fallback behavior;
- latency;
- aggregate accuracy.

Threshold sweeps are available with `--min-scores` and `--rerank-margins`.

Tune `minScore`, `topK`, and `rerankBelowMargin` only after the final taxonomy and clean category cache exist. Ancestry changes, fallback exclusion, or description edits change the embedding distribution and invalidate conclusions drawn from the previous cache.

## Russian routing examples

The repository packages reviewed Russian examples:

```text
examples/resource-taxonomy.ru.yaml
examples/routing-cases.ru.json
```

The taxonomy contains structural parents plus writable semantic leaves. The accompanying cases intentionally include cross-branch adversarial boundaries such as:

- benchmark code versus benchmark report;
- working research notes versus formal report;
- security audit report versus pentest evidence;
- active incident response versus completed postmortem;
- personal runtime Docker configuration versus repository Compose manifest;
- personal administrative shell script versus project shell source;
- YAML dataset versus application configuration;
- scraped web documentation versus ordinary local project documentation;
- single forum topic versus bulk forum-history export;
- SQL source versus database dump versus backup archive.

These examples are calibration material, not universal taxonomy doctrine.

## OpenViking directory descriptions

Taxonomy descriptions used by this router are local classifier metadata. They are not automatically identical to OpenViking directory `.abstract.md` metadata.

OpenViking 0.4.12 supports `POST /api/v1/fs/mkdir` with a `description`, which writes directory abstract metadata and vectorizes it. Synchronizing a taxonomy into OpenViking directory descriptions should therefore be a separate explicit maintenance operation, not a hidden side effect of every gateway start.

Do not manipulate OpenViking vector storage directly.

## Security boundary

The embedder and reranker receive only known semantic candidate documents. Neither can generate a destination URI.

The plugin:

- parses the YAML strictly;
- requires globally unique semantic keys;
- forbids unsafe path segments and URI collisions;
- compiles full paths and URIs itself;
- excludes fallback from semantic ranking;
- resolves explicit selectors only against the compiled taxonomy;
- converts bad explicit selectors to the configured fallback rather than creating arbitrary paths;
- preserves per-agent API-key isolation;
- keeps routing infrastructure failures fail-closed.

The agent cannot route a resource into `..`, another namespace, another agent's tree, or an invented `viking://` path through the category interface.

## Configuration example

```jsonc
{
  "resourceRouting": {
    "enabled": true,
    "taxonomyFile": "/home/openclaw/.openclaw/openviking/categories/{agentId}.yaml",
    "cacheFile": "/home/openclaw/.openclaw/openviking/resource-routing-cache/{agentId}.json",
    "semanticInputTemplate": "{{summary}}",
    "summaryLanguage": "ru",
    "embedding": {
      "baseUrl": "http://127.0.0.1:18081",
      "model": "bge-m3",
      "timeoutMs": 10000,
      "dimensions": 1024
    },
    "reranker": {
      "baseUrl": "http://127.0.0.1:18080",
      "model": "bge-reranker-v2-m3",
      "timeoutMs": 10000
    },
    "retrieval": {
      "topK": 3,
      "minScore": 0.57,
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
```

The values above are a deployment example, not universal thresholds. Calibrate the final taxonomy/cache before changing them.
