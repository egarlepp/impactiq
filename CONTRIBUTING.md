# Contributing to ImpactIQ

Thanks for helping. Bug reports, fixes and focused features are all welcome.

## Before you start

- Read `CLAUDE.md`. It is the project's rulebook (architecture, RBAC, i18n, dark mode, naming) and applies to every change, whether written by a person or an AI assistant.
- For anything larger than a small fix, open an issue first so the approach can be agreed before you write code.
- Security issues go through private reporting, never a public issue. See `SECURITY.md`.

## Development setup

```bash
cp .env.example .env          # fill in POSTGRES_PASSWORD, SESSION_SECRET, TOKEN_ENCRYPTION_KEY
docker compose up postgres -d
npm install
npm run dev                   # client on :5173, server on :3000
```

## Checks to run before a pull request

```bash
npx tsc --noEmit -p tsconfig.server.json
(cd src/client && npx tsc -b --noEmit)
npm test
python3 scripts/check-i18n-parity.py
python3 scripts/check-banned-terms.py
```

CI runs the same checks and migrates an empty Postgres on every pull request.

## Rules that reviews enforce

- **Every user-facing string goes through `t()`**, and all seven locale files (`en`, `de`, `fr`, `es`, `ja`, `pt`, `it`) get the key in the same pull request, translated, not copied from English. Locale files use CRLF line endings.
- **Every protected route checks roles server-side** and scopes its query to teams the caller can see.
- **Never edit an existing migration.** Add a new `.sql` file and its `_journal.json` entry.
- **No secrets, tokens or customer data** in code, tests, fixtures or logs. Use Acme-style placeholders; never name a real customer or employer.
- **Light and dark mode** for every new surface (`dark:` classes alongside the light ones).
- **Version bumps** update `package.json`, `src/shared/appVersion.ts`, `src/shared/changelog.ts` (with a category) and `docs/history.md` together.

## Pull requests

Keep each pull request to one change, describe what it does and how you tested it, and fill in the template. By submitting a contribution you agree it is licensed under the Apache License 2.0, as the rest of the project is.
