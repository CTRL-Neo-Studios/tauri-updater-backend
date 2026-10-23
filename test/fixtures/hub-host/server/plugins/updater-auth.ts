// Stand-in for the host's own auth (e.g. nuxt-auth-utils): a "session" header decides admin access.
export default defineNitroPlugin((nitroApp) => {
	nitroApp.hooks.hook('tauri-updater:authorize', (ctx) => {
		const role = getHeader(ctx.event, 'x-host-role')
		if (role === 'admin') {
			ctx.allowed = true
			ctx.actor = 'host-admin'
		}
		else if (role) ctx.allowed = false
	})
})
