import type { ReportRecord } from "@reprorelay/shared";
import { projectName } from "../lib/data-source.js";

export type InboxFilter = "all" | "review" | "high" | "archived";

interface InboxListProps {
  reports: ReportRecord[];
  selectedId?: string;
  filter: InboxFilter;
  counts: Record<InboxFilter, number>;
  onFilter: (filter: InboxFilter) => void;
  onSelect: (report: ReportRecord) => void;
}

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

const tabs: Array<{ id: InboxFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "high", label: "High" },
  { id: "archived", label: "Archived" },
];

export function needsReview(report: ReportRecord): boolean {
  return report.humanReview?.status === "pending" || report.agentStatus === "needs_review";
}

export function isHighSeverity(report: ReportRecord): boolean {
  return report.severity === "high" || report.severity === "critical";
}

export function InboxList({ reports, selectedId, filter, counts, onFilter, onSelect }: InboxListProps) {
  return (
    <section className="inbox" aria-label="Report inbox">
      <div className="inbox-top">
        <div className="inbox-title">
          <h2>Inbox</h2>
          <span>{counts.all} {counts.all === 1 ? "report" : "reports"}</span>
        </div>
        <div className="inbox-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              className={filter === tab.id ? "active" : ""}
              onClick={() => onFilter(tab.id)}
            >
              {tab.label}<span className="n">{counts[tab.id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="inbox-rows">
        {reports.length === 0 ? (
          <p className="inbox-empty">No reports in this view.</p>
        ) : reports.map((report) => (
          <button
            key={report.id}
            type="button"
            className={report.id === selectedId ? "inbox-row active" : "inbox-row"}
            onClick={() => onSelect(report)}
          >
            <span className="inbox-row-top">
              <span className={`sev-dot sev-${report.severity}`} data-status={report.status} aria-hidden="true" />
              <span className="inbox-row-title">{report.title}</span>
              <span className="inbox-row-time">{shortDate.format(new Date(report.createdAt))}</span>
            </span>
            <span className="inbox-row-meta">
              <span className="prj">{projectName(report.projectKey)}</span>
              <span className="dot-sep">·</span>
              {report.environment}
              <StatusPill report={report} />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function StatusPill({ report }: { report: ReportRecord }) {
  if (report.status === "closed") {
    return <span className="row-status resolved"><span className="d" />Resolved</span>;
  }
  if (report.githubIssueUrl || report.status === "agent_handoff") {
    return <span className="row-status ready"><span className="d" />Ready</span>;
  }
  if (needsReview(report)) {
    return <span className="row-status review"><span className="d" />Needs review</span>;
  }
  if (report.aiTriage) {
    return <span className="row-status triage"><span className="d" />AI triaged</span>;
  }
  return <span className="row-status"><span className="d" />New</span>;
}
