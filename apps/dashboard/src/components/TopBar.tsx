import type { ReportRecord } from "@reprorelay/shared";
import { Folder, Search, Settings } from "lucide-react";
import type { PersonPresentation, ProjectInfo } from "../lib/data-source.js";

interface TopBarProps {
  workspaceName: string;
  account: PersonPresentation;
  query: string;
  results: ReportRecord[];
  showResults: boolean;
  requiresAuthentication: boolean;
  projects: ProjectInfo[];
  projectFilter: string;
  showSettings: boolean;
  onQuery: (value: string) => void;
  onSelectResult: (report: ReportRecord) => void;
  onSignOut: () => void;
  onProjectFilter: (projectKey: string) => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
}

export function TopBar({
  workspaceName,
  account,
  query,
  results,
  showResults,
  requiresAuthentication,
  projects,
  projectFilter,
  showSettings,
  onQuery,
  onSelectResult,
  onSignOut,
  onProjectFilter,
  onOpenSettings,
  onOpenAccount,
}: TopBarProps) {
  const initials = account.name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "OP";
  return (
    <header className="topbar">
      <div className="brand">
        <img src="/brand/reprorelay-mark.png" alt="" />
        ReproRelay
      </div>
      <span className="topbar-div" />
      {projects.length ? (
        <label className="workspace-name project-switch">
          <Folder size={15} />
          <select value={projectFilter} onChange={(event) => onProjectFilter(event.target.value)} aria-label="Filter by project">
            <option value="all">All projects</option>
            {projects.map((project) => (
              <option key={project.projectKey} value={project.projectKey}>{project.name}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="workspace-name"><Folder size={15} />{workspaceName}</div>
      )}

      <div className="global-search">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search reports…"
          aria-label="Search reports"
        />
        <kbd>⌘K</kbd>
        {showResults ? (
          <div className="search-results" role="listbox">
            {results.length ? results.map((report) => (
              <button type="button" role="option" key={report.id} onClick={() => onSelectResult(report)}>
                <strong>{report.title}</strong>
                <span>{report.projectKey.replace(/^proj_/, "").replace(/[-_]/g, " ")} · {report.environment}</span>
              </button>
            )) : <p>No matching reports</p>}
          </div>
        ) : null}
      </div>

      {showSettings ? (
        <button className="topbar-icon" type="button" aria-label="Workspace settings" onClick={onOpenSettings}>
          <Settings size={16} />
        </button>
      ) : null}
      <button className="account" type="button" aria-label={`${account.name} account settings`} onClick={onOpenAccount}>
        <span className="avatar">{initials}</span>
        <span className="nm">{account.name}</span>
      </button>
      {requiresAuthentication ? <button className="signout" type="button" onClick={onSignOut}>Sign out</button> : null}
    </header>
  );
}
