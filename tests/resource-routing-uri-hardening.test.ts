import { describe, expect, it } from "vitest";

import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";

function withSegment(segment: string) {
  return {
    schemaVersion: 1,
    categories: {
      test: {
        segment,
        description: "Test category.",
      },
    },
  };
}

describe("trusted resource taxonomy URI segments", () => {
  it.each([
    "docs",
    "security-audits",
    "api.v2",
    "документы",
    "日本語",
    "данные_2026",
  ])("accepts server-compatible segment %s", (segment) => {
    expect(parseResourceTaxonomy(withSegment(segment)).byKey.get("test")?.segment).toBe(segment);
  });

  it.each([
    "with space",
    "fragment#x",
    "percent%2Fescape",
    "colon:name",
    "query?x",
    "slash/name",
    "back\\slash",
    "*INBOX*",
  ])("rejects non-server-safe segment %s", (segment) => {
    expect(() => parseResourceTaxonomy(withSegment(segment))).toThrow(/safe resource URI segment/);
  });

  it("rejects segments longer than OpenViking's 50-character semantic segment bound", () => {
    expect(() => parseResourceTaxonomy(withSegment("a".repeat(51)))).toThrow(/at most 50 characters/);
    expect(parseResourceTaxonomy(withSegment("я".repeat(50))).byKey.get("test")?.segment).toHaveLength(50);
  });
});
