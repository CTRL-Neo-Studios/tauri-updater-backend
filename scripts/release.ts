// Used by .github/workflows/tauri-release.yml. Two steps:
//   bun release.ts collect <platform-key> <bundle-dir> <app> <version> <out-dir>
//     copies one platform's Tauri bundles to <out-dir> under URL-safe names, writes <out-dir>/<platform-key>.json
//   bun release.ts publish <api-base> <app> <version> <dir> [--audience a] [--channel c] [--notes text]
//     merges the per-platform json, starts the release (OIDC from the Actions env), uploads, then publishes.
//     <api-base> includes the module's route prefix, e.g. https://example.com/apps.
import {copyFile, mkdir, readdir, readFile, stat, writeFile} from 'node:fs/promises'
import {basename, join} from 'node:path'
import {parseArgs} from 'node:util'

interface Collected {
	platforms: Record<string, {file: string, size: number, signature: string}>
	installers: Record<string, {file: string, size: number}>
}

/** Where each OS puts its updater bundle and first-install installer, under target/.../release/bundle. */
const LAYOUT: Record<string, {updater: [string, string], installer: [string, string]}> = {
	windows: {updater: ['nsis', '-setup.exe'], installer: ['nsis', '-setup.exe']},
	darwin: {updater: ['macos', '.app.tar.gz'], installer: ['dmg', '.dmg']},
	linux: {updater: ['appimage', '.AppImage'], installer: ['appimage', '.AppImage']}
}

function fail(message: string): never {
	console.error(`::error::${message}`)
	process.exit(1)
}

async function findOne(dir: string, suffix: string) {
	const matches = (await readdir(dir).catch(() => [])).filter(f => f.endsWith(suffix))
	if (matches.length !== 1) fail(`expected exactly one *${suffix} in ${dir}, found ${matches.length}`)
	return join(dir, matches[0]!)
}

/** Bundle names contain spaces and differ per app; store under <app>-<version>-<platform><suffix> instead. */
async function collect(platformKeys: string, bundleDir: string, app: string, version: string, outDir: string) {
	const os = platformKeys.split(',')[0]!.split('-')[0]!
	const layout = LAYOUT[os] ?? fail(`unknown OS in ${platformKeys}`)
	await mkdir(outDir, {recursive: true})

	const place = async (source: string, suffix: string) => {
		const file = `${app}-${version}-${os}${suffix}`
		await copyFile(source, join(outDir, file))
		return {file, size: (await stat(source)).size}
	}

	const updaterSource = await findOne(join(bundleDir, layout.updater[0]), layout.updater[1])
	const updater = await place(updaterSource, layout.updater[1])
	const signature = (await readFile(`${updaterSource}.sig`, 'utf8').catch(() => fail(`${basename(updaterSource)}.sig missing: is createUpdaterArtifacts on and TAURI_SIGNING_PRIVATE_KEY set?`))).trim()
	const installerSource = await findOne(join(bundleDir, layout.installer[0]), layout.installer[1])
	const installer = installerSource === updaterSource ? updater : await place(installerSource, layout.installer[1])

	// a universal macOS build serves both architectures from one bundle
	const collected: Collected = {platforms: {}, installers: {}}
	for (const key of platformKeys.split(',')) {
		collected.platforms[key] = {...updater, signature}
		collected.installers[key] = installer
	}
	await writeFile(join(outDir, `${os}.json`), JSON.stringify(collected))
	console.log(`collected ${platformKeys}: ${updater.file}${installer === updater ? '' : `, ${installer.file}`}`)
}

/** GitHub Actions OIDC token for the release service (needs `permissions: id-token: write`). */
async function oidcToken(audience: string) {
	const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
	const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
	if (!url || !bearer) fail('no OIDC token available: the publish job needs `permissions: id-token: write`')
	const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {headers: {authorization: `bearer ${bearer}`}})
	if (!res.ok) fail(`OIDC token request failed (${res.status})`)
	const body: unknown = await res.json()
	const token = body && typeof body === 'object' && 'value' in body ? body.value : undefined
	return typeof token === 'string' ? token : fail('OIDC response had no token')
}

