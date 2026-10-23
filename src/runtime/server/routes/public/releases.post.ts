// CI only: registers a pending release and returns presigned upload URLs. Auth: GitHub Actions OIDC (see utils/oidc.ts).
import {defineEventHandler, getHeader, readBody, setResponseStatus} from 'h3'
import {useUpdaterConfig} from '../../utils/context'
import {param, useReleaseDeps} from '../../utils/http'
import {HttpError, parse, startReleaseSchema} from '../../utils/model'
import {assertPublisher} from '../../utils/oidc'
import {startRelease} from '../../utils/releases'

export default defineEventHandler(async (event) => {
	const app = param(event, 'app')
	const deps = await useReleaseDeps()
	const config = await deps.store.getApp(app)
	if (!config) throw new HttpError(404, 'Unknown app')
	const runId = await assertPublisher(getHeader(event, 'authorization'), config, useUpdaterConfig().oidc)

	const body = parse(startReleaseSchema, await readBody(event), 'release')
	setResponseStatus(event, 201)
	return startRelease(deps, app, body, runId)
})
