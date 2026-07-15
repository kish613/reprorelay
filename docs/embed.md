# Embedding ReproRelay

## Browser SDK

```ts
import { ReproRelay } from "@reprorelay/browser-sdk";

ReproRelay.init({
  projectKey: "proj_client_app",
  apiUrl: "https://reprorelay.example.com",
  release: "1.4.2",
  environment: "production",
  user: {
    id: "user_123",
    email: "client@example.com",
    name: "Client User",
  },
  privacy: {
    maskSelector: "[data-reprorelay-mask]",
    ignoreSelector: "[data-reprorelay-ignore]",
  },
  widget: {
    position: "right-center",
    enableScreenRecording: true,
    enableCameraRecording: true,
    enableMicrophone: true,
    maxRecordingMs: 90000,
  },
});
```

The default launcher is injected at the right side of the viewport. Its Shadow DOM keeps host-application styles from changing the widget. The recording choices are:

- **Screen + voice:** screen capture with microphone narration.
- **Screen + camera:** screen capture with webcam picture-in-picture and microphone narration.
- **No recording:** screenshot, replay, console, network and browser context only.

Pass the signed-in user's email in `user.email` whenever it is available. That lets operators reply to the reporter from the dashboard. If the host app does not provide an email, the widget asks for an optional contact email in the report form; set `widget.collectReporterEmail: false` to hide that field.

Every report also includes a customer-selected priority: Low, Normal, High, or Urgent. These values map to the existing report severity field, so dashboards, GitHub issues, and agent handoffs receive the same priority consistently.

## Customer Status Tab

The widget includes an always-available **Status** tab. It lists reports sent from that browser and refreshes their live progress when opened:

- Open reports stay visible at the top, newest first.
- Resolved reports move into a collapsed, count-labelled section that the customer can expand.

The customer-visible milestones are:

- Received
- Seen by the team
- With engineering
- Resolved

Each new submission stores a private status receipt in that browser's local storage. The receipt can read only a sanitized status projection (timestamps, workflow stage, and whether a screenshot or recording was uploaded); it cannot read comments, identities, internal notes, or evidence URLs. Reports submitted before status receipts were introduced remain visible with their last known status, but cannot be refreshed live.

Authenticated products can instead pass `statusFeedUrl` to load a shared project or organisation feed across browsers. The URL should be a same-origin server endpoint that authenticates the signed-in user and proxies ReproRelay with a server-only project status key; never put that key in browser configuration.

Opening a report in the authenticated dashboard records the first **seen** timestamp automatically. Changing its dashboard status updates what the reporter sees the next time the Status tab refreshes.

| Developer portal action | Customer widget result |
| --- | --- |
| Open the report for the first time | Seen |
| Leave as New | Received, or Seen after it has been opened |
| Set status to Triaged | Under review |
| Set status to Issue created | Fix planned |
| Choose Send to engineering or set With engineering | With engineering |
| Set status to Closed | Resolved and moved into the collapsed Resolved reports section |

Screen and device access always require explicit browser permission. Camera and microphone capture require HTTPS outside local development. The 90-second default is chosen to stay below ReproRelay's default 25 MiB per-asset upload limit at the SDK's recording bitrate; raise both limits together if you allow longer recordings.

## Plain HTML / Script Tag

Use the standalone IIFE build for static sites, Vue, Angular, server-rendered pages or any application that can load a script. Every ReproRelay deployment serves the current SDK at `/sdk/reprorelay.js`, so embedding from your own deployment keeps client sites on the latest SDK automatically:

```html
<script src="https://reprorelay.example.com/sdk/reprorelay.js"></script>
<script>
  ReproRelay.init({
    projectKey: "proj_client_app",
    apiUrl: "https://reprorelay.example.com",
  });
</script>
```

The dashboard's Workspace settings → Projects → Setup shows this snippet pre-filled for each project. If you previously copied `reprorelay.iife.js` into a client project, replace it with this script tag (or refresh the copied file after each ReproRelay deploy) — stale SDK copies miss capture fixes.

Set `widget.logoUrl` if you want a self-hosted or white-label launcher image. Header attribution is off by default. To show your own attribution, set `widget.showAttribution: true` with `widget.attributionName` and, optionally, `widget.attributionLabel` and `widget.attributionLogoUrl`. Set `autoInjectButton: false` when you want to call `ReproRelay.show()` from your own control.

## React

```tsx
import { ReproRelayProvider } from "@reprorelay/react";

export function App() {
  return (
    <ReproRelayProvider
      config={{
        projectKey: "proj_client_app",
        apiUrl: "https://reprorelay.example.com",
        release: "1.4.2",
      }}
    >
      <YourApp />
    </ReproRelayProvider>
  );
}
```

## Manual Context

```ts
ReproRelay.setContext({ accountId: "acct_123", plan: "enterprise" });
ReproRelay.addBreadcrumb({ type: "custom", message: "User opened billing drawer" });
```

## Privacy Markup

```html
<input data-reprorelay-mask value="sensitive value" />
<section data-reprorelay-ignore>Never capture this DOM subtree</section>
```
