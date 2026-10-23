// Release rules against real databases: libSQL (SQLite dialect) and PGlite (PostgreSQL dialect), so every statement
// is exercised on both. The bucket is an in-memory S3Client: the logic only needs size/delete/list/presign.
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createDatabase} from 'db0'
import libsql from 'db0/connectors/libsql/node'
import pglite from 'db0/connectors/pglite'
import {afterAll, beforeEach, describe, expect, it} from 'vitest'
import {migrate} from '../src/runtime/server/utils/db'
import {hashToken, HttpError} from '../src/runtime/server/utils/model'
import type {StartRelease} from '../src/runtime/server/utils/model'
import {deleteRelease, findRelease, publishRelease, purgePending, startRelease, sweepOrphans} from '../src/runtime/server/utils/releases'
import type {ReleaseDeps} from '../src/runtime/server/utils/releases'
import type {S3Client} from '../src/runtime/server/utils/s3'
import {Store} from '../src/runtime/server/utils/store'

const dir = mkdtempSync(join(tmpdir(), 'tu-test-'))
afterAll(() => rmSync(dir, {recursive: true, force: true}))

function fakeBucket() {
	const objects = new Map<string, number>()
	const client: S3Client = {
		size: async key => objects.get(key) ?? null,
		delete: async (key) => {
			objects.delete(key)
		},
		list: async prefix => [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({key, size, lastModified: ''})),
		presignGet: async key => `https://s3.test/${key}?get`,
		presignPut: async key => `https://s3.test/${key}?put`
	}
	return {client, objects}
}

/** Rejects with an HttpError carrying this status. */
async function expectStatus(promise: Promise<unknown>, status: number) {
	const error = await promise.then(() => undefined, (e: unknown) => e)
	expect(error).toBeInstanceOf(HttpError)
	expect((error as HttpError).statusCode).toBe(status)
}

const dialects = [
	['libsql', () => libsql({url: `file:${join(dir, `${crypto.randomUUID()}.db`)}`})],
	['pglite', () => pglite({})]
] as const

