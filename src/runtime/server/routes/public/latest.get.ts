// Newest release on a channel (?channel=, default stable), without download URLs: for version badges and download pages.
import {defineEventHandler, getQuery, setResponseHeader} from 'h3'
import {channelToken, param, useStore} from '../../utils/http'
import {HttpError} from '../../utils/model'
import {findRelease} from '../../utils/releases'

export default defineEventHandler(async (event) => {
	const app = param(event, 'app')
	const channel = String(getQuery(event).channel || 'stable')

	const {channel: config, release} = await findRelease(await useStore(), channelToken(event), app, channel)
	setResponseHeader(event, 'Cache-Control', config.access === 'public' ? 'public, max-age=60' : 'private, no-store')
	if (!release) throw new HttpError(404, 'No release on this channel yet')

	return {
		app: release.app,
		version: release.version,
		channel: release.channel,
		notes: release.notes ?? '',
		pub_date: release.pub_date,
		platforms: Object.keys(release.platforms),
		installers: Object.keys(release.installers)
	}
})
