import { describe, expect, it } from "vitest";
import { describeElement } from "../src/browser.js";

describe("describeElement", () => {
  it("uses accessible labels where available", () => {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Send report");
    expect(describeElement(button)).toContain("Send report");
  });
});
