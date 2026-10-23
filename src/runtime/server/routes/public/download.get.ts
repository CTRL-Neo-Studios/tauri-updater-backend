// First-install download for website buttons: 302 to a 15-minute link for the newest installer.
// ?channel= selects a channel (default stable); browsers send no token, so only public channels work here.
import {defineEventHandler, getQuery, sendRedirect, setResponseHeader} from 'h3'
import {objectKey, useUpdaterS3} from '../../utils/context'
import {param, useStore} from '../../utils/http'
import {HttpError} from '../../utils/model'
import {findRelease} from '../../utils/releases'

export default defineEventHandler(async (event) => {
	const app = param(event, 'app')
	const platform = param(event, 'platform')
	const channel = String(getQuery(event).channel || 'stable')

	setResponseHeader(event, 'Cache-Control', 'no-store')
	const {release} = await findRelease(await useStore(), undefined, app, channel, r => Object.hasOwn(r.installers, platform))
	const installer = release?.installers[platform]
	if (!release || !installer) throw new HttpError(404, 'No installer for this platform')

	return sendRedirect(event, await useUpdaterS3().presignGet(objectKey(release.app, release.version, installer.file)), 302)
})
