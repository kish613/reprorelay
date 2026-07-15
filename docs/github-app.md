# GitHub Connection

## One-Button Connect (recommended)

Open the dashboard → Workspace settings → **GitHub** → **Connect GitHub**.

GitHub creates a private ReproRelay issues app on your account via the
[app manifest flow](https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
with the right permissions (Issues: read/write, Metadata: read), webhook URL, and
events already configured. You then pick which repositories it can access, and land
back in the dashboard. The app credentials — including the webhook secret — are
stored in the database; **no environment variables are needed**.

After connecting, open the **Projects** tab and choose a repository for each
project. The worker files each report's GitHub issue in its project's repository.

Use **Choose repositories on GitHub** in the GitHub tab to grant access to more
repositories later, and **Disconnect** to remove the stored credentials.

## Manual GitHub App (legacy / env-managed)

Create a GitHub App for the organization that owns client repos.

### Permissions

- Metadata: read
- Issues: read and write
- Issue comments: read and write

### Webhooks

Subscribe to:

- Issues
- Issue comments

Set the webhook URL to:

```text
https://your-reprorelay-api.example.com/v1/webhooks/github
```

Set `WEBHOOK_SECRET` in the API environment. (When an app is connected through
the dashboard, its stored webhook secret takes precedence.)

### Environment

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_BASE64="$(base64 -i private-key.pem)"
GITHUB_INSTALLATION_ID=12345678
GITHUB_OWNER=your-org
GITHUB_REPO=client-repo
```

The env-configured app is a fallback: it is used for reports whose project has no
repository linked in the dashboard.
