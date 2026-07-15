# Privacy And Security

ReproRelay is designed for client projects, so the default stance is conservative.

## Data Collected

- Browser URL with query values redacted
- Page title, user agent, viewport, language, and timezone
- Click descriptions, route changes, console events, and fetch metadata
- rrweb replay events with input masking
- Screenshot when a report is submitted
- Optional 10 second screen recording after browser permission
- User/context fields provided by the host app

## Redaction Defaults

- Passwords, tokens, cookies, authorization headers, and session-like values are redacted.
- Query string values are replaced by `[value]` or `[redacted]`.
- Text-like inputs are masked.
- Elements matching `[data-reprorelay-mask]` are masked.
- Elements matching `[data-reprorelay-ignore]` are ignored by widget capture helpers.

## Production Checklist

- Set strict `CORS_ORIGINS`.
- Set `REPRORELAY_PROJECT_KEYS` so unknown public project keys cannot mint upload sessions.
- Set `REPRORELAY_MAX_UPLOAD_BYTES` to the smallest limit that fits the enabled evidence types.
- Use HTTPS for API, dashboard, and storage.
- Use S3/R2/MinIO presigned uploads with short expirations.
- Configure GitHub webhook secret verification.
- Keep GitHub App permissions to metadata read, issues write, and issue comments write.
- Avoid sending direct personal contact, payment, health, or credential data to agent comments.
- Review public-repo AI agent workflows carefully before allowing automatic write permissions.

## Evidence Retention

The default Vercel deployment runs `/v1/internal/retention` daily at 03:00 UTC. Set `CRON_SECRET` so Vercel can authenticate that request. Video objects older than `REPRORELAY_VIDEO_RETENTION_DAYS` (seven days by default) are deleted from the configured storage provider and removed from the report. The report, screenshot, replay, triage, notes, and external issue links remain available.

The cleanup is idempotent: rerunning it does not delete the same object twice or alter reports whose videos have already expired. Self-hosted deployments should call the same authenticated route from their scheduler.

## Ingestion Boundary

- Report submissions must present the same short-lived upload token issued for their session.
- Local evidence uploads re-check that token and verify the object key and content type belong to the session.
- Submitted evidence URLs are rebuilt by the API rather than trusted from the browser payload.
- Asset types, upload sizes, collection lengths, string lengths, and custom-context key counts are bounded by shared schemas and API limits.

These controls reduce cross-session evidence references and accidental resource exhaustion. They do not replace dashboard authentication, project membership, private asset authorization, rate limiting, retention jobs, or a full multi-tenant security review; those remain production prerequisites.
