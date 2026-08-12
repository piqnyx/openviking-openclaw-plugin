import { describe, expect, it, vi } from "vitest";

import { createOpenVikingService } from "../plugin/openviking-services.js";

describe("createOpenVikingService", () => {
  it("starts resource routing preload asynchronously and only once", async () => {
    const healthCheck = vi.fn(async () => ({ status: "ok" }));
    const getClient = vi.fn(async () => ({ healthCheck }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let releasePreload!: () => void;
    const preloadGate = new Promise<void>((resolve) => {
      releasePreload = resolve;
    });
    const preloadResourceRouting = vi.fn(async () => {
      await preloadGate;
    });

    const service = createOpenVikingService({
      cfg: { baseUrl: "http://127.0.0.1:1933", targetUri: "viking://user/memories" },
      getClient,
      logger,
      recallTraceHttpRoutesRegistered: true,
      registerRecallTraceRoutes: vi.fn(() => false),
      preloadResourceRouting,
    });

    await service.start();
    expect(preloadResourceRouting).toHaveBeenCalledTimes(1);
    // start() must not wait for a cold routing cache to finish.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("openviking: initialized"));

    await service.start();
    expect(preloadResourceRouting).toHaveBeenCalledTimes(1);

    releasePreload();
    await preloadGate;
  });

  it("reports an asynchronous preload failure without rejecting service start", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const service = createOpenVikingService({
      cfg: { baseUrl: "http://127.0.0.1:1933", targetUri: "viking://user/memories" },
      getClient: async () => ({ healthCheck: async () => ({ status: "ok" }) }),
      logger,
      recallTraceHttpRoutesRegistered: false,
      registerRecallTraceRoutes: () => false,
      preloadResourceRouting: async () => {
        throw new Error("embedder offline");
      },
    });

    await expect(service.start()).resolves.toBeUndefined();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(
      "openviking: resource routing startup preload failed: embedder offline",
    );
  });
});
