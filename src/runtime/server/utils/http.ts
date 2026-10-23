// Glue between h3 events and the pure logic: one place that reads config, opens the store, and maps params.
import type {H3Event} from 'h3'
import {getHeader, getRouterParam} from 'h3'
import {objectKey, useUpdaterConfig, useUpdaterDb, useUpdaterS3} from './context'
import {HttpError} from './model'
import type {ReleaseDeps} from './releases'
import {Store} from './store'

export async function useStore() {
	return new Store(await useUpdaterDb())
}

/** Store + bucket + key builder for release operations. */
export async function useReleaseDeps(): Promise<ReleaseDeps> {
	return {store: await useStore(), s3: useUpdaterS3(), key: objectKey}
}

/** Required, decoded router param; 400 instead of a crash on a missing one. */
export function param(event: H3Event, name: string) {
	const value = getRouterParam(event, name, {decode: true})
	if (!value) throw new HttpError(400, `Missing ${name}`)
	return value
}

/** Restricted-channel token, from the configured header. */
export const channelToken = (event: H3Event) => getHeader(event, useUpdaterConfig().headers.token)
