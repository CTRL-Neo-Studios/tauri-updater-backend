// A real Nuxt build of a host that uses NuxtHub's own database next to the module. Checks the coexistence promises:
// the module never touches hub:db (both have a tu_apps table; they'd collide in one database), routes stay under the
// configured paths, and the host's auth hook decides admin access before the token fallback.
import {existsSync, rmSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {$fetch, fetch, setup} from '@nuxt/test-utils/e2e'
import {describe, expect, it} from 'vitest'

const rootDir = fileURLToPath(new URL('./fixtures/hub-host', import.meta.url))
const admin = (role?: string) => ({'x-tauri-updater': '1', ...role ? {'x-host-role': role} : {}})

describe('host with NuxtHub', async () => {
	// both databases persist in the fixture's .data; start each run from empty so results don't depend on the last one
	rmSync(`${rootDir}/.data`, {recursive: true, force: true})
	await setup({rootDir})

	it('host and module keep separate databases with same-named tables', async () => {
		// module: create an app in its own tu_apps (slug-keyed)
		const created = await $fetch('/ops/updates/api/apps', {method: 'POST', headers: admin('admin'), body: {slug: 'my-app', repo: 'o/my-app'}})
		expect(created).toMatchObject({slug: 'my-app'})
		// host: its tu_apps (id/label) is untouched and still usable through hub:db
		const hostRows = await $fetch<{label: string}[]>('/api/host-apps', {method: 'POST'})
		expect(hostRows).toEqual([expect.objectContaining({label: 'host-row'})])
		expect(existsSync(`${rootDir}/.data/updater/updater.db`)).toBe(true)
	})

	it('host auth hook grants, denies, and otherwise leaves the admin closed', async () => {
		expect((await fetch('/ops/updates/api/overview', {headers: admin('admin')})).status).toBe(200)
		expect((await fetch('/ops/updates/api/overview', {headers: admin('viewer')})).status).toBe(403)
		// no hook decision and no admin token configured: closed, not open
		expect((await fetch('/ops/updates/api/overview', {headers: admin()})).status).toBe(404)
	})

	it('public routes serve from the module database under the prefix', async () => {
		const res = await fetch('/apps/api/v1/apps/my-app/channels')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({channels: [{name: 'stable', access: 'public'}]})
		// the updater feed answers 204 (nothing published yet), not a host 404
		expect((await fetch('/apps/updates/my-app/windows/x86_64/1.0.0')).status).toBe(204)
	})
})
