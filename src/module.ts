import {addServerHandler, addServerTemplate, addTypeTemplate, createResolver, defineNuxtModule, extendPages, hasNuxtModule, useLogger} from '@nuxt/kit'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {defu} from 'defu'

export type DatabaseConnector = 'libsql' | 'postgresql' | 'pglite' | 'cloudflare-d1'

/** db0 entry per connector; the build includes only the configured one (see the #tauri-updater/connector template). */
const connectorImports: Record<DatabaseConnector, string> = {
	'libsql': 'db0/connectors/libsql/node',
	'postgresql': 'db0/connectors/postgresql',
	'pglite': 'db0/connectors/pglite',
	'cloudflare-d1': 'db0/connectors/cloudflare-d1'
}

const LIBSQL_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64-gnu', 'linux-x64-musl', 'linux-arm64-gnu', 'linux-arm64-musl', 'linux-arm-gnueabihf', 'linux-arm-musleabihf', 'win32-x64-msvc']

/** Absolute paths of the installed libsql native binaries, resolved the way libsql itself requires them. */
function libsqlBinaries(rootDir: string) {
	try {
		const fromClient = createRequire(createRequire(join(rootDir, 'index.js')).resolve('@libsql/client'))
		const fromLibsql = createRequire(fromClient.resolve('libsql'))
		return LIBSQL_TARGETS.flatMap((target) => {
			try {
				return [fromLibsql.resolve(`@libsql/${target}`)]
			}
			catch {
				return []
			}
		})
	}
	catch {
		return [] // @libsql/client not installed: db0 reports it clearly at the first query
	}
}

export interface ModuleOptions {
	/** Public and CI routes live under this path. Installed apps bake it into their updater endpoint: pick it once. */
	prefix: string
	/** Admin UI path; its API is <adminPath>/api/**. */
	adminPath: string
	/** Serve the admin UI (needs @nuxt/ui in the host). The admin API is registered either way. */
	adminUi: boolean
	/** Fallback admin auth when no `tauri-updater:authorize` hook decides. Set at runtime: NUXT_TAURI_UPDATER_ADMIN_TOKEN. */
	adminToken: string
	/**
	 * Optional GitHub token for the admin's repo/branch lookup: lets it see private repos and lifts the 60 calls/hour
	 * anonymous limit. Read-only access is enough. Set at runtime: NUXT_TAURI_UPDATER_GITHUB_TOKEN.
	 */
	githubToken: string
	database: {
		/** Chosen at build time, so only that driver is bundled. */
		connector: DatabaseConnector
		/** Connector options. Secrets at runtime: NUXT_TAURI_UPDATER_DATABASE_OPTIONS_URL, ..._AUTH_TOKEN. */
		options: Record<string, unknown>
	}
	s3: {
		endpoint: string
		region: string
		bucket: string
		accessKeyId: string
		secretAccessKey: string
		/** Every object goes under <keyPrefix>/<app>/<version>/; lets the module share a bucket safely. */
		keyPrefix: string
	}
	oidc: {
		issuer: string
		audience: string
		/** `job_workflow_ref` values allowed to publish. Empty = publishing disabled. */
		allowedWorkflows: string[]
	}
	/** Request headers the Tauri app sends; configurable so existing installs keep working after a migration. */
	headers: {channel: string, token: string}
}

const normalizePath = (path: string) => `/${path.replace(/^\/+|\/+$/g, '')}`

