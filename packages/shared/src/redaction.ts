import type { NetworkEvent, PrivacyConfig } from "./schemas.js";
import { defaultPrivacyConfig } from "./schemas.js";

const SECRET_KEY_PATTERN = /(authorization|cookie|token|secret|password|api[-_]?key|session|jwt)/i;
const SENSITIVE_QUERY_PATTERN = /(token|secret|password|key|session|jwt|code|state)/i;

export function redactText(value: string): string {
  if (!value) return value;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[redacted-key]")
    .replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1@[redacted]");
}

export function redactUrl(rawUrl: string, privacy?: PrivacyConfig): string {
  const merged = { ...defaultPrivacyConfig, ...privacy };

  try {
    const url = new URL(rawUrl, "https://reprorelay.local");
    if (merged.redactQueryStrings) {
      for (const key of Array.from(url.searchParams.keys())) {
        url.searchParams.set(key, SENSITIVE_QUERY_PATTERN.test(key) ? "[redacted]" : "[value]");
      }
    }

    const output = url.toString();
    if (rawUrl.startsWith("http")) return output;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return redactText(rawUrl);
  }
}

export function redactHeaders(headers: Record<string, string> = {}, privacy?: PrivacyConfig): Record<string, string> {
  const allowed = new Set((privacy?.allowedRequestHeaders ?? []).map((header) => header.toLowerCase()));

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const shouldKeep = allowed.has(key.toLowerCase()) && !SECRET_KEY_PATTERN.test(key);
      return [key, shouldKeep ? redactText(value) : "[redacted]"];
    }),
  );
}

export function redactNetworkEvent(event: NetworkEvent, privacy?: PrivacyConfig): NetworkEvent {
  return {
    ...event,
    url: redactUrl(event.url, privacy),
    requestHeaders: event.requestHeaders ? redactHeaders(event.requestHeaders, privacy) : undefined,
  };
}

export function shouldMaskElement(element: Element, privacy?: PrivacyConfig): boolean {
  const merged = { ...defaultPrivacyConfig, ...privacy };
  if (element.matches(merged.maskSelector)) return true;

  if (!merged.maskTextInputs) return false;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;

  return element instanceof HTMLInputElement
    ? ["password", "email", "tel", "text", "search", "url"].includes(element.type)
    : true;
}
