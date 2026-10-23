// Admin API, mounted at <adminPath>/api/**. One handler with an internal router: one registration in the host, and
// every endpoint passes the same auth gate first.
import type {EventHandler, H3Event} from 'h3'
import type {z, ZodType} from 'zod'
import {createRouter, defineEventHandler, getHeader, readBody, setResponseHeader, useBase} from 'h3'
import {useUpdaterConfig, useUpdaterS3, objectKey} from '../../utils/context'
import {param, useStore} from '../../utils/http'
import {requireAdmin} from '../../utils/admin'
import {appInput, appPatch, channelInput, channelPatch, confirmInput, grantInput, purgeInput, repoLookupInput, sweepInput, userInput, userPatch, yankInput} from '../../utils/admin-schemas'
import {lookupRepo} from '../../utils/github'
import {hashToken, HttpError, newToken, parse} from '../../utils/model'
import {deleteRelease, purgePending, sweepOrphans} from '../../utils/releases'
import type {ReleaseDeps} from '../../utils/releases'
import type {Store} from '../../utils/store'
import connectorName from '#tauri-updater/connector-name'

/** JSON body validated by a zod schema; an empty or non-JSON body validates as {}. */
async function body<T extends ZodType>(event: H3Event, schema: T): Promise<z.infer<T>> {
	return parse(schema, await readBody(event).catch(() => undefined) ?? {})
}

function confirm(input: {confirm: string}, expected: string) {
	if (input.confirm !== expected) throw new HttpError(400, `Type "${expected}" to confirm`)
}

async function requireApp(store: Store, app: string) {
	const row = await store.getApp(app)
	if (!row) throw new HttpError(404, 'Unknown app')
	return row
}

/** Every included channel must exist on the app and can't be the channel itself. */
async function assertIncludes(store: Store, app: string, name: string, includes: string[]) {
	const known = new Set((await store.listChannels(app)).map(c => c.name))
	const bad = includes.filter(c => c === name || !known.has(c))
	if (bad.length) throw new HttpError(400, `Unknown or self-referencing channels in includes: ${bad.join(', ')}`)
}

function releaseDeps(store: Store): ReleaseDeps {
	return {store, s3: useUpdaterS3(), key: objectKey}
}

