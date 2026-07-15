import { Check, Copy, FolderPlus, Github, Trash2, UserPlus, X } from "lucide-react";
import { useState } from "react";
import type { GitHubStatus, ProjectInfo, SessionUser, TeamUser } from "../lib/data-source.js";

type SettingsTab = "projects" | "team" | "github";

interface SettingsPanelProps {
  apiUrl: string;
  projects: ProjectInfo[];
  users: TeamUser[];
  sessionUser?: SessionUser;
  canManageTeam: boolean;
  canConnectGitHub: boolean;
  github?: GitHubStatus;
  githubRepos: string[];
  githubConnectUrl?: string;
  initialTab?: SettingsTab;
  busy: boolean;
  onCreateProject(input: { name: string; origin?: string }): Promise<void>;
  onDeleteProject(projectKey: string): Promise<void>;
  onSetProjectRepo(projectKey: string, githubRepo: string | null): Promise<void>;
  onCreateUser(input: { email: string; name: string; password: string }): Promise<void>;
  onDeleteUser(id: string): Promise<void>;
  onDisconnectGitHub(): Promise<void>;
  onClose(): void;
}

export function SettingsPanel({
  apiUrl,
  projects,
  users,
  sessionUser,
  canManageTeam,
  canConnectGitHub,
  github,
  githubRepos,
  githubConnectUrl,
  initialTab = "projects",
  busy,
  onCreateProject,
  onDeleteProject,
  onSetProjectRepo,
  onCreateUser,
  onDeleteUser,
  onDisconnectGitHub,
  onClose,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>(canManageTeam && initialTab === "team" ? "team" : initialTab);
  const [error, setError] = useState<string>();

  const [projectName, setProjectName] = useState("");
  const [projectOrigin, setProjectOrigin] = useState("");
  const [expandedKey, setExpandedKey] = useState<string>();
  const [copiedKey, setCopiedKey] = useState<string>();

  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");
  const [userPassword, setUserPassword] = useState("");

  async function run(action: () => Promise<void>): Promise<void> {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    }
  }

  async function submitProject(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!projectName.trim()) return;
    await run(async () => {
      await onCreateProject({ name: projectName.trim(), origin: projectOrigin.trim() || undefined });
      setProjectName("");
      setProjectOrigin("");
    });
  }

  async function submitUser(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await run(async () => {
      await onCreateUser({ email: userEmail.trim(), name: userName.trim(), password: userPassword });
      setUserEmail("");
      setUserName("");
      setUserPassword("");
    });
  }

  async function copySnippet(project: ProjectInfo): Promise<void> {
    try {
      await navigator.clipboard.writeText(embedSnippet(project, apiUrl));
      setCopiedKey(project.projectKey);
      window.setTimeout(() => setCopiedKey((current) => (current === project.projectKey ? undefined : current)), 2000);
    } catch {
      setError("Couldn't copy — select the snippet text and copy it manually.");
    }
  }

  return (
    <div className="settings-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-label="Workspace settings">
        <header className="settings-head">
          <h2>Workspace settings</h2>
          <button type="button" aria-label="Close settings" onClick={onClose}><X size={17} /></button>
        </header>

        <div className="settings-tabs">
          <button type="button" className={tab === "projects" ? "active" : ""} onClick={() => { setTab("projects"); setError(undefined); }}>
            Projects <span className="n">{projects.length}</span>
          </button>
          {canManageTeam ? (
            <button type="button" className={tab === "team" ? "active" : ""} onClick={() => { setTab("team"); setError(undefined); }}>
              Team <span className="n">{users.length}</span>
            </button>
          ) : null}
          {canConnectGitHub ? (
            <button type="button" className={tab === "github" ? "active" : ""} onClick={() => { setTab("github"); setError(undefined); }}>
              GitHub {github?.connected ? <span className="n">✓</span> : null}
            </button>
          ) : null}
        </div>

        {error ? <p className="settings-error" role="alert">{error}</p> : null}

        {tab === "projects" ? (
          <div className="settings-body">
            <form className="settings-form" onSubmit={(event) => void submitProject(event)}>
              <div className="settings-fields">
                <label>
                  Project name
                  <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Marketing site" required />
                </label>
                <label>
                  Site origin <small>(optional — allows browser reports from this site)</small>
                  <input value={projectOrigin} onChange={(event) => setProjectOrigin(event.target.value)} placeholder="https://app.example.com" type="url" />
                </label>
              </div>
              <button className="settings-submit" type="submit" disabled={busy || !projectName.trim()}>
                <FolderPlus size={15} /> Add project
              </button>
            </form>

            <ul className="settings-list">
              {projects.map((project) => (
                <li key={project.projectKey}>
                  <div className="settings-row">
                    <div className="settings-row-main">
                      <b>{project.name}</b>
                      <code>{project.projectKey}</code>
                      {project.origins.length ? <span className="origins">{project.origins.join(", ")}</span> : null}
                    </div>
                    {github?.connected ? (
                      <select
                        className="repo-select"
                        aria-label={`GitHub repository for ${project.name}`}
                        value={project.githubRepo ?? ""}
                        disabled={busy}
                        onChange={(event) => void run(() => onSetProjectRepo(project.projectKey, event.target.value || null))}
                      >
                        <option value="">No GitHub repo</option>
                        {project.githubRepo && !githubRepos.includes(project.githubRepo) ? (
                          <option value={project.githubRepo}>{project.githubRepo}</option>
                        ) : null}
                        {githubRepos.map((repo) => <option key={repo} value={repo}>{repo}</option>)}
                      </select>
                    ) : null}
                    <button
                      type="button"
                      className="settings-link"
                      onClick={() => setExpandedKey((current) => (current === project.projectKey ? undefined : project.projectKey))}
                    >
                      {expandedKey === project.projectKey ? "Hide setup" : "Setup"}
                    </button>
                    <button
                      type="button"
                      className="settings-danger"
                      aria-label={`Delete ${project.name}`}
                      disabled={busy}
                      onClick={() => { if (window.confirm(`Delete ${project.name}? New reports for its key will be rejected.`)) void run(() => onDeleteProject(project.projectKey)); }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {expandedKey === project.projectKey ? (
                    <div className="snippet">
                      <div className="snippet-head">
                        <span>Paste before <code>&lt;/body&gt;</code> on {project.name}</span>
                        <button type="button" onClick={() => void copySnippet(project)}>
                          {copiedKey === project.projectKey ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                        </button>
                      </div>
                      <pre>{embedSnippet(project, apiUrl)}</pre>
                    </div>
                  ) : null}
                </li>
              ))}
              {!projects.length ? <li className="settings-empty">No projects yet — add your first one above.</li> : null}
            </ul>
          </div>
        ) : tab === "github" ? (
          <div className="settings-body">
            {github?.connected ? (
              <div className="github-card">
                <div className="github-card-head">
                  <Github size={18} />
                  <div>
                    <b>Connected as {github.name ?? github.slug}</b>
                    <span>Issues are filed by your private ReproRelay app. For reporter privacy, only private repositories can be linked.</span>
                  </div>
                </div>
                <div className="github-card-actions">
                  {github.manageUrl ? (
                    <a href={github.manageUrl} target="_blank" rel="noreferrer">Choose repositories on GitHub</a>
                  ) : null}
                  <button
                    type="button"
                    className="settings-danger-link"
                    disabled={busy}
                    onClick={() => { if (window.confirm("Disconnect GitHub? Issue creation stops until you connect again.")) void run(onDisconnectGitHub); }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className="github-card">
                <div className="github-card-head">
                  <Github size={18} />
                  <div>
                    <b>Connect GitHub</b>
                    <span>
                      One click creates a private GitHub App on your account with the right permissions,
                      lets you choose repositories, and brings you straight back here. Reports can then be
                      sent to GitHub as issues, per project.
                    </span>
                  </div>
                </div>
                <div className="github-card-actions">
                  {githubConnectUrl ? (
                    <a className="github-connect" href={githubConnectUrl}>
                      <Github size={15} /> Connect GitHub
                    </a>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="settings-body">
            <form className="settings-form" onSubmit={(event) => void submitUser(event)}>
              <div className="settings-fields">
                <label>
                  Name
                  <input value={userName} onChange={(event) => setUserName(event.target.value)} placeholder="Ada Lovelace" required />
                </label>
                <label>
                  Email
                  <input value={userEmail} onChange={(event) => setUserEmail(event.target.value)} placeholder="ada@example.com" type="email" required />
                </label>
                <label>
                  Password <small>(at least 8 characters)</small>
                  <input value={userPassword} onChange={(event) => setUserPassword(event.target.value)} type="password" minLength={8} autoComplete="new-password" required />
                </label>
              </div>
              <button className="settings-submit" type="submit" disabled={busy}>
                <UserPlus size={15} /> Add teammate
              </button>
            </form>

            <ul className="settings-list">
              {users.map((user) => (
                <li key={user.id}>
                  <div className="settings-row">
                    <div className="settings-row-main">
                      <b>{user.name}{sessionUser?.id === user.id ? " (you)" : ""}</b>
                      <span className="origins">{user.email}</span>
                    </div>
                    <button
                      type="button"
                      className="settings-danger"
                      aria-label={`Remove ${user.name}`}
                      disabled={busy || sessionUser?.id === user.id}
                      onClick={() => { if (window.confirm(`Remove ${user.name}? They will be signed out immediately.`)) void run(() => onDeleteUser(user.id)); }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              ))}
              {!users.length ? (
                <li className="settings-empty">
                  No team accounts yet. Add one for each person — the shared admin password keeps working as a fallback.
                </li>
              ) : null}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function embedSnippet(project: ProjectInfo, apiUrl: string): string {
  // The SDK is served by this ReproRelay deployment itself, so client sites
  // pick up SDK fixes on every deploy — no npm or CDN version to chase.
  return [
    `<script src="${apiUrl}/sdk/reprorelay.js"></script>`,
    `<script>`,
    `  ReproRelay.init({`,
    `    projectKey: "${project.projectKey}",`,
    `    apiUrl: "${apiUrl}",`,
    `  });`,
    `</script>`,
  ].join("\n");
}
