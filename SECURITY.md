# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue, pull request or discussion for them.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- what the issue is and where it lives (file, route or screen),
- the steps or a request that reproduces it,
- the version you tested (`APP_VERSION`, shown in the sidebar version chip),
- what an attacker could do with it.

You should get a first reply within 7 days. Once a fix is ready, it ships in a release whose changelog entry is filed under **Security & Compliance**, and the advisory is published after that release is out.

## Supported versions

Only the latest release on `main` receives security fixes. ImpactIQ is self-hosted, so please update before reporting an issue that a newer release may already fix.

## Scope

In scope: the ImpactIQ server, client, Docker image and Compose file in this repository.

Out of scope: vulnerabilities in a third-party service ImpactIQ connects to (Salesforce, HubSpot, Microsoft Graph, Okta, Gong, AI providers), findings that need an already-compromised App Admin account or host, and missing hardening on a deployment that ignores the README (for example, publishing Postgres to the internet).

## Hardening reminders for operators

- Generate `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` with `openssl rand -hex 32`. The server refuses to start in production with the `.env.example` placeholders.
- Set a strong `POSTGRES_PASSWORD` and keep Postgres off public interfaces (the Compose file binds it to `127.0.0.1`).
- Run behind HTTPS and set **Trusted proxy hops** (Admin → Integrations → Rate Limiting, or `TRUSTED_PROXY_HOPS`) to the real number of proxies in front of the app.
