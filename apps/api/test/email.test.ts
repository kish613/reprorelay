import { describe, expect, it } from "vitest";
import { buildReportReplyEmail } from "../src/email.js";

describe("report reply email", () => {
  it("includes the report reference and safely formats reporter content", () => {
    const email = buildReportReplyEmail({
      reportId: "018ff3ef-f9dd-7c29-a648-d8dd59a9b001",
      reportTitle: "Save <button> does not work",
      reportComment: "I clicked Save & nothing happened.",
      message: "Thanks <Sarah> — we are looking into this.",
      reporterName: "Sarah Chen",
    });

    expect(email.subject).toBe("Re: Save <button> does not work [#018FF3EF]");
    expect(email.text).toContain("Hi Sarah,");
    expect(email.text).toContain("Reference: #018FF3EF");
    expect(email.text).toContain("Your original report:\nI clicked Save & nothing happened.");
    expect(email.html).toContain("Thanks &lt;Sarah&gt; — we are looking into this.");
    expect(email.html).toContain("Save &lt;button&gt; does not work");
    expect(email.html).toContain("I clicked Save &amp; nothing happened.");
    expect(email.html).not.toContain("Thanks <Sarah>");
  });
});
