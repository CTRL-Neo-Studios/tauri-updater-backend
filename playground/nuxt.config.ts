export default defineNuxtConfig({
	modules: ['@nuxt/ui', 'tauri-updater-backend'],
	css: ['~/assets/main.css'],
	devtools: {enabled: true},
	compatibilityDate: 'latest',
	tauriUpdater: {
		database: {connector: 'libsql', options: {url: 'file:.data/updater.db'}},
		oidc: {allowedWorkflows: ['my-org/my-app/.github/workflows/release.yml@refs/heads/main']}
	}
})
