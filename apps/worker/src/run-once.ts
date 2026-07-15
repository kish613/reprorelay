import { createGitHubAppClient, loadGitHubAppConfig } from "@reprorelay/github";
import { createTriageGenerator } from "./ai.js";
import { ReproRelayApiClient } from "./api-client.js";
import { loadWorkerConfig } from "./config.js";
import { processReports, type GitHubClientResolver } from "./processor.js";

export interface RunWorkerOverrides {
  /**
   * Per-report GitHub client, e.g. from a dashboard-connected GitHub App with
   * per-project repositories. Falls back to the env-configured single-repo
   * app when it returns undefined.
   */
  githubForReport?: GitHubClientResolver;
}

export async function runWorkerOnce(env = process.env, overrides: RunWorkerOverrides = {}): Promise<{ processed: number; github: "app" | "disabled"; triage: "openai" | "local" }> {
  const config = loadWorkerConfig(env);
  if (!config.internalToken) throw new Error("REPRORELAY_INTERNAL_TOKEN is required by the worker");
  const api = new ReproRelayApiClient(config.apiUrl, config.internalToken);
  const githubConfig = loadGitHubAppConfig(env);
  const envGithub = githubConfig ? createGitHubAppClient(githubConfig) : undefined;
  const githubForReport: GitHubClientResolver = async (report) =>
    (await overrides.githubForReport?.(report)) ?? envGithub;
  const githubEnabled = Boolean(envGithub || overrides.githubForReport);
  const processed = await processReports(api, githubForReport, {
    dashboardUrl: config.dashboardUrl,
    agentRules: config.agentRules,
    triage: createTriageGenerator(config.openai, console),
  });
  return { processed, github: githubEnabled ? "app" : "disabled", triage: config.openai ? "openai" : "local" };
}
