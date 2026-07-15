# Agent Handoff

ReproRelay defaults to human-reviewed handoff.

Reports become GitHub issues first. The worker can generate an AI triage draft automatically, but agent triggers are blocked until a human approves handoff in the dashboard. After approval, configured rules decide which agent trigger is sent.

The default rules are:

- Claude: high and critical reports
- Codex: high and critical reports
- Copilot: critical reports through a `copilot` label

## Environment

```bash
AGENT_HANDOFF_MODE=triage
CLAUDE_TRIGGER=@claude
CODEX_TRIGGER=@codex
COPILOT_LABEL=copilot
```

Human review is not bypassable in V1. Agent adapters only run after the dashboard stores `humanReview.agentHandoffApproved=true`.

Set `AGENT_HANDOFF_MODE=manual` to disable agent comments and labels even after review.

## Review Flow

1. Client submits a report.
2. Worker creates an AI triage draft with summary, likely area, severity recommendation, labels, suggested tests, and an agent prompt.
3. Worker creates or updates the GitHub issue with the triage draft.
4. Dashboard shows the report as `Needs review`.
5. A human chooses either `Approve handoff` or `Keep manual`.
6. Only approved reports can trigger Claude, Codex, Copilot, or custom agent adapters.

## Workflow Templates

See `.github/agent-workflows/claude-code-action.yml` and `.github/agent-workflows/codex-action.yml`.

These templates are intentionally not active workflows. Copy the one you want into `.github/workflows/` inside a client repo after reviewing permissions.
