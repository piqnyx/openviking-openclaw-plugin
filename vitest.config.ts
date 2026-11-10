import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // The plugin's files (the catch-up bookmarks, PLAN-krug 7г) go to the gateway's state directory: never the
    // real one from a test.
    env: { OPENCLAW_STATE_DIR: path.join(tmpdir(), "openviking-plugin-tests-state") },
  },
});
