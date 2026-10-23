import type {H3Event} from 'h3'
import {getHeader} from 'h3'
import {useNitroApp} from 'nitropack/runtime'
import {useUpdaterConfig} from './context'
import {HttpError, safeEqual} from './model'

/**
 * Passed to the `tauri-updater:authorize` Nitro hook. A host plugin sets `allowed` (and optionally `actor`) from its own
 * auth, e.g. nuxt-auth-utils: `nitroApp.hooks.hook('tauri-updater:authorize', async ctx => { ctx.allowed = ... })`.
 */
export interface AuthorizeContext {
	event: H3Event
	allowed: boolean | undefined
	actor?: string
}

declare module 'nitropack/types' {
	interface NitroRuntimeHooks {
		'tauri-updater:authorize': (ctx: AuthorizeContext) => void | Promise<void>
	}
}

/**
 * Admin access, in order: a host hook that decided (true/false wins), else the `Authorization: Bearer <adminToken>`
 * fallback. With neither configured the admin is closed (404), never open.
 */
export async function requireAdmin(event: H3Event): Promise<string> {
	const ctx: AuthorizeContext = {event, allowed: undefined}
	await useNitroApp().hooks.callHook('tauri-updater:authorize', ctx)
	if (ctx.allowed === true) return ctx.actor ?? 'host'
	if (ctx.allowed === false) throw new HttpError(403, 'Not allowed')

	const adminToken = useUpdaterConfig().adminToken
	if (!adminToken) throw new HttpError(404, 'Not found')
	const sent = getHeader(event, 'authorization')?.match(/^Bearer (.+)$/)?.[1]
	if (!sent || !safeEqual(sent, adminToken)) throw new HttpError(401, 'Admin token required')
	return 'admin-token'
}
