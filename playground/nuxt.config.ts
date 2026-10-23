export default defineNuxtConfig({
	modules: ['@nuxt/ui', 'tauri-updater-backend'],
	css: ['~/assets/main.css'],
	devtools: {enabled: true},
	compatibilityDate: 'latest',
	tauriUpdater: {
		// playground only: sign in to /__updater-admin with "dev". Real hosts set NUXT_TAURI_UPDATER_ADMIN_TOKEN instead.
		adminToken: 'dev',
		database: {connector: 'libsql', options: {url: 'file:.data/updater.db'}},
		oidc: {allowedWorkflows: ['my-org/my-app/.github/workflows/release.yml@refs/heads/main']}
	}
})