// `.with()` types every defaulted option as optional in the host's nuxt.config, including nested keys
export default defineNuxtModule<ModuleOptions>().with({
	meta: {
		name: 'tauri-updater-backend',
		configKey: 'tauriUpdater',
		compatibility: {nuxt: '>=4.0.0'}
	},
	defaults: {
		prefix: '/apps',
		adminPath: '/__updater-admin',
		adminUi: true,
		adminToken: '',
		githubToken: '',
		database: {connector: 'libsql', options: {}},
		s3: {endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', keyPrefix: 'apps'},
		oidc: {issuer: 'https://token.actions.githubusercontent.com', audience: 'tauri-updater', allowedWorkflows: []},
		headers: {channel: 'x-updater-channel', token: 'x-updater-token'}
	},
	setup(options, nuxt) {
		const logger = useLogger('tauri-updater')
		const {resolve} = createResolver(import.meta.url)
		const prefix = normalizePath(options.prefix)
		const adminPath = normalizePath(options.adminPath)
		if (!Object.hasOwn(connectorImports, options.database.connector))
			throw new Error(`[tauri-updater] unknown database.connector "${options.database.connector}"; use one of ${Object.keys(connectorImports).join(', ')}`)

		// Private runtime config: every value can be overridden by NUXT_TAURI_UPDATER_* at runtime, so builds never need
		// secrets. Host values win over module defaults. Only the two paths are public (the admin UI needs them).
		// Nuxt only applies env overrides to keys that exist at build time, so the database keys a deploy sets by env
		// (url, authToken, bindingName) are declared empty here; empty values are dropped before reaching the driver.
		const runtimeConfig = nuxt.options.runtimeConfig as {tauriUpdater?: object, public: {tauriUpdater?: object}}
		runtimeConfig.tauriUpdater = defu(runtimeConfig.tauriUpdater, {
			prefix,
			adminPath,
			adminToken: options.adminToken,
			githubToken: options.githubToken,
			database: {options: defu(options.database.options, {url: '', authToken: '', bindingName: ''})},
			s3: options.s3,
			oidc: options.oidc,
			headers: {channel: options.headers.channel.toLowerCase(), token: options.headers.token.toLowerCase()}
		})
		runtimeConfig.public.tauriUpdater = defu(runtimeConfig.public.tauriUpdater, {prefix, adminPath})

		// Internal alias for runtime code; nothing is auto-imported into the host's server or app.
		nuxt.options.alias['#tauri-updater'] = resolve('./runtime')
		// The configured db0 connector, as a static import so the bundler includes exactly one driver. A local libsql
		// file (file:...) gets its directory created first: SQLite won't, and a fresh checkout or volume has none.
		addServerTemplate({
			filename: '#tauri-updater/connector',
			getContents: () => options.database.connector === 'libsql'
				? [
						`import { mkdirSync } from 'node:fs'`,
						`import { dirname } from 'node:path'`,
						`import libsql from ${JSON.stringify(connectorImports.libsql)}`,
						`export default (options) => {`,
						`  const path = typeof options.url === 'string' && options.url.startsWith('file:') ? options.url.slice(5).replace(/^\\/\\/(?=\\/)/, '') : ''`,
						`  if (path && path !== ':memory:') mkdirSync(dirname(path), { recursive: true })`,
						`  return libsql(options)`,
						`}`
					].join('\n')
				: `export { default } from ${JSON.stringify(connectorImports[options.database.connector])}`
		})
		addServerTemplate({
			filename: '#tauri-updater/connector-name',
			getContents: () => `export default ${JSON.stringify(options.database.connector)}`
		})
		// Types for the virtual modules, in both the app and the Nitro tsconfig. Inline import() on purpose: a top-level
		// import would make this file a module and turn the declarations into augmentations of non-existent modules.
		addTypeTemplate({
			filename: 'types/tauri-updater-virtual.d.ts',
			getContents: () => [
				`declare module '#tauri-updater/connector' { const connector: (options: Record<string, unknown>) => import('db0').Connector; export default connector }`,
				`declare module '#tauri-updater/connector-name' { const name: string; export default name }`
			].join('\n')
		}, {nuxt: true, nitro: true})

		const route = (path: string, file: string, method?: 'get' | 'post') =>
			addServerHandler({route: `${prefix}${path}`, method, handler: resolve(`./runtime/server/routes/public/${file}`)})
		route('/updates/:app/:target/:arch/:current', 'updates.get', 'get')
		route('/download/:app/:platform', 'download.get', 'get')
		route('/api/v1/apps/:app/releases/latest', 'latest.get', 'get')
		route('/api/v1/apps/:app/channels', 'channels.get', 'get')
		route('/api/v1/apps/:app/releases', 'releases.post', 'post')
		route('/api/v1/apps/:app/releases/:version/publish', 'publish.post', 'post')
		addServerHandler({route: `${adminPath}/api/**`, handler: resolve('./runtime/server/routes/admin/api')})

		// libsql loads its native binary with a computed require(`@libsql/${target}`) the file tracer can't follow, so a
		// Node build ships without it. Resolve each target from libsql's own location (isolated installs such as bun's
		// only link it there) and trace the ones present. A cross-OS build (macOS → Linux image) must install the target's
		// binary at build time, or use a remote libsql:// URL, which needs no binary.
		if (options.database.connector === 'libsql') {
			nuxt.hook('nitro:config', (nitro) => {
				nitro.externals = defu(nitro.externals, {traceInclude: libsqlBinaries(nuxt.options.rootDir)})
			})
		}

		if (!options.adminUi) return
		if (!hasNuxtModule('@nuxt/ui')) {
			logger.warn(`@nuxt/ui is not installed, so the admin UI at ${adminPath} is disabled. The admin API still works.`)
			return
		}
		extendPages((pages) => {
			pages.push({name: 'tauri-updater-admin', path: `${adminPath}/:section(.*)*`, file: resolve('./runtime/app/admin.vue')})
		})
		// Nuxt UI compiles Tailwind once, from its generated ui.css, scanning only the host's layers. Add the admin's files
		// to that same compilation; a separate CSS file with its own @source would be compiled alone and emit nothing.
		const adminSource = `@source ${JSON.stringify(resolve('./runtime/app'))};`
		nuxt.hook('app:templates', (app) => {
			const uiCss = app.templates.find(t => t.filename === 'ui.css')
			if (!uiCss?.getContents) {
				logger.warn('Nuxt UI\'s ui.css template was not found; admin styles may be incomplete.')
				return
			}
			const original = uiCss.getContents
			uiCss.getContents = async data => `${adminSource}\n${await original(data)}`
		})
		// client-only, noindex: the admin is never server-rendered or crawled
		nuxt.options.routeRules = defu(nuxt.options.routeRules, {
			[`${adminPath}/**`]: {ssr: false, headers: {'x-robots-tag': 'noindex, nofollow'}},
			[adminPath]: {ssr: false, headers: {'x-robots-tag': 'noindex, nofollow'}}
		})
	}
})
