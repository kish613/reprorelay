import { describe, expect, it } from "vitest";
import { MemoryReportStore } from "../src/store.js";

describe("MemoryReportStore", () => {
  it("starts empty so live deployments never receive showcase reports", async () => {
    const store = new MemoryReportStore();
    await store.init();

    await expect(store.listReports()).resolves.toEqual([]);
  });
});