describe.each(dialects)('%s', (_name, connector) => {
	let deps: ReleaseDeps
	let objects: Map<string, number>

	/** Starts a release with one file per platform and uploads it unless told otherwise. */
	async function ship(version: string, platforms: string[], opts: {channel?: string, upload?: boolean} = {}) {
		const input: StartRelease = {
			version,
			channel: opts.channel,
			platforms: Object.fromEntries(platforms.map(p => [p, {file: `${p}-${version}.bin`, size: 10, signature: `sig-${version}`}])),
			installers: {}
		}
		const started = await startRelease(deps, 'app', input, 'run-1')
		if (opts.upload !== false) for (const p of platforms) objects.set(deps.key('app', version, `${p}-${version}.bin`), 10)
		return started
	}
	const publish = async (version: string, platforms: string[], channel?: string) => {
		await ship(version, platforms, {channel})
		return publishRelease(deps, 'app', version)
	}

	beforeEach(async () => {
		const db = createDatabase(connector())
		await migrate(db)
		await migrate(db) // second run must be a no-op
		const store = new Store(db)
		const bucket = fakeBucket()
		objects = bucket.objects
		deps = {store, s3: bucket.client, key: (a, v, f) => `apps/${a}/${v}/${f}`}
		await store.createApp({slug: 'app', repo: 'o/app', ref: 'refs/heads/main'})
		await store.putChannel({app: 'app', name: 'stable', access: 'public', includes: []}, true)
		await store.putChannel({app: 'app', name: 'beta', access: 'public', includes: ['stable']}, true)
		await store.putChannel({app: 'app', name: 'insider', access: 'restricted', includes: ['beta', 'stable']}, true)
	})

	it('picks the newest live release across included channels, by semver', async () => {
		await publish('1.0.0', ['windows-x86_64'])
		await publish('1.10.0-beta.2', ['windows-x86_64'])
		await publish('1.9.0', ['windows-x86_64'])
		// 1.10 > 1.9 numerically; a text sort would pick 1.9.0
		expect((await findRelease(deps.store, undefined, 'app', 'beta')).release?.version).toBe('1.10.0-beta.2')
		expect((await findRelease(deps.store, undefined, 'app', 'stable')).release?.version).toBe('1.9.0')
	})

	it('falls back per platform when the newest release skipped it', async () => {
		await publish('1.0.0', ['windows-x86_64', 'darwin-aarch64'])
		await publish('1.1.0-beta.1', ['windows-x86_64'])
		const darwin = await findRelease(deps.store, undefined, 'app', 'beta', r => Object.hasOwn(r.platforms, 'darwin-aarch64'))
		expect(darwin.release?.version).toBe('1.0.0')
	})

	it('yanking hides a release and the channel falls back; unyank restores it', async () => {
		await publish('1.0.0', ['windows-x86_64'])
		await publish('1.1.0', ['windows-x86_64'])
		await deps.store.setYanked('app', '1.1.0', true)
		expect((await findRelease(deps.store, undefined, 'app', 'stable')).release?.version).toBe('1.0.0')
		await deps.store.setYanked('app', '1.1.0', false)
		expect((await findRelease(deps.store, undefined, 'app', 'stable')).release?.version).toBe('1.1.0')
	})

	it('a yanked version still blocks republishing and downgrades', async () => {
		await publish('1.1.0', ['windows-x86_64'])
		await deps.store.setYanked('app', '1.1.0', true)
		await expectStatus(ship('1.1.0', ['windows-x86_64']), 409)
	})

	it('rejects replacing a published version and downgrades on the same channel', async () => {
		await publish('2.0.0', ['windows-x86_64'])
		await expectStatus(ship('2.0.0', ['windows-x86_64']), 409)
		await expectStatus(ship('1.5.0', ['windows-x86_64']), 409)
	})

	it('a CI re-run of a pending version replaces its file list', async () => {
		await ship('1.0.0', ['windows-x86_64'], {upload: false})
		await ship('1.0.0', ['darwin-aarch64'], {upload: false})
		const pending = await deps.store.getRelease('app', '1.0.0')
		expect(Object.keys(pending!.platforms)).toEqual(['darwin-aarch64'])
	})

	it('publish refuses incomplete or wrong-size uploads, then succeeds once they are right', async () => {
		await ship('1.0.0', ['windows-x86_64'], {upload: false})
		await expectStatus(publishRelease(deps, 'app', '1.0.0'), 422)
		objects.set('apps/app/1.0.0/windows-x86_64-1.0.0.bin', 9)
		await expectStatus(publishRelease(deps, 'app', '1.0.0'), 422)
		objects.set('apps/app/1.0.0/windows-x86_64-1.0.0.bin', 10)
		expect((await publishRelease(deps, 'app', '1.0.0')).status).toBe('published')
	})

	it('publish is idempotent, and a version overtaken while pending loses', async () => {
		await ship('1.0.0', ['windows-x86_64'])
		await publish('1.1.0', ['windows-x86_64'])
		await expectStatus(publishRelease(deps, 'app', '1.0.0'), 409)
		expect((await publishRelease(deps, 'app', '1.1.0')).status).toBe('published')
	})

	it('racing publishes of the same pending version: exactly one wins the flip', async () => {
		await ship('1.0.0', ['windows-x86_64'])
		const flips = await Promise.all([deps.store.markPublished('app', '1.0.0'), deps.store.markPublished('app', '1.0.0')])
		expect(flips.filter(Boolean)).toHaveLength(1)
	})

	it('restricted channels: 401 without or with an unknown token, 403 without a grant, wildcard grants match', async () => {
		await publish('1.0.0-insider.1', ['windows-x86_64'])
		await expectStatus(findRelease(deps.store, undefined, 'app', 'insider'), 401)
		await expectStatus(findRelease(deps.store, 'tu_nope', 'app', 'insider'), 401)
		await deps.store.createUser('bob', await hashToken('tok-bob'), null)
		await expectStatus(findRelease(deps.store, 'tok-bob', 'app', 'insider'), 403)
		await deps.store.addGrant('bob', '*:insider')
		expect((await findRelease(deps.store, 'tok-bob', 'app', 'insider')).release?.version).toBe('1.0.0-insider.1')
		await deps.store.setUserToken('bob', await hashToken('tok-new'))
		await expectStatus(findRelease(deps.store, 'tok-bob', 'app', 'insider'), 401)
	})

	it('unknown app or channel is 404, and an unregistered prerelease tag cannot start', async () => {
		await expectStatus(findRelease(deps.store, undefined, 'nope', 'stable'), 404)
		await expectStatus(findRelease(deps.store, undefined, 'app', 'nope'), 404)
		await expectStatus(ship('1.0.0-rc.1', ['windows-x86_64']), 404)
	})

	it('deleting a release removes its objects and rows; a shared file is deleted once', async () => {
		const input: StartRelease = {
			version: '1.0.0',
			platforms: {'darwin-aarch64': {file: 'u.tar.gz', size: 10, signature: 's'}, 'darwin-x86_64': {file: 'u.tar.gz', size: 10, signature: 's'}},
			installers: {}
		}
		await startRelease(deps, 'app', input, 'r')
		objects.set('apps/app/1.0.0/u.tar.gz', 10)
		await publishRelease(deps, 'app', '1.0.0')
		await deleteRelease(deps, (await deps.store.getRelease('app', '1.0.0'))!)
		expect(objects.size).toBe(0)
		expect(await deps.store.getRelease('app', '1.0.0')).toBeNull()
	})

	it('purges only stale pending releases, with their uploads', async () => {
		await ship('1.0.0', ['windows-x86_64'])
		expect(await purgePending(deps, 1)).toEqual([])
		expect(await purgePending(deps, -1)).toEqual(['app@1.0.0'])
		expect(objects.size).toBe(0)
	})

	it('sweep finds only objects no row references, and deletes them only when applied', async () => {
		await publish('1.0.0', ['windows-x86_64'])
		objects.set('apps/app/9.9.9/stray.bin', 3)
		objects.set('other-prefix/keep.bin', 3)
		const dry = await sweepOrphans(deps, 'apps', false)
		expect(dry.orphans.map(o => o.key)).toEqual(['apps/app/9.9.9/stray.bin'])
		expect(objects.has('apps/app/9.9.9/stray.bin')).toBe(true)
		await sweepOrphans(deps, 'apps', true)
		expect([...objects.keys()].sort()).toEqual(['apps/app/1.0.0/windows-x86_64-1.0.0.bin', 'other-prefix/keep.bin'])
	})

	it('duplicate app, channel and user names are 409, not 500', async () => {
		await expectStatus(deps.store.createApp({slug: 'app', repo: 'o/x', ref: 'refs/heads/main'}), 409)
		await expectStatus(deps.store.putChannel({app: 'app', name: 'beta', access: 'public', includes: []}, true), 409)
		await deps.store.createUser('amy', await hashToken('a'), null)
		await expectStatus(deps.store.createUser('amy', await hashToken('b'), null), 409)
	})
})
