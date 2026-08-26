import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RERANK, rerankMemories, type RerankCandidate } from "../recall-rerank.js";

const settings = { ...DEFAULT_RERANK, enabled: true, keep: 3, floor: 0.3 };

/** The live case: the answer sixth, three unrelated notes above it. */
const CANDIDATES: RerankCandidate[] = [
  { uri: "voice/key_panel_work.md", abstract: "Не смог уснуть и решил поработать над панелью ключей", score: 0.521 },
  { uri: "voice/adoration_line.md", abstract: "Отреагировал на заботливое пожелание спокойной ночи", score: 0.493 },
  { uri: "events/anton_stolen_lard.md", abstract: "Дед Антон наелся сала и обосрался", score: 0.457 },
  { uri: "assistant/eva_identity.md", abstract: "Живет с котами: рыжий кот Байт и трёхцветная кошка Кэш", score: 0.437 },
];

function answering(scores: number[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ results: scores.map((s, index) => ({ index, relevance_score: s })) }),
  })) as unknown as typeof fetch;
}

describe("reordering by reading", () => {
  it("lifts the answer over the noise it was buried under", async () => {
    const out = await rerankMemories("как там Байт?", CANDIDATES,
      settings, answering([0.02, 0.01, 0.01, 0.94]));
    expect(out.reason).toBe("reranked");
    expect(out.kept[0].uri).toBe("assistant/eva_identity.md");
    expect(out.kept[0].score).toBeCloseTo(0.94);
  });

  it("keeps only as many as asked for", async () => {
    const out = await rerankMemories("q", CANDIDATES, settings, answering([0.9, 0.8, 0.7, 0.6]));
    expect(out.kept).toHaveLength(3);
  });

  it("says nothing at all when nothing answers the question", async () => {
    // The graph plugin's rule, and the right one: an unrelated memory in the
    // context is worse than an empty one, because the model will weave it in.
    const out = await rerankMemories("как там Байт?", CANDIDATES,
      settings, answering([0.05, 0.04, 0.03, 0.02]));
    expect(out.reason).toBe("below-floor");
    expect(out.kept).toEqual([]);
    expect(out.best).toBeCloseTo(0.05);
  });

  it("falls back to the search order when the reranker is unreachable", async () => {
    const dead = vi.fn(async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    const out = await rerankMemories("q", CANDIDATES, settings, dead);
    expect(out.reason).toBe("unavailable");
    expect(out.kept.map((k: RerankCandidate) => k.uri)).toEqual(CANDIDATES.slice(0, 3).map((c: RerankCandidate) => c.uri));
  });

  it("falls back on a refusal and on an empty answer too", async () => {
    const refusing = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch;
    expect((await rerankMemories("q", CANDIDATES, settings, refusing)).reason).toBe("unavailable");
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ results: [] }) })) as unknown as typeof fetch;
    expect((await rerankMemories("q", CANDIDATES, settings, empty)).reason).toBe("unavailable");
  });

  it("sends the text of a memory, not its address", async () => {
    let sent = "";
    const seen = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }) };
    }) as unknown as typeof fetch;
    await rerankMemories("q", CANDIDATES, settings, seen);
    const body = JSON.parse(sent);
    expect(body.documents[3]).toContain("Байт");
    expect(body.documents[3]).not.toContain("viking://");
  });

  it("does nothing when switched off, and nothing when there is nothing", async () => {
    const never = vi.fn() as unknown as typeof fetch;
    expect((await rerankMemories("q", CANDIDATES, DEFAULT_RERANK, never)).reason).toBe("disabled");
    expect((await rerankMemories("", CANDIDATES, settings, never)).reason).toBe("nothing-to-do");
    expect((await rerankMemories("q", [], settings, never)).kept).toEqual([]);
    expect(never).not.toHaveBeenCalled();
  });
});
