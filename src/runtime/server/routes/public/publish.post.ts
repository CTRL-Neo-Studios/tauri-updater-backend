// CI only: verifies every upload and publishes the release. Auth: GitHub Actions OIDC (see utils/oidc.ts).
import {defineEventHandler, getHeader} from 'h3'
import {useUpdaterConfig} from '../../utils/context'
import {param, useReleaseDeps} from '../../utils/http'
import {HttpError, parse, version} from '../../utils/model'
import {assertPublisher} from '../../utils/oidc'
import {publishRelease} from '../../utils/releases'

export default defineEventHandler(async (event) => {
	const app = param(event, 'app')
	const ver = parse(version, param(event, 'version'), 'version')
	const deps = await useReleaseDeps()
	const config = await deps.store.getApp(app)
	if (!config) throw new HttpError(404, 'Unknown app')
	await assertPublisher(getHeader(event, 'authorization'), config, useUpdaterConfig().oidc)

	return publishRelease(deps, app, ver)
})
