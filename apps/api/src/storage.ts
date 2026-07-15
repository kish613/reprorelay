import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { del as deleteBlob, get as getBlob, issueSignedToken, presignUrl } from "@vercel/blob";
import type { UploadIntent, UploadIntentResponse } from "@reprorelay/shared";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ApiConfig } from "./config.js";

export interface ObjectStorage {
  createUploadIntent(input: UploadIntent, authorization?: UploadAuthorization): Promise<UploadIntentResponse>;
  readObject(objectKey: string): Promise<StoredObject>;
  deleteObject(objectKey: string): Promise<void>;
  writeLocalObject?(objectKey: string, body: Buffer): Promise<void>;
  /**
   * Returns a short-lived direct download URL when the driver supports it.
   * Lets browsers stream evidence (video) straight from object storage with
   * native Range support instead of proxying bytes through the API function.
   */
  createDownloadUrl?(objectKey: string): Promise<string | undefined>;
}

const DOWNLOAD_URL_TTL_SECONDS = 300;

export interface UploadAuthorization {
  uploadToken?: string;
}

export interface StoredObject {
  body: Buffer;
  contentType?: string;
}

export class LocalObjectStorage implements ObjectStorage {
  constructor(
    private readonly publicUrl: string,
    private readonly root = join(process.cwd(), "storage"),
  ) {}

  async createUploadIntent(input: UploadIntent, authorization?: UploadAuthorization): Promise<UploadIntentResponse> {
    const objectKey = buildObjectKey(input);
    return {
      objectKey,
      uploadUrl: `${this.publicUrl}/v1/local-uploads/${encodeURIComponent(objectKey)}`,
      method: "PUT",
      headers: authorization?.uploadToken ? { "x-reprorelay-upload-token": authorization.uploadToken } : {},
      publicUrl: `${this.publicUrl}/v1/assets/${encodeURIComponent(objectKey)}`,
    };
  }

  async writeLocalObject(objectKey: string, body: Buffer): Promise<void> {
    const target = safeLocalPath(this.root, objectKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async readObject(objectKey: string): Promise<StoredObject> {
    const target = safeLocalPath(this.root, objectKey);
    return {
      body: await readFile(target),
      contentType: contentTypeFromKey(objectKey),
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await unlink(safeLocalPath(this.root, objectKey));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly config: ApiConfig["storage"],
    private readonly publicUrl: string,
  ) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
    });
  }

  async createUploadIntent(input: UploadIntent): Promise<UploadIntentResponse> {
    if (!this.config.bucket) throw new Error("S3_BUCKET is required");
    const objectKey = buildObjectKey(input);
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    });
    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn: 300 });
    return {
      objectKey,
      uploadUrl,
      method: "PUT",
      headers: {},
      publicUrl: this.config.publicUrl ? `${this.config.publicUrl.replace(/\/$/, "")}/${objectKey}` : buildAssetUrl(this.publicUrl, objectKey),
    };
  }

  async createDownloadUrl(objectKey: string): Promise<string | undefined> {
    if (!this.config.bucket) throw new Error("S3_BUCKET is required");
    const command = new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey });
    return getSignedUrl(this.client, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  }

  async readObject(objectKey: string): Promise<StoredObject> {
    if (!this.config.bucket) throw new Error("S3_BUCKET is required");
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
      }),
    );

    if (!response.Body) throw new Error("Object not found");
    return {
      body: await streamToBuffer(response.Body),
      contentType: response.ContentType ?? contentTypeFromKey(objectKey),
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    if (!this.config.bucket) throw new Error("S3_BUCKET is required");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
  }
}

export class VercelBlobObjectStorage implements ObjectStorage {
  constructor(
    private readonly config: ApiConfig["storage"],
    private readonly publicUrl: string,
  ) {}

