import type { ReportRecord } from "@reprorelay/shared";
import pg from "pg";

export interface StoredSession {
  sessionId: string;
  projectKey: string;
  uploadToken: string;
  expiresAt: string;
  createdAt: string;
}

export interface StoredProject {
  projectKey: string;
  name: string;
  origins: string[];
  /** "owner/repo" the worker files GitHub issues into, when linked. */
  githubRepo?: string;
  createdAt: string;
}

/** Credentials of the GitHub App created via the dashboard's manifest flow. */
export interface StoredGitHubApp {
  appId: number;
  slug: string;
  name: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  pem: string;
  htmlUrl?: string;
  createdAt: string;
}

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
}

export interface ReportStore {
  init(): Promise<void>;
  createSession(session: StoredSession): Promise<void>;
  getSession(sessionId: string): Promise<StoredSession | undefined>;
  createReport(report: ReportRecord): Promise<void>;
  listReports(projectKey?: string): Promise<ReportRecord[]>;
  getReport(id: string): Promise<ReportRecord | undefined>;
  updateReport(id: string, patch: Partial<ReportRecord>): Promise<ReportRecord | undefined>;
  listProjects(): Promise<StoredProject[]>;
  getProject(projectKey: string): Promise<StoredProject | undefined>;
  createProject(project: StoredProject): Promise<void>;
  updateProject(projectKey: string, patch: Partial<Pick<StoredProject, "name" | "origins" | "githubRepo">>): Promise<StoredProject | undefined>;
  deleteProject(projectKey: string): Promise<boolean>;
  getGitHubApp(): Promise<StoredGitHubApp | undefined>;
  saveGitHubApp(app: StoredGitHubApp): Promise<void>;
  deleteGitHubApp(): Promise<boolean>;
  listUsers(): Promise<StoredUser[]>;
  getUserByEmail(email: string): Promise<StoredUser | undefined>;
  getUserById(id: string): Promise<StoredUser | undefined>;
  createUser(user: StoredUser): Promise<void>;
  deleteUser(id: string): Promise<boolean>;
}

