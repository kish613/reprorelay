import html2canvas from "html2canvas-pro";
import type { PrivacyConfig } from "@reprorelay/shared";

export type RecordingContentType = "video/webm" | "video/mp4";

export interface ScreenRecordingOptions {
  includeCamera?: boolean;
  includeMicrophone?: boolean;
  maxDurationMs?: number;
}

export interface ScreenRecordingResult {
  blob: Blob;
  contentType: RecordingContentType;
  durationMs: number;
  includesCamera: boolean;
  includesMicrophone: boolean;
}

export interface ActiveScreenRecording {
  readonly startedAt: number;
  readonly includesCamera: boolean;
  readonly includesMicrophone: boolean;
  readonly finished: Promise<ScreenRecordingResult>;
  stop(): Promise<ScreenRecordingResult>;
  discard(): void;
}

const DEFAULT_MASK_SELECTOR = "[data-reprorelay-mask]";
const DEFAULT_IGNORE_SELECTOR = "[data-reprorelay-ignore]";
const TEXT_INPUT_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

export async function captureScreenshot(
  root: HTMLElement = document.body,
  privacy: PrivacyConfig = {},
): Promise<Blob> {
  const maskSelector = validSelector(privacy.maskSelector, DEFAULT_MASK_SELECTOR);
  const ignoreSelector = validSelector(privacy.ignoreSelector, DEFAULT_IGNORE_SELECTOR);
  const canvas = await html2canvas(root, {
    backgroundColor: "#ffffff",
    logging: false,
    ignoreElements: (element) => element.matches(ignoreSelector),
    onclone: (clonedDocument) => {
      redactMatches(clonedDocument, maskSelector);
      if (privacy.maskTextInputs !== false) redactMatches(clonedDocument, TEXT_INPUT_SELECTOR);
    },
  });

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
  if (!blob) throw new Error("Unable to create screenshot blob");
  return blob;
}

function validSelector(candidate: string | undefined, fallback: string): string {
  const selector = candidate ?? fallback;
  try {
    document.querySelector(selector);
    return selector;
  } catch {
    return fallback;
  }
}

function redactMatches(documentRoot: Document, selector: string): void {
  for (const element of documentRoot.querySelectorAll<HTMLElement>(selector)) {
    if (element.dataset.reprorelayRedacted === "true") continue;
    element.dataset.reprorelayRedacted = "true";

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = "[redacted]";
      element.setAttribute("value", "[redacted]");
      element.removeAttribute("placeholder");
      continue;
    }

    if (element instanceof HTMLSelectElement) {
      const option = documentRoot.createElement("option");
      option.textContent = "[redacted]";
      option.selected = true;
      element.replaceChildren(option);
      continue;
    }

    element.replaceChildren(documentRoot.createTextNode("[redacted]"));
    element.style.backgroundColor = "#d1d5db";
    element.style.color = "#111827";
  }
}

export async function startScreenRecording(options: ScreenRecordingOptions = {}): Promise<ActiveScreenRecording> {
  if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Screen recording is not supported in this browser");
  }

  const includeCamera = options.includeCamera === true;
  const includeMicrophone = options.includeMicrophone === true;
  const maxDurationMs = Math.max(5_000, options.maxDurationMs ?? 90_000);
  let displayStream: MediaStream | undefined;
  let userStream: MediaStream | undefined;

  try {
    // This call must remain the first awaited permission request. Browsers require
    // getDisplayMedia to run directly from the user's click handler.
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });

    if (includeCamera || includeMicrophone) {
      if (!navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera and microphone recording are not supported in this browser");
      }

      userStream = await navigator.mediaDevices.getUserMedia({
        video: includeCamera
          ? {
              width: { ideal: 640 },
              height: { ideal: 480 },
              facingMode: "user",
            }
          : false,
        audio: includeMicrophone
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : false,
      });
    }

    const composition = includeCamera && userStream
      ? await composeScreenAndCamera(displayStream, userStream)
      : {
          stream: new MediaStream([
            ...displayStream.getVideoTracks(),
            ...(userStream?.getAudioTracks() ?? []),
          ]),
          stop: () => undefined,
        };

    return createRecordingSession({
      outputStream: composition.stream,
      sourceStreams: [displayStream, ...(userStream ? [userStream] : [])],
      stopComposition: composition.stop,
      includesCamera: includeCamera && Boolean(userStream?.getVideoTracks().length),
      includesMicrophone: includeMicrophone && Boolean(userStream?.getAudioTracks().length),
      maxDurationMs,
    });
  } catch (error) {
    stopStream(displayStream);
    stopStream(userStream);
    throw error;
  }
}

export async function recordScreenForDuration(durationMs = 10_000): Promise<Blob> {
  const recording = await startScreenRecording({ maxDurationMs: durationMs });
  window.setTimeout(() => void recording.stop(), durationMs);
  return (await recording.finished).blob;
}

interface RecordingSessionInput {
  outputStream: MediaStream;
  sourceStreams: MediaStream[];
  stopComposition: () => void;
  includesCamera: boolean;
  includesMicrophone: boolean;
  maxDurationMs: number;
}

