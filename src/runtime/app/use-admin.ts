import {inject, ref} from 'vue'
import {useToast} from '@nuxt/ui/composables/useToast'
import type {Api} from './api'

/** API client, admin base path, and a runner that toasts failures instead of throwing into the template. */
export function useAdmin() {
	const api = inject<Api>('tauri-updater:api')!
	const base = inject<string>('tauri-updater:base')!
	const toast = useToast()
	const busy = ref(false)

	async function run<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
		busy.value = true
		try {
			const result = await action()
			if (success) toast.add({title: success, color: 'success', icon: 'i-lucide-check'})
			return result
		}
		catch (error) {
			toast.add({title: error instanceof Error ? error.message : 'Request failed', color: 'error', icon: 'i-lucide-circle-alert'})
			return undefined
		}
		finally {
			busy.value = false
		}
	}

	return {api, base, run, busy}
}

export interface Release {
	app: string
	version: string
	channel: string
	status: 'pending' | 'published'
	notes?: string
	pub_date?: string
	yanked_at?: string
	created_at: string
	platforms: Record<string, {file: string, size: number}>
	installers: Record<string, {file: string, size: number}>
}

export interface Channel {name: string, access: 'public' | 'restricted', includes: string[]}
export interface AppSummary {slug: string, repo: string, ref: string, created_at: string, channels: number, latest: string | null}
export interface User {name: string, note: string | null, created_at: string, grants: string[]}

export const formatDate = (iso?: string) => iso ? new Date(iso).toLocaleString() : '—'
export const formatSize = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
