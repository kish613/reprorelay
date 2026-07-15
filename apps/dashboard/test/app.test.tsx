import { demoReports } from "@reprorelay/shared/fixtures";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App, reportsForFilter } from "../src/App.js";
import { presentShowcaseReport } from "../src/showcase/data-source.js";

afterEach(cleanup);

describe("showcase report presentation", () => {
  it("keeps presentation data scoped to the selected report", () => {
    const primary = presentShowcaseReport(demoReports[0]!);
    const mobile = presentShowcaseReport(demoReports[1]!);

    expect(primary.reportNumber).not.toBe(mobile.reportNumber);
    expect(primary.reporter.name).toBe("Sarah Chen");
    expect(mobile.reporter.name).toBe("Lettings Manager");
    expect(mobile.environmentLabel).toBe("Production");
    expect(mobile.releaseLabel).toBe("2026.07.08");
    expect(mobile.browserLabel).toBe("Safari 605");
    expect(mobile.agentPrompt).toBeUndefined();
    expect(mobile.aiSummary).toEqual([]);
    expect(mobile.evidence.screenshotUrl).toBeUndefined();
    expect(mobile.evidence.errorSignal).toBeUndefined();
    expect(mobile.evidence.attachments).toEqual([]);
    expect(mobile.activity.every((item) => !item.label.includes("Sarah Chen"))).toBe(true);
  });

  it("returns no reports when a view has no matching severity", () => {
    expect(reportsForFilter([demoReports[1]!], "high")).toEqual([]);
  });
});

describe("dashboard report selection", () => {
  it("shows closed GitHub-backed reports as resolved with green status dots", async () => {
    const report = {
      ...demoReports[0]!,
      status: "closed" as const,
      githubIssueUrl: "https://github.com/example/repo/issues/42",
      seenAt: new Date().toISOString(),
    };
    const dataSource = {
      mode: "showcase" as const,
      fetchReports: async () => [report],
      updateReport: async (_id: string, patch: Partial<typeof report>) => ({ ...report, ...patch }),
      addNote: async () => report,
      sendReply: async () => report,
      requestGitHubIssue: async () => report,
      present: presentShowcaseReport,
      savedViews: () => [],
    };

    render(<App dataSource={dataSource} />);
    await screen.findByRole("heading", { name: report.title });

    const inboxRow = screen.getByRole("button", { name: new RegExp(report.title) });
    expect(within(inboxRow).getByText("Resolved")).toBeTruthy();
    expect(within(inboxRow).queryByText("Ready")).toBeNull();
    expect(inboxRow.querySelector(".sev-dot")?.getAttribute("data-status")).toBe("closed");
    expect(document.querySelector(".kick .sev")?.getAttribute("data-status")).toBe("closed");
  });

  it("opens a searched report without leaking the previous report details", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: demoReports[0]!.title });

    await user.type(screen.getByRole("textbox", { name: "Search reports" }), "mobile");
    await user.click(screen.getByRole("option", { name: "Property search filters reset on mobile estates · production" }));

    const detail = screen.getByRole("region", { name: "Report detail" });
    expect(within(detail).getByRole("heading", { name: demoReports[1]!.title })).toBeTruthy();
    expect(within(detail).getAllByText("Lettings Manager")).toHaveLength(2);
    expect(within(detail).getByText("Production")).toBeTruthy();
    expect(within(detail).queryByText(/Template preview is blank after selecting a contact group/)).toBeNull();
    expect(within(detail).queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });

  it("persists the first visible report when the active filter excludes the selection", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: demoReports[0]!.title });

    await user.click(screen.getByRole("button", { name: /Property search filters reset on mobile/ }));
    expect(screen.getByRole("heading", { name: demoReports[1]!.title })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "High 1" }));
    expect(screen.getByRole("heading", { name: demoReports[0]!.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Template preview is blank after selecting a contact group/ }).className).toContain("active");

    await user.click(screen.getByRole("tab", { name: "All 2" }));
    expect(screen.getByRole("heading", { name: demoReports[0]!.title })).toBeTruthy();
  });

  it("resets to All when search selects a report outside the current filter", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: demoReports[0]!.title });
    await user.click(screen.getByRole("tab", { name: "High 1" }));

    await user.type(screen.getByRole("textbox", { name: "Search reports" }), "mobile");
    await user.click(screen.getByRole("option", { name: "Property search filters reset on mobile estates · production" }));

    expect(screen.getByRole("tab", { name: "All 2" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: demoReports[1]!.title })).toBeTruthy();
  });
});