function buildRouter() {
	const router = createRouter()

	router.get('/overview', defineEventHandler(async (event) => {
		const config = useUpdaterConfig()
		const store = await useStore()
		return {
			actor: event.context.tauriUpdaterActor,
			counts: await store.counts(),
			config: {
				prefix: config.prefix,
				database: connectorName,
				storage: {endpoint: config.s3.endpoint ? new URL(config.s3.endpoint).host : null, bucket: config.s3.bucket || null, keyPrefix: config.s3.keyPrefix},
				oidc: {issuer: config.oidc.issuer, audience: config.oidc.audience, allowedWorkflows: config.oidc.allowedWorkflows},
				headers: config.headers,
				auth: event.context.tauriUpdaterActor === 'admin-token' ? 'token' : 'host'
			}
		}
	}))

	// ── apps ────────────────────────────────────────────────────────────────
	/** Live check while typing owner/name: exists?, private?, branches. Never blocks saving (see utils/github.ts). */
	router.post('/github/repo', defineEventHandler(async (event) => {
		const {repo} = await body(event, repoLookupInput)
		return lookupRepo(repo, useUpdaterConfig().githubToken)
	}))

	router.get('/apps', defineEventHandler(async () => {
		const store = await useStore()
		return Promise.all((await store.listApps()).map(async app => ({
			...app,
			channels: (await store.listChannels(app.slug)).length,
			latest: (await store.listReleases(app.slug, {status: 'published'})).find(r => !r.yanked_at)?.version ?? null
		})))
	}))

	router.post('/apps', defineEventHandler(async (event) => {
		const input = await body(event, appInput)
		const store = await useStore()
		await store.createApp(input)
		// every app starts with the channel releases default to
		await store.putChannel({app: input.slug, name: 'stable', access: 'public', includes: []}, true)
		return store.getApp(input.slug)
	}))

	router.get('/apps/:app', defineEventHandler(async (event) => {
		const store = await useStore()
		const app = await requireApp(store, param(event, 'app'))
		return {app, channels: await store.listChannels(app.slug), releases: await store.listReleases(app.slug)}
	}))

	router.put('/apps/:app', defineEventHandler(async (event) => {
		const store = await useStore()
		const slug = param(event, 'app')
		await store.updateApp(slug, await body(event, appPatch))
		return store.getApp(slug)
	}))

	router.delete('/apps/:app', defineEventHandler(async (event) => {
		const store = await useStore()
		const app = await requireApp(store, param(event, 'app'))
		confirm(await body(event, confirmInput), app.slug)
		const deps = releaseDeps(store)
		for (const release of await store.listReleases(app.slug)) await deleteRelease(deps, release)
		await store.deleteApp(app.slug)
		return {deleted: app.slug}
	}))

	// ── channels ────────────────────────────────────────────────────────────
	router.post('/apps/:app/channels', defineEventHandler(async (event) => {
		const store = await useStore()
		const app = await requireApp(store, param(event, 'app'))
		const input = await body(event, channelInput)
		await assertIncludes(store, app.slug, input.name, input.includes)
		await store.putChannel({app: app.slug, ...input}, true)
		return store.getChannel(app.slug, input.name)
	}))

	router.put('/apps/:app/channels/:channel', defineEventHandler(async (event) => {
		const store = await useStore()
		const app = param(event, 'app')
		const name = param(event, 'channel')
		const input = await body(event, channelPatch)
		await assertIncludes(store, app, name, input.includes)
		await store.putChannel({app, name, ...input}, false)
		return store.getChannel(app, name)
	}))

	/** Deletes the channel and every release published or pending on it, objects included. */
	router.delete('/apps/:app/channels/:channel', defineEventHandler(async (event) => {
		const store = await useStore()
		const app = param(event, 'app')
		const name = param(event, 'channel')
		if (!await store.getChannel(app, name)) throw new HttpError(404, 'Unknown channel')
		confirm(await body(event, confirmInput), name)
		const includedBy = (await store.listChannels(app)).filter(c => c.includes.includes(name)).map(c => c.name)
		if (includedBy.length) throw new HttpError(409, `Remove ${name} from the includes of ${includedBy.join(', ')} first`)
		const deps = releaseDeps(store)
		const releases = await store.listReleases(app, {channel: name})
		for (const release of releases) await deleteRelease(deps, release)
		await store.deleteChannel(app, name)
		return {deleted: name, releases: releases.map(r => r.version)}
	}))

	// ── releases ────────────────────────────────────────────────────────────
	/** Yanked releases stop being offered; the channel falls back to its next-newest live release. */
	router.post('/apps/:app/releases/:version/yank', defineEventHandler(async (event) => {
		const store = await useStore()
		const app = param(event, 'app')
		const version = param(event, 'version')
		await store.setYanked(app, version, (await body(event, yankInput)).yanked)
		return store.getRelease(app, version)
	}))

	router.delete('/apps/:app/releases/:version', defineEventHandler(async (event) => {
		const store = await useStore()
		const release = await store.getRelease(param(event, 'app'), param(event, 'version'))
		if (!release) throw new HttpError(404, 'Unknown release')
		confirm(await body(event, confirmInput), release.version)
		await deleteRelease(releaseDeps(store), release)
		return {deleted: release.version}
	}))

	// ── users and grants ────────────────────────────────────────────────────
	router.get('/users', defineEventHandler(async () => (await useStore()).listUsers()))

	/** Returns the token exactly once; only its hash is stored. */
	router.post('/users', defineEventHandler(async (event) => {
		const input = await body(event, userInput)
		const store = await useStore()
		const token = newToken()
		await store.createUser(input.name, await hashToken(token), input.note ?? null)
		for (const g of input.grants) await store.addGrant(input.name, g)
		return {user: (await store.listUsers()).find(u => u.name === input.name), token}
	}))

	router.patch('/users/:user', defineEventHandler(async (event) => {
		const store = await useStore()
		const name = param(event, 'user')
		await store.setUserNote(name, (await body(event, userPatch)).note)
		return (await store.listUsers()).find(u => u.name === name)
	}))

	/** New token; the old one stops working immediately. */
	router.post('/users/:user/rotate', defineEventHandler(async (event) => {
		const store = await useStore()
		const token = newToken()
		await store.setUserToken(param(event, 'user'), await hashToken(token))
		return {token}
	}))

	router.delete('/users/:user', defineEventHandler(async (event) => {
		const store = await useStore()
		const name = param(event, 'user')
		confirm(await body(event, confirmInput), name)
		await store.deleteUser(name)
		return {deleted: name}
	}))

	router.post('/users/:user/grants', defineEventHandler(async (event) => {
		const store = await useStore()
		const name = param(event, 'user')
		if (!(await store.listUsers()).some(u => u.name === name)) throw new HttpError(404, 'Unknown user')
		await store.addGrant(name, (await body(event, grantInput)).grant)
		return (await store.listUsers()).find(u => u.name === name)
	}))

	// grants contain ":" and "*", so the value travels in the body rather than the path
	router.delete('/users/:user/grants', defineEventHandler(async (event) => {
		const store = await useStore()
		const name = param(event, 'user')
		await store.removeGrant(name, (await body(event, grantInput)).grant)
		return (await store.listUsers()).find(u => u.name === name)
	}))

	// ── maintenance ─────────────────────────────────────────────────────────
	router.post('/maintenance/purge-pending', defineEventHandler(async (event) => {
		const {olderThanHours} = await body(event, purgeInput)
		return {purged: await purgePending(releaseDeps(await useStore()), olderThanHours)}
	}))

	/** Dry run unless {apply: true}: lists bucket objects under the key prefix that no release references. */
	router.post('/maintenance/sweep', defineEventHandler(async (event) => {
		const {apply} = await body(event, sweepInput)
		return sweepOrphans(releaseDeps(await useStore()), useUpdaterConfig().s3.keyPrefix, apply)
	}))

	return router
}

let handler: EventHandler | undefined

export default defineEventHandler(async (event) => {
	setResponseHeader(event, 'Cache-Control', 'no-store')
	// a custom header can't be sent cross-site without a CORS preflight, so cookie-based host auth isn't CSRF-able
	if (getHeader(event, 'x-tauri-updater') !== '1') throw new HttpError(400, 'Missing x-tauri-updater header')
	event.context.tauriUpdaterActor = await requireAdmin(event)
	handler ??= useBase(`${useUpdaterConfig().adminPath}/api`, buildRouter().handler)
	return handler(event)
})
