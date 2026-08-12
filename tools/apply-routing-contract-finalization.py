#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


def replace_regex_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one regex match, got {count}")
    return updated


# 1. Expose the parsed summary-language policy through ResourceRoutingService so
# the agent tool can enforce language without knowing config internals.
path = ROOT / "routing/resource-routing-service.ts"
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''  get enabled(): boolean {
    return this.#config.enabled;
  }
''',
    '''  get enabled(): boolean {
    return this.#config.enabled;
  }

  get summaryLanguage(): ParsedResourceRoutingConfig["summaryLanguage"] {
    return this.#config.summaryLanguage;
  }
''',
    "resource routing summaryLanguage getter",
)
path.write_text(text, encoding="utf-8")


# 2. Make the agent tool language-aware and restore provenance as a first-class
# semantic discriminator. The low-level/manual interfaces remain untouched.
path = ROOT / "plugin/openviking-import-tools.ts"
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''    "enabled" | "resolveCategoryOrFallback" | "routeAutomatic"
''',
    '''    "enabled" | "summaryLanguage" | "resolveCategoryOrFallback" | "routeAutomatic"
''',
    "import-tool routing dependency",
)
text = replace_once(
    text,
    '''export function registerOpenVikingImportTools(deps: OpenVikingImportToolsDeps): void {
  if (deps.enableAddResourceTool) {
''',
    '''export function registerOpenVikingImportTools(deps: OpenVikingImportToolsDeps): void {
  const requireRussianSummary = deps.resourceRouting?.summaryLanguage === "ru";
  const summaryLanguageGuidance = requireRussianSummary
    ? "Write the summary in Russian even when the source material is in another language; preserve product names, commands, code identifiers, protocols, and other technical terms when useful. "
    : "Write the summary in the natural language appropriate for the configured taxonomy; preserve product names, commands, code identifiers, protocols, and other technical terms when useful. ";
  const summaryParameterGuidance = requireRussianSummary
    ? "Required for automatic routing: one short Russian sentence based on known or inspected content, describing what the resource is about and what it is useful for. Technical product names, commands, protocols and code identifiers may remain in their natural form. When provenance or container form defines the resource type, state it naturally."
    : "Required for automatic routing: one short sentence based on known or inspected content, describing what the resource is about and what it is useful for. When provenance or container form defines the resource type, state it naturally.";

  if (deps.enableAddResourceTool) {
''',
    "import-tool language guidance setup",
)
text = replace_once(
    text,
    '''          "When automatic resource routing is enabled and category is omitted, you MUST provide summary in Russian: one short sentence describing the actual semantic content and purpose of the resource. Write the summary in Russian even when the source material is in another language; preserve product names, commands, code identifiers, protocols, and other technical terms when useful. Inspect or read enough of the resource to understand it unless its contents are already established in the conversation; never guess from its filename or path. " +
          "Use category only as an explicit override with an existing full taxonomy path such as code/source/javascript, or a stable semantic key for compatibility. Never invent category paths, keys, or resource URIs. Unknown, ambiguous, or organizational category selectors are routed to the configured fallback inbox rather than creating new paths. " +
''',
    '''          "When automatic resource routing is enabled and category is omitted, you MUST provide summary: one short sentence describing the actual semantic content and purpose of the resource. " +
          summaryLanguageGuidance +
          "Inspect or read enough of the resource to understand it unless its contents are already established in the conversation; never guess from its filename or path. When provenance or container form defines the semantic type, state it naturally in the summary, for example a saved web article/page, batch scraping or crawling result, email/newsletter, exported chat or forum history, spoken transcript, machine log, database dump, backup/archive bundle, or screenshot. Do not copy raw filename, path, MIME type, storage URI, or unrelated metadata into the semantic summary. " +
          "Use category only as an explicit override with an existing full taxonomy path such as code/source/javascript, or a stable semantic key for compatibility. Never invent category paths, keys, or resource URIs. Unknown, ambiguous, or organizational category selectors are routed to the configured fallback inbox rather than creating new paths. " +
''',
    "import-tool automatic routing guidance",
)
text = replace_once(
    text,
    '''          summary: Type.Optional(Type.String({
            description: "Required for automatic routing: one short Russian sentence based on known or inspected content, describing what the resource is about and what it is useful for. Technical product names, commands, protocols and code identifiers may remain in their natural form.",
          })),
''',
    '''          summary: Type.Optional(Type.String({
            description: summaryParameterGuidance,
          })),
''',
    "import-tool summary parameter guidance",
)
text = replace_once(
    text,
    '''            if (!summary) {
              return rejectedResourceImport(
                "Automatic resource routing requires `summary`. Inspect or read enough of the resource to understand its actual content, then describe in one short Russian sentence what it is about and what it is useful for. Do not guess from or merely repeat its filename, path, MIME type, or storage location.",
                { routing: "automatic", source },
              );
            }
            if (!isRussianSemanticSummary(summary)) {
              return rejectedResourceImport(
                "Automatic resource routing requires a genuinely Russian semantic `summary`, not an English sentence with a token Cyrillic character. Rewrite the content-and-purpose summary in Russian; technical product names, commands, protocols and code identifiers may remain in their original form.",
                { routing: "automatic", source, summaryLanguage: "ru" },
              );
            }
''',
    '''            if (!summary) {
              return rejectedResourceImport(
                requireRussianSummary
                  ? "Automatic resource routing requires `summary`. Inspect or read enough of the resource to understand its actual content, then describe in one short Russian sentence what it is about and what it is useful for. When provenance or container form defines the semantic type, state it naturally. Do not guess from or merely repeat filename, path, MIME type, storage location, or unrelated metadata."
                  : "Automatic resource routing requires `summary`. Inspect or read enough of the resource to understand its actual content, then describe in one short sentence what it is about and what it is useful for. When provenance or container form defines the semantic type, state it naturally. Do not guess from or merely repeat filename, path, MIME type, storage location, or unrelated metadata.",
                { routing: "automatic", source },
              );
            }
            if (requireRussianSummary && !isRussianSemanticSummary(summary)) {
              return rejectedResourceImport(
                "Automatic resource routing is configured with summaryLanguage=ru and requires a genuinely Russian semantic `summary`, not an English sentence with a token Cyrillic character. Rewrite the content-and-purpose summary in Russian; technical product names, commands, protocols and code identifiers may remain in their original form.",
                { routing: "automatic", source, summaryLanguage: "ru" },
              );
            }
''',
    "import-tool runtime language validation",
)
path.write_text(text, encoding="utf-8")


