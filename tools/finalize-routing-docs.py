#!/usr/bin/env python3
from pathlib import Path


def replace_section(path: Path, start_heading: str, end_heading: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    start = text.index(start_heading)
    end = text.index(end_heading, start)
    path.write_text(text[:start] + replacement + text[end:], encoding="utf-8")


README = Path("README.md")
README_SECTION = '''## Configurable resource routing

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

'''
replace_section(README, "## Configurable resource routing\n", "## Agent key file\n", README_SECTION)

DOC = Path("docs/resource-routing.md")
text = DOC.read_text(encoding="utf-8")
old_rows = "| `description` | yes | Semantic meaning of this taxonomy node. |\n| `routeable` | no | Whether the node can receive resources. Schema v1 defaults to `true`. |"
new_rows = "| `description` | yes | Positive semantic meaning of this taxonomy node. |\n| `distinguishFrom` | no | Boundary hints used by the reranker, never by the category embedding. |\n| `routeable` | no | Whether the node can receive resources. Schema v1 defaults to `true`. |"
if text.count(old_rows) != 1:
    raise SystemExit(f"docs category-field table match count={text.count(old_rows)}")
text = text.replace(old_rows, new_rows, 1)
DOC.write_text(text, encoding="utf-8")

SEMANTIC_BLOCK = '''## Ancestry-aware embedding and reranker texts

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

'''
replace_section(DOC, "## Ancestry-aware routing text\n", "## Flat semantic candidate set\n", SEMANTIC_BLOCK)

text = DOC.read_text(encoding="utf-8")
replacements = {
    "The ancestry-aware routing text supplies branch context while preserving the ability for a globally better leaf to beat a superficially similar leaf in another branch.":
        "The ancestry-aware `embeddingText` supplies branch context while preserving the ability for a globally better leaf to beat a superficially similar leaf in another branch.",
    "7. if their gap is below `rerankBelowMargin`, rerank the entire retained candidate set using the same ancestry-aware `routingText` documents;":
        "7. if their gap is below `rerankBelowMargin`, rerank the entire retained candidate set using boundary-aware `rerankText` documents;",
}
for old, new in replacements.items():
    if text.count(old) != 1:
        raise SystemExit(f"docs prose match count={text.count(old)} for {old!r}")
    text = text.replace(old, new, 1)
DOC.write_text(text, encoding="utf-8")

print("Final routing documentation synchronized")
