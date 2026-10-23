// Every SQL statement the module runs. Pure db0: portable across libSQL, D1, PostgreSQL and PGlite.
// Invariants live in primary keys and single conditional statements, never in multi-statement transactions.
import semver from 'semver'
import type {Database} from 'db0'
import {HttpError} from './model'
import type {Release} from './model'

export interface AppRow {slug: string, repo: string, ref: string, created_at: string}
export interface ChannelRow {app: string, name: string, access: 'public' | 'restricted', includes: string[], created_at: string}
export interface UserRow {name: string, note: string | null, created_at: string, grants: string[]}
export interface StoreCounts {apps: number, users: number, releases: number, pending: number}
interface ReleaseRow {app: string, version: string, channel: string, status: 'pending' | 'published', notes: string | null, pub_date: string | null, yanked_at: string | null, created_at: string}
interface FileRow {version: string, kind: 'updater' | 'installer', platform: string, file: string, size: number | string, signature: string | null}

const now = () => new Date().toISOString()
const rows = async <T>(query: Promise<{rows?: unknown[]}>) => ((await query).rows ?? []) as T[]

/** Rows touched by an UPDATE/DELETE; db0 passes the driver result through (libSQL rowsAffected, pg rowCount, D1 meta.changes). */
function changes(result: unknown): number {
	const r = result as {rowsAffected?: number, rowCount?: number, affectedRows?: number, meta?: {changes?: number}, changes?: number}
	return Number(r.rowsAffected ?? r.rowCount ?? r.affectedRows ?? r.meta?.changes ?? r.changes ?? 0)
}

/** Unique violations across SQLite (libSQL, D1) and PostgreSQL, so inserts can report 409 instead of 500. */
export function isUniqueViolation(error: unknown) {
	const e = error as {code?: string, message?: string, cause?: {code?: string, message?: string}}
	const text = `${e?.code ?? ''} ${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`
	return /23505|SQLITE_CONSTRAINT|UNIQUE constraint|duplicate key/i.test(text)
}

async function insertOrConflict(insert: Promise<unknown>, message: string) {
	try {
		await insert
	}
	catch (error) {
		if (isUniqueViolation(error)) throw new HttpError(409, message)
		throw error
	}
}

function toRelease(row: ReleaseRow, files: FileRow[]): Release {
	const release: Release = {
		app: row.app, version: row.version, channel: row.channel, status: row.status, created_at: row.created_at,
		platforms: {}, installers: {}
	}
	if (row.notes) release.notes = row.notes
	if (row.pub_date) release.pub_date = row.pub_date
	if (row.yanked_at) release.yanked_at = row.yanked_at
	for (const f of files) {
		const entry = {file: f.file, size: Number(f.size)}
		if (f.kind === 'updater') release.platforms[f.platform] = {...entry, signature: f.signature ?? ''}
		else release.installers[f.platform] = entry
	}
	return release
}

export class Store {
	constructor(private readonly db: Database) {}

	private async filesOf(app: string, versions: string[]) {
		const byVersion = new Map<string, FileRow[]>()
		if (!versions.length) return byVersion
		const wanted = new Set(versions)
		for (const f of await rows<FileRow>(this.db.sql`SELECT version, kind, platform, file, size, signature FROM tu_files WHERE app = ${app}`))
			if (wanted.has(f.version)) byVersion.set(f.version, [...byVersion.get(f.version) ?? [], f])
		return byVersion
	}

	// ── apps ──────────────────────────────────────────────────────────────────
	listApps() {
		return rows<AppRow>(this.db.sql`SELECT slug, repo, ref, created_at FROM tu_apps ORDER BY slug`)
	}

	async getApp(slug: string): Promise<AppRow | null> {
		return (await rows<AppRow>(this.db.sql`SELECT slug, repo, ref, created_at FROM tu_apps WHERE slug = ${slug}`))[0] ?? null
	}

	async createApp(app: Omit<AppRow, 'created_at'>) {
		await insertOrConflict(this.db.sql`INSERT INTO tu_apps (slug, repo, ref, created_at) VALUES (${app.slug}, ${app.repo}, ${app.ref}, ${now()})`, `App ${app.slug} already exists`)
	}

	async updateApp(slug: string, patch: {repo: string, ref: string}) {
		if (!changes(await this.db.sql`UPDATE tu_apps SET repo = ${patch.repo}, ref = ${patch.ref} WHERE slug = ${slug}`)) throw new HttpError(404, 'Unknown app')
	}

