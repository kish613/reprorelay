# @reprorelay/browser-sdk

Browser capture SDK for [ReproRelay](https://github.com/kish613/reprorelay) — an open-source client bug capture system. Adds a "Report issue" widget that captures DOM replay, screenshot, optional screen recording (MP4), console/network context, and submits it to your ReproRelay deployment. Its Status tab lets the submitting browser follow acknowledgement and fixing progress through to resolution.

Pass `statusFeedUrl` to let a logged-in account or organisation load a shared cross-browser status feed through its own authenticated, same-origin server endpoint. Without it, private per-browser status receipts remain the default.

```ts
import { ReproRelay } from "@reprorelay/browser-sdk";

ReproRelay.init({
  projectKey: "proj_your_project",
  apiUrl: "https://your-reprorelay.example.com",
  user: { id: "user_123", email: "client@example.com", name: "Client User" },
});
```

Providing `user.email` makes dashboard email replies available immediately. When it is omitted, the default report form offers an optional reporter email field.

Or use the standalone script your ReproRelay deployment serves at `/sdk/reprorelay.js`.

See the [embedding guide](https://github.com/kish613/reprorelay/blob/main/docs/embed.md) for recording options, privacy masking, and React usage.

Licensed under the repository's [MIT License](https://github.com/kish613/reprorelay/blob/main/LICENSE). See the project notice for original-creator credit.