  async createUploadIntent(input: UploadIntent): Promise<UploadIntentResponse> {
    const objectKey = buildObjectKey(input);
    if (input.contentLength > this.config.blobMaxUploadBytes) {
      throw new Error(`Upload exceeds VERCEL_BLOB_MAX_UPLOAD_BYTES (${this.config.blobMaxUploadBytes})`);
    }
    // Bind the provider-enforced capability to the size approved for this
    // specific intent. Using the account-wide ceiling here would let a caller
    // declare a small upload and then store a much larger object directly.
    const maximumSizeInBytes = input.contentLength;
    const validUntil = Date.now() + this.config.blobUploadTtlSeconds * 1000;
    const token = await issueSignedToken({
      pathname: objectKey,
      operations: ["put"],
      validUntil,
      allowedContentTypes: [input.contentType],
      maximumSizeInBytes,
      ...this.blobAuthOptions(),
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: "put",
      pathname: objectKey,
      access: this.config.blobAccess,
      validUntil,
      allowedContentTypes: [input.contentType],
      maximumSizeInBytes,
      allowOverwrite: false,
      addRandomSuffix: false,
      cacheControlMaxAge: this.config.blobCacheControlMaxAge,
    });

    return {
      objectKey,
      uploadUrl: presignedUrl,
      method: "PUT",
      headers: {},
      publicUrl: buildAssetUrl(this.publicUrl, objectKey),
    };
  }

  async createDownloadUrl(objectKey: string): Promise<string | undefined> {
    const validUntil = Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000;
    const token = await issueSignedToken({
      pathname: objectKey,
      operations: ["get"],
      validUntil,
      ...this.blobAuthOptions(),
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: "get",
      pathname: objectKey,
      access: this.config.blobAccess,
      validUntil,
    });
    return presignedUrl;
  }

  async readObject(objectKey: string): Promise<StoredObject> {
    const result = await getBlob(objectKey, {
      access: this.config.blobAccess,
      useCache: this.config.blobAccess === "public",
      ...this.blobAuthOptions(),
    });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error("Object not found");

    return {
      body: await streamToBuffer(result.stream),
      contentType: result.blob.contentType,
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    await deleteBlob(objectKey, this.blobAuthOptions());
  }

  private blobAuthOptions(): { token?: string; storeId?: string; oidcToken?: string } {
    return {
      token: this.config.blobReadWriteToken,
      storeId: this.config.blobStoreId,
      oidcToken: this.config.blobOidcToken,
    };
  }
}

export function createObjectStorage(config: ApiConfig): ObjectStorage {
  if (config.storage.driver === "local") return new LocalObjectStorage(config.publicUrl);
  if (config.storage.driver === "s3") return new S3ObjectStorage(config.storage, config.publicUrl);
  if (config.storage.driver === "vercel-blob") return new VercelBlobObjectStorage(config.storage, config.publicUrl);

  if (hasVercelBlobConfig(config.storage)) return new VercelBlobObjectStorage(config.storage, config.publicUrl);
  if (config.storage.bucket) return new S3ObjectStorage(config.storage, config.publicUrl);
  return new LocalObjectStorage(config.publicUrl);
}

export function buildObjectKey(input: Pick<UploadIntent, "projectKey" | "sessionId" | "kind" | "contentType">): string {
  const safeProjectKey = sanitizePathSegment(input.projectKey);
  const safeKind = input.kind.replace(/[^a-z]/g, "");
  const extension = extensionForContentType(input.contentType);
  return `${safeProjectKey}/${input.sessionId}/${safeKind}.${extension}`;
}

export function buildAssetUrl(publicUrl: string, objectKey: string): string {
  return `${publicUrl.replace(/\/$/, "")}/v1/assets/${encodeURIComponent(objectKey)}`;
}

function contentTypeFromKey(objectKey: string): string {
  if (objectKey.endsWith(".png")) return "image/png";
  if (objectKey.endsWith(".jpg")) return "image/jpeg";
  if (objectKey.endsWith(".webm")) return "video/webm";
  if (objectKey.endsWith(".mp4")) return "video/mp4";
  if (objectKey.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function extensionForContentType(contentType: UploadIntent["contentType"]): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "video/webm":
      return "webm";
    case "video/mp4":
      return "mp4";
    case "application/json":
      return "json";
    default:
      throw new Error(`Unsupported content type: ${contentType}`);
  }
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (isReadableStream(body)) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isReadableStream(body: unknown): body is ReadableStream<Uint8Array> {
  return typeof body === "object" && body !== null && "getReader" in body && typeof (body as ReadableStream<Uint8Array>).getReader === "function";
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function hasVercelBlobConfig(storage: ApiConfig["storage"]): boolean {
  return Boolean(storage.blobReadWriteToken || (storage.blobStoreId && storage.blobOidcToken));
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function safeLocalPath(root: string, objectKey: string): string {
  if (objectKey.includes("..") || objectKey.startsWith("/") || objectKey.includes("\\")) {
    throw new Error("Unsafe object key");
  }
  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, objectKey);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error("Unsafe object key");
  }
  return targetPath;
}
