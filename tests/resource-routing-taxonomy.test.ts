import { describe, expect, it } from "vitest";

import {
  parseResourceTaxonomyYaml,
  resolveResourceTaxonomyCategory,
} from "../resource-routing/taxonomy.js";

const BASE = `
schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    description: Uncertain resources.
  projects:
    segment: projects
    description: Project material.
    routeable: false
    children:
      openclaw:
        segment: openclaw
        description: OpenClaw project material.
        children:
          openviking:
            segment: openviking
            description: OpenViking integration material.
`;

describe("resource taxonomy", () => {
  it("compiles arbitrary nested categories to trusted resource URIs", () => {
    const taxonomy = parseResourceTaxonomyYaml(BASE, "test.yaml");
    expect(taxonomy.byKey.get("inbox")?.uri).toBe("viking://resources/__INBOX__");
    expect(taxonomy.byKey.get("projects")).toMatchObject({
      routeable: false,
      uri: "viking://resources/projects",
    });
    expect(taxonomy.byKey.get("openviking")).toMatchObject({
      parentKey: "openclaw",
      ancestorKeys: ["projects", "openclaw"],
      pathSegments: ["projects", "openclaw", "openviking"],
      uri: "viking://resources/projects/openclaw/openviking",
      routeable: true,
    });
    expect(taxonomy.routeableCategories.map((category) => category.key)).toEqual([
      "inbox",
      "openclaw",
      "openviking",
    ]);
    expect(taxonomy.taxonomyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not impose an artificial taxonomy depth limit", () => {
    const yaml = `
schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    description: Inbox.
  l1:
    segment: l1
    description: L1.
    children:
      l2:
        segment: l2
        description: L2.
        children:
          l3:
            segment: l3
            description: L3.
            children:
              l4:
                segment: l4
                description: L4.
                children:
                  l5:
                    segment: l5
                    description: L5.
                    children:
                      l6:
                        segment: l6
                        description: L6.
`;
    expect(parseResourceTaxonomyYaml(yaml).byKey.get("l6")?.uri).toBe(
      "viking://resources/l1/l2/l3/l4/l5/l6",
    );
  });

  it("requires globally unique semantic keys", () => {
    const yaml = `
schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    description: Inbox.
  one:
    segment: one
    description: One.
    children:
      duplicate:
        segment: first
        description: First duplicate.
  two:
    segment: two
    description: Two.
    children:
      duplicate:
        segment: second
        description: Second duplicate.
`;
    expect(() => parseResourceTaxonomyYaml(yaml)).toThrow(/defined more than once/);
  });

  it("rejects two semantic categories that resolve to the same resource URI", () => {
    const yaml = `
schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    description: Inbox.
  alpha:
    segment: same
    description: Alpha.
  beta:
    segment: same
    description: Beta.
`;
    expect(() => parseResourceTaxonomyYaml(yaml)).toThrow(/resolve to the same URI/);
  });

  it.each(["../escape", "a/b", "a?b", "a%b", "has space", "\\\\windows"])(
    "rejects unsafe URI segment %s",
    (segment) => {
      const yaml = `
schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    description: Inbox.
  bad:
    segment: "${segment}"
    description: Bad.
`;
      expect(() => parseResourceTaxonomyYaml(yaml)).toThrow(/safe URI segment|invalid YAML/);
    },
  );

  it("resolves configured fallback or explicit category keys only when they exist and are routeable", () => {
    const taxonomy = parseResourceTaxonomyYaml(BASE);
    expect(resolveResourceTaxonomyCategory(taxonomy, "inbox").uri).toBe(
      "viking://resources/__INBOX__",
    );
    expect(() => resolveResourceTaxonomyCategory(taxonomy, "missing")).toThrow(/does not exist/);
    expect(() => resolveResourceTaxonomyCategory(taxonomy, "projects")).toThrow(/is not routeable/);
  });

  it("rejects unknown schema fields and duplicate YAML keys", () => {
    expect(() =>
      parseResourceTaxonomyYaml(
        BASE.replace(
          "description: Project material.",
          "description: Project material.\n    magic: true",
        ),
      ),
    ).toThrow(/unknown keys: magic/);

    const duplicate = `
schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    segment: duplicate
    description: Inbox.
`;
    expect(() => parseResourceTaxonomyYaml(duplicate)).toThrow(/invalid YAML/);
  });

  it("rejects aliases and anchors instead of allowing YAML object reuse", () => {
    const yaml = `
schemaVersion: 1
categories:
  inbox: &base
    segment: __INBOX__
    description: Inbox.
  copy: *base
`;
    expect(() => parseResourceTaxonomyYaml(yaml)).toThrow(/aliases\/anchors/);
  });

  it("hashes semantic taxonomy content rather than comments, whitespace, or mapping order", () => {
    const first = parseResourceTaxonomyYaml(BASE);
    const second = parseResourceTaxonomyYaml(`
# same taxonomy, reordered
schemaVersion: 1
categories:
  projects:
    description: Project material.
    routeable: false
    segment: projects
    children:
      openclaw:
        description: OpenClaw project material.
        segment: openclaw
        children:
          openviking:
            description: OpenViking integration material.
            segment: openviking
  inbox:
    description: Uncertain resources.
    segment: __INBOX__
`);
    expect(second.taxonomyHash).toBe(first.taxonomyHash);

    const changed = parseResourceTaxonomyYaml(
      BASE.replace("OpenViking integration material.", "Different semantic meaning."),
    );
    expect(changed.taxonomyHash).not.toBe(first.taxonomyHash);
  });
});
