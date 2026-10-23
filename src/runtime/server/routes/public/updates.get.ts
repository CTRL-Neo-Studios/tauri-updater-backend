// Tauri updater endpoint: <prefix>/updates/<app>/{{target}}/{{arch}}/{{current_version}}
// Channel from the configured channel header (default stable); restricted channels also need the token header.
import semver from 'semver'
import {defineEventHandler, getHeader, sendNoContent, setResponseHeader} from 'h3'
import {useUpdaterConfig, useUpdaterS3, objectKey} from '../../utils/context'
import {channelToken, param, useStore} from '../../utils/http'
import {HttpError} from '../../utils/model'
import {findRelease} from '../../utils/releases'

export default defineEventHandler(async (event) => {
	const app = param(event, 'app')
	const current = param(event, 'current')
	if (!semver.valid(current)) throw new HttpError(400, 'Invalid current version')
	const platform = `${param(event, 'target')}-${param(event, 'arch')}`
	const channel = getHeader(event, useUpdaterConfig().headers.channel) || 'stable'

	// answers vary by token and carry presigned URLs, so nothing in between may cache them
	setResponseHeader(event, 'Cache-Control', 'no-store')
	const {release} = await findRelease(await useStore(), channelToken(event), app, channel, r => Object.hasOwn(r.platforms, platform))
	const bundle = release?.platforms[platform]
	if (!release || !bundle || !semver.gt(release.version, current)) return sendNoContent(event)

	return {
		version: release.version,
		notes: release.notes ?? '',
		pub_date: release.pub_date,
		url: await useUpdaterS3().presignGet(objectKey(release.app, release.version, bundle.file)),
		signature: bundle.signature
	}
})
