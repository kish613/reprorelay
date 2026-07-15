import html2canvas from "html2canvas-pro";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureScreenshot, startScreenRecording } from "../src/media.js";

vi.mock("html2canvas-pro", () => ({ default: vi.fn() }));

const html2canvasMock = vi.mocked(html2canvas);

class FakeTrack extends EventTarget {
  readonly stop = vi.fn();

  constructor(readonly kind: "audio" | "video") {
    super();
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}

  getTracks(): FakeTrack[] {
    return this.tracks;
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(): boolean {
    return true;
  }

  readonly mimeType: string;
  state: RecordingState = "inactive";

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "video/webm";
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    const dataEvent = new Event("dataavailable");
    Object.defineProperty(dataEvent, "data", { value: new Blob(["recording"], { type: this.mimeType }) });
    this.dispatchEvent(dataEvent);
    this.dispatchEvent(new Event("stop"));
  }
}

afterEach(() => {
  html2canvasMock.mockReset();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("captureScreenshot", () => {
  it("redacts configured elements and text inputs in the cloned document", async () => {
    html2canvasMock.mockResolvedValueOnce(fakeCanvas());

    await captureScreenshot(document.body, {
      maskSelector: "[data-private]",
      ignoreSelector: "[data-skip]",
      maskTextInputs: true,
    });

    const options = html2canvasMock.mock.calls[0]?.[1];
    if (!options?.onclone || !options.ignoreElements) throw new Error("Expected privacy-aware screenshot options");
    const clone = document.implementation.createHTMLDocument();
    clone.body.innerHTML = `
      <p data-private>customer@example.com</p>
      <input value="EAAG-secret-token" placeholder="Token" />
      <section data-skip>never capture this</section>
    `;
    await options.onclone(clone, clone.body);

    expect(clone.querySelector("[data-private]")?.textContent).toBe("[redacted]");
    expect((clone.querySelector("input") as HTMLInputElement).value).toBe("[redacted]");
    expect((clone.querySelector("input") as HTMLInputElement).placeholder).toBe("");
    expect(options.ignoreElements(clone.querySelector("[data-skip]") as Element)).toBe(true);
    expect(options.ignoreElements(clone.body)).toBe(false);
  });
});

describe("startScreenRecording", () => {
  it("combines a selected screen with microphone audio and returns a stoppable recording", async () => {
    const screenTrack = new FakeTrack("video");
    const microphoneTrack = new FakeTrack("audio");
    const getDisplayMedia = vi.fn(async () => new FakeMediaStream([screenTrack]));
    const getUserMedia = vi.fn(async () => new FakeMediaStream([microphoneTrack]));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia, getUserMedia },
    });
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const recording = await startScreenRecording({ includeMicrophone: true, maxDurationMs: 30_000 });
    const result = await recording.stop();

    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Object), video: false }));
    expect(result.includesMicrophone).toBe(true);
    expect(result.includesCamera).toBe(false);
    // MP4 (H.264) is preferred whenever the recorder supports it so the clip
    // plays back in Safari and on iOS; the fake recorder supports everything.
    expect(result.contentType).toBe("video/mp4");
    expect(result.blob.size).toBeGreaterThan(0);
    expect(screenTrack.stop).toHaveBeenCalled();
    expect(microphoneTrack.stop).toHaveBeenCalled();
  });
});

function fakeCanvas(): HTMLCanvasElement {
  return {
    toBlob(callback: BlobCallback) {
      callback(new Blob(["png"], { type: "image/png" }));
    },
  } as HTMLCanvasElement;
}
