export type StorageDriver = "auto" | "local" | "s3" | "vercel-blob";
export type BlobAccess = "public" | "private";

export interface ApiConfig {
  port: number;
  publicUrl: string;
  corsOrigins: string[];
  projectKeys: string[];
  /** Project-scoped server keys allowed to read shared, sanitized status feeds. */
  statusApiKeys: Record<string, string>;
  maxUploadBytes: number;
  databaseUrl?: string;
  webhookSecret?: string;
  workerUrl?: string;
  email: {
    resendApiKey?: string;
    replyFrom?: string;
    replyReplyTo?: string;
  };
  retention: {
    cronSecret?: string;
    videoDays: number;
  };
  admin: {
    password?: string;
    sessionSecret?: string;
    internalToken?: string;
    sessionTtlSeconds: number;
    secureCookies: boolean;
  };
  storage: {
    driver: StorageDriver;
    bucket?: string;
    endpoint?: string;
    publicUrl?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle?: boolean;
    blobAccess: BlobAccess;
    blobReadWriteToken?: string;
    blobStoreId?: string;
    blobOidcToken?: string;
    blobUploadTtlSeconds: number;
    blobMaxUploadBytes: number;
    blobCacheControlMaxAge?: number;
  };
}

export function loadConfig(env = process.env): ApiConfig {
  const storageDriver = parseStorageDriver(env.STORAGE_DRIVER);
  const blobAccess = env.VERCEL_BLOB_ACCESS === "public" ? "public" : "private";
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;

  if ((env.NODE_ENV === "production" || Boolean(env.VERCEL)) && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production; refusing to use ephemeral report storage");
  }

  return {
    port: Number(env.PORT ?? 4000),
    publicUrl: env.REPRORELAY_API_URL ?? `http://localhost:${env.PORT ?? 4000}`,
    corsOrigins: parseList(env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:3001,http://localhost:5173"),
    projectKeys: parseList(env.REPRORELAY_PROJECT_KEYS),
    statusApiKeys: parseSecretMap(env.REPRORELAY_STATUS_API_KEYS),
    maxUploadBytes: parsePositiveInteger(env.REPRORELAY_MAX_UPLOAD_BYTES, 25 * 1024 * 1024),
    databaseUrl,
    webhookSecret: env.WEBHOOK_SECRET,
    workerUrl: env.REPRORELAY_WORKER_URL,
    email: {
      resendApiKey: env.RESEND_API_KEY?.trim() || undefined,
      replyFrom: env.REPRORELAY_REPLY_FROM?.trim() || undefined,
      replyReplyTo: env.REPRORELAY_REPLY_REPLY_TO?.trim() || undefined,
    },
    retention: {
      cronSecret: env.CRON_SECRET?.trim() || undefined,
      videoDays: parsePositiveInteger(env.REPRORELAY_VIDEO_RETENTION_DAYS, 7),
    },
    admin: {
      password: env.REPRORELAY_ADMIN_PASSWORD,
      sessionSecret: env.REPRORELAY_ADMIN_SESSION_SECRET,
      internalToken: env.REPRORELAY_INTERNAL_TOKEN,
      sessionTtlSeconds: parsePositiveInteger(env.REPRORELAY_ADMIN_SESSION_TTL_SECONDS, 60 * 60 * 12),
      secureCookies: env.REPRORELAY_SECURE_COOKIES === "true" || env.NODE_ENV === "production" || Boolean(env.VERCEL),
    },
    storage: {
      driver: storageDriver,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      publicUrl: env.S3_PUBLIC_URL,
      region: env.S3_REGION ?? "us-east-1",
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
      blobAccess,
      blobReadWriteToken: env.BLOB_READ_WRITE_TOKEN,
      blobStoreId: env.BLOB_STORE_ID,
      blobOidcToken: env.VERCEL_OIDC_TOKEN,
      blobUploadTtlSeconds: parsePositiveInteger(env.VERCEL_BLOB_UPLOAD_TTL_SECONDS, 300),
      blobMaxUploadBytes: parsePositiveInteger(env.VERCEL_BLOB_MAX_UPLOAD_BYTES, 1024 * 1024 * 200),
      blobCacheControlMaxAge: env.VERCEL_BLOB_CACHE_CONTROL_MAX_AGE ? parsePositiveInteger(env.VERCEL_BLOB_CACHE_CONTROL_MAX_AGE, 2592000) : undefined,
    },
  };
}

function parseStorageDriver(value: string | undefined): StorageDriver {
  if (value === "local" || value === "s3" || value === "vercel-blob") return value;
  return "auto";
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseSecretMap(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("REPRORELAY_STATUS_API_KEYS must be a JSON object of project keys to secrets");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("REPRORELAY_STATUS_API_KEYS must be a JSON object of project keys to secrets");
  }
  const entries = Object.entries(parsed);
  for (const [projectKey, secret] of entries) {
    if (!/^[a-zA-Z0-9_-]{3,80}$/.test(projectKey) || typeof secret !== "string" || secret.length < 32) {
      throw new Error("REPRORELAY_STATUS_API_KEYS requires valid project keys and secrets of at least 32 characters");
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
