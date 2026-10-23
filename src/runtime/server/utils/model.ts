// Validation and shared shapes. No Nitro or Node-only imports: runs on Node, Bun and Workers, and in plain vitest.
import semver from 'semver'
import {z} from 'zod'

/**
 * Error with an HTTP status; h3 sends it as a JSON error (statusCode, statusMessage, data). `__h3_error__` is the brand
 * h3 checks (isError), so expected 4xx answers aren't logged as unhandled crashes, without importing h3 here.
 */
export class HttpError extends Error {
	static __h3_error__ = true
	fatal = false
	unhandled = false
	constructor(public statusCode: number, public statusMessage: string, public data?: unknown) {
		super(statusMessage)
	}
}

/** Slugs for apps, channels, users: also storage path segments, so no slashes or dots. */
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase letters, digits and dashes, max 64')

/** Grants are "app:channel"; "*" on either side matches anything. */
export const grant = z.string().regex(/^([a-z0-9][a-z0-9-]*|\*):([a-z0-9][a-z0-9-]*|\*)$/, 'must look like app:channel (* allowed)')

/** Strict semver (1.0.0-alpha.1), the only form Tauri's updater and bundler accept. */
export const version = z.string().refine(v => semver.valid(v) === v, 'must be a semver version like 1.0.0 or 1.0.0-alpha.1')

/** File names inside a version folder; never paths, so a release can't point outside its own folder. */
export const fileName = z.string().regex(/^[\w.-]{1,128}$/)

/** Tauri platform keys: "<target>-<arch>" (windows-x86_64, darwin-aarch64, linux-x86_64, ...). */
export const platformKey = z.string().regex(/^(windows|darwin|linux)-(x86_64|aarch64|i686|armv7)$/)

/** GitHub repo, owner/name. */
export const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name')

/** A branch name as people type it (main, release/v2). A pasted full ref (refs/heads/main) is accepted too. */
export const branch = z.string().trim().transform(b => b.replace(/^refs\/heads\//, ''))
	.pipe(z.string()
		.regex(/^[\w./-]{1,200}$/, 'must be a branch name like main or release/v2')
		.refine(b => !b.startsWith('/') && !b.endsWith('/') && !b.includes('//') && !b.includes('..'), 'must be a branch name like main or release/v2'))

export const channelAccess = z.enum(['public', 'restricted'])

const fileEntry = z.object({file: fileName, size: z.number().int().positive()})

/** What CI sends to start a release: metadata, .sig contents and sizes; the files themselves go to presigned URLs. */
export const startReleaseSchema = z.object({
	version,
	/** default: the prerelease tag (1.0.0-beta.2 → beta), else stable */
	channel: slug.optional(),
	notes: z.string().max(10_000).optional(),
	platforms: z.record(platformKey, fileEntry.extend({signature: z.string().min(1).max(4096)})),
	installers: z.record(platformKey, fileEntry).default({})
}).refine(r => Object.keys(r.platforms).length > 0, 'at least one updater platform is required')
export type StartRelease = z.infer<typeof startReleaseSchema>

/** Release as the API returns it; the same shape the prism layer used, so existing CI scripts keep working. */
export interface Release {
	app: string
	version: string
	channel: string
	status: 'pending' | 'published'
	notes?: string
	pub_date?: string
	yanked_at?: string
	created_at: string
	platforms: Record<string, {file: string, size: number, signature: string}>
	installers: Record<string, {file: string, size: number}>
}

/** Parses untrusted input or throws 400 with the zod issues attached. */
export function parse<T extends z.ZodType>(schema: T, input: unknown, what = 'request'): z.infer<T> {
	const result = schema.safeParse(input)
	if (!result.success) throw new HttpError(400, `Invalid ${what}`, result.error.issues)
	return result.data
}

export function grantMatches(grantValue: string, app: string, channel: string) {
	const [grantApp, grantChannel] = grantValue.split(':')
	return (grantApp === '*' || grantApp === app) && (grantChannel === '*' || grantChannel === channel)
}

/** Tokens are stored only as this hash. Web Crypto, so it works on Workers too. */
export async function hashToken(token: string) {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
	return `sha256:${[...digest].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

export function newToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return `tu_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/** Constant-time compare, so an admin token can't be guessed byte by byte from response timing. */
export function safeEqual(a: string, b: string) {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

/** Prerelease tag picks the channel (1.0.0-beta.2 → beta); plain versions go to stable. */
export function defaultChannel(ver: string) {
	const tag = semver.prerelease(ver)?.[0]
	return typeof tag === 'string' ? tag : 'stable'
}