	/** Rows only; the caller deletes the app's objects first. */
	async deleteApp(slug: string) {
		await this.db.sql`DELETE FROM tu_files WHERE app = ${slug}`
		await this.db.sql`DELETE FROM tu_releases WHERE app = ${slug}`
		await this.db.sql`DELETE FROM tu_channels WHERE app = ${slug}`
		await this.db.sql`DELETE FROM tu_apps WHERE slug = ${slug}`
	}

	// ── channels ──────────────────────────────────────────────────────────────
	async listChannels(app: string): Promise<ChannelRow[]> {
		const list = await rows<Omit<ChannelRow, 'includes'> & {includes: string}>(this.db.sql`SELECT app, name, access, includes, created_at FROM tu_channels WHERE app = ${app} ORDER BY created_at, name`)
		return list.map(c => ({...c, includes: JSON.parse(c.includes) as string[]}))
	}

	async getChannel(app: string, name: string) {
		return (await this.listChannels(app)).find(c => c.name === name) ?? null
	}

	async putChannel(channel: Omit<ChannelRow, 'created_at'>, create: boolean) {
		const includes = JSON.stringify(channel.includes)
		if (create) {
			await insertOrConflict(this.db.sql`INSERT INTO tu_channels (app, name, access, includes, created_at) VALUES (${channel.app}, ${channel.name}, ${channel.access}, ${includes}, ${now()})`, `Channel ${channel.name} already exists`)
			return
		}
		if (!changes(await this.db.sql`UPDATE tu_channels SET access = ${channel.access}, includes = ${includes} WHERE app = ${channel.app} AND name = ${channel.name}`))
			throw new HttpError(404, 'Unknown channel')
	}

	async deleteChannel(app: string, name: string) {
		await this.db.sql`DELETE FROM tu_channels WHERE app = ${app} AND name = ${name}`
	}

	// ── users and grants ──────────────────────────────────────────────────────
	async listUsers(): Promise<UserRow[]> {
		const users = await rows<Omit<UserRow, 'grants'>>(this.db.sql`SELECT name, note, created_at FROM tu_users ORDER BY name`)
		const grants = await rows<{user_name: string, grant_value: string}>(this.db.sql`SELECT user_name, grant_value FROM tu_grants ORDER BY grant_value`)
		return users.map(u => ({...u, grants: grants.filter(g => g.user_name === u.name).map(g => g.grant_value)}))
	}

	async createUser(name: string, tokenHash: string, note: string | null) {
		await insertOrConflict(this.db.sql`INSERT INTO tu_users (name, token_hash, note, created_at) VALUES (${name}, ${tokenHash}, ${note}, ${now()})`, `User ${name} already exists`)
	}

	async setUserToken(name: string, tokenHash: string) {
		if (!changes(await this.db.sql`UPDATE tu_users SET token_hash = ${tokenHash} WHERE name = ${name}`)) throw new HttpError(404, 'Unknown user')
	}

	async setUserNote(name: string, note: string | null) {
		if (!changes(await this.db.sql`UPDATE tu_users SET note = ${note} WHERE name = ${name}`)) throw new HttpError(404, 'Unknown user')
	}

	async deleteUser(name: string) {
		await this.db.sql`DELETE FROM tu_grants WHERE user_name = ${name}`
		await this.db.sql`DELETE FROM tu_users WHERE name = ${name}`
	}

	async addGrant(user: string, value: string) {
		await this.db.sql`INSERT INTO tu_grants (user_name, grant_value) VALUES (${user}, ${value}) ON CONFLICT (user_name, grant_value) DO NOTHING`
	}

	async removeGrant(user: string, value: string) {
		await this.db.sql`DELETE FROM tu_grants WHERE user_name = ${user} AND grant_value = ${value}`
	}

	/** Grants of the user holding this token hash, or null for an unknown token. */
	async grantsForToken(tokenHash: string): Promise<string[] | null> {
		const user = (await rows<{name: string}>(this.db.sql`SELECT name FROM tu_users WHERE token_hash = ${tokenHash}`))[0]
		if (!user) return null
		return (await rows<{grant_value: string}>(this.db.sql`SELECT grant_value FROM tu_grants WHERE user_name = ${user.name}`)).map(g => g.grant_value)
	}

	// ── releases ──────────────────────────────────────────────────────────────
	/** Newest version first (semver order, not insertion order). */
	async listReleases(app: string, filter: {channel?: string, status?: 'pending' | 'published'} = {}): Promise<Release[]> {
		let list = await rows<ReleaseRow>(this.db.sql`SELECT app, version, channel, status, notes, pub_date, yanked_at, created_at FROM tu_releases WHERE app = ${app}`)
		if (filter.channel) list = list.filter(r => r.channel === filter.channel)
		if (filter.status) list = list.filter(r => r.status === filter.status)
		list.sort((a, b) => semver.rcompare(a.version, b.version))
		const files = await this.filesOf(app, list.map(r => r.version))
		return list.map(r => toRelease(r, files.get(r.version) ?? []))
	}