# 3. Replace the add_resource skill section with the actual minimal agent contract.
path = ROOT / "skills/openviking-context-database/SKILL.md"
text = path.read_text(encoding="utf-8")
start = text.index("### `add_resource`")
end = text.index("### `add_skill`", start)
section = '''### `add_resource`

Import resources into the validated `viking://resources/...` taxonomy. This agent tool is disabled by default and should be used only when the user explicitly asks to import, add, upload, save, or index a resource. Never call it merely to improve search or retrieval.

The agent-facing contract is intentionally minimal:

| Parameter | Required | Description |
|---|---|---|
| `source` | Yes | Local path, OpenClaw media attachment path, directory path, public URL, or Git URL. |
| `summary` | Automatic routing only | One short semantic sentence based on known/inspected content: what the resource contains and what it is useful for. Obey the configured `resourceRouting.summaryLanguage`; with `ru`, write a genuinely Russian sentence while preserving technical names and identifiers where useful. |
| `category` | No | Explicit override using an existing full taxonomy path such as `code/source/javascript`; stable semantic keys remain accepted for compatibility. |

When `category` is omitted, inspect/read enough of the resource to understand its actual content before writing `summary`. Never infer content from filename/path alone.

When provenance or container form defines the semantic resource type, state it naturally in `summary`. Examples: saved web article/page, batch scraping or crawling result, email/newsletter, exported chat/forum history, spoken transcript, machine log, database dump, backup/archive bundle, or screenshot. Do not copy raw filename, path, MIME type, storage URI, or unrelated metadata into the semantic summary.

Explicit category selection is deterministic and model-free. The plugin accepts only categories from the validated taxonomy. Unknown, ambiguous, or organizational selectors are sent to the configured fallback inbox; they never create a new arbitrary path.

Automatic semantic uncertainty below the configured confidence threshold also goes to fallback. Routing infrastructure failures remain fail-closed and the resource is not imported.

The agent tool deliberately does **not** expose arbitrary `to`/`parent` URIs, `create_parent`, `reason`, `instruction`, parser filters, strictness switches, structure switches, watch controls, tags, or other low-level connector arguments. Those remain available through lower-level/manual interfaces where a human can choose them deliberately.

The agent tool always submits the accepted resource import with `wait=false`. If a mutating request loses its HTTP response, inspect OpenViking state before any deliberate retry; never repeat the same import automatically after an outcome-unknown result.

'''
text = text[:start] + section + text[end:]
path.write_text(text, encoding="utf-8")