export class MemoryReportStore implements ReportStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly reports = new Map<string, ReportRecord>();

  async init(): Promise<void> {}

  async createSession(session: StoredSession): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  async getSession(sessionId: string): Promise<StoredSession | undefined> {
    return this.sessions.get(sessionId);
  }

  async createReport(report: ReportRecord): Promise<void> {
    this.reports.set(report.id, report);
  }

  async listReports(projectKey?: string): Promise<ReportRecord[]> {
    return Array.from(this.reports.values())
      .filter((report) => !projectKey || report.projectKey === projectKey)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getReport(id: string): Promise<ReportRecord | undefined> {
    return this.reports.get(id);
  }

  async updateReport(id: string, patch: Partial<ReportRecord>): Promise<ReportRecord | undefined> {
    const current = this.reports.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.reports.set(id, next);
    return next;
  }

  private readonly projects = new Map<string, StoredProject>();
  private readonly users = new Map<string, StoredUser>();

  async listProjects(): Promise<StoredProject[]> {
    return Array.from(this.projects.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getProject(projectKey: string): Promise<StoredProject | undefined> {
    return this.projects.get(projectKey);
  }

  async createProject(project: StoredProject): Promise<void> {
    this.projects.set(project.projectKey, project);
  }

  async updateProject(projectKey: string, patch: Partial<Pick<StoredProject, "name" | "origins" | "githubRepo">>): Promise<StoredProject | undefined> {
    const current = this.projects.get(projectKey);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.projects.set(projectKey, next);
    return next;
  }

  async deleteProject(projectKey: string): Promise<boolean> {
    return this.projects.delete(projectKey);
  }

  private githubApp: StoredGitHubApp | undefined;

  async getGitHubApp(): Promise<StoredGitHubApp | undefined> {
    return this.githubApp;
  }

  async saveGitHubApp(app: StoredGitHubApp): Promise<void> {
    this.githubApp = app;
  }

  async deleteGitHubApp(): Promise<boolean> {
    const existed = Boolean(this.githubApp);
    this.githubApp = undefined;
    return existed;
  }

  async listUsers(): Promise<StoredUser[]> {
    return Array.from(this.users.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getUserByEmail(email: string): Promise<StoredUser | undefined> {
    return Array.from(this.users.values()).find((user) => user.email === email);
  }

  async getUserById(id: string): Promise<StoredUser | undefined> {
    return this.users.get(id);
  }

  async createUser(user: StoredUser): Promise<void> {
    this.users.set(user.id, user);
  }

  async deleteUser(id: string): Promise<boolean> {
    return this.users.delete(id);
  }
}

export class PgReportStore implements ReportStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: normalizePostgresUrl(databaseUrl),
      max: 5,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      create table if not exists reprorelay_sessions (
        session_id uuid primary key,
        project_key text not null,
        upload_token text not null,
        expires_at timestamptz not null,
        created_at timestamptz not null
      );

      create table if not exists reprorelay_reports (
        id uuid primary key,
        project_key text not null,
        status text not null,
        github_issue_url text,
        github_issue_number integer,
        agent_status text not null,
        payload jsonb not null,
        created_at timestamptz not null
      );

      create index if not exists reprorelay_reports_project_created_idx
        on reprorelay_reports (project_key, created_at desc);

      create table if not exists reprorelay_projects (
        project_key text primary key,
        name text not null,
        origins jsonb not null default '[]',
        created_at timestamptz not null
      );

      create table if not exists reprorelay_users (
        id uuid primary key,
        email text not null unique,
        name text not null,
        password_hash text not null,
        created_at timestamptz not null
      );

      alter table reprorelay_projects add column if not exists github_repo text;

      create table if not exists reprorelay_github_app (
        id integer primary key default 1 check (id = 1),
        app_id bigint not null,
        slug text not null,
        name text not null,
        client_id text,
        client_secret text,
        webhook_secret text,
        pem text not null,
        html_url text,
        created_at timestamptz not null
      );
    `);
  }

  async createSession(session: StoredSession): Promise<void> {
    await this.pool.query(
      `insert into reprorelay_sessions (session_id, project_key, upload_token, expires_at, created_at)
       values ($1, $2, $3, $4, $5)`,
      [session.sessionId, session.projectKey, session.uploadToken, session.expiresAt, session.createdAt],
    );
  }

  async getSession(sessionId: string): Promise<StoredSession | undefined> {
    const result = await this.pool.query(`select * from reprorelay_sessions where session_id = $1`, [sessionId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      projectKey: row.project_key,
      uploadToken: row.upload_token,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    };
  }

  async createReport(report: ReportRecord): Promise<void> {
    await this.pool.query(
      `insert into reprorelay_reports (id, project_key, status, github_issue_url, github_issue_number, agent_status, payload, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [report.id, report.projectKey, report.status, report.githubIssueUrl, report.githubIssueNumber, report.agentStatus, report, report.createdAt],
    );
  }

  async listReports(projectKey?: string): Promise<ReportRecord[]> {
    const result = projectKey
      ? await this.pool.query(`select payload from reprorelay_reports where project_key = $1 order by created_at desc`, [projectKey])
      : await this.pool.query(`select payload from reprorelay_reports order by created_at desc`);
    return result.rows.map((row) => row.payload as ReportRecord);
  }

  async getReport(id: string): Promise<ReportRecord | undefined> {
    const result = await this.pool.query(`select payload from reprorelay_reports where id = $1`, [id]);
    return result.rows[0]?.payload as ReportRecord | undefined;
  }

  async updateReport(id: string, patch: Partial<ReportRecord>): Promise<ReportRecord | undefined> {
    const current = await this.getReport(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.pool.query(
      `update reprorelay_reports
       set status = $2, github_issue_url = $3, github_issue_number = $4, agent_status = $5, payload = $6
       where id = $1`,
      [id, next.status, next.githubIssueUrl, next.githubIssueNumber, next.agentStatus, next],
    );
    return next;
  }

  async listProjects(): Promise<StoredProject[]> {
    const result = await this.pool.query(`select * from reprorelay_projects order by created_at asc`);
    return result.rows.map(projectFromRow);
  }

  async getProject(projectKey: string): Promise<StoredProject | undefined> {
    const result = await this.pool.query(`select * from reprorelay_projects where project_key = $1`, [projectKey]);
    return result.rows[0] ? projectFromRow(result.rows[0]) : undefined;
  }

  async createProject(project: StoredProject): Promise<void> {
    await this.pool.query(
      `insert into reprorelay_projects (project_key, name, origins, github_repo, created_at)
       values ($1, $2, $3, $4, $5)
       on conflict (project_key) do nothing`,
      [project.projectKey, project.name, JSON.stringify(project.origins), project.githubRepo ?? null, project.createdAt],
    );
  }

  async updateProject(projectKey: string, patch: Partial<Pick<StoredProject, "name" | "origins" | "githubRepo">>): Promise<StoredProject | undefined> {
    const current = await this.getProject(projectKey);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await this.pool.query(
      `update reprorelay_projects set name = $2, origins = $3, github_repo = $4 where project_key = $1`,
      [projectKey, next.name, JSON.stringify(next.origins), next.githubRepo ?? null],
    );
    return next;
  }

  async deleteProject(projectKey: string): Promise<boolean> {
    const result = await this.pool.query(`delete from reprorelay_projects where project_key = $1`, [projectKey]);
    return (result.rowCount ?? 0) > 0;
  }

  async getGitHubApp(): Promise<StoredGitHubApp | undefined> {
    const result = await this.pool.query(`select * from reprorelay_github_app where id = 1`);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      appId: Number(row.app_id),
      slug: row.slug,
      name: row.name,
      clientId: row.client_id ?? undefined,
      clientSecret: row.client_secret ?? undefined,
      webhookSecret: row.webhook_secret ?? undefined,
      pem: row.pem,
      htmlUrl: row.html_url ?? undefined,
      createdAt: row.created_at.toISOString(),
    };
  }

  async saveGitHubApp(app: StoredGitHubApp): Promise<void> {
    await this.pool.query(
      `insert into reprorelay_github_app (id, app_id, slug, name, client_id, client_secret, webhook_secret, pem, html_url, created_at)
       values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do update set
         app_id = excluded.app_id, slug = excluded.slug, name = excluded.name,
         client_id = excluded.client_id, client_secret = excluded.client_secret,
         webhook_secret = excluded.webhook_secret, pem = excluded.pem,
         html_url = excluded.html_url, created_at = excluded.created_at`,
      [app.appId, app.slug, app.name, app.clientId ?? null, app.clientSecret ?? null, app.webhookSecret ?? null, app.pem, app.htmlUrl ?? null, app.createdAt],
    );
  }

  async deleteGitHubApp(): Promise<boolean> {
    const result = await this.pool.query(`delete from reprorelay_github_app where id = 1`);
    return (result.rowCount ?? 0) > 0;
  }

  async listUsers(): Promise<StoredUser[]> {
    const result = await this.pool.query(`select * from reprorelay_users order by created_at asc`);
    return result.rows.map(userFromRow);
  }

  async getUserByEmail(email: string): Promise<StoredUser | undefined> {
    const result = await this.pool.query(`select * from reprorelay_users where email = $1`, [email]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async getUserById(id: string): Promise<StoredUser | undefined> {
    const result = await this.pool.query(`select * from reprorelay_users where id = $1`, [id]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async createUser(user: StoredUser): Promise<void> {
    await this.pool.query(
      `insert into reprorelay_users (id, email, name, password_hash, created_at)
       values ($1, $2, $3, $4, $5)`,
      [user.id, user.email, user.name, user.passwordHash, user.createdAt],
    );
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await this.pool.query(`delete from reprorelay_users where id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }
}

interface ProjectRow {
  project_key: string;
  name: string;
  origins: unknown;
  github_repo?: string | null;
  created_at: Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
}

function projectFromRow(row: ProjectRow): StoredProject {
  return {
    projectKey: row.project_key,
    name: row.name,
    origins: Array.isArray(row.origins) ? row.origins.filter((origin): origin is string => typeof origin === "string") : [],
    githubRepo: row.github_repo ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

function userFromRow(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: row.created_at.toISOString(),
  };
}

export function createStore(databaseUrl?: string): ReportStore {
  return databaseUrl ? new PgReportStore(databaseUrl) : new MemoryReportStore();
}

function normalizePostgresUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.get("sslmode") === "require") {
      url.searchParams.set("sslmode", "verify-full");
    }
    return url.toString();
  } catch {
    return value;
  }
}
