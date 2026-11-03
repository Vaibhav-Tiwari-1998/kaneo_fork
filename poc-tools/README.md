# Kaneo without @better-auth/kysely-adapter

Base code: `usekaneo/kaneo` commit `dd92f6bc9b5f86b3b4dfc396026350d220e129a5` (Better Auth 1.7.14).
Result: Kaneo installs and runs without downloading `@better-auth/kysely-adapter`. No other package version changes.

## The changes (4 files, in `kaneo-overlay\`)

| File | Change |
| --- | --- |
| `apps/api/src/auth.ts` | One line: `betterAuth` is imported from `better-auth/minimal`, Better Auth's official entry point for apps that use a database adapter (Kaneo uses Drizzle). It doesn't load the Kysely adapter. |
| `patches/@better-auth__api-key@1.7.14.patch` | New. One line in the API-key plugin: `BetterAuthError` is imported from `@better-auth/core/error` instead of `better-auth`. It is the same class; `better-auth` only re-exports it. Without this, the plugin loads Better Auth's full entry point, which loads the Kysely adapter. |
| `pnpm-workspace.yaml` | Adds `"@better-auth/kysely-adapter": "-"` under `overrides` (removes it from the install) and registers the patch under `patchedDependencies`. |
| `pnpm-lock.yaml` | Regenerated. The only package change is the removed Kysely adapter, plus the patch hash for the API-key plugin. |

`changes-for-security-review.diff` shows every changed line.

## How to use it

1. Commit the four files in `kaneo-overlay\` to a branch of the internal Kaneo repo, at their same paths.
2. Download the zip of that branch and follow the normal setup steps. The install stays `--frozen-lockfile`.
3. Optional: `node check-deps.mjs --registry <mirror-url>` checks the 1,583 packages in `kaneo-packages.txt` against the mirror.

## What was tested (Linux, Node.js 24, pnpm 12.15.0, PostgreSQL 16)

- Fresh frozen install: `@better-auth/kysely-adapter` not downloaded
- Shared packages and the web app build
- API start, database migrations, no "Drizzle schema mismatch"
- Sign-up, sign-in, wrong-password rejection (401)
- API key creation, bad API key rejection (401), Kaneo MCP server `whoami`
- Sign-in through the web UI in a browser, with no console errors

## Caveat

This is a local change to Kaneo and to a Better Auth plugin. It must be redone, or dropped, when Kaneo or Better Auth is upgraded.
