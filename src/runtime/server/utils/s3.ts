import {AwsClient} from 'aws4fetch'

export interface S3Settings {
	endpoint: string
	region?: string
	bucket: string
	accessKeyId: string
	secretAccessKey: string
}

export interface S3Object {
	key: string
	size: number
	lastModified: string
}

/** Only the operations the updater needs; binaries never pass through the server, only presigned URLs do. */
export interface S3Client {
	/** Object size in bytes, or null when missing. */
	size(key: string): Promise<number | null>
	delete(key: string): Promise<void>
	/** Every object under a prefix (follows continuation tokens). */
	list(prefix: string): Promise<S3Object[]>
	presignGet(key: string, expiresInSeconds?: number): Promise<string>
	presignPut(key: string, expiresInSeconds?: number): Promise<string>
}

const xmlDecode = (s: string) => s
	.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]

/** Minimal S3 client over aws4fetch: AWS, Cloudflare R2, B2, MinIO, Tigris, megas4, any S3-compatible API. */
export function createS3(settings: S3Settings): S3Client {
	const {endpoint, region, bucket, accessKeyId, secretAccessKey} = settings
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 storage is not configured')
	const aws = new AwsClient({accessKeyId, secretAccessKey, region: region || 'auto', service: 's3'})
	// path-style URLs: work with any S3-compatible server, no wildcard DNS needed
	const base = `${endpoint.replace(/\/+$/, '')}/${bucket}`
	const objectUrl = (key: string) => `${base}/${key.split('/').map(encodeURIComponent).join('/')}`

	async function presign(method: 'GET' | 'PUT', key: string, expiresInSeconds: number) {
		const url = new URL(objectUrl(key))
		url.searchParams.set('X-Amz-Expires', String(expiresInSeconds))
		return (await aws.sign(url.toString(), {method, aws: {signQuery: true}})).url
	}

	return {
		async size(key) {
			const res = await aws.fetch(objectUrl(key), {method: 'HEAD'})
			if (res.status === 404) return null
			if (!res.ok) throw new Error(`S3 head ${key} failed (${res.status})`)
			return Number(res.headers.get('content-length'))
		},

		async delete(key) {
			const res = await aws.fetch(objectUrl(key), {method: 'DELETE'})
			if (!res.ok && res.status !== 404) throw new Error(`S3 delete ${key} failed (${res.status})`)
		},

		async list(prefix) {
			const objects: S3Object[] = []
			let token: string | undefined
			do {
				const url = new URL(base)
				url.searchParams.set('list-type', '2')
				url.searchParams.set('prefix', prefix)
				if (token) url.searchParams.set('continuation-token', token)
				const res = await aws.fetch(url.toString())
				if (!res.ok) throw new Error(`S3 list ${prefix} failed (${res.status})`)
				const xml = await res.text()
				for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
					objects.push({
						key: xmlDecode(tag(entry!, 'Key') ?? ''),
						size: Number(tag(entry!, 'Size') ?? 0),
						lastModified: tag(entry!, 'LastModified') ?? ''
					})
				}
				const next = tag(xml, 'NextContinuationToken')
				token = tag(xml, 'IsTruncated') === 'true' && next ? xmlDecode(next) : undefined
			} while (token)
			return objects
		},

		presignGet: (key, expiresInSeconds = 900) => presign('GET', key, expiresInSeconds),
		presignPut: (key, expiresInSeconds = 3600) => presign('PUT', key, expiresInSeconds)
	}
}
