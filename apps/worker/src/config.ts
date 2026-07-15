import type { AgentRule, HandoffMode } from "@reprorelay/agent-adapters";
import type { OpenAiConfig } from "./ai.js";

export interface WorkerConfig {
  apiUrl: string;
  dashboardUrl?: string;
  intervalMs: number;
  internalToken?: string;
  agentRules: AgentRule[];
  openai?: OpenAiConfig;
}

export function loadWorkerConfig(env = process.env): WorkerConfig {
  const mode = (env.AGENT_HANDOFF_MODE ?? "triage") as HandoffMode;
  const openaiApiKey = env.OPENAI_API_KEY?.trim();
  return {
    apiUrl: env.REPRORELAY_API_URL ?? "http://localhost:4000",
    dashboardUrl: env.REPRORELAY_PUBLIC_URL,
    intervalMs: Number(env.WORKER_INTERVAL_MS ?? 15000),
    internalToken: env.REPRORELAY_INTERNAL_TOKEN,
    openai: openaiApiKey
      ? {
          apiKey: openaiApiKey,
          model: env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
          baseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
        }
      : undefined,
    agentRules: [
      { kind: "claude", mode, trigger: env.CLAUDE_TRIGGER ?? "@claude", minSeverity: "high" },
      { kind: "codex", mode, trigger: env.CODEX_TRIGGER ?? "@codex", minSeverity: "high" },
      { kind: "copilot", mode, trigger: env.COPILOT_LABEL ?? "copilot", minSeverity: "critical" },
    ],
  };
}
