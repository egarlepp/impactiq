// Build-time app version. Source of truth: package.json at repo root.
// Update both in lockstep when releasing (see CLAUDE.md §20b — a version
// bump with no matching src/shared/changelog.ts entry is incomplete).
//
// Lives in src/shared/ (not src/client/) so the server can import the exact
// same constant — the App Update check (services/updates/checkForUpdates.ts)
// compares this against the pinned branch's own CHANGELOG[0].version with no
// separate GIT_SHA/build-time injection needed. src/client/lib/version.ts
// re-exports this verbatim for existing client call sites.
export const APP_VERSION = '1.479.1'
