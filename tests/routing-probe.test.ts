import { describe, expect, it } from "vitest";

// The probe is intentionally plain ESM JavaScript so it can execute the tracked
// production dist directly without creating a second compiled routing implementation.
// @ts-expect-error The .mjs probe intentionally has no TypeScript declaration file.
import {
  buildProfiles,
  extractResourceRoutingConfig,
  normalizeCases,
  parseArgs,
  parseNumberList,
  rankProfileSummaries,
} from "../tools/routing-probe.mjs";

describe("routing probe", () => {
  it("extracts resourceRouting from the normal OpenClaw plugin config shape", () => {
    const routing = { enabled: true, fallbackCategory: "inbox" };
    expect(extractResourceRoutingConfig({
      plugins: {
        entries: {
          openviking: {
            config: { resourceRouting: routing },
          },
        },
      },
    })).toEqual({
      source: "plugins.entries.openviking.config.resourceRouting",
      value: routing,
    });
  });

  it("normalizes labeled cases and supports multiple acceptable categories", () => {
    expect(normalizeCases([
      {
        id: "ambiguous-guide",
        summary: "A practical step-by-step setup guide.",
        expected: ["docs-guides-tutorials", "docs-guides-howtos"],
      },
      {
        summary: "A source patch.",
        expected: "code-patches",
      },
    ])).toEqual([
      {
        id: "ambiguous-guide",
        summary: "A practical step-by-step setup guide.",
        expected: ["docs-guides-tutorials", "docs-guides-howtos"],
        note: undefined,
      },
      {
        id: "case-2",
        summary: "A source patch.",
        expected: ["code-patches"],
        note: undefined,
      },
    ]);
  });

  it("builds the cross-product of threshold grids", () => {
    expect(buildProfiles({
      retrieval: { topK: 3, minScore: 0.57, rerankBelowMargin: 0.06 },
    }, {
      minScores: [0.5, 0.6],
      rerankMargins: [0.03, 0.06],
    })).toEqual([
      { topK: 3, minScore: 0.5, rerankBelowMargin: 0.03 },
      { topK: 3, minScore: 0.5, rerankBelowMargin: 0.06 },
      { topK: 3, minScore: 0.6, rerankBelowMargin: 0.03 },
      { topK: 3, minScore: 0.6, rerankBelowMargin: 0.06 },
    ]);
  });

  it("parses numeric threshold lists strictly", () => {
    expect(parseNumberList("0.45,0.57,0.57,0.69", "threshold", -1, 1))
      .toEqual([0.45, 0.57, 0.69]);
    expect(() => parseNumberList("0.4,nope", "threshold", -1, 1)).toThrow(/threshold/);
  });

  it("parses a read-only batch invocation without requiring an output file", () => {
    const parsed = parseArgs([
      "--agent", "main",
      "--cases", "/tmp/cases.json",
      "--min-scores", "0.45,0.57,0.69",
      "--rerank-margins", "0.03,0.06",
      "--details", "none",
    ]);
    expect(parsed.agentId).toBe("main");
    expect(parsed.minScores).toEqual([0.45, 0.57, 0.69]);
    expect(parsed.rerankMargins).toEqual([0.03, 0.06]);
    expect(parsed.details).toBe("none");
  });

  it("ranks higher accuracy first and uses routing cost only as a tie-breaker", () => {
    const common = {
      topK: 3,
      cases: 10,
      labeled: 10,
      falseInbox: 0,
      missedInbox: 0,
      avgEmbeddingMs: 1,
      avgTotalMs: 1,
    };
    const ranked = rankProfileSummaries([
      { ...common, id: "a", minScore: 0.57, rerankBelowMargin: 0.06, correct: 9, wrong: 1, accuracy: 0.9, rerankerCount: 2 },
      { ...common, id: "b", minScore: 0.60, rerankBelowMargin: 0.03, correct: 10, wrong: 0, accuracy: 1, rerankerCount: 8 },
      { ...common, id: "c", minScore: 0.55, rerankBelowMargin: 0.03, correct: 10, wrong: 0, accuracy: 1, rerankerCount: 3 },
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });
});
