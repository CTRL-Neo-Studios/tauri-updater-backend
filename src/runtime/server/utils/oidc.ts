import {createRemoteJWKSet, jwtVerify} from 'jose'
import type {RemoteJWKSet} from 'jose'
import {HttpError} from './model'
import type {AppRow} from './store'

export interface OidcSettings {
	issuer: string
	audience: string
	/** `job_workflow_ref` values allowed to publish, e.g. owner/repo/.github/workflows/tauri-release.yml@refs/heads/main */
	allowedWorkflows: string[]
}

let jwks: {issuer: string, set: RemoteJWKSet} | undefined

/**
 * Verifies a GitHub Actions OIDC bearer token: right issuer and audience, minted in the app's registered repo, on its
 * registered ref, by one of the allowed release workflows. Returns the run id; 401 on any failed check.
 */
export async function assertPublisher(authorization: string | undefined, app: AppRow, settings: OidcSettings) {
	const token = authorization?.match(/^Bearer (.+)$/)?.[1]
	if (!token) throw new HttpError(401, 'Missing GitHub Actions OIDC token')
	if (!settings.allowedWorkflows.length) throw new HttpError(401, 'Publishing is disabled: no allowed release workflows are configured')

	if (jwks?.issuer !== settings.issuer) jwks = {issuer: settings.issuer, set: createRemoteJWKSet(new URL(`${settings.issuer}/.well-known/jwks`))}
	let payload: Record<string, unknown>
	try {
		payload = (await jwtVerify(token, jwks.set, {issuer: settings.issuer, audience: settings.audience})).payload
	}
	catch {
		throw new HttpError(401, 'Invalid GitHub Actions OIDC token')
	}

	const ok = payload.repository === app.repo
		&& payload.ref === app.ref
		&& typeof payload.job_workflow_ref === 'string' && settings.allowedWorkflows.includes(payload.job_workflow_ref)
	if (!ok || typeof payload.run_id !== 'string')
		throw new HttpError(401, `Only ${app.repo}@${app.ref} via an allowed release workflow may publish`)
	return payload.run_id
}