	async getRelease(app: string, version: string): Promise<Release | null> {
		const row = (await rows<ReleaseRow>(this.db.sql`SELECT app, version, channel, status, notes, pub_date, yanked_at, created_at FROM tu_releases WHERE app = ${app} AND version = ${version}`))[0]
		if (!row) return null
		return toRelease(row, (await this.filesOf(app, [version])).get(version) ?? [])
	}

	/** Published, not yanked releases on any of these channels, newest first. */
	async liveReleases(app: string, channels: string[]) {
		const wanted = new Set(channels)
		return (await this.listReleases(app, {status: 'published'})).filter(r => wanted.has(r.channel) && !r.yanked_at)
	}

	/**
	 * Inserts a pending release, or replaces the files of an existing pending one (a CI re-run). Returns false when the
	 * version is already published, so it can never be replaced.
	 */
	async upsertPending(release: Release, runId: string) {
		try {
			await this.db.sql`INSERT INTO tu_releases (app, version, channel, status, notes, run_id, created_at) VALUES (${release.app}, ${release.version}, ${release.channel}, ${'pending'}, ${release.notes ?? null}, ${runId}, ${now()})`
		}
		catch (error) {
			if (!isUniqueViolation(error)) throw error
			const updated = await this.db.sql`UPDATE tu_releases SET channel = ${release.channel}, notes = ${release.notes ?? null}, run_id = ${runId} WHERE app = ${release.app} AND version = ${release.version} AND status = ${'pending'}`
			if (!changes(updated)) return false
		}
		await this.db.sql`DELETE FROM tu_files WHERE app = ${release.app} AND version = ${release.version}`
		const {app, version} = release
		for (const [platform, f] of Object.entries(release.platforms))
			await this.db.sql`INSERT INTO tu_files (app, version, kind, platform, file, size, signature) VALUES (${app}, ${version}, ${'updater'}, ${platform}, ${f.file}, ${f.size}, ${f.signature})`
		for (const [platform, f] of Object.entries(release.installers))
			await this.db.sql`INSERT INTO tu_files (app, version, kind, platform, file, size, signature) VALUES (${app}, ${version}, ${'installer'}, ${platform}, ${f.file}, ${f.size}, ${null})`
		return true
	}

	/** pending → published in one conditional statement; false when another run already published it. */
	async markPublished(app: string, version: string) {
		return changes(await this.db.sql`UPDATE tu_releases SET status = ${'published'}, pub_date = ${now()} WHERE app = ${app} AND version = ${version} AND status = ${'pending'}`) > 0
	}

	async setYanked(app: string, version: string, yanked: boolean) {
		if (!changes(await this.db.sql`UPDATE tu_releases SET yanked_at = ${yanked ? now() : null} WHERE app = ${app} AND version = ${version} AND status = ${'published'}`))
			throw new HttpError(404, 'No published release with this version')
	}

	/** Rows only; the caller deletes the objects first. */
	async deleteRelease(app: string, version: string) {
		await this.db.sql`DELETE FROM tu_files WHERE app = ${app} AND version = ${version}`
		await this.db.sql`DELETE FROM tu_releases WHERE app = ${app} AND version = ${version}`
	}

	stalePending(olderThan: string) {
		return rows<{app: string, version: string, created_at: string}>(this.db.sql`SELECT app, version, created_at FROM tu_releases WHERE status = ${'pending'} AND created_at < ${olderThan} ORDER BY created_at`)
	}

	/** Every object the database references, as "app/version/file". */
	async referencedFiles() {
		return new Set((await rows<{app: string, version: string, file: string}>(this.db.sql`SELECT app, version, file FROM tu_files`)).map(f => `${f.app}/${f.version}/${f.file}`))
	}

	async counts(): Promise<StoreCounts> {
		const count = async (q: Promise<{rows?: unknown[]}>) => Number((await rows<{n: number | string}>(q))[0]?.n ?? 0)
		return {
			apps: await count(this.db.sql`SELECT COUNT(*) AS n FROM tu_apps`),
			users: await count(this.db.sql`SELECT COUNT(*) AS n FROM tu_users`),
			releases: await count(this.db.sql`SELECT COUNT(*) AS n FROM tu_releases WHERE status = ${'published'}`),
			pending: await count(this.db.sql`SELECT COUNT(*) AS n FROM tu_releases WHERE status = ${'pending'}`)
		}
	}
}
