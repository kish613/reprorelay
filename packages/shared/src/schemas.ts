import { z } from "zod";

export const ProjectKeySchema = z.string().min(3).max(80).regex(/^[a-zA-Z0-9_-]+$/, "Use only letters, numbers, underscores, and hyphens");

export const UserContextSchema = z.object({
  id: z.string().max(256).optional(),
  email: z.string().email().max(320).optional(),
  name: z.string().max(256).optional(),
}).strict();

export const CaptureConfigSchema = z.object({
  replay: z.boolean().default(true),
  screenshot: z.boolean().default(true),
  video: z.boolean().default(false),
  console: z.boolean().default(true),
  network: z.boolean().default(true),
  clicks: z.boolean().default(true),
  routes: z.boolean().default(true),
}).partial();

export const PrivacyConfigSchema = z.object({
  maskTextInputs: z.boolean().default(true),
  redactQueryStrings: z.boolean().default(true),
  redactCookies: z.boolean().default(true),
  maskSelector: z.string().default("[data-reprorelay-mask]"),
  ignoreSelector: z.string().default("[data-reprorelay-ignore]"),
  allowedRequestHeaders: z.array(z.string()).default([]),
}).partial();

export const ClientConfigSchema = z.object({
  projectKey: ProjectKeySchema,
  apiUrl: z.string().url(),
  release: z.string().max(256).optional(),
  environment: z.string().min(1).max(80).default("production"),
  user: UserContextSchema.optional(),
  capture: CaptureConfigSchema.optional(),
  privacy: PrivacyConfigSchema.optional(),
  context: boundedRecord(50).optional(),
}).strict();

export const BreadcrumbSchema = z.object({
  type: z.enum(["click", "route", "console", "network", "custom"]),
  message: z.string().max(2000),
  timestamp: z.string().datetime(),
  data: boundedRecord(25).optional(),
}).strict();

export const BrowserMetadataSchema = z.object({
  url: z.string().url().max(4096),
  title: z.string().max(512),
  userAgent: z.string().max(2048),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    devicePixelRatio: z.number().positive(),
  }).strict(),
  language: z.string().max(80).optional(),
  timezone: z.string().max(120).optional(),
}).strict();

export const AssetKindSchema = z.enum(["screenshot", "video", "replay"]);
export const AssetContentTypeSchema = z.enum(["image/png", "image/jpeg", "video/webm", "video/mp4", "application/json"]);

export const AssetSchema = z.object({
  kind: AssetKindSchema,
  objectKey: z.string().min(1).max(512),
  contentType: AssetContentTypeSchema,
  size: z.number().int().nonnegative().optional(),
  url: z.string().url().optional(),
}).strict().superRefine(validateAssetContentType);

export const NetworkEventSchema = z.object({
  method: z.string().min(1).max(16),
  url: z.string().max(4096),
  status: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  requestHeaders: z.record(z.string().max(2048)).optional(),
}).strict();

export const ConsoleEventSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().max(2000),
  timestamp: z.string().datetime(),
}).strict();

export const AiTriageSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  generatedAt: z.string().datetime(),
  summary: z.string(),
  likelyArea: z.enum(["frontend", "backend", "network", "auth", "data", "design", "unknown"]),
  severityRecommendation: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  reproductionSteps: z.array(z.string()),
  keySignals: z.array(z.string()),
  suggestedLabels: z.array(z.string()),
  suggestedTests: z.array(z.string()),
  agentPrompt: z.string(),
  safetyNotes: z.array(z.string()),
  requiresHumanReview: z.literal(true).default(true),
});

export const ReportNoteSchema = z.object({
  id: z.string().uuid(),
  author: z.string().min(1).max(256),
  body: z.string().min(1).max(8000),
  /** Internal notes stay private; reply/email entries are visible to the reporter. */
  channel: z.enum(["note", "email", "reply"]).default("note"),
  /** Optional email-copy result for a reporter-visible widget reply. */
  emailDelivery: z.enum(["sent", "failed"]).optional(),
  providerId: z.string().max(256).optional(),
  createdAt: z.string().datetime(),
}).strict();

