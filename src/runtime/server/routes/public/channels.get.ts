// Channels the caller may use: every public channel, plus restricted ones its token grants. Feeds the app's channel picker.
import {defineEventHandler, setResponseHeader} from 'h3'
import {channelToken, param, useStore} from '../../utils/http'
import {HttpError} from '../../utils/model'
import {assertChannelAccess} from '../../utils/releases'

export default defineEventHandler(async (event) => {
	const app = param(event, 'app')
	const store = await useStore()
	if (!await store.getApp(app)) throw new HttpError(404, 'Unknown app')

	setResponseHeader(event, 'Cache-Control', 'private, no-store')
	const token = channelToken(event)
	const channels: {name: string, access: 'public' | 'restricted'}[] = []
	for (const channel of await store.listChannels(app)) {
		try {
			await assertChannelAccess(store, token, app, channel)
			channels.push({name: channel.name, access: channel.access})
		}
		catch (error) {
			if (!(error instanceof HttpError) || ![401, 403].includes(error.statusCode)) throw error
		}
	}
	return {channels}
})
