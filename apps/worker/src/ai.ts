import { buildAiTriage, type AiTriage, type ReportRecord } from "@reprorelay/shared";
import { z } from "zod";

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export type TriageGenerator = (report: ReportRecord) => Promise<AiTriage>;

interface Logger {
  warn(value: unknown, message?: string): void;
}

/**
 * Returns a triage generator. When OpenAI is configured it produces an
 * LLM-authored triage draft and falls back to the local heuristic on any
 * failure, so the worker never blocks on the model being unavailable.
 */
export function createTriageGenerator(openai?: OpenAiConfig, log?: Logger): TriageGenerator {
  if (!openai) return async (report) => buildAiTriage(report);
  return async (report) => {
    try {
      return await generateOpenAiTriage(report, openai);
    } catch (error) {
      log?.warn({ error }, "OpenAI triage failed; falling back to local heuristic");
      return buildAiTriage(report);
    }
  };
}

const OpenAiTriageSchema = z
  .object({
    summary: z.string(),
    likelyArea: z.enum(["frontend", "backend", "network", "auth", "data", "design", "unknown"]),
    severityRecommendation: z.enum(["low", "medium", "high", "critical"]),
    confidence: z.number().min(0).max(1),
    reproductionSteps: z.array(z.string()),
    keySignals: z.array(z.string()),
    suggestedLabels: z.array(z.string()),
    suggestedTests: z.array(z.string()),
    agentPrompt: z.string(),
  })
  .partial();

const SYSTEM_PROMPT = [
  "You triage software bug reports for an engineering team.",
  "Return ONLY a JSON object with these optional keys: summary (string),",
  "likelyArea (one of frontend, backend, network, auth, data, design, unknown),",
  "severityRecommendation (low, medium, high, critical), confidence (0-1),",
  "reproductionSteps (string[]), keySignals (string[]), suggestedLabels (string[]),",
  "suggestedTests (string[]), agentPrompt (string).",
  "agentPrompt must be a self-contained task brief that a coding agent can act on",
  "with no other context: state the problem, the affected page URL/route, the exact",
  "error signals verbatim, numbered reproduction steps, and acceptance criteria for",
  "the fix. Write it as instructions to the agent, not a description of the report.",
  "Be concise and specific. Never invent evidence that is not in the report.",
].join(" ");

async function generateOpenAiTriage(report: ReportRecord, openai: OpenAiConfig): Promise<AiTriage> {
  const base = buildAiTriage(report);
  const response = await fetch(`${openai.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${openai.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: openai.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(report) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty triage response");

  const parsed = OpenAiTriageSchema.parse(JSON.parse(content));

  return {
    ...base,
    provider: "openai",
    model: openai.model,
    generatedAt: new Date().toISOString(),
    summary: parsed.summary ?? base.summary,
    likelyArea: parsed.likelyArea ?? base.likelyArea,
    severityRecommendation: parsed.severityRecommendation ?? base.severityRecommendation,
    confidence: parsed.confidence ?? base.confidence,
    reproductionSteps: parsed.reproductionSteps?.length ? parsed.reproductionSteps : base.reproductionSteps,
    keySignals: parsed.keySignals?.length ? parsed.keySignals : base.keySignals,
    suggestedLabels: parsed.suggestedLabels?.length ? parsed.suggestedLabels : base.suggestedLabels,
    suggestedTests: parsed.suggestedTests?.length ? parsed.suggestedTests : base.suggestedTests,
    agentPrompt: parsed.agentPrompt ?? base.agentPrompt,
  };
}

function buildUserPrompt(report: ReportRecord): string {
  const consoleErrors = report.console.filter((event) => event.level === "error").slice(0, 5);
  const failedRequests = report.network.filter((event) => typeof event.status === "number" && event.status >= 400).slice(0, 5);
  const steps = report.breadcrumbs
    .filter((item) => item.type === "click" || item.type === "route")
    .slice(-10)
    .map((item) => `${item.type}: ${item.message}`);

  return [
    `Title: ${report.title}`,
    `Reporter comment: ${report.comment}`,
    `Reported severity: ${report.severity}`,
    `Environment: ${report.environment}`,
    `Release: ${report.release ?? "unknown"}`,
    `URL: ${report.browser.url}`,
    consoleErrors.length ? `Console errors:\n${consoleErrors.map((e) => `- ${e.message}`).join("\n")}` : "Console errors: none",
    failedRequests.length
      ? `Failed requests:\n${failedRequests.map((e) => `- ${e.method} ${e.url} -> ${e.status}`).join("\n")}`
      : "Failed requests: none",
    steps.length ? `User timeline:\n${steps.map((s) => `- ${s}`).join("\n")}` : "User timeline: none captured",
  ].join("\n");
}