# 4. Add summaryLanguage to the OpenClaw manifest schema without changing runtime defaults.
path = ROOT / "openclaw.plugin.json"
manifest = json.loads(path.read_text(encoding="utf-8"))
routing = manifest["configSchema"]["properties"]["resourceRouting"]
props = routing["properties"]
if "summaryLanguage" in props:
    raise SystemExit("manifest summaryLanguage already exists; refusing a second application")
new_props = {}
for key, value in props.items():
    new_props[key] = value
    if key == "semanticInputTemplate":
        new_props["summaryLanguage"] = {
            "type": "string",
            "enum": ["any", "ru"],
            "default": "any",
            "description": "Optional automatic-summary language policy. Use ru for a Russian taxonomy; any leaves language unrestricted."
        }
routing["properties"] = new_props
path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# 5. Align the manifest contract test.
path = ROOT / "tests/resource-routing-manifest.test.ts"
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''      "semanticInputTemplate",
      "embedding",
''',
    '''      "semanticInputTemplate",
      "summaryLanguage",
      "embedding",
''',
    "manifest property expectation",
)
text = replace_once(
    text,
    '''  it("keeps embedding dimensions separate from the reranker schema", () => {
''',
    '''  it("exposes the optional summary language policy", () => {
    const routing = manifest.configSchema?.properties?.resourceRouting as {
      properties?: Record<string, { enum?: string[]; default?: unknown }>;
    } | undefined;
    expect(routing?.properties?.summaryLanguage?.enum).toEqual(["any", "ru"]);
    expect(routing?.properties?.summaryLanguage?.default).toBe("any");
  });

  it("keeps embedding dimensions separate from the reranker schema", () => {
''',
    "manifest summary language test",
)
path.write_text(text, encoding="utf-8")


# 6. Make add_resource tests explicitly model the configured language instead of
# relying on a global Russian assumption. Also pin provenance wording.
path = ROOT / "tests/add-resource-routing-tool.test.ts"
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''  explicitFallback?: boolean;
} = {}) {
''',
    '''  explicitFallback?: boolean;
  summaryLanguage?: "any" | "ru";
} = {}) {
''',
    "test setup summary language option",
)
text = replace_once(
    text,
    '''    resourceRouting: {
      enabled: options.routingEnabled ?? true,
      resolveCategoryOrFallback,
      routeAutomatic,
    },
''',
    '''    resourceRouting: {
      enabled: options.routingEnabled ?? true,
      summaryLanguage: options.summaryLanguage ?? "ru",
      resolveCategoryOrFallback,
      routeAutomatic,
    },
''',
    "test routing summary language fixture",
)
text = replace_once(
    text,
    '''  it("routes a Russian summary automatically and forwards only a trusted parent", async () => {
''',
    '''  it("allows an unrestricted-language taxonomy to route a non-Russian summary", async () => {
    const { factories, routeAutomatic } = setup({ summaryLanguage: "any" });
    const summary = "A practical guide to configuring OpenClaw services.";
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      summary,
    });
    expect(routeAutomatic).toHaveBeenCalledWith(expect.objectContaining({ summary }));
  });

  it("publishes provenance guidance for categories where source form is semantic", () => {
    const tool = setup().factories.get("add_resource")!({});
    expect(tool.description).toContain("batch scraping or crawling result");
    expect(tool.description).toContain("exported chat or forum history");
    expect(tool.description).toContain("database dump");
  });

  it("routes a Russian summary automatically and forwards only a trusted parent", async () => {
''',
    "test unrestricted language and provenance guidance",
)
path.write_text(text, encoding="utf-8")


# 7. Tighten README routing prose without duplicating the full architecture doc.
path = ROOT / "README.md"
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''- **Optional configurable resource routing** (`resourceRouting`) — routes `add_resource` into a per-agent YAML taxonomy with local BGE-M3 embeddings, conditional BGE reranking, deterministic fallback, per-agent cache, and JSONL audit. Explicit `to` / `parent` / `category` still win. See [`docs/resource-routing.md`](docs/resource-routing.md)
''',
    '''- **Optional configurable resource routing** (`resourceRouting`) — routes agent `add_resource` imports through a validated per-agent YAML taxonomy with ancestry-aware category embeddings, conditional reranking, fallback excluded from semantic ranking, per-agent atomic cache, and JSONL audit. The agent contract is `source + summary + optional category path/key`; arbitrary target URIs remain manual-only. See [`docs/resource-routing.md`](docs/resource-routing.md)
''',
    "README routing feature bullet",
)
text = replace_once(
    text,
    '''This repository also ships a starter taxonomy at `routing/default-resource-taxonomy.yaml` plus a local benchmark/probe command:

```bash
npm run routing:probe -- --agent main --cases /path/to/cases.json --output /tmp/routing-probe.json
```

The probe is read-only: it requires a valid existing category cache, calls the configured embedding/reranker services, and never imports/moves/deletes OpenViking resources.
''',
    '''This repository also ships a generic starter taxonomy at `routing/default-resource-taxonomy.yaml`, reviewed Russian calibration examples under `examples/`, a zero-model-call taxonomy audit, and a read-only production-equivalent probe:

```bash
npm run routing:audit -- --agent main --language ru
npm run routing:probe -- --agent main --cases /path/to/routing-cases.ru.json --output /tmp/routing-probe.json
```

The audit never calls models. The probe requires a valid existing semantic-category cache, calls the configured embedding/reranker services, and never imports, moves, or deletes OpenViking resources.
''',
    "README routing tools section",
)
text = replace_once(
    text,
    '''- configurable resource routing with local BGE embeddings/reranking, per-agent taxonomy/cache/audit, explicit-category bypass, and deterministic fallback;
''',
    '''- configurable resource routing with ancestry-aware local BGE embeddings/reranking, fallback excluded from semantic ranking, per-agent taxonomy/cache/audit, deterministic explicit path/key selection, and fallback-safe bad-selector handling;
''',
    "README changes-from-upstream routing bullet",
)
path.write_text(text, encoding="utf-8")

print("Applied final routing contract synchronization")
print("  resource-routing service: summaryLanguage getter")
print("  agent add_resource: language-aware summary + provenance + minimal contract")
print("  skill: final source/summary/category contract")
print("  manifest: summaryLanguage any|ru")
print("  tests: manifest + language + provenance")
print("  README: final routing architecture/tools wording")
