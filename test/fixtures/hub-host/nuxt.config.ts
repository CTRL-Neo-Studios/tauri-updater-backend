// A host that uses NuxtHub for its own database, with the updater module alongside. Proves the two don't interfere:
// separate databases, separate route trees, and the host's own auth plugged into the admin through the hook.
import {fileURLToPath} from 'node:url'
import TauriUpdater from '../../../src/module'

// absolute: a relative file: URL resolves against the process cwd, which differs between vitest and a deployed server
const updaterDb = fileURLToPath(new URL('./.data/updater/updater.db', import.meta.url))

export default defineNuxtConfig({
	modules: ['@nuxthub/core', TauriUpdater],
	hub: {db: 'sqlite', dir: '.data/hub'},
	tauriUpdater: {
		adminUi: false,
		adminPath: '/ops/updates',
		database: {connector: 'libsql', options: {url: `file:${updaterDb}`}},
		s3: {endpoint: 'http://127.0.0.1:1', bucket: 'unused', accessKeyId: 'x', secretAccessKey: 'x', keyPrefix: 'apps'}
	},
	compatibilityDate: 'latest'
})
