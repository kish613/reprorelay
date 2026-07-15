import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface GitHubAppConfig {
  appId: string;
  privateKeyBase64: string;
  installationId: string;
  owner: string;
  repo: string;
}

export interface GitHubClient {
  createIssue(input: { title: string; body: string; labels?: string[] }): Promise<{ number: number; htmlUrl: string }>;
  createComment(input: { issueNumber: number; body: string }): Promise<{ htmlUrl: string }>;
  addLabels(input: { issueNumber: number; labels: string[] }): Promise<void>;
}

export function loadGitHubAppConfig(env = process.env): GitHubAppConfig | undefined {
  const appId = env.GITHUB_APP_ID;
  const privateKeyBase64 = env.GITHUB_PRIVATE_KEY_BASE64;
  const installationId = env.GITHUB_INSTALLATION_ID;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;

  if (!appId || !privateKeyBase64 || !installationId || !owner || !repo) return undefined;
  return { appId, privateKeyBase64, installationId, owner, repo };
}

export function createGitHubAppClient(config: GitHubAppConfig): GitHubClient {
  const privateKey = Buffer.from(config.privateKeyBase64, "base64").toString("utf8");
  const auth = createAppAuth({
    appId: config.appId,
    privateKey,
    installationId: config.installationId,
  });

  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: config.appId, privateKey, installationId: config.installationId } });

  return {
    async createIssue(input) {
      await auth({ type: "installation" });
      const response = await octokit.rest.issues.create({
        owner: config.owner,
        repo: config.repo,
        title: input.title,
        body: input.body,
        labels: input.labels,
      });
      return { number: response.data.number, htmlUrl: response.data.html_url };
    },
    async createComment(input) {
      const response = await octokit.rest.issues.createComment({
        owner: config.owner,
        repo: config.repo,
        issue_number: input.issueNumber,
        body: input.body,
      });
      return { htmlUrl: response.data.html_url };
    },
    async addLabels(input) {
      await octokit.rest.issues.addLabels({
        owner: config.owner,
        repo: config.repo,
        issue_number: input.issueNumber,
        labels: input.labels,
      });
    },
  };
}

export class DryRunGitHubClient implements GitHubClient {
  readonly createdIssues: Array<{ title: string; body: string; labels?: string[] }> = [];
  readonly comments: Array<{ issueNumber: number; body: string }> = [];
  readonly labels: Array<{ issueNumber: number; labels: string[] }> = [];

  async createIssue(input: { title: string; body: string; labels?: string[] }): Promise<{ number: number; htmlUrl: string }> {
    this.createdIssues.push(input);
    return { number: this.createdIssues.length, htmlUrl: `https://github.com/reprorelay/dry-run/issues/${this.createdIssues.length}` };
  }

  async createComment(input: { issueNumber: number; body: string }): Promise<{ htmlUrl: string }> {
    this.comments.push(input);
    return { htmlUrl: `https://github.com/reprorelay/dry-run/issues/${input.issueNumber}#comment-${this.comments.length}` };
  }

  async addLabels(input: { issueNumber: number; labels: string[] }): Promise<void> {
    this.labels.push(input);
  }
}