/** POST to the release service. Accept JSON explicitly: Nuxt renders errors as HTML for clients that accept anything. */
async function api(base: string, path: string, token: string, body?: unknown) {
	// manual: fetch drops the Authorization header when a redirect changes host (example.com -> www.example.com), which
	// the server then reports as a missing OIDC token. Name the real problem instead.
	const res = await fetch(`${base}${path}`, {
		method: 'POST',
		redirect: 'manual',
		headers: {'authorization': `Bearer ${token}`, 'content-type': 'application/json', 'accept': 'application/json'},
		body: body === undefined ? undefined : JSON.stringify(body)
	})
	if (res.status >= 300 && res.status < 400)
		fail(`${base}${path} redirects to ${res.headers.get('location')}; set the workflow's \`api\` input to the final URL`)
	const text = await res.text()
	let message = text
	try {
		const parsed: unknown = JSON.parse(text)
		if (parsed && typeof parsed === 'object' && 'statusMessage' in parsed && typeof parsed.statusMessage === 'string') message = parsed.statusMessage
	}
	catch { /* non-JSON body: report it verbatim */ }
	return {status: res.status, text, message}
}

/** `base` is the full public route prefix, e.g. https://example.com/apps (the module's `prefix` option). */
async function publish(base: string, app: string, version: string, dir: string, audience: string, channel?: string, notes?: string) {
	const merged: Collected = {platforms: {}, installers: {}}
	for (const name of (await readdir(dir)).filter(f => f.endsWith('.json'))) {
		const part: Collected = JSON.parse(await readFile(join(dir, name), 'utf8'))
		Object.assign(merged.platforms, part.platforms)
		Object.assign(merged.installers, part.installers)
	}
	if (!Object.keys(merged.platforms).length) fail('no platform built successfully; nothing to publish')

	const token = await oidcToken(audience)
	const started = await api(base, `/api/v1/apps/${app}/releases`, token, {version, channel, notes, ...merged})
	if (started.status === 409) {
		console.log(`::notice::skipped: ${started.message}`)
		return
	}
	if (started.status !== 201) fail(`starting the release failed (${started.status}): ${started.message}`)
	const {uploads, release}: {uploads: Record<string, string>, release: {channel: string}} = JSON.parse(started.text)

	for (const [file, url] of Object.entries(uploads)) {
		// ponytail: whole file in memory; bundles are tens of MB. Stream it if an app ever ships >1 GB.
		const res = await fetch(url, {method: 'PUT', body: await readFile(join(dir, file))})
		if (!res.ok) fail(`uploading ${file} failed (${res.status}): ${await res.text()}`)
		console.log(`uploaded ${file}`)
	}

	const published = await api(base, `/api/v1/apps/${app}/releases/${version}/publish`, token)
	if (published.status !== 200) fail(`publishing failed (${published.status}): ${published.message}`)
	console.log(`::notice::published ${app} ${version} to ${release.channel} (${Object.keys(merged.platforms).join(', ')})`)
}

const {positionals, values} = parseArgs({allowPositionals: true, options: {channel: {type: 'string'}, notes: {type: 'string'}, audience: {type: 'string'}}})
const [command, ...args] = positionals
if (command === 'collect' && args.length === 5) await collect(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!)
else if (command === 'publish' && args.length === 4) await publish(args[0]!.replace(/\/+$/, ''), args[1]!, args[2]!, args[3]!, values.audience || 'tauri-updater', values.channel || undefined, values.notes || undefined)
else fail('usage: release.ts collect <platform-keys> <bundle-dir> <app> <version> <out-dir> | publish <api-base-with-prefix> <app> <version> <dir> [--audience a] [--channel c] [--notes n]')
