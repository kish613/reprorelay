import type { Breadcrumb, ConsoleEvent, NetworkEvent, PrivacyConfig } from "@reprorelay/shared";
import { redactNetworkEvent, redactText, redactUrl } from "@reprorelay/shared";
import { record } from "rrweb";
import { describeElement } from "./browser.js";
import type { CapturedState } from "./types.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export class CaptureController {
  private readonly breadcrumbs: Breadcrumb[] = [];
  private readonly consoleEvents: ConsoleEvent[] = [];
  private readonly networkEvents: NetworkEvent[] = [];
  private readonly replayEvents: unknown[] = [];
  private stopReplay?: () => void;
  private stopListeners: Array<() => void> = [];
  private readonly originalConsole = new Map<"debug" | "info" | "warn" | "error", (...args: unknown[]) => void>();
  private originalFetch?: typeof fetch;

  constructor(private readonly privacy?: PrivacyConfig) {}

  start(options: { replay?: boolean; console?: boolean; network?: boolean; clicks?: boolean; routes?: boolean } = {}): void {
    if (options.replay !== false) this.startReplay();
    if (options.console !== false) this.startConsole();
    if (options.network !== false) this.startNetwork();
    if (options.clicks !== false) this.startClicks();
    if (options.routes !== false) this.startRoutes();
  }

  stop(): void {
    this.stopReplay?.();
    this.stopReplay = undefined;
    for (const stop of this.stopListeners.splice(0)) stop();
    this.restoreConsole();
    this.restoreNetwork();
  }

  addBreadcrumb(input: Omit<Breadcrumb, "timestamp"> & { timestamp?: string }): void {
    this.breadcrumbs.push({
      ...input,
      timestamp: input.timestamp ?? new Date().toISOString(),
    });
    this.trim();
  }

  snapshot(): CapturedState {
    return {
      breadcrumbs: [...this.breadcrumbs],
      consoleEvents: [...this.consoleEvents],
      networkEvents: [...this.networkEvents],
      replayEvents: [...this.replayEvents],
    };
  }

  private startReplay(): void {
    if (this.stopReplay) return;

    this.stopReplay = record({
      emit: (event) => {
        this.replayEvents.push(event);
        if (this.replayEvents.length > 5000) this.replayEvents.splice(0, this.replayEvents.length - 5000);
      },
      maskAllInputs: true,
      maskTextSelector: this.privacy?.maskSelector ?? "[data-reprorelay-mask]",
      blockSelector: this.privacy?.ignoreSelector ?? "[data-reprorelay-ignore]",
    });
  }

  private startClicks(): void {
    const handler = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target) return;
      if (target.closest(this.privacy?.ignoreSelector ?? "[data-reprorelay-ignore]")) return;

      this.addBreadcrumb({
        type: "click",
        message: describeElement(target),
        data: { x: event.clientX, y: event.clientY },
      });
    };

    document.addEventListener("click", handler, { capture: true });
    this.stopListeners.push(() => document.removeEventListener("click", handler, { capture: true }));
  }

  private startRoutes(): void {
    let lastUrl = window.location.href;
    const pushRoute = () => {
      const nextUrl = window.location.href;
      if (nextUrl === lastUrl) return;
      lastUrl = nextUrl;
      this.addBreadcrumb({ type: "route", message: redactUrl(nextUrl, this.privacy) });
    };

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    history.pushState = (...args) => {
      const result = originalPushState(...args);
      queueMicrotask(pushRoute);
      return result;
    };

    history.replaceState = (...args) => {
      const result = originalReplaceState(...args);
      queueMicrotask(pushRoute);
      return result;
    };

    window.addEventListener("popstate", pushRoute);
    this.stopListeners.push(() => {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      window.removeEventListener("popstate", pushRoute);
    });
  }

  private startConsole(): void {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      if (this.originalConsole.has(level)) continue;
      const original = console[level].bind(console);
      this.originalConsole.set(level, original);
      console[level] = (...args: unknown[]) => {
        this.consoleEvents.push({
          level,
          message: redactText(args.map((arg) => stringifyConsoleArg(arg)).join(" ")).slice(0, 2000),
          timestamp: new Date().toISOString(),
        });
        this.trim();
        original(...args);
      };
    }
  }

  private restoreConsole(): void {
    for (const [level, original] of this.originalConsole.entries()) {
      console[level] = original;
    }
    this.originalConsole.clear();
  }

  private startNetwork(): void {
    if (this.originalFetch || typeof window.fetch !== "function") return;

    this.originalFetch = window.fetch.bind(window);
    window.fetch = async (input: FetchInput, init?: FetchInit) => {
      const startedAt = performance.now();
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      try {
        const response = await this.originalFetch!(input, init);
        this.recordNetwork({
          method,
          url,
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return response;
      } catch (error) {
        this.recordNetwork({
          method,
          url,
          durationMs: Math.round(performance.now() - startedAt),
        });
        throw error;
      }
    };
  }

  private restoreNetwork(): void {
    if (this.originalFetch) {
      window.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
  }

  private recordNetwork(event: NetworkEvent): void {
    this.networkEvents.push(redactNetworkEvent(event, this.privacy));
    this.addBreadcrumb({ type: "network", message: `${event.method} ${redactUrl(event.url, this.privacy)}` });
    this.trim();
  }

  private trim(): void {
    if (this.breadcrumbs.length > 200) this.breadcrumbs.splice(0, this.breadcrumbs.length - 200);
    if (this.consoleEvents.length > 100) this.consoleEvents.splice(0, this.consoleEvents.length - 100);
    if (this.networkEvents.length > 100) this.networkEvents.splice(0, this.networkEvents.length - 100);
  }
}

function stringifyConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
