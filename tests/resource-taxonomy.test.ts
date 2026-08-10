import { describe, expect, it } from "vitest";

import {
  listRouteableResourceCategories,
  parseResourceTaxonomy,
  parseResourceTaxonomyYaml,
  resolveResourceCategoryUri,
} from "../resource-routing/taxonomy.js";
import {
  defaultResourceRoutingAuditPath,
  defaultResourceRoutingCachePath,
  defaultResourceTaxonomyPath,
} from "../resource-routing/agent-paths.js";

function makeTaxonomy() {
  return parseResourceTaxonomy({
    schemaVersion: 1,
    fallback: "inbox",
    categories: {
      inbox: {
        segment: "__INBOX__",
        description: "Fallback resources.",
      },
      projects: {
        segment: "projects",
        description: "Project materials.",
        children: {
          "project-openviking": {
            segment: "openviking",
            description: "OpenViking integration materials.",
          },
        },
      },
      grouping: {
        segment: "grouping",
        description: "Organization only.",
        routeable: false,
        children: {
          leaf: {
            segment: "leaf",
            description: "A routeable leaf.",
          },
        },
      },
    },
  });
}

describe("resource taxonomy", () => {
  it("flattens arbitrary nesting and builds trusted URIs", () => {
    const taxonomy = makeTaxonomy();
    expect(resolveResourceCategoryUri(taxonomy, "project-openviking")).toBe(
      "viking://resources/projects/openviking",
    );
    expect(resolveResourceCategoryUri(taxonomy, "leaf")).toBe(
      "viking://resources/grouping/leaf",
    );
    expect(listRouteableResourceCategories(taxonomy).map((category) => category.key)).toEqual([
      "inbox",
      "projects",
      "project-openviking",
      "leaf",
    ]);
  });

  it("accepts YAML and preserves semantic keys separately from path segments", () => {
    const taxonomy = parseResourceTaxonomyYaml(`
      schemaVersion: 1
      fallback: inbox
      categories:
        inbox:
          segment: __INBOX__
          description: Fallback.
        semantic-security-audits:
          segment: audits
          description: Security audit reports.
    `);
    expect(resolveResourceCategoryUri(taxonomy, "semantic-security-audits")).toBe(
      "viking://resources/audits",
    );
  });

  it.each([
    [{ schemaVersion: 2, fallback: "inbox", categories: {} }, "schemaVersion"],
    [{ schemaVersion: 1, fallback: "missing", categories: { inbox: { segment: "inbox", description: "x" } } }, "does not exist"],
    [{ schemaVersion: 1, fallback: "inbox", categories: { inbox: { segment: "../x", description: "x" } } }, "safe resource URI segment"],
    [{ schemaVersion: 1, fallback: "inbox", categories: { inbox: { segment: "inbox", description: "x", routeable: false } } }, "must be routeable"],
  ])("rejects invalid taxonomy (%s)", (value, message) => {
    expect(() => parseResourceTaxonomy(value)).toThrow(message);
  });

  it("rejects duplicate YAML keys before taxonomy validation", () => {
    expect(() => parseResourceTaxonomyYaml(`
      schemaVersion: 1
      fallback: inbox
      categories:
        inbox:
          segment: inbox
          description: one
        inbox:
          segment: inbox2
          description: two
    `)).toThrow("YAML parse failed");
  });

  it("rejects selection of unknown or non-routeable categories", () => {
    const taxonomy = makeTaxonomy();
    expect(() => resolveResourceCategoryUri(taxonomy, "missing")).toThrow("unknown category");
    expect(() => resolveResourceCategoryUri(taxonomy, "grouping")).toThrow("non-routeable");
  });
});

describe("per-agent resource routing paths", () => {
  it("uses one taxonomy, cache and audit file per agent", () => {
    const home = "/srv/openclaw/.openclaw";
    expect(defaultResourceTaxonomyPath("main", home)).toBe("/srv/openclaw/.openclaw/main.yaml");
    expect(defaultResourceTaxonomyPath("igor", home)).toBe("/srv/openclaw/.openclaw/igor.yaml");
    expect(defaultResourceRoutingCachePath("main", home)).toBe(
      "/srv/openclaw/.openclaw/cache/openviking-resource-routing/main.json",
    );
    expect(defaultResourceRoutingAuditPath("igor", home)).toBe(
      "/srv/openclaw/.openclaw/logs/openviking-resource-routing/igor.jsonl",
    );
  });

  it("refuses unsafe agent ids before deriving filesystem paths", () => {
    expect(() => defaultResourceTaxonomyPath("../main", "/tmp/.openclaw")).toThrow("invalid agent id");
  });
});
