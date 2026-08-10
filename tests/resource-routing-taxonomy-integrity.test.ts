import { describe, expect, it } from "vitest";

import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";

describe("resource taxonomy destination integrity", () => {
  it("rejects different semantic keys that compile to the same trusted URI", () => {
    expect(() => parseResourceTaxonomy({
      schemaVersion: 1,
      categories: {
        docs: {
          segment: "documents",
          description: "Documents.",
          children: {
            reports: {
              segment: "reports",
              description: "Reports.",
            },
            "reports-alias": {
              segment: "reports",
              description: "An accidental duplicate destination.",
            },
          },
        },
      },
    })).toThrow(/duplicate destination URI/);
  });

  it("still allows the same segment name in different branches", () => {
    const taxonomy = parseResourceTaxonomy({
      schemaVersion: 1,
      categories: {
        documents: {
          segment: "documents",
          description: "Documents.",
          children: {
            "documents-reports": {
              segment: "reports",
              description: "General reports.",
            },
          },
        },
        security: {
          segment: "security",
          description: "Security.",
          children: {
            "security-reports": {
              segment: "reports",
              description: "Security reports.",
            },
          },
        },
      },
    });
    expect(taxonomy.byKey.get("documents-reports")?.uri).toBe("viking://resources/documents/reports");
    expect(taxonomy.byKey.get("security-reports")?.uri).toBe("viking://resources/security/reports");
  });
});
