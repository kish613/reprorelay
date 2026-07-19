import type { ReportRecord } from "@reprorelay/shared";
import { useEffect, useMemo, useState } from "react";
import { type ComposerMode } from "./components/Composer.js";
import { InboxList, isHighSeverity, needsReview, type InboxFilter } from "./components/InboxList.js";
import { ReportDetail } from "./components/ReportDetail.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { TopBar } from "./components/TopBar.js";
import { type DashboardDataSource, type EmailStatus, type GitHubStatus, type ProjectInfo, type SessionUser, type TeamUser } from "./lib/data-source.js";
import { dashboardDataSource as defaultDataSource } from "virtual:reprorelay-data-source";

export function reportsForFilter(reports: ReportRecord[], filter: InboxFilter): ReportRecord[] {
  if (filter === "archived") return reports.filter((report) => Boolean(report.archivedAt));
  const active = reports.filter((report) => !report.archivedAt);
  if (filter === "review") return active.filter(needsReview);
  if (filter === "high") return active.filter(isHighSeverity);
  return active;
}

interface AppProps {
  dataSource?: DashboardDataSource;
}

export function App({ dataSource = defaultDataSource }: AppProps = {}) {
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [acknowledgingId, setAcknowledgingId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [authState, setAuthState] = useState<"checking" | "signed-out" | "signed-in">(
    dataSource.requiresAuthentication ? "checking" : "signed-in",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string>();
  const [sessionUser, setSessionUser] = useState<SessionUser>();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [projectFilter, setProjectFilter] = useState("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"projects" | "team">("projects");
  const [github, setGithub] = useState<GitHubStatus>();
  const [githubRepos, setGithubRepos] = useState<string[]>([]);
  const [emailStatus, setEmailStatus] = useState<EmailStatus>({ configured: dataSource.mode === "showcase" });

  const canManageProjects = Boolean(dataSource.listProjects && dataSource.createProject && dataSource.deleteProject);
  const canManageTeam = Boolean(dataSource.listUsers && dataSource.createUser && dataSource.deleteUser);
  const canConnectGitHub = Boolean(dataSource.githubStatus && dataSource.githubConnectPath);

  async function loadWorkspace(): Promise<void> {
    const fallbackEmailStatus: EmailStatus = { configured: dataSource.mode === "showcase" };
    const [nextReports, nextProjects, nextEmailStatus] = await Promise.all([
      dataSource.fetchReports(),
      canManageProjects ? dataSource.listProjects!() : Promise.resolve([]),
      dataSource.emailStatus
        ? dataSource.emailStatus().catch(() => fallbackEmailStatus)
        : Promise.resolve(fallbackEmailStatus),
    ]);
    setReports(nextReports);
    setProjects(nextProjects);
    setEmailStatus(nextEmailStatus);
    setSelectedId((current) => current ?? nextReports[0]?.id);
    setLoaded(true);
  }

  useEffect(() => {
    let cancelled = false;
    async function start(): Promise<void> {
      try {
        if (dataSource.requiresAuthentication) {
          const session = await dataSource.checkSession?.();
          if (cancelled) return;
          if (!session?.authenticated) {
            setAuthState("signed-out");
            setLoaded(true);
            return;
          }
          setSessionUser(session.user);
          setAuthState("signed-in");
        }
        await loadWorkspace();
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Unable to load reports.");
        setLoaded(true);
      }
    }
    void start();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (authState !== "signed-in" || dataSource.mode !== "live") return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void dataSource.fetchReports().then((nextReports) => {
        if (!cancelled) setReports(nextReports);
      }).catch(() => {
        // Keep the last good inbox visible; the next poll retries.
      });
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [authState, dataSource]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(undefined), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const projectReports = useMemo(
    () => (projectFilter === "all" ? reports : reports.filter((report) => report.projectKey === projectFilter)),
    [reports, projectFilter],
  );

  const counts = useMemo<Record<InboxFilter, number>>(() => ({
    all: reportsForFilter(projectReports, "all").length,
    review: reportsForFilter(projectReports, "review").length,
    high: reportsForFilter(projectReports, "high").length,
    archived: reportsForFilter(projectReports, "archived").length,
  }), [projectReports]);

  const visibleReports = useMemo(() => reportsForFilter(projectReports, filter), [projectReports, filter]);
  const selectedReport = visibleReports.find((report) => report.id === selectedId) ?? visibleReports[0];
  const presentation = selectedReport ? dataSource.present(selectedReport) : undefined;

  useEffect(() => {
    if (!selectedReport || selectedReport.seenAt || authState !== "signed-in") return;
    let cancelled = false;
    const reportId = selectedReport.id;
    const seenAt = new Date().toISOString();
    setAcknowledgingId(reportId);
    void dataSource.updateReport(reportId, { seenAt }).then((updated) => {
      if (cancelled) return;
      setReports((current) => current.map((report) => (report.id === updated.id ? updated : report)));
    }).catch(() => {
      // Reading the report still works if acknowledgement persistence is
      // temporarily unavailable; the next open will retry.
    }).finally(() => {
      setAcknowledgingId((current) => current === reportId ? undefined : current);
    });
    return () => { cancelled = true; };
  }, [authState, dataSource, selectedReport?.id, selectedReport?.seenAt]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const searchable = reportsForFilter(projectReports, filter === "archived" ? "archived" : "all");
    return searchable.filter((report) => [report.title, report.comment, report.projectKey].join(" ").toLowerCase().includes(normalized));
  }, [filter, query, projectReports]);

  const account = presentation?.currentUser
    ?? (sessionUser ? { name: sessionUser.name, email: sessionUser.email } : { name: "Workspace operator" });
  const selectedProjectName = projectFilter === "all"
    ? undefined
    : projects.find((project) => project.projectKey === projectFilter)?.name;

  function applyUpdated(updated: ReportRecord): void {
    setReports((current) => current.map((report) => (report.id === updated.id ? updated : report)));
  }

  function selectReport(report: ReportRecord): void {
    setSelectedId(report.id);
    setQuery("");
  }

  function selectSearchResult(report: ReportRecord): void {
    setFilter(report.archivedAt ? "archived" : "all");
    selectReport(report);
  }

  function changeFilter(nextFilter: InboxFilter): void {
    const nextVisibleReports = reportsForFilter(projectReports, nextFilter);
    setFilter(nextFilter);
    setSelectedId((current) => nextVisibleReports.some((report) => report.id === current)
      ? current
      : nextVisibleReports[0]?.id);
  }

  function changeProjectFilter(nextProjectFilter: string): void {
    const nextProjectReports = nextProjectFilter === "all"
      ? reports
      : reports.filter((report) => report.projectKey === nextProjectFilter);
    const nextVisibleReports = reportsForFilter(nextProjectReports, filter);
    setProjectFilter(nextProjectFilter);
    setSelectedId((current) => nextVisibleReports.some((report) => report.id === current)
      ? current
      : nextVisibleReports[0]?.id);
  }

  async function runAction(action: () => Promise<ReportRecord>, successNotice?: string): Promise<void> {
    setBusy(true);
    try {
      applyUpdated(await action());
      if (successNotice) setNotice(successNotice);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function changeStatus(status: ReportRecord["status"]): void {
    if (!selectedReport) return;
    void runAction(() => dataSource.updateReport(selectedReport.id, { status }), "Status updated.");
  }

  function toggleAssignee(): void {
    if (!selectedReport || !presentation) return;
    const assigned = Boolean(selectedReport.humanReview?.reviewedBy);
    const base = {
      status: selectedReport.humanReview?.status ?? "pending" as const,
      agentHandoffApproved: selectedReport.humanReview?.agentHandoffApproved ?? false,
    };
    const humanReview = assigned
      ? base
      : { ...base, reviewedBy: presentation.currentUser.email ?? presentation.currentUser.name, reviewedAt: new Date().toISOString() };
    void runAction(() => dataSource.updateReport(selectedReport.id, { humanReview }), assigned ? "Unassigned." : "Assigned to you.");
  }

  function createIssue(): void {
    if (!selectedReport) return;
    void runAction(() => dataSource.requestGitHubIssue(selectedReport.id), "GitHub issue queued — the worker will sync it shortly.");
  }

  function sendToEngineering(): void {
    if (!selectedReport || !dataSource.requestEngineeringHandoff) return;
    void runAction(() => dataSource.requestEngineeringHandoff!(selectedReport.id), "Engineering handoff queued with the reviewed evidence bundle.");
  }

  function updateReporterEmail(email: string): void {
    if (!selectedReport || !dataSource.updateReporterEmail) return;
    void runAction(() => dataSource.updateReporterEmail!(selectedReport.id, email), "Reporter email saved — future widget replies can also be emailed.");
  }

  function archiveReport(): void {
    if (!selectedReport || !dataSource.archiveReport) return;
    void runAction(() => dataSource.archiveReport!(selectedReport.id), "Report archived and removed from the active inbox.");
  }

  function restoreReport(): void {
    if (!selectedReport || !dataSource.restoreReport) return;
    void runAction(() => dataSource.restoreReport!(selectedReport.id), "Report restored to the active inbox.");
  }

  function submitComposer(body: string, mode: ComposerMode): void {
    if (!selectedReport || !presentation) return;
    if (mode === "reply") {
      void runAction(() => dataSource.sendReply(selectedReport.id, body), `Reply is now visible to ${presentation.reporter.name} in the widget.`);
    } else {
      void runAction(() => dataSource.addNote(selectedReport.id, body), "Internal note saved.");
    }
  }

  async function openSettings(tab: "projects" | "team" = "projects"): Promise<void> {
    setSettingsTab(tab);
    setSettingsOpen(true);
    if (canManageTeam) {
      try {
        setUsers(await dataSource.listUsers!());
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not load your team.");
      }
    }
    if (canConnectGitHub) {
      try {
        const status = await dataSource.githubStatus!();
        setGithub(status);
        if (status.connected && dataSource.listGitHubRepos) {
          setGithubRepos(await dataSource.listGitHubRepos());
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not check the GitHub connection.");
      }
    }
  }

  async function setProjectRepo(projectKey: string, githubRepo: string | null): Promise<void> {
    setBusy(true);
    try {
      const updated = await dataSource.updateProject!(projectKey, { githubRepo });
      setProjects((current) => current.map((project) => (project.projectKey === projectKey ? updated : project)));
      setNotice(githubRepo ? `Issues for this project now go to ${githubRepo}.` : "GitHub repo unlinked for this project.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnectGitHub(): Promise<void> {
    setBusy(true);
    try {
      await dataSource.disconnectGitHub!();
      setGithub({ connected: false });
      setGithubRepos([]);
    } finally {
      setBusy(false);
    }
  }

  async function createProject(input: { name: string; origin?: string }): Promise<void> {
    setBusy(true);
    try {
      const project = await dataSource.createProject!(input);
      setProjects((current) => [...current, project]);
      setNotice(`${project.name} added — open Setup for its embed snippet.`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject(projectKey: string): Promise<void> {
    setBusy(true);
    try {
      await dataSource.deleteProject!(projectKey);
      setProjects((current) => current.filter((project) => project.projectKey !== projectKey));
      setProjectFilter((current) => (current === projectKey ? "all" : current));
    } finally {
      setBusy(false);
    }
  }

  async function createUser(input: { email: string; name: string; password: string }): Promise<void> {
    setBusy(true);
    try {
      const user = await dataSource.createUser!(input);
      setUsers((current) => [...current, user]);
      setNotice(`${user.name} can now sign in with their own email and password.`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(id: string): Promise<void> {
    setBusy(true);
    try {
      await dataSource.deleteUser!(id);
      setUsers((current) => current.filter((user) => user.id !== id));
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dataSource.login) return;
    setBusy(true);
    setAuthError(undefined);
    try {
      await dataSource.login({ email: email.trim() || undefined, password });
      const session = await dataSource.checkSession?.();
      setSessionUser(session?.user);
      await loadWorkspace();
      setPassword("");
      setAuthState("signed-in");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function signOut(): Promise<void> {
    await dataSource.logout?.();
    setReports([]);
    setProjects([]);
    setUsers([]);
    setSessionUser(undefined);
    setSelectedId(undefined);
    setSettingsOpen(false);
    setAuthState("signed-out");
  }

  if (authState === "checking") {
    return <main className="load-state"><img src="/brand/reprorelay-mark.png" alt="" /><p>Checking your ReproRelay session…</p></main>;
  }

  if (authState === "signed-out") {
    return (
      <main className="login-page">
        <form className="login-card" onSubmit={(event) => void signIn(event)}>
          <img src="/brand/reprorelay-lockup.png" alt="ReproRelay" />
          <div><span>Private workspace</span><h1>Sign in to your inbox</h1><p>Use your team email and password, or leave email blank to sign in with the administrator password.</p></div>
          <label htmlFor="admin-email">Email <small>(optional)</small></label>
          <input id="admin-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoFocus />
          <label htmlFor="admin-password">Password</label>
          <input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          {authError ? <p className="login-error" role="alert">{authError}</p> : null}
          <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          <small>Session credentials are stored in a secure HTTP-only cookie.</small>
        </form>
      </main>
    );
  }

  if (loadError) {
    return <main className="load-state"><img src="/brand/reprorelay-mark.png" alt="ReproRelay" /><h1>Couldn’t load the inbox</h1><p>{loadError}</p></main>;
  }

  if (!loaded) {
    return <main className="load-state"><img src="/brand/reprorelay-mark.png" alt="" /><p>Loading your ReproRelay workspace…</p></main>;
  }

  return (
    <div className="shell">
      <TopBar
        workspaceName={selectedProjectName ?? presentation?.workspaceName ?? "All projects"}
        account={account}
        query={query}
        results={searchResults}
        showResults={query.trim().length > 0}
        requiresAuthentication={Boolean(dataSource.requiresAuthentication)}
        projects={projects}
        projectFilter={projectFilter}
        showSettings={canManageProjects || canManageTeam}
        onQuery={setQuery}
        onSelectResult={selectSearchResult}
        onSignOut={() => void signOut()}
        onProjectFilter={changeProjectFilter}
        onOpenSettings={() => void openSettings()}
        onOpenAccount={() => void openSettings("team")}
      />
      <div className="workspace">
        <InboxList
          reports={visibleReports}
          selectedId={selectedReport?.id}
          filter={filter}
          counts={counts}
          onFilter={changeFilter}
          onSelect={selectReport}
        />
        {selectedReport && presentation ? (
          <ReportDetail
            key={selectedReport.id}
            report={selectedReport}
            presentation={presentation}
            projectRepo={projects.find((project) => project.projectKey === selectedReport.projectKey)?.githubRepo}
            busy={busy || acknowledgingId === selectedReport.id}
            onChangeStatus={changeStatus}
            onToggleAssignee={toggleAssignee}
            onCreateIssue={createIssue}
            onSendToEngineering={sendToEngineering}
            onUpdateReporterEmail={updateReporterEmail}
            onArchive={archiveReport}
            onRestore={restoreReport}
            emailConfigured={emailStatus.configured}
            onSubmitComposer={submitComposer}
          />
        ) : (
          <main className="load-state workspace-empty">
            <img src="/brand/reprorelay-mark.png" alt="" />
            <h1>
              {projectReports.length > 0
                ? "No reports in this view"
                : `No reports ${projectFilter === "all" ? "yet" : `for ${selectedProjectName ?? "this project"}`}`}
            </h1>
            <p>
              {projectReports.length > 0
                ? "Try another inbox filter to see the rest of your reports."
                : projectFilter === "all"
                  ? "Reports will appear after a website sends them to the ReproRelay API."
                  : "Reports will appear once this project's site sends one — or switch back to All projects."}
            </p>
            {projectReports.length === 0 && canManageProjects ? (
              <button type="button" className="abtn primary" onClick={() => void openSettings()}>Connect a project</button>
            ) : null}
          </main>
        )}
      </div>
      {settingsOpen ? (
        <SettingsPanel
          apiUrl={dataSource.apiUrl ?? window.location.origin}
          projects={projects}
          users={users}
          sessionUser={sessionUser}
          canManageTeam={canManageTeam}
          canConnectGitHub={canConnectGitHub}
          github={github}
          githubRepos={githubRepos}
          githubConnectUrl={canConnectGitHub ? `${dataSource.apiUrl ?? window.location.origin}${dataSource.githubConnectPath}` : undefined}
          initialTab={settingsTab}
          busy={busy}
          onCreateProject={createProject}
          onDeleteProject={deleteProject}
          onSetProjectRepo={setProjectRepo}
          onCreateUser={createUser}
          onDeleteUser={deleteUser}
          onDisconnectGitHub={disconnectGitHub}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {notice ? <div className="toast" role="status">{notice}</div> : null}
    </div>
  );
}