export const HumanReviewSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  agentHandoffApproved: z.boolean().default(false),
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
});

export const ReportPayloadSchema = z.object({
  sessionId: z.string().uuid(),
  projectKey: ProjectKeySchema,
  title: z.string().min(3).max(160),
  comment: z.string().min(1).max(8000),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  user: UserContextSchema.optional(),
  release: z.string().max(256).optional(),
  environment: z.string().min(1).max(80).default("production"),
  browser: BrowserMetadataSchema,
  breadcrumbs: z.array(BreadcrumbSchema).max(200).default([]),
  console: z.array(ConsoleEventSchema).max(100).default([]),
  network: z.array(NetworkEventSchema).max(100).default([]),
  replayEvents: z.array(z.unknown()).max(5000).default([]),
  assets: z.array(AssetSchema).max(3).default([]),
  context: boundedRecord(50).optional(),
  createdAt: z.string().datetime(),
}).strict();

export const SessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  uploadBaseUrl: z.string().url(),
  uploadToken: z.string(),
});

export const UploadIntentSchema = z.object({
  sessionId: z.string().uuid(),
  projectKey: ProjectKeySchema,
  kind: AssetKindSchema,
  contentType: AssetContentTypeSchema,
  contentLength: z.number().int().positive(),
}).strict().superRefine(validateAssetContentType);

export const UploadIntentResponseSchema = z.object({
  objectKey: z.string(),
  uploadUrl: z.string().url(),
  method: z.literal("PUT"),
  headers: z.record(z.string()).default({}),
  publicUrl: z.string().url().optional(),
});

export const ReportStatusSchema = z.enum(["new", "triaged", "github_created", "agent_handoff", "closed"]);

export const ReportRecordSchema = ReportPayloadSchema.extend({
  id: z.string().uuid(),
  status: ReportStatusSchema,
  /** Hidden from the default operator inbox until explicitly restored. */
  archivedAt: z.string().datetime().optional(),
  archivedBy: z.string().max(256).optional(),
  /** First time an operator opened this report in the private dashboard. */
  seenAt: z.string().datetime().optional(),
  /** Last server-side change visible in the report workflow. */
  updatedAt: z.string().datetime().optional(),
  githubIssueUrl: z.string().url().optional(),
  githubIssueNumber: z.number().int().positive().optional(),
  agentStatus: z.enum(["pending", "needs_review", "queued", "skipped", "sent", "failed"]).default("pending"),
  aiTriage: AiTriageSchema.optional(),
  humanReview: HumanReviewSchema.optional(),
  notes: z.array(ReportNoteSchema).max(500).default([]),
  githubIssueRequestedAt: z.string().datetime().optional(),
  /** When video evidence was removed by the configured retention policy. */
  videoDeletedAt: z.string().datetime().optional(),
});

/** Private receipt retained by the submitting browser for live status checks. */
export const ReportStatusReceiptSchema = z.object({
  id: z.string().uuid(),
  trackingToken: z.string().min(32).max(512),
}).strict();

export const ReportStatusesRequestSchema = z.object({
  projectKey: ProjectKeySchema,
  receipts: z.array(ReportStatusReceiptSchema).max(20),
}).strict();

/** A deliberately identity-free reply that is safe to show back to the reporter. */
export const PublicReporterMessageSchema = z.object({
  id: z.string().uuid(),
  body: z.string().min(1).max(8000),
  createdAt: z.string().datetime(),
}).strict();

/** Deliberately small public projection: no report comments, internal notes, identities or evidence URLs. */
export const PublicReportStatusSchema = z.object({
  id: z.string().uuid(),
  status: ReportStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  seenAt: z.string().datetime().optional(),
  hadVideo: z.boolean(),
  hadScreenshot: z.boolean(),
  /** Reporter-visible replies only. Missing on older servers and therefore defaulted. */
  messages: z.array(PublicReporterMessageSchema).max(20).default([]),
}).strict();

