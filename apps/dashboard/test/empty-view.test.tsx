import { demoReports } from "@reprorelay/shared/fixtures";
import type { DashboardDataSource } from "../src/lib/data-source.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App } from "../src/App.js";
import { presentShowcaseReport } from "../src/showcase/data-source.js";

afterEach(cleanup);

it("keeps the inbox visible and renders an empty detail state for a zero-match filter", async () => {
  const report = demoReports[1]!;
  const dataSource: DashboardDataSource = {
    mode: "showcase",
    fetchReports: async () => [report],
    updateReport: async (_id, patch) => ({ ...report, ...patch }),
    addNote: async () => report,
    sendReply: async () => report,
    requestGitHubIssue: async () => report,
    present: presentShowcaseReport,
    savedViews: () => [],
  };
  const user = userEvent.setup();
  render(<App dataSource={dataSource} />);
  await screen.findByRole("heading", { name: demoReports[1]!.title });

  await user.click(screen.getByRole("tab", { name: "High 0" }));

  expect(screen.getByRole("region", { name: "Report inbox" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "No reports in this view" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Report detail" })).toBeNull();
});

it("acknowledges a report when an operator opens it", async () => {
  const report = demoReports[1]!;
  const updateReport = vi.fn(async (_id: string, patch: Partial<typeof report>) => ({ ...report, ...patch }));
  const dataSource: DashboardDataSource = {
    mode: "showcase",
    fetchReports: async () => [report],
    updateReport,
    addNote: async () => report,
    sendReply: async () => report,
    requestGitHubIssue: async () => report,
    present: presentShowcaseReport,
    savedViews: () => [],
  };

  render(<App dataSource={dataSource} />);
  await screen.findByRole("heading", { name: report.title });

  await waitFor(() => expect(updateReport).toHaveBeenCalledWith(report.id, { seenAt: expect.any(String) }));
});

it("adds a missing reporter email and queues engineering through dedicated actions", async () => {
  const report = {
    ...demoReports[1]!,
    user: { id: "client-2", name: "Lettings Manager" },
    seenAt: new Date().toISOString(),
  };
  const updateReporterEmail = vi.fn(async (_id: string, email: string) => ({ ...report, user: { ...report.user, email } }));
  const requestEngineeringHandoff = vi.fn(async () => ({
    ...report,
    agentStatus: "queued" as const,
    humanReview: { status: "approved" as const, agentHandoffApproved: true },
    githubIssueRequestedAt: new Date().toISOString(),
  }));
  const dataSource: DashboardDataSource = {
    mode: "showcase",
    fetchReports: async () => [report],
    updateReport: async (_id, patch) => ({ ...report, ...patch }),
    addNote: async () => report,
    sendReply: async () => report,
    requestGitHubIssue: async () => report,
    requestEngineeringHandoff,
    updateReporterEmail,
    emailStatus: async () => ({ configured: true }),
    present: presentShowcaseReport,
    savedViews: () => [],
  };
  const user = userEvent.setup();

  render(<App dataSource={dataSource} />);
  await screen.findByRole("heading", { name: report.title });
  expect(screen.getByText("Required before this report can receive an email reply.")).toBeTruthy();

  await user.type(screen.getByRole("textbox", { name: "Reporter email" }), "reporter@example.com");
  await user.click(screen.getByRole("button", { name: "Save email" }));
  await waitFor(() => expect(updateReporterEmail).toHaveBeenCalledWith(report.id, "reporter@example.com"));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Reply to Lettings" }).hasAttribute("disabled")).toBe(false));

  await user.click(screen.getByRole("button", { name: "Send to engineering" }));
  await waitFor(() => expect(requestEngineeringHandoff).toHaveBeenCalledWith(report.id));
  expect(screen.getByRole("button", { name: "Queued — sending…" })).toBeTruthy();
});

it("removes archived reports from the active inbox and allows restoring them", async () => {
  const report = { ...demoReports[1]!, seenAt: new Date().toISOString() };
  const archiveReport = vi.fn(async () => ({
    ...report,
    archivedAt: new Date().toISOString(),
    archivedBy: "Operator",
  }));
  const restoreReport = vi.fn(async () => ({ ...report, archivedAt: undefined, archivedBy: undefined }));
  const dataSource: DashboardDataSource = {
    mode: "showcase",
    fetchReports: async () => [report],
    updateReport: async (_id, patch) => ({ ...report, ...patch }),
    addNote: async () => report,
    sendReply: async () => report,
    requestGitHubIssue: async () => report,
    archiveReport,
    restoreReport,
    present: presentShowcaseReport,
    savedViews: () => [],
  };
  const user = userEvent.setup();

  render(<App dataSource={dataSource} />);
  await screen.findByRole("heading", { name: report.title });
  await user.click(screen.getByRole("button", { name: "Archive" }));

  await waitFor(() => expect(archiveReport).toHaveBeenCalledWith(report.id));
  expect(screen.getByRole("heading", { name: "No reports in this view" })).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "Archived 1" }));
  await screen.findByRole("heading", { name: report.title });
  await user.click(screen.getByRole("button", { name: "Restore" }));

  await waitFor(() => expect(restoreReport).toHaveBeenCalledWith(report.id));
  expect(screen.getByRole("tab", { name: "Archived 0" })).toBeTruthy();
});
