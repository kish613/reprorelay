# Gleap-Inspired Product Roadmap

Research date: 2026-07-10

Implementation sequence: [Gleap-inspired implementation plan](gleap-parity-implementation-plan.md)

## Executive Read

Gleap is no longer just a visual bug reporter. Its current product joins four loops in one workspace:

1. Capture a problem with technical evidence.
2. Triage, assign, automate, and discuss the resulting ticket.
3. Talk back to the customer or deflect the question with self-service support.
4. Turn recurring feedback into roadmap items, releases, surveys, and onboarding.

ReproRelay already has the right open-source wedge: evidence-rich browser reports, GitHub sync, and a human-reviewed coding-agent handoff. It should not immediately copy Gleap's entire support and marketing suite. The best route is to become the strongest self-hosted, Git-native issue intelligence system first, then add the customer feedback loop around that core.

## Research Basis And Limits

This benchmark uses Gleap's public pricing, help center, SDK repositories, and public review summaries. It did not use a logged-in Gleap workspace, so detailed interaction quality and administration flows still need hands-on validation.

Primary sources:

- [Gleap pricing and plan feature matrix](https://www.gleap.io/pricing)
- [Gleap bug reporting workflow](https://help.gleap.io/en/articles/32-getting-started-with-gleap-s-bug-reporting)
- [Gleap developer capture options](https://help.gleap.io/en/articles/31-developer-options)
- [Gleap workflow actions](https://help.gleap.io/en/articles/56-workflow-actions)
- [Gleap public roadmap and feature requests](https://help.gleap.io/en/articles/141-getting-started-with-gleap-s-public-product-roadmap)
- [Gleap integrations](https://help.gleap.io/en/articles/2-getting-started-with-integrations)
- [Gleap AI knowledge sources](https://help.gleap.io/en/articles/95-get-started-with-kai-ai-bot)
- [Gleap supported SDKs on GitHub](https://github.com/GleapSDK)

Public user signal:

- [G2 review summary](https://www.g2.com/products/gleap-gleap/reviews?qs=pros-and-cons) highlights easy setup, broad functionality, automation, and centralized feedback as strengths. It also flags advanced-feature learning curve, filtering, ticket merging, email handling, and some performance or polish concerns. These are directional anecdotes, not a complete user study.

## Current ReproRelay Baseline

Already present in this repository:

- Browser and React SDKs with an in-app report form.
- DOM replay, screenshot, optional permission-gated screen video, console logs, fetch metadata, routes, and click breadcrumbs.
- Conservative input masking and token, cookie, header, and query-value redaction.
- Fastify API, Postgres or memory storage, and local, S3-compatible, or Vercel Blob evidence storage.
- A triage dashboard with evidence, technical context, GitHub state, and a human review gate.
- GitHub issue creation, deterministic AI triage, and guarded Claude, Codex, Copilot, or custom handoff adapters.

Important gaps:

- No dashboard identity, project membership, or role-based access control.
- No embedded replay player or screenshot annotation workflow.
- No XHR, global JavaScript error, unhandled rejection, crash, or rage-click capture yet.
- No assignees, teams, tags, due dates, internal notes, customer replies, or saved views.
- No duplicate detection or merge model.
- GitHub is the only first-class issue tracker connector.
- No feature-request board, public roadmap, changelog, survey, knowledge base, or live support inbox.
- Web is the only supported client platform.

## Features To Take From Gleap

### P0: Make The Bug-To-Fix Loop Excellent

These are prerequisites for a trustworthy hosted or self-hosted product.

| Capability | What to take | ReproRelay move |
| --- | --- | --- |
| Workspace security | Projects, memberships, roles, private evidence, auditability | Add users, organizations, projects, RBAC, service tokens, signed asset reads, retention controls, and an audit log |
| Visual evidence | Annotated screenshots and replay that can be inspected inside the ticket | Add screenshot drawing tools, an embedded rrweb player, replay timeline markers, and privacy-block indicators |
| Capture reliability | Console and network context plus automatic failure signals | Add XHR, global errors, unhandled rejections, resource failures, rage clicks, release/source-map context, offline buffering, and upload retry |
| Ticket operations | A real operational inbox, not a report list | Add status workflow, priority, assignee/team, tags, due date, internal notes, customer-visible replies, bulk actions, filters, and saved views |
| Duplicate management | Similar reports should converge on one problem | Fingerprint route, release, error, failed request, and stack; suggest duplicates; merge occurrences while keeping every reporter and evidence set |
| Git-native delivery | Rich handoff without losing the customer record | Make GitHub sync bidirectional, map labels and state, link commits/PRs/releases, and notify reporters when the issue changes |
| Integration framework | Connector behavior should be reusable | Define a connector contract and webhook/event bus, then add Linear and Jira after GitHub is solid |

The first implementation pass in this benchmark hardens the ingestion boundary by binding reports and local uploads to an issued short-lived session, adding an optional project-key allowlist, validating evidence type/key ownership, enforcing upload limits, canonicalizing evidence URLs, and bounding untrusted payload collections.

### P1: Close The Customer Feedback Loop

This is where Gleap becomes more valuable than a standalone bug reporter.

| Capability | Why it matters | Suggested scope |
| --- | --- | --- |
| Reporter conversation | Engineers can ask the original reporter a question without starting a separate email thread | Ticket comments with internal/customer visibility, email notifications, secure reply links, and reporter status updates |
| Contact timeline | A report is more useful when support history and customer value are visible | Contact identity, account/tenant, plan, prior reports, open issues, and consent/privacy state |
| Rules and workflows | Automation keeps a growing inbox usable | Event-condition-action rules for tag, priority, assign, webhook, GitHub sync, notify, and close; keep a human gate for coding-agent writes |
| Team routing and SLA | Ownership and response health become measurable | Teams, round-robin or balanced assignment, operating hours, first-response targets, breach alerts, and queue health |
| Feature requests and roadmap | Repeated requests become structured product evidence | Separate request type, duplicate suggestions, votes, comments, public/private columns, subscribers, and status notifications |
| Changelog and release loop | Users should hear when their report or request ships | Release posts tied to issues and roadmap items, targeted notifications, and reporter follow-up |
| Surveys | Lightweight product signal belongs beside tickets | NPS, CSAT, CES, and custom micro-surveys with audience rules and report/contact linkage |
| Product analytics | Teams need to see whether the loop is improving | Volume, duplicates, time to triage, time to resolution, reopen rate, top routes/releases, agent outcomes, and privacy-safe capture failure rates |

### P2: Expand Into Support And Engagement Carefully

These are valuable, but each is effectively another product. Build them after the issue and feedback loops are strong.

- Knowledge base with public articles, versioning, search, and embeddable contextual help.
- Retrieval-based answer bot grounded in approved articles and URLs, with citations, confidence, no-answer handling, evaluation, and human escalation.
- Agent copilot for summaries, reply drafts, translation, classification, and safe tool calls.
- Live chat and shared inbox, followed by email; defer WhatsApp, Instagram, Messenger, Telegram, and other channels until the core conversation model is stable.
- Product tours, checklists, banners, tooltips, modals, and outbound messaging with audience targeting.
- Native SDKs. Start with React Native or Flutter only after the web SDK has a stable capture protocol and a platform-neutral SDK specification.
- Enterprise controls such as SSO, SCIM, advanced retention, data residency, export, legal hold, custom encryption keys, and compliance evidence.

## What Not To Copy Yet

Avoid turning the first releases into a broad Intercom replacement.

- Do not build every support channel before private workspaces and ticket permissions exist.
- Do not add autonomous AI actions before there is an audit log, scoped tools, approvals, retries, and idempotency.
- Do not build product tours before capture reliability, replay inspection, and triage are genuinely good.
- Do not hide weak deterministic workflows behind an AI label. Duplicate clustering, tagging, and routing need visible evidence and human override.
- Do not couple the core issue model directly to GitHub, Jira, or one AI provider. Keep connectors and agent adapters replaceable.

## Recommended Delivery Sequence

### Milestone 0: Production Trust Boundary

- Complete ingestion session binding and payload limits.
- Add dashboard authentication, organizations, projects, roles, API/service tokens, and private asset authorization.
- Add migrations instead of runtime-only table creation, lifecycle cleanup for expired sessions, rate limits, and retention jobs.
- Add security tests for cross-project reads/writes, replay privacy, webhook replay, malicious asset keys, and oversized payloads.

Exit condition: one organization cannot read or mutate another organization's reports or evidence, and every sensitive action is attributable.

### Milestone 1: Best-In-Class Issue Evidence

- Embedded replay player and screenshot annotation.
- XHR and global error capture, upload retry, offline queue, source maps, and release health.
- Rich ticket workflow, comments, tags, assignees, saved views, and duplicate groups.
- Bidirectional GitHub sync and reporter notifications.

Exit condition: a developer can understand, reproduce, discuss, and ship the majority of valid web reports without leaving the ticket.

### Milestone 2: Feedback Operations

- Workflow engine, teams, SLA, audit log, and analytics.
- Connector SDK plus Linear, Jira, generic webhook, and Slack notifications.
- Contacts and account timeline.

Exit condition: a support or product team can operate the queue daily without using the database or relying on GitHub as the dashboard.

### Milestone 3: Public Product Loop

- Feature requests, duplicate suggestions, voting, public roadmap, subscriptions, and changelog.
- NPS, CSAT, CES, and targeted surveys.
- Close-the-loop notifications tied to shipped issues and releases.

Exit condition: customer input can move from report or request to public status and release notification while retaining its evidence trail.

### Milestone 4: Optional Support Platform

- Knowledge base and grounded answer bot.
- Live chat, email, copilot, and approved tools.
- Product onboarding and outbound messaging.
- Mobile SDKs and enterprise controls.

Exit condition: expand only when adopters are choosing ReproRelay as their customer-support system, not merely asking for one adjacent feature.

## Open-Source Differentiation

The strongest positioning is not "free Gleap." It is:

> A self-hosted, evidence-first customer issue system that connects users, maintainers, Git repositories, and coding agents without giving up control of source code or support data.

That suggests durable product principles:

- Self-hosting is a first-class tested path, not a source-code dump.
- The capture protocol and connector contracts are documented and stable.
- Evidence privacy is visible, configurable, and safe by default.
- AI is optional, provider-neutral, attributable, and approval-gated for writes.
- GitHub remains excellent, but the domain model is not GitHub-shaped.
- Every report, duplicate, conversation, fix, release, and notification remains one traceable feedback loop.
