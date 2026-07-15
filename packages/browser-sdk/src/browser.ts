import type { BrowserMetadata, PrivacyConfig } from "@reprorelay/shared";
import { redactUrl } from "@reprorelay/shared";

export function getBrowserMetadata(privacy?: PrivacyConfig): BrowserMetadata {
  return {
    url: redactUrl(window.location.href, privacy),
    title: document.title,
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function describeElement(element: Element): string {
  const role = element.getAttribute("role");
  const ariaLabel = element.getAttribute("aria-label");
  const testId = element.getAttribute("data-testid");
  const id = element.id ? `#${element.id}` : "";
  const className = typeof element.className === "string" && element.className ? `.${element.className.split(/\s+/).slice(0, 2).join(".")}` : "";
  const text = element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80);
  const label = ariaLabel || testId || text || role || element.tagName.toLowerCase();
  return `${element.tagName.toLowerCase()}${id}${className}: ${label}`;
}
