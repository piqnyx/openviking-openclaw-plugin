from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise SystemExit(f"{label}: expected exactly one anchor in {path}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "resource-routing/taxonomy.ts",
    r"const SEGMENT_RE = /^[^/\\?\0]+$/u;",
    r"const SEGMENT_RE = /^[\p{L}\p{N}\p{M}_.-]+$/u;",
    "taxonomy segment regex",
)

replace_once(
    "resource-routing/taxonomy.ts",
    '''function validateSegment(segment: string, label: string): void {
  if (segment === "." || segment === ".." || !SEGMENT_RE.test(segment)) {
    throw new Error(`${label} is not a safe resource URI segment`);
  }
  if (segment.trim() !== segment) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
}''',
    '''function validateSegment(segment: string, label: string): void {
  if (segment === "." || segment === ".." || !SEGMENT_RE.test(segment)) {
    throw new Error(`${label} is not a safe resource URI segment`);
  }
  if (Array.from(segment).length > 50) {
    throw new Error(`${label} must be at most 50 characters`);
  }
}''',
    "taxonomy segment length",
)

replace_once(
    "resource-routing/taxonomy.ts",
    '''  const categories: ResourceTaxonomyCategory[] = [];
  const byKey = new Map<string, ResourceTaxonomyCategory>();''',
    '''  const categories: ResourceTaxonomyCategory[] = [];
  const byKey = new Map<string, ResourceTaxonomyCategory>();
  const byUri = new Set<string>();''',
    "taxonomy URI set",
)

replace_once(
    "resource-routing/taxonomy.ts",
    '''    const routeable = parseRouteable(node.routeable, `resource taxonomy category ${key}.routeable`);
    const uri = `${parentUri}/${segment}`;

    const category: ResourceTaxonomyCategory = {''',
    '''    const routeable = parseRouteable(node.routeable, `resource taxonomy category ${key}.routeable`);
    const uri = `${parentUri}/${segment}`;
    if (byUri.has(uri)) {
      throw new Error(`resource taxonomy contains duplicate destination URI: ${uri}`);
    }
    byUri.add(uri);

    const category: ResourceTaxonomyCategory = {''',
    "taxonomy duplicate destination",
)

replace_once(
    "resource-routing/config.ts",
    '''  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`resourceRouting endpoint baseUrl must use http or https: ${value}`);
  }
  return value.replace(/\\/+$/, "");
}

function normalizeEndpointPath(value: string, label: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#")) {
    throw new Error(`${label} must be an absolute URL path without query or fragment`);
  }
  return value;
}''',
    '''  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`resourceRouting endpoint baseUrl must use http or https: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("resourceRouting endpoint baseUrl must not contain credentials; use apiKey or headers");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("resourceRouting endpoint baseUrl must not contain query or fragment");
  }
  return value.replace(/\\/+$/, "");
}

function normalizeEndpointPath(value: string, label: string): string {
  const segments = value.split("/");
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\\\") ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe absolute URL path without traversal, query, or fragment`);
  }
  return value;
}''',
    "endpoint URL hardening",
)

replace_once(
    "resource-routing/config.ts",
    '''function validatePathTemplate(value: string, label: string): string {
  if (!value.includes("{agentId}")) {
    throw new Error(`${label} must contain {agentId} so every isolated agent gets its own file`);
  }
  return value;
}''',
    '''function validatePathTemplate(value: string, label: string): string {
  if (!value.includes("{agentId}")) {
    throw new Error(`${label} must contain {agentId} so every isolated agent gets its own file`);
  }
  const first = resolveAgentScopedResourceRoutingPath(value, "routing-isolation-a");
  const second = resolveAgentScopedResourceRoutingPath(value, "routing-isolation-b");
  if (first === second) {
    throw new Error(`${label} must resolve to distinct paths for different agents`);
  }
  return value;
}''',
    "per-agent path isolation",
)

replace_once(
    "resource-routing/manager.ts",
    '''import {
  loadResourceTaxonomyFile,
  resolveResourceCategoryUri,
  type ResourceTaxonomy,
} from "./taxonomy.js";''',
    '''import {
  assertResourceRoutingFallbackCategory,
  loadResourceTaxonomyFile,
  resolveResourceCategoryUri,
  type ResourceTaxonomy,
} from "./taxonomy.js";''',
    "manager fallback import",
)

replace_once(
    "resource-routing/manager.ts",
    '''    const path = resolveAgentResourceRoutingPaths(this.config, agentId).taxonomyFile;
    const pending = this.loadTaxonomy(path);
    this.taxonomyPromises.set(agentId, pending);''',
    '''    const path = resolveAgentResourceRoutingPaths(this.config, agentId).taxonomyFile;
    const pending = this.loadTaxonomy(path).then((taxonomy) => {
      assertResourceRoutingFallbackCategory(taxonomy, this.config.fallbackCategory);
      return taxonomy;
    });
    this.taxonomyPromises.set(agentId, pending);''',
    "manager fallback validation",
)
