// One-time import from the S3-JSON layout of the original prism `layers/apps` backend (and copies of it) into this
// module's database. Objects stay where they are: keep `s3.keyPrefix` equal to --prefix (default "apps").
//
//   bun scripts/import-legacy.ts --registry registry.json [--prefix apps] [--connector libsql|postgresql] [--dry-run]
//
// Reads NUXT_TAURI_UPDATER_S3_* for the bucket and NUXT_TAURI_UPDATER_DATABASE_OPTIONS_URL (+ _AUTH_TOKEN) for the
// target database. registry.json is the old `appRegistry` (apps.ts) as JSON:
//   {"my-app": {"repo": "owner/my-app", "channels": {"stable": {"access": "public"}, "beta": {"access": "public", "includes": ["stable"]}}}}
// Safe to re-run: every insert skips rows that already exist.
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {createDatabase} from 'db0'
import type {Database} from 'db0'
import libsql from 'db0/connectors/libsql/node'
import postgresql from 'db0/connectors/postgresql'
import semver from 'semver'
import {z} from 'zod'
import {migrate} from '../src/runtime/server/utils/db'
import {channelAccess, fileName, grant, platformKey, repo, slug, version} from '../src/runtime/server/utils/model'
import {createS3} from '../src/runtime/server/utils/s3'

const registrySchema = z.record(slug, z.object({
	repo,
	channels: z.record(slug, z.object({access: channelAccess, includes: z.array(slug).default([])}))
}))
const accessSchema = z.object({users: z.record(slug, z.object({token: z.string().startsWith('sha256:'), grants: z.array(grant), note: z.string().optional()}))})
const fileEntry = z.object({file: fileName, size: z.number().int().positive()})
const legacyRelease = z.object({
	app: slug,
	version,
	channel: slug,
	status: z.enum(['pending', 'published']),
	notes: z.string().optional(),
	pub_date: z.string().optional(),
	platforms: z.record(platformKey, fileEntry.extend({signature: z.string().min(1)})),
	installers: z.record(platformKey, fileEntry).default({})
})

function fail(message: string): never {
	console.error(`error: ${message}`)
	process.exit(1)
}

const {values} = parseArgs({options: {
	'registry': {type: 'string'},
	'prefix': {type: 'string', default: 'apps'},
	'connector': {type: 'string', default: 'libsql'},
	'dry-run': {type: 'boolean', default: false}
}})
if (!values.registry) fail('--registry <file> is required (the old appRegistry as JSON)')
const prefix = values.prefix!.replace(/^\/+|\/+$/g, '')
const dryRun = values['dry-run']!

const s3 = createS3({
	endpoint: process.env.NUXT_TAURI_UPDATER_S3_ENDPOINT ?? '',
	region: process.env.NUXT_TAURI_UPDATER_S3_REGION ?? '',
	bucket: process.env.NUXT_TAURI_UPDATER_S3_BUCKET ?? '',
	accessKeyId: process.env.NUXT_TAURI_UPDATER_S3_ACCESS_KEY_ID ?? '',
	secretAccessKey: process.env.NUXT_TAURI_UPDATER_S3_SECRET_ACCESS_KEY ?? ''
})

