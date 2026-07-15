import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { VercelBlobObjectStorage } from "../src/storage.js";

const blobMocks = vi.hoisted(() => ({
  deleteBlob: vi.fn(),
  getBlob: vi.fn(),
  issueSignedToken: vi.fn(),
  presignUrl: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  del: blobMocks.deleteBlob,
  get: blobMocks.getBlob,
  issueSignedToken: blobMocks.issueSignedToken,
  presignUrl: blobMocks.presignUrl,
}));

describe("VercelBlobObjectStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blobMocks.issueSignedToken.mockResolvedValue("signed-upload-token");
    blobMocks.presignUrl.mockResolvedValue({ presignedUrl: "https://blob.example/upload" });
  });

  it("binds the signed upload capability to the declared content length", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      STORAGE_DRIVER: "vercel-blob",
      VERCEL_BLOB_MAX_UPLOAD_BYTES: "209715200",
    });
    const storage = new VercelBlobObjectStorage(config.storage, config.publicUrl);

    await storage.createUploadIntent({
      projectKey: "proj_example",
      sessionId: "11111111-1111-4111-8111-111111111111",
      kind: "screenshot",
      contentType: "image/png",
      contentLength: 1024,
    });

    expect(blobMocks.issueSignedToken).toHaveBeenCalledWith(
      expect.objectContaining({ maximumSizeInBytes: 1024 }),
    );
    expect(blobMocks.presignUrl).toHaveBeenCalledWith(
      "signed-upload-token",
      expect.objectContaining({ maximumSizeInBytes: 1024 }),
    );
  });

  it("retains the provider-wide ceiling as a defensive upper bound", async () => {
    const config = loadConfig({
      NODE_ENV: "development",
      STORAGE_DRIVER: "vercel-blob",
      VERCEL_BLOB_MAX_UPLOAD_BYTES: "1024",
    });
    const storage = new VercelBlobObjectStorage(config.storage, config.publicUrl);

    await expect(storage.createUploadIntent({
      projectKey: "proj_example",
      sessionId: "11111111-1111-4111-8111-111111111111",
      kind: "screenshot",
      contentType: "image/png",
      contentLength: 1025,
    })).rejects.toThrow("Upload exceeds VERCEL_BLOB_MAX_UPLOAD_BYTES (1024)");

    expect(blobMocks.issueSignedToken).not.toHaveBeenCalled();
    expect(blobMocks.presignUrl).not.toHaveBeenCalled();
  });
});
