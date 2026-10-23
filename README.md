# tauri-updater-backend

A Nuxt module that turns your Nuxt site into the update server for your Tauri apps: updater feeds, release channels,
access tokens for private channels, CI publishing from GitHub Actions, and an admin UI to manage it all.

- **Your own database** for metadata: libSQL/Turso, PostgreSQL/Neon, PGlite or Cloudflare D1. It never touches the
  host's NuxtHub `hub:db` or Nitro's `useDatabase()`.
- **Any S3-compatible bucket** for binaries: AWS S3, Cloudflare R2, Backblaze B2, MinIO, Tigris, DigitalOcean Spaces.
  Downloads and CI uploads go through presigned URLs, so large installers never pass through your server (works on
  Vercel's 4.5 MB function limit).
- **Admin UI** (Nuxt UI) at `/__updater-admin`: apps, channels, token users and grants, yank/restore, delete, purge of
  abandoned releases, and an orphaned-file sweep.
- **No interference with the host**: everything lives under two configurable paths, nothing is auto-imported, and its
  tables, env vars and storage prefix are its own.

## Setup

```bash
npx nuxt module add tauri-updater-backend
bun add @libsql/client   # or pg, @electric-sql/pglite; nothing for D1
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
	modules: ['@nuxt/ui', 'tauri-updater-backend'],   // @nuxt/ui is only needed for the admin UI
	tauriUpdater: {
		database: {connector: 'libsql'},
		oidc: {allowedWorkflows: ['CTRL-Neo-Studios/tauri-updater-backend/.github/workflows/tauri-release.yml@refs/heads/main']}
	}
})
```

Secrets are read at runtime only, so builds never contain them:

```bash
NUXT_TAURI_UPDATER_DATABASE_OPTIONS_URL=libsql://my-db.turso.io     # file:/abs/path.db for local SQLite
NUXT_TAURI_UPDATER_DATABASE_OPTIONS_AUTH_TOKEN=…
NUXT_TAURI_UPDATER_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
NUXT_TAURI_UPDATER_S3_REGION=auto
NUXT_TAURI_UPDATER_S3_BUCKET=updates
NUXT_TAURI_UPDATER_S3_ACCESS_KEY_ID=…
NUXT_TAURI_UPDATER_S3_SECRET_ACCESS_KEY=…
NUXT_TAURI_UPDATER_ADMIN_TOKEN=<long random string>              # admin login fallback, see Admin access
```

Keep the database outside your deployment (Turso, Neon, D1, a mounted volume). A SQLite file inside the project
directory is wiped by every redeploy.

Tables are created on the first request (`tu_*`, tracked in `tu_migrations`), and every migration is safe to run from
several instances at once.

## Options

| Option | Default | |
|---|---|---|
| `prefix` | `/apps` | public and CI routes. Installed apps bake it into their updater URL: pick it once |
| `adminPath` | `/__updater-admin` | admin UI; its API is `<adminPath>/api/**` |
| `adminUi` | `true` | set `false` to register the admin API only |
| `adminToken` | `''` | admin login fallback; set it at runtime with `NUXT_TAURI_UPDATER_ADMIN_TOKEN` |
| `database.connector` | `libsql` | `libsql`, `postgresql`, `pglite`, `cloudflare-d1`; only this driver is bundled |
| `database.options` | `{}` | connector options: `url`, `authToken` (libsql), `bindingName` (D1), `dataDir` (pglite) |
| `s3.keyPrefix` | `apps` | objects go under `<keyPrefix>/<app>/<version>/`; lets the module share a bucket |
| `oidc.issuer` | GitHub Actions | |
| `oidc.audience` | `tauri-updater` | must match the workflow's `audience` input |
| `oidc.allowedWorkflows` | `[]` | `job_workflow_ref` values allowed to publish; empty disables publishing |
| `headers.channel` | `x-updater-channel` | header the app sends to pick a channel |
| `headers.token` | `x-updater-token` | header carrying the access token for restricted channels |

Every option can be overridden at runtime with `NUXT_TAURI_UPDATER_*` (e.g. `NUXT_TAURI_UPDATER_S3_KEY_PREFIX`).

**Database examples**

| Host | `connector` | Runtime env |
|---|---|---|
| Vercel, Netlify, any Node host | `libsql` | `…_DATABASE_OPTIONS_URL=libsql://…turso.io`, `…_AUTH_TOKEN` |
| Node with a volume | `libsql` | `…_DATABASE_OPTIONS_URL=file:/data/updater.db` |
| Postgres / Neon | `postgresql` | `…_DATABASE_OPTIONS_URL=postgres://…` |
| Cloudflare Workers | `cloudflare-d1` | a D1 binding; `database.options: {bindingName: 'UPDATER_DB'}` |

With libsql and a local `file:` URL, the native binary for the build machine is bundled. If you build on one OS and
deploy to another (e.g. macOS → Linux image), build inside the target image, or use a remote `libsql://` URL.

**Using it next to NuxtHub.** Add both modules. NuxtHub keeps the host's `hub:db`, `hub:kv` and `hub:blob`; this module
opens its own connection and its own bucket. Even same-named tables don't collide, because they live in different
databases (covered by `test/hub-host.test.ts`).

## Routes

All under `prefix` (default `/apps`):

| Route | For | Responses |
|---|---|---|
| `GET /updates/:app/:target/:arch/:current` | Tauri updater (`{{target}}/{{arch}}/{{current_version}}`) | 200 manifest · 204 up to date · 401/403 restricted · 404 unknown app/channel |
| `GET /download/:app/:platform?channel=` | website download buttons | 302 to a 15-minute link · 404 |
| `GET /api/v1/apps/:app/releases/latest?channel=` | version badges, download pages | release metadata, no URLs |
| `GET /api/v1/apps/:app/channels` | the app's channel picker | public channels + those the token grants |
| `POST /api/v1/apps/:app/releases` | CI | 201 pending release + upload URLs · 409 published or not newer |
| `POST /api/v1/apps/:app/releases/:version/publish` | CI | 200 published · 422 uploads incomplete · 409 lost a race |

Clients pick a channel with the channel header (updater) or `?channel=` (web); the default is `stable`. Restricted
channels also need the token header. These are custom headers on purpose: the updater resends its headers when
downloading, and S3 rejects presigned URLs that also carry an `Authorization` header.

In the Tauri app, set the updater endpoint to
`https://example.com/apps/updates/<app>/{{target}}/{{arch}}/{{current_version}}` and send the headers you configured.

## Versions and channels

- **Strict semver**, the only form Tauri accepts: `1.2.0`, `1.3.0-beta.1`. Put a dot before prerelease numbers
  (`alpha.10` sorts after `alpha.9`; `alpha10` sorts before `alpha9`).
- **A release is a version bump.** A version can never be replaced and must be newer than its channel's current
  release. To fix a broken release, ship the next version, or **yank** it in the admin: the channel falls back to its
  previous release immediately.
- **The prerelease tag picks the channel** (`1.3.0-beta.1` → `beta`, plain versions → `stable`); the workflow's
  `channel` input overrides it. The channel must exist.
- **Includes.** A channel can also offer other channels' releases (`beta` includes `stable`), and the newest version
  wins, so beta users move up to stable once it overtakes them. Per platform, an app gets the newest release that
  actually has its platform.

## Admin access

The admin checks, in order:

1. A `tauri-updater:authorize` Nitro hook in the host. Set `allowed` to `true` or `false` and it decides. Use this in
   production, backed by your own auth:

   ```ts
   // server/plugins/updater-admin.ts (host)
   export default defineNitroPlugin((nitroApp) => {
   	nitroApp.hooks.hook('tauri-updater:authorize', async (ctx) => {
   		const {user} = await getUserSession(ctx.event)      // nuxt-auth-utils, or your own
   		if (user) {
   			ctx.allowed = user.role === 'admin'
   			ctx.actor = user.login
   		}
   	})
   })
   ```

2. Otherwise, `Authorization: Bearer <NUXT_TAURI_UPDATER_ADMIN_TOKEN>`. The UI asks for it and keeps it in
   `sessionStorage` (never a cookie).
3. Neither configured: the admin answers 404. It is never open by default.

Every admin API request must send `x-tauri-updater: 1`. Browsers can't add that header cross-site without a CORS
preflight, so cookie-based host auth can't be abused for CSRF.

Anyone with admin access can change which repo publishes an app. Prefer the hook in production; the overview page
warns while you're signed in with the shared token.

## Publishing from CI

Call the reusable workflow from the app repo:

```yaml
# .github/workflows/release.yml
on: {push: {branches: [main]}, workflow_dispatch: {}}
jobs:
  release:
    uses: CTRL-Neo-Studios/tauri-updater-backend/.github/workflows/tauri-release.yml@main
    with:
      app: my-app
      api: https://example.com/apps          # your site + prefix
      # audience: tauri-updater              # must equal tauriUpdater.oidc.audience
    secrets: inherit                         # TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD)
    permissions: {contents: read, id-token: write}
```

It builds Windows (NSIS), macOS (universal) and Linux (AppImage, best-effort), uploads straight to the bucket with
presigned URLs, and publishes. Pushing an unchanged version builds, then skips the publish with a notice.

A publish is accepted only from a GitHub Actions OIDC token that has the configured audience, comes from the app's
registered repo and ref (set per app in the admin), and was minted by a workflow listed in `oidc.allowedWorkflows`.
No storage keys ever leave the server.

The app repo must use Bun, keep `src-tauri/` at the root with the version in `src-tauri/tauri.conf.json`, and commit
`bun.lock`.

## Maintenance

- **Purge pending**: deletes releases whose CI run never published (failed or cancelled builds), with their uploads.
- **Orphan sweep**: lists bucket objects under `keyPrefix` that no release references. Scanning is read-only;
  deleting is a separate confirmation.
- **Deletes** of an app, channel, release or user require typing its name. Deleting a release or channel also deletes
  its stored files.

## Migrating from prism's `layers/apps`

`scripts/import-legacy.ts` copies the old S3-JSON layout (`_access.json`, `release.json` files) into the database.
Token hashes carry over, so issued tokens keep working, and every channel is checked against its old pointer file. To
keep already-installed apps working, set `prefix`, `headers`, `oidc.audience` and `s3.keyPrefix` to the old values.
See `docs/apps-release-guide.md` in prism for a worked example.

## Development

```bash
bun install
bun run dev:prepare
bun run dev        # playground at http://localhost:3000, admin at /__updater-admin
bun run lint
bun run test       # release rules on libSQL + PGlite, and a NuxtHub host build
bun run prepack    # build dist/
```
