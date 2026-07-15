# Contributing

ReproRelay is intentionally small and self-hostable. Contributions should preserve that shape:

- Keep the browser SDK privacy-first by default.
- Do not add AGPL dependencies to runtime packages.
- Keep provider integrations isolated behind packages or adapters.
- Add tests for capture, redaction, issue formatting, and provider handoff behavior.
- Document any new data collected by the SDK.

Use GitHub Issues for bugs and focused feature requests, and Discussions for setup help or early ideas. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). All project participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Before opening a PR:

```bash
npm install
npm run check
```