function createRecordingSession(input: RecordingSessionInput): ActiveScreenRecording {
  const mimeType = bestVideoMimeType();
  const recorder = new MediaRecorder(input.outputStream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 1_800_000,
    audioBitsPerSecond: 96_000,
  });
  const chunks: BlobPart[] = [];
  const startedAt = Date.now();
  let stopping = false;
  let timeoutId: number | undefined;
  let resolveFinished!: (result: ScreenRecordingResult) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<ScreenRecordingResult>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const cleanup = () => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    input.stopComposition();
    stopStream(input.outputStream);
    for (const stream of input.sourceStreams) stopStream(stream);
  };

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener("error", () => {
    cleanup();
    rejectFinished(new Error("The browser was unable to record the selected screen"));
  }, { once: true });
  recorder.addEventListener("stop", () => {
    cleanup();
    const contentType = normalizeVideoContentType(recorder.mimeType || mimeType);
    resolveFinished({
      blob: new Blob(chunks, { type: contentType }),
      contentType,
      durationMs: Math.max(0, Date.now() - startedAt),
      includesCamera: input.includesCamera,
      includesMicrophone: input.includesMicrophone,
    });
  }, { once: true });

  const stop = async (): Promise<ScreenRecordingResult> => {
    if (!stopping) {
      stopping = true;
      if (recorder.state !== "inactive") recorder.stop();
    }
    return finished;
  };

  input.sourceStreams[0]?.getVideoTracks()[0]?.addEventListener("ended", () => void stop(), { once: true });
  recorder.start(500);
  timeoutId = window.setTimeout(() => void stop(), input.maxDurationMs);

  return {
    startedAt,
    includesCamera: input.includesCamera,
    includesMicrophone: input.includesMicrophone,
    finished,
    stop,
    discard: () => {
      void stop();
    },
  };
}

async function composeScreenAndCamera(
  displayStream: MediaStream,
  userStream: MediaStream,
): Promise<{ stream: MediaStream; stop: () => void }> {
  const screenVideo = createVideo(displayStream);
  const cameraVideo = createVideo(new MediaStream(userStream.getVideoTracks()));
  await Promise.all([playVideo(screenVideo), playVideo(cameraVideo)]);

  const screenTrack = displayStream.getVideoTracks()[0];
  const settings = screenTrack?.getSettings();
  const sourceWidth = settings?.width ?? screenVideo.videoWidth ?? 1920;
  const sourceHeight = settings?.height ?? screenVideo.videoHeight ?? 1080;
  const scale = Math.min(1, 1920 / sourceWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(640, Math.round(sourceWidth * scale));
  canvas.height = Math.max(360, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d");
  if (!context || typeof canvas.captureStream !== "function") {
    throw new Error("Camera overlay recording is not supported in this browser");
  }

  let animationFrame = 0;
  const draw = () => {
    context.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
    drawCameraOverlay(context, cameraVideo, canvas.width, canvas.height);
    animationFrame = window.requestAnimationFrame(draw);
  };
  draw();

  const canvasStream = canvas.captureStream(30);
  for (const track of userStream.getAudioTracks()) canvasStream.addTrack(track);

  return {
    stream: canvasStream,
    stop: () => {
      window.cancelAnimationFrame(animationFrame);
      screenVideo.pause();
      cameraVideo.pause();
      screenVideo.srcObject = null;
      cameraVideo.srcObject = null;
    },
  };
}

function createVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  return video;
}

async function playVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("Unable to read the selected video source")), { once: true });
    });
  }
  await video.play();
}

function drawCameraOverlay(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const width = Math.round(Math.min(canvasWidth * 0.24, 360));
  const height = Math.round(width * 0.75);
  const margin = Math.round(Math.max(18, canvasWidth * 0.018));
  const border = Math.max(4, Math.round(canvasWidth * 0.004));
  const x = canvasWidth - width - margin;
  const y = canvasHeight - height - margin;
  const radius = Math.max(14, Math.round(width * 0.08));

  context.save();
  context.shadowColor = "rgba(8, 12, 10, 0.32)";
  context.shadowBlur = Math.max(12, Math.round(canvasWidth * 0.012));
  context.fillStyle = "#ffffff";
  roundedRect(context, x - border, y - border, width + border * 2, height + border * 2, radius + border);
  context.fill();
  context.restore();

  context.save();
  roundedRect(context, x, y, width, height, radius);
  context.clip();
  drawCover(context, video, x, y, width, height);
  context.restore();
}

function drawCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 480;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }

  context.drawImage(video, sx, sy, sw, sh, x, y, width, height);
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function bestVideoMimeType(): string | undefined {
  // Prefer H.264 MP4: WebM recordings cannot be played back in Safari or on
  // iOS, so a Chrome-recorded VP9 clip is unwatchable for reviewers there.
  // MP4/H.264 decodes everywhere; WebM stays as the fallback for recorders
  // without MP4 muxing support (e.g. Firefox).
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function normalizeVideoContentType(value?: string): RecordingContentType {
  return value?.toLowerCase().startsWith("video/mp4") ? "video/mp4" : "video/webm";
}

function stopStream(stream?: MediaStream): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