/** Schema-checked JSON object, or null when missing. Storage content is external input. */
async function readJson<T extends z.ZodType>(key: string, schema: T): Promise<z.infer<T> | null> {
	const res = await fetch(await s3.presignGet(key, 60))
	if (res.status === 404) return null
	if (!res.ok) fail(`reading ${key} failed (${res.status})`)
	const parsed = schema.safeParse(await res.json())
	if (!parsed.success) fail(`${key} is malformed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
	return parsed.data
}

const url = process.env.NUXT_TAURI_UPDATER_DATABASE_OPTIONS_URL
if (!url) fail('set NUXT_TAURI_UPDATER_DATABASE_OPTIONS_URL to the target database')
const db: Database = createDatabase(values.connector === 'postgresql'
	? postgresql({url})
	: values.connector === 'libsql'
		? libsql({url, authToken: process.env.NUXT_TAURI_UPDATER_DATABASE_OPTIONS_AUTH_TOKEN || undefined})
		: fail(`unsupported --connector ${values.connector}; use libsql or postgresql`))

const registry = registrySchema.parse(JSON.parse(await readFile(values.registry, 'utf8')))
const access = await readJson(`${prefix}/_access.json`, accessSchema)
const releaseKeys = (await s3.list(`${prefix}/`)).map(o => o.key).filter(k => k.endsWith('/release.json'))
const releases = []
for (const key of releaseKeys) {
	const release = await readJson(key, legacyRelease)
	if (!release) continue
	if (!Object.hasOwn(registry, release.app)) fail(`${key} belongs to ${release.app}, which is not in the registry`)
	if (!Object.hasOwn(registry[release.app]!.channels, release.channel)) fail(`${key} is on channel ${release.channel}, which ${release.app} doesn't declare`)
	releases.push(release)
}

const users = Object.entries(access?.users ?? {})
console.log(`found ${Object.keys(registry).length} apps, ${users.length} users, ${releases.length} releases (${releases.filter(r => r.status === 'published').length} published)`)
if (dryRun) {
	console.log('dry run: nothing written')
	process.exit(0)
}

await migrate(db)
const now = new Date().toISOString()
for (const [appSlug, app] of Object.entries(registry)) {
	await db.sql`INSERT INTO tu_apps (slug, repo, ref, created_at) VALUES (${appSlug}, ${app.repo}, ${'refs/heads/main'}, ${now}) ON CONFLICT (slug) DO NOTHING`
	for (const [name, channel] of Object.entries(app.channels)) {
		const unknown = channel.includes.filter(c => !Object.hasOwn(app.channels, c))
		if (unknown.length) fail(`${appSlug}/${name} includes undeclared channels: ${unknown.join(', ')}`)
		await db.sql`INSERT INTO tu_channels (app, name, access, includes, created_at) VALUES (${appSlug}, ${name}, ${channel.access}, ${JSON.stringify(channel.includes)}, ${now}) ON CONFLICT (app, name) DO NOTHING`
	}
}
// token hashes carry over unchanged (same "sha256:<hex>" format), so issued tokens keep working
for (const [name, user] of users) {
	await db.sql`INSERT INTO tu_users (name, token_hash, note, created_at) VALUES (${name}, ${user.token}, ${user.note ?? null}, ${now}) ON CONFLICT (name) DO NOTHING`
	for (const g of user.grants) await db.sql`INSERT INTO tu_grants (user_name, grant_value) VALUES (${name}, ${g}) ON CONFLICT (user_name, grant_value) DO NOTHING`
}
for (const r of releases) {
	await db.sql`INSERT INTO tu_releases (app, version, channel, status, notes, pub_date, run_id, created_at) VALUES (${r.app}, ${r.version}, ${r.channel}, ${r.status}, ${r.notes ?? null}, ${r.pub_date ?? null}, ${'import'}, ${r.pub_date ?? now}) ON CONFLICT (app, version) DO NOTHING`
	for (const [platform, f] of Object.entries(r.platforms))
		await db.sql`INSERT INTO tu_files (app, version, kind, platform, file, size, signature) VALUES (${r.app}, ${r.version}, ${'updater'}, ${platform}, ${f.file}, ${f.size}, ${f.signature}) ON CONFLICT (app, version, kind, platform) DO NOTHING`
	for (const [platform, f] of Object.entries(r.installers))
		await db.sql`INSERT INTO tu_files (app, version, kind, platform, file, size, signature) VALUES (${r.app}, ${r.version}, ${'installer'}, ${platform}, ${f.file}, ${f.size}, ${null}) ON CONFLICT (app, version, kind, platform) DO NOTHING`
}

// The old backend served each channel's pointer file; the module derives "current" from the rows. They must agree.
let mismatches = 0
for (const [appSlug, app] of Object.entries(registry)) {
	for (const name of Object.keys(app.channels)) {
		const pointer = await readJson(`${prefix}/${appSlug}/channels/${name}.json`, legacyRelease)
		const derived = releases
			.filter(r => r.app === appSlug && r.channel === name && r.status === 'published')
			.sort((a, b) => semver.rcompare(a.version, b.version))[0]?.version ?? null
		const expected = pointer?.version ?? null
		const ok = derived === expected
		if (!ok) mismatches++
		console.log(`${ok ? 'ok      ' : 'MISMATCH'} ${appSlug}/${name}: pointer ${expected ?? '—'}, derived ${derived ?? '—'}`)
	}
}
await db.dispose?.()
if (mismatches) fail(`${mismatches} channel(s) disagree with their old pointer file; check before switching traffic`)
console.log('import complete')