export const ReportStatusesResponseSchema = z.object({
  reports: z.array(PublicReportStatusSchema),
}).strict();

/** Server-authenticated status feed shared by every member of one project/organisation. */
export const ProjectReportStatusesRequestSchema = z.object({
  projectKey: ProjectKeySchema,
}).strict();

/**
 * Safe cross-browser projection. Unlike a receipt refresh it includes the
 * display fields needed to build report cards on a browser with no local copy.
 */
export const ProjectReportStatusSchema = PublicReportStatusSchema.extend({
  title: z.string().min(3).max(160),
  severity: z.enum(["low", "medium", "high", "critical"]),
}).strict();

export const ProjectReportStatusesResponseSchema = z.object({
  reports: z.array(ProjectReportStatusSchema).max(20),
}).strict();

export type UserContext = z.infer<typeof UserContextSchema>;
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;
export type PrivacyConfig = z.infer<typeof PrivacyConfigSchema>;
export type ClientConfig = z.infer<typeof ClientConfigSchema>;
export type Breadcrumb = z.infer<typeof BreadcrumbSchema>;
export type BrowserMetadata = z.infer<typeof BrowserMetadataSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type NetworkEvent = z.infer<typeof NetworkEventSchema>;
export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;
export type AiTriage = z.infer<typeof AiTriageSchema>;
export type ReportNote = z.infer<typeof ReportNoteSchema>;
export type HumanReview = z.infer<typeof HumanReviewSchema>;
export type ReportPayload = z.infer<typeof ReportPayloadSchema>;
export type ReportRecord = z.infer<typeof ReportRecordSchema>;
export type ReportStatus = z.infer<typeof ReportStatusSchema>;
export type ReportStatusReceipt = z.infer<typeof ReportStatusReceiptSchema>;
export type PublicReporterMessage = z.infer<typeof PublicReporterMessageSchema>;
export type PublicReportStatus = z.infer<typeof PublicReportStatusSchema>;
export type ReportStatusesRequest = z.infer<typeof ReportStatusesRequestSchema>;
export type ReportStatusesResponse = z.infer<typeof ReportStatusesResponseSchema>;
export type ProjectReportStatus = z.infer<typeof ProjectReportStatusSchema>;
export type ProjectReportStatusesRequest = z.infer<typeof ProjectReportStatusesRequestSchema>;
export type ProjectReportStatusesResponse = z.infer<typeof ProjectReportStatusesResponseSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type UploadIntent = z.infer<typeof UploadIntentSchema>;
export type UploadIntentResponse = z.infer<typeof UploadIntentResponseSchema>;

export const defaultCaptureConfig: Required<CaptureConfig> = {
  replay: true,
  screenshot: true,
  video: false,
  console: true,
  network: true,
  clicks: true,
  routes: true,
};

export const defaultPrivacyConfig: Required<PrivacyConfig> = {
  maskTextInputs: true,
  redactQueryStrings: true,
  redactCookies: true,
  maskSelector: "[data-reprorelay-mask]",
  ignoreSelector: "[data-reprorelay-ignore]",
  allowedRequestHeaders: [],
};

function boundedRecord(maxKeys: number) {
  return z.record(z.unknown()).superRefine((value, context) => {
    if (Object.keys(value).length > maxKeys) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected at most ${maxKeys} keys`,
      });
    }
  });
}

function validateAssetContentType(
  value: { kind: z.infer<typeof AssetKindSchema>; contentType: z.infer<typeof AssetContentTypeSchema> },
  context: z.RefinementCtx,
): void {
  const allowed: Record<z.infer<typeof AssetKindSchema>, ReadonlyArray<z.infer<typeof AssetContentTypeSchema>>> = {
    screenshot: ["image/png", "image/jpeg"],
    video: ["video/webm", "video/mp4"],
    replay: ["application/json"],
  };

  if (!allowed[value.kind].includes(value.contentType)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contentType"],
      message: `${value.contentType} is not valid for ${value.kind}`,
    });
  }
}
