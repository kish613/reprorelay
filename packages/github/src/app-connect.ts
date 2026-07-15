import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { GitHubClient } from "./client.js";

/** Credentials returned by GitHub's app-manifest conversion endpoint. */
export interface ConvertedGitHubApp {
  appId: number;
  slug: string;
  name: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  pem: string;
  htmlUrl?: string;
}

export interface GitHubAppCredentials {
  appId: number | string;
  /** PEM private key (not base64-wrapped). */
  privateKey: string;
}

/**
 * Exchanges a manifest-flow `code` for the newly created GitHub App's
 * credentials. https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
export async function exchangeManifestCode(code: string): Promise<ConvertedGitHubApp> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub manifest conversion failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as {
    id: number;
    slug: string;
    name: string;
    client_id?: string;
    client_secret?: string;
    webhook_secret?: string;
    pem: string;
    html_url?: string;
  };
  return {
    appId: body.id,
    slug: body.slug,
    name: body.name,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    webhookSecret: body.webhook_secret,
    pem: body.pem,
    htmlUrl: body.html_url,
  };
}

/** Lists private repositories the app's installations can reach, as "owner/repo". */
export async function listAccessibleRepos(credentials: GitHubAppCredentials): Promise<string[]> {
  const appOctokit = appLevelOctokit(credentials);
  const installations = await appOctokit.paginate(appOctokit.rest.apps.listInstallations, { per_page: 100 });
  const repos: string[] = [];
  for (const installation of installations) {
    const installationOctokit = installationOctokitFor(credentials, installation.id);
    const accessible = await installationOctokit.paginate(
      installationOctokit.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
    for (const repo of accessible) {
      if (repo.private) repos.push(repo.full_name);
    }
  }
  return repos.sort((a, b) => a.localeCompare(b));
}

/**
 * Builds an issue client for one repository, resolving the app installation
 * that covers it on demand — no installation bookkeeping in the database.
 */
export async function createGitHubClientForRepo(
  credentials: GitHubAppCredentials,
  owner: string,
  repo: string,
): Promise<GitHubClient> {
  const appOctokit = appLevelOctokit(credentials);
  const installation = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
  const octokit = installationOctokitFor(credentials, installation.data.id);
  const repository = await octokit.rest.repos.get({ owner, repo });
  if (!repository.data.private) {
    throw new Error("ReproRelay only files evidence-rich issues in private GitHub repositories");
  }

  return {
    async createIssue(input) {
      const response = await octokit.rest.issues.create({
        owner,
        repo,
        title: input.title,
        body: input.body,
        labels: input.labels,
      });
      return { number: response.data.number, htmlUrl: response.data.html_url };
    },
    async createComment(input) {
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: input.issueNumber,
        body: input.body,
      });
      return { htmlUrl: response.data.html_url };
    },
    async addLabels(input) {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: input.issueNumber,
        labels: input.labels,
      });
    },
  };
}

function appLevelOctokit(credentials: GitHubAppCredentials): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: credentials.appId, privateKey: credentials.privateKey },
  });
}

function installationOctokitFor(credentials: GitHubAppCredentials, installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: credentials.appId, privateKey: credentials.privateKey, installationId },
  });
}
