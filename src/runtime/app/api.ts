// Admin API client. The admin token (fallback auth) lives in sessionStorage: gone when the tab closes, never a cookie.
import {ref} from 'vue'

const TOKEN_KEY = 'tauri-updater:admin-token'

export const adminToken = ref<string>(typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(TOKEN_KEY) ?? '')

export function setAdminToken(token: string) {
	adminToken.value = token
	if (token) sessionStorage.setItem(TOKEN_KEY, token)
	else sessionStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
	constructor(public status: number, message: string, public data?: unknown) {
		super(message)
	}
}

/** Calls <adminPath>/api<path>; rejects with ApiError carrying the server's statusMessage. */
export type Api = <T>(path: string, init?: {method?: string, body?: unknown}) => Promise<T>

export function createApi(base: string): Api {
	return async function api<T>(path: string, init: {method?: string, body?: unknown} = {}): Promise<T> {
		const headers: Record<string, string> = {'accept': 'application/json', 'x-tauri-updater': '1'}
		if (adminToken.value) headers.authorization = `Bearer ${adminToken.value}`
		if (init.body !== undefined) headers['content-type'] = 'application/json'
		const res = await fetch(`${base}/api${path}`, {
			method: init.method ?? 'GET',
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body)
		})
		const text = await res.text()
		const json: unknown = text ? JSON.parse(text) : null
		if (!res.ok) {
			const message = json && typeof json === 'object' && 'statusMessage' in json && typeof json.statusMessage === 'string' ? json.statusMessage : res.statusText
			throw new ApiError(res.status, message, json && typeof json === 'object' && 'data' in json ? json.data : undefined)
		}
		return json as T
	}
}

