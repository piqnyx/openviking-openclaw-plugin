import { describe, expect, it, vi } from "vitest";

import { parseAddResourceCommandArgs } from "../plugin/openviking-command-args.js";
import { createOpenVikingImportRuntime } from "../plugin/openviking-import-runtime.js";

describe("/add-resource create-parent parity", () => {
  it("parses --create-parent only together with --parent", () => {
    expect(parseAddResourceCommandArgs(
      "/workspace/guide.md --parent viking://resources/docs --create-parent --wait",
    )).toMatchObject({
      source: "/workspace/guide.md",
      parent: "viking://resources/docs",
      createParent: true,
      wait: true,
    });

    expect(() => parseAddResourceCommandArgs(
      "/workspace/guide.md --create-parent",
    )).toThrow(/--create-parent requires --parent/);
  });

  it("forwards createParent through the manual import runtime", async () => {
    const addResource = vi.fn(async () => ({ status: "success" }));
    const runtime = createOpenVikingImportRuntime({
      getClient: vi.fn(async () => ({
        addResource,
        addSkill: vi.fn(),
      })),
    });

    await runtime.addResourceOpenViking({
      source: "/workspace/guide.md",
      parent: "viking://resources/docs",
      createParent: true,
    }, "main_peer");

    expect(addResource).toHaveBeenCalledWith(expect.objectContaining({
      pathOrUrl: "/workspace/guide.md",
      parent: "viking://resources/docs",
      createParent: true,
    }), "main_peer");
  });
});
