import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFileCatchUpBookmarks } from "../services/catch-up-bookmarks.js";

/*
 * PLAN-krug 7г: файл закладок «догнать» -- сессия Викинга -> новейшая строка ветки, которую Викинг заведомо
 * держит. Правка по одной сессии (чтение-правка-запись), чтобы два пишущих (перерегистрация, старый процесс
 * при перезапуске) не стирали друг другу записи; запись через временный файл и переименование.
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});
async function fileIn(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "catch-up-bookmarks-"));
  dirs.push(dir);
  return path.join(dir, "nested", "catch-up-bookmarks.json");
}

describe("файл закладок «догнать»", () => {
  it("помнит закладку сессии между экземплярами (перезапуск)", async () => {
    const file = await fileIn();
    await createFileCatchUpBookmarks(file).set("s1", "a2");

    expect(await createFileCatchUpBookmarks(file).get("s1")).toBe("a2");
    expect(await createFileCatchUpBookmarks(file).get("s2")).toBeUndefined();
  });

  it("два пишущих не стирают друг другу сессии", async () => {
    const file = await fileIn();
    const first = createFileCatchUpBookmarks(file);
    const second = createFileCatchUpBookmarks(file);
    await first.set("s1", "a1");
    await second.set("s2", "b1");
    await first.set("s1", "a2");

    const reader = createFileCatchUpBookmarks(file);
    expect([await reader.get("s1"), await reader.get("s2")]).toEqual(["a2", "b1"]);
  });

  it("держит не больше предела, уходят самые давние", async () => {
    const file = await fileIn();
    const store = createFileCatchUpBookmarks(file, { maxEntries: 2, now: (() => { let t = 0; return () => (t += 1); })() });
    await store.set("s1", "a");
    await store.set("s2", "b");
    await store.set("s3", "c");

    expect([await store.get("s1"), await store.get("s2"), await store.get("s3")]).toEqual([undefined, "b", "c"]);
  });

  it("испорченный файл -- записи нет, следующая запись его чинит", async () => {
    const file = await fileIn();
    await createFileCatchUpBookmarks(file).set("s0", "x");
    await writeFile(file, "{не json", "utf8");
    const store = createFileCatchUpBookmarks(file);

    expect(await store.get("s0")).toBeUndefined();
    await store.set("s1", "a1");
    expect(JSON.parse(await readFile(file, "utf8")).sessions.s1.row).toBe("a1");
  });
});
