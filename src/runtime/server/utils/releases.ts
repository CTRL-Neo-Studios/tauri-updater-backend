// Release logic over Store + S3: channel resolution, access checks, start/publish, deletes. No Nitro imports, so tests
// drive it directly with an in-memory database and a fake bucket.
import semver from 'semver'
import {grantMatches, hashToken, HttpError, defaultChannel} from './model'
import type {Release, StartRelease} from './model'
import type {S3Client} from './s3'
import type {ChannelRow, Store} from './store'

export interface ReleaseDeps {
	store: Store
	s3: S3Client
	/** Object key for a release file (applies the configured keyPrefix). */
	key: (app: string, version: string, file: string) => string
}

export interface StartedRelease {
	release: Release
	/** file name → presigned PUT URL, valid for an hour */
	uploads: Record<string, string>
}

export async function requireChannel(store: Store, app: string, channel: string): Promise<ChannelRow> {
	const config = await store.getChannel(app, channel)
	if (!config) throw new HttpError(404, 'Unknown app or channel')
	return config
}

/** Throws 401 (missing/unknown token) or 403 (no grant) for restricted channels; public channels pass. */
export async function assertChannelAccess(store: Store, token: string | undefined, app: string, channel: ChannelRow) {
	if (channel.access === 'public') return
	if (!token) throw new HttpError(401, 'This channel requires an access token')
	const grants = await store.grantsForToken(await hashToken(token))
	if (!grants) throw new HttpError(401, 'Unknown access token')
	if (!grants.some(g => grantMatches(g, app, channel.name))) throw new HttpError(403, 'Token has no access to this channel')
}

/**
 * Newest live release a channel offers (the channel plus everything it includes), after the access check.
 * `usable` filters first, so a platform a newer prerelease skipped still gets the newest build that has it.
 */
export async function findRelease(store: Store, token: string | undefined, app: string, channelName: string, usable: (r: Release) => boolean = () => true) {
	const channel = await requireChannel(store, app, channelName)
	await assertChannelAccess(store, token, app, channel)
	const release = (await store.liveReleases(app, [channel.name, ...channel.includes])).find(usable) ?? null
	return {channel, release}
}

/** Files a release must contain, by name → expected size. Rejects the same name listed twice with different sizes. */
function expectedFiles(release: Pick<Release, 'platforms' | 'installers'>) {
	const files: Record<string, number> = {}
	for (const {file, size} of [...Object.values(release.platforms), ...Object.values(release.installers)]) {
		if (Object.hasOwn(files, file) && files[file] !== size) throw new HttpError(400, `File ${file} is listed twice with different sizes`)
		files[file] = size
	}
	return files
}

/**
 * Registers a pending release and returns upload URLs. Idempotent per version while pending (a CI re-run re-uploads);
 * 409 once published, so a version can never be replaced. The version must beat the channel's newest live release.
 */
export async function startRelease(deps: ReleaseDeps, app: string, input: StartRelease, runId: string): Promise<StartedRelease> {
	const channel = input.channel ?? defaultChannel(input.version)
	await requireChannel(deps.store, app, channel)
	const current = (await deps.store.liveReleases(app, [channel]))[0]
	if (current && !semver.gt(input.version, current.version))
		throw new HttpError(409, `${input.version} is not newer than ${channel}'s ${current.version}`)

	const release: Release = {
		app, version: input.version, channel, status: 'pending', created_at: new Date().toISOString(),
		platforms: input.platforms, installers: input.installers
	}
	if (input.notes) release.notes = input.notes
	const files = expectedFiles(release)
	if (!await deps.store.upsertPending(release, runId)) throw new HttpError(409, `${app} ${input.version} is already published`)

	const uploads: Record<string, string> = {}
	for (const file of Object.keys(files)) uploads[file] = await deps.s3.presignPut(deps.key(app, input.version, file))
	return {release, uploads}
}

/**
 * Publishes a pending release once every file exists with its declared size. The pending → published flip is one
 * conditional UPDATE, so two racing runs can't both publish, and there is no pointer to move.
 */
export async function publishRelease(deps: ReleaseDeps, app: string, version: string): Promise<Release> {
	const stored = await deps.store.getRelease(app, version)
	if (!stored) throw new HttpError(404, `${app} ${version} was never started`)
	if (stored.status === 'published') return stored

	const missing: string[] = []
	for (const [file, size] of Object.entries(expectedFiles(stored))) {
		const actual = await deps.s3.size(deps.key(app, version, file))
		if (actual !== size) missing.push(actual === null ? `${file} (missing)` : `${file} (${actual} bytes, expected ${size})`)
	}
	if (missing.length) throw new HttpError(422, `Upload incomplete: ${missing.join(', ')}`)

	// another run may have published a newer version on this channel since this one started
	const current = (await deps.store.liveReleases(app, [stored.channel]))[0]
	if (current && !semver.gt(version, current.version))
		throw new HttpError(409, `${version} is not newer than ${stored.channel}'s ${current.version}`)

	if (!await deps.store.markPublished(app, version)) throw new HttpError(409, `${app} ${version} was published by another run`)
	return (await deps.store.getRelease(app, version))!
}

/** Deletes a release's objects, then its rows; objects first, so a failure never leaves unreferenced files behind. */
export async function deleteRelease(deps: ReleaseDeps, release: Release) {
	const files = new Set([...Object.values(release.platforms), ...Object.values(release.installers)].map(f => f.file))
	for (const file of files) await deps.s3.delete(deps.key(release.app, release.version, file))
	await deps.store.deleteRelease(release.app, release.version)
}

/** Removes pending releases older than `hours` (abandoned CI runs) with their uploaded objects. */
export async function purgePending(deps: ReleaseDeps, hours: number) {
	const cutoff = new Date(Date.now() - hours * 3600_000).toISOString()
	const purged: string[] = []
	for (const {app, version} of await deps.store.stalePending(cutoff)) {
		const release = await deps.store.getRelease(app, version)
		if (release?.status !== 'pending') continue
		await deleteRelease(deps, release)
		purged.push(`${app}@${version}`)
	}
	return purged
}

/**
 * Objects under the module's key prefix that no database row references: leftovers from deleted rows, failed runs or
 * manual uploads. Dry run unless `apply`.
 */
export async function sweepOrphans(deps: ReleaseDeps, keyPrefix: string, apply: boolean) {
	const prefix = keyPrefix.replace(/^\/+|\/+$/g, '')
	const referenced = await deps.store.referencedFiles()
	const orphans = (await deps.s3.list(prefix ? `${prefix}/` : ''))
		.filter(o => !referenced.has(prefix ? o.key.slice(prefix.length + 1) : o.key))
	if (apply) for (const o of orphans) await deps.s3.delete(o.key)
	return {orphans, deleted: apply}
}
