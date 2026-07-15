# Railway Deployment

ReproRelay deploys to Railway as three services from one shared monorepo:

- `reprorelay-api` - Fastify API for sessions, uploads, reports, assets, and GitHub webhooks.
- `reprorelay-worker` - background worker that creates GitHub issues and queues agent handoff.
- `reprorelay-dashboard` - static React/Vite dashboard served by Nginx.

Railway supports custom config-as-code files, so each service uses its own file under `railway/`.

## 1. Create The Railway Project

1. Create an empty Railway project.
2. Add a Railway Postgres database.
3. Create three empty services named `reprorelay-api`, `reprorelay-worker`, and `reprorelay-dashboard`.
4. Connect each service to the same GitHub repo.

Do not set a Railway root directory for these services. This is a shared npm workspace monorepo, so each service needs the repo root plus its shared packages.

## 2. Set Config File Paths

In each service's settings, set the custom config file path:

| Service | Config file path |
| --- | --- |
| `reprorelay-api` | `/railway/api.railway.json` |
| `reprorelay-worker` | `/railway/worker.railway.json` |
| `reprorelay-dashboard` | `/railway/dashboard.railway.json` |

The config files select the right Dockerfile, health check, restart policy, and watch paths.

## 3. Generate Public Domains

Generate public domains for:

- `reprorelay-api`
- `reprorelay-dashboard`

The worker does not need a public domain.

Use the generated values in the env vars below:

- `https://<api-domain>` for API URLs.
- `https://<dashboard-domain>` for dashboard/public URLs.

## 4. Configure API Variables

Set these on `reprorelay-api`:

```bash
NODE_ENV=production
REPRORELAY_API_URL=https://<api-domain>
CORS_ORIGINS=https://<dashboard-domain>,https://<client-app-domain>
DATABASE_URL=${{Postgres.DATABASE_URL}}
WEBHOOK_SECRET=<github-webhook-secret>

STORAGE_DRIVER=s3
S3_ENDPOINT=<r2-or-s3-endpoint>
S3_REGION=auto
S3_BUCKET=reprorelay
S3_ACCESS_KEY_ID=<access-key-id>
S3_SECRET_ACCESS_KEY=<secret-access-key>
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_URL=
```

For Cloudflare R2, `S3_ENDPOINT` usually looks like:

```bash
https://<account-id>.r2.cloudflarestorage.com
```

Leave `S3_PUBLIC_URL` blank for private buckets. The API will proxy dashboard asset reads through `/v1/assets/:objectKey`. If you later put the bucket behind a public custom domain, set `S3_PUBLIC_URL` to that origin to let the dashboard load assets directly.

Railway can also use Vercel Blob for evidence storage:

```bash
STORAGE_DRIVER=vercel-blob
VERCEL_BLOB_ACCESS=private
BLOB_READ_WRITE_TOKEN=<blob-read-write-token>
```

## 5. Configure Worker Variables

Set these on `reprorelay-worker`:

```bash
NODE_ENV=production
REPRORELAY_API_URL=https://<api-domain>
REPRORELAY_PUBLIC_URL=https://<dashboard-domain>
WORKER_INTERVAL_MS=15000

GITHUB_APP_ID=<github-app-id>
GITHUB_PRIVATE_KEY_BASE64=<base64-private-key>
GITHUB_INSTALLATION_ID=<installation-id>
GITHUB_OWNER=<repo-owner>
GITHUB_REPO=<repo-name>

AGENT_HANDOFF_MODE=triage
CLAUDE_TRIGGER=@claude
CODEX_TRIGGER=@codex
COPILOT_LABEL=copilot
```

If the GitHub App variables are missing, the worker uses the dry-run GitHub client. That is useful for first deploy smoke tests, but real issues will not be created until the GitHub App is configured.

## 6. Configure Dashboard Variables

Set this on `reprorelay-dashboard` before deploying:

```bash
VITE_REPRORELAY_API_URL=https://<api-domain>
```

This value is baked into the Vite build. If you change it after deploy, redeploy the dashboard service.
The Railway dashboard Dockerfile uses the normal live build. It does not include the showcase data source, fixture identities, or showcase evidence assets. Do not replace the Docker build command with `build:showcase` for a production service.

## 7. GitHub App Webhook

In the GitHub App settings:

- Webhook URL: `https://<api-domain>/v1/webhooks/github`
- Webhook secret: same value as `WEBHOOK_SECRET`
- Permissions: metadata read, issues write, issue comments write.
- Subscribe to: issues and issue comments.

Install the GitHub App on the target repo and copy the installation ID into `GITHUB_INSTALLATION_ID`.

## 8. Client Embed URL

Client apps should initialize the SDK with the Railway API URL:

```ts
ReproRelay.init({
  projectKey: "proj_client",
  apiUrl: "https://<api-domain>",
  environment: "production",
});
```

Also add each client app origin to `CORS_ORIGINS` on the API service.

## 9. Smoke Test

1. Open `https://<api-domain>/health` and expect `{ "ok": true, "service": "reprorelay-api" }`.
2. Open `https://<dashboard-domain>/health` and expect `ok`.
3. Submit a report from the demo/client app.
4. Confirm the report appears in the dashboard.
5. Confirm the worker creates or dry-runs the GitHub issue in worker logs.

## Notes

- Railway service files are ephemeral, so production evidence storage should use S3-compatible object storage or Vercel Blob, not local uploads.
- Redis is included in local Docker Compose for the future queue backend. The current worker polls the API and does not require Redis on Railway yet.
- Keep `CORS_ORIGINS` strict. Add dashboard and client app origins explicitly.
