// Per-instance singletons built from runtime config. Server-only; never auto-imported into the host.
import type {Database} from 'db0'
import {useRuntimeConfig} from 'nitropack/runtime'
import connector from '#tauri-updater/connector'
import {createUpdaterDatabase} from './db'
import {HttpError} from './model'
import {createS3} from './s3'
import type {S3Client} from './s3'

export interface UpdaterRuntimeConfig {
	prefix: string
	adminPath: string
	adminToken: string
	database: {options: Record<string, unknown>}
	s3: {endpoint: string, region: string, bucket: string, accessKeyId: string, secretAccessKey: string, keyPrefix: string}
	oidc: {issuer: string, audience: string, allowedWorkflows: string[]}
	headers: {channel: string, token: string}
}

export const useUpdaterConfig = () => useRuntimeConfig().tauriUpdater as UpdaterRuntimeConfig

let database: (() => Promise<Database>) | undefined
let s3: S3Client | undefined

/** The module's own database, opened and migrated on first use. */
export function useUpdaterDb(): Promise<Database> {
	// empty strings are the build-time placeholders that make env overrides possible; drivers must not see them
	database ??= createUpdaterDatabase(() => connector(Object.fromEntries(Object.entries(useUpdaterConfig().database.options).filter(([, v]) => v !== ''))))
	return database().catch((error) => {
		console.error('[tauri-updater] database unavailable', error)
		throw new HttpError(503, 'Update database is not available')
	})
}

/** Storage client from NUXT_TAURI_UPDATER_S3_*; misconfiguration surfaces as 503, not a crash. */
export function useUpdaterS3(): S3Client {
	if (s3) return s3
	try {
		s3 = createS3(useUpdaterConfig().s3)
	}
	catch {
		throw new HttpError(503, 'Release storage is not configured')
	}
	return s3
}

/** Object key for a release file; keyPrefix keeps this module's objects apart from anything else in the bucket. */
export function objectKey(app: string, version: string, file: string) {
	const prefix = useUpdaterConfig().s3.keyPrefix.replace(/^\/+|\/+$/g, '')
	return `${prefix ? `${prefix}/` : ''}${app}/${version}/${file}`
}
