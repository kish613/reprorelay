import { describe, expect, it, vi } from "vitest";
import { createRecoveringLoader } from "../src/app-loader.js";

describe("createRecoveringLoader", () => {
  it("clears a rejected initialization and caches the recovered value", async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("temporary startup failure"))
      .mockResolvedValueOnce({ ready: true });
    const load = createRecoveringLoader(factory);

    await expect(load()).rejects.toThrow("temporary startup failure");
    await expect(load()).resolves.toEqual({ ready: true });
    await expect(load()).resolves.toEqual({ ready: true });

    expect(factory).toHaveBeenCalledTimes(2);
  });
});
