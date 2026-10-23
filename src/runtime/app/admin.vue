<script setup lang="ts">
// Admin shell: auth gate, navigation, section routing. One page record catches <adminPath>/**; sections are local
// components, so the module adds a single route to the host and nothing else.
import {computed, onMounted, provide, ref, watch} from 'vue'
import {definePageMeta, useHead, useRoute, useRuntimeConfig} from '#imports'
import UApp from '@nuxt/ui/components/App.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UNavigationMenu from '@nuxt/ui/components/NavigationMenu.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import {ApiError, adminToken, createApi, setAdminToken} from './api'
import UIcon from '@nuxt/ui/components/Icon.vue'
import AppDetail from './sections/AppDetail.vue'
import AppsList from './sections/AppsList.vue'
import Maintenance from './sections/Maintenance.vue'
import Overview from './sections/Overview.vue'
import Users from './sections/Users.vue'

definePageMeta({layout: false})
useHead({title: 'Updater admin', meta: [{name: 'robots', content: 'noindex, nofollow'}]})

const base: string = useRuntimeConfig().public.tauriUpdater.adminPath
const api = createApi(base)
provide('tauri-updater:api', api)
provide('tauri-updater:base', base)

const route = useRoute()
const section = computed(() => {
	const parts = ([] as string[]).concat(route.params.section ?? []).filter(Boolean)
	return {name: parts[0] ?? '', arg: parts[1]}
})

const nav = computed(() => [
	{label: 'Overview', icon: 'i-lucide-gauge', to: base, active: section.value.name === ''},
	{label: 'Apps', icon: 'i-lucide-package', to: `${base}/apps`, active: section.value.name === 'apps'},
	{label: 'Users & tokens', icon: 'i-lucide-key-round', to: `${base}/users`, active: section.value.name === 'users'},
	{label: 'Maintenance', icon: 'i-lucide-wrench', to: `${base}/maintenance`, active: section.value.name === 'maintenance'}
])

// auth: try the API. 401: token fallback in use, ask for one. 403: the host's hook said no. 404: neither a hook nor a
// token is configured, so the admin is closed. Anything else (503 database down, ...) is shown as-is.
const state = ref<'checking' | 'ok' | 'needs-token' | 'denied' | 'unconfigured' | 'error'>('checking')
const tokenInput = ref('')
const authError = ref('')
const loadError = ref('')

async function check() {
	state.value = 'checking'
	try {
		await api('/overview')
		state.value = 'ok'
	}
	catch (error) {
		const status = error instanceof ApiError ? error.status : 0
		if (status === 401) {
			if (adminToken.value) authError.value = 'That token was rejected.'
			setAdminToken('')
			state.value = 'needs-token'
		}
		else if (status === 403) state.value = 'denied'
		else if (status === 404) state.value = 'unconfigured'
		else {
			loadError.value = error instanceof Error ? error.message : 'Request failed'
			state.value = 'error'
		}
	}
}

function signIn() {
	authError.value = ''
	setAdminToken(tokenInput.value.trim())
	tokenInput.value = ''
	return check()
}

function signOut() {
	setAdminToken('')
	state.value = 'needs-token'
}

onMounted(check)
watch(() => route.fullPath, () => window.scrollTo({top: 0}))
</script>

<template>
	<UApp>
		<div class="min-h-svh bg-default text-default">
			<div v-if="state === 'checking'" class="grid min-h-svh place-items-center text-muted text-sm">Loading…</div>

			<div v-else-if="state === 'needs-token'" class="grid min-h-svh place-items-center p-4">
				<UCard class="w-full max-w-sm">
					<template #header>
						<h1 class="font-semibold text-highlighted">Updater admin</h1>
						<p class="text-sm text-muted">Paste the admin token (NUXT_TAURI_UPDATER_ADMIN_TOKEN).</p>
					</template>
					<form class="space-y-3" @submit.prevent="signIn">
						<UInput v-model="tokenInput" type="password" autocomplete="off" placeholder="Admin token" autofocus class="w-full"/>
						<p v-if="authError" class="text-sm text-error">{{ authError }}</p>
						<UButton type="submit" label="Sign in" block :disabled="!tokenInput.trim()"/>
					</form>
				</UCard>
			</div>

			<div v-else-if="state === 'denied'" class="grid min-h-svh place-items-center p-4">
				<UAlert class="max-w-md" color="error" variant="subtle" icon="i-lucide-shield-x" title="No access" description="Your account isn't allowed to manage releases."/>
			</div>

			<div v-else-if="state === 'unconfigured'" class="grid min-h-svh place-items-center p-4">
				<UAlert class="max-w-lg" color="warning" variant="subtle" icon="i-lucide-lock" title="The admin isn't set up yet">
					<template #description>
						It stays closed until you choose how to sign in. Set
						<code class="font-mono">NUXT_TAURI_UPDATER_ADMIN_TOKEN</code> (or <code class="font-mono">tauriUpdater.adminToken</code>),
						or add a <code class="font-mono">tauri-updater:authorize</code> server hook backed by your own auth. Then reload.
					</template>
				</UAlert>
			</div>

			<div v-else-if="state === 'error'" class="grid min-h-svh place-items-center p-4">
				<UAlert class="max-w-md" color="error" variant="subtle" icon="i-lucide-circle-alert" title="The admin couldn't load" :description="loadError"/>
			</div>

			<div v-else class="mx-auto grid max-w-7xl gap-6 p-4 md:grid-cols-[14rem_1fr] md:p-8">
				<aside class="space-y-4">
					<div class="flex items-center gap-2 px-2">
						<UIcon name="i-lucide-rocket" class="size-5 text-primary"/>
						<span class="font-semibold text-highlighted">Updater</span>
					</div>
					<UNavigationMenu :items="nav" orientation="vertical"/>
					<UButton v-if="adminToken" label="Sign out" icon="i-lucide-log-out" color="neutral" variant="ghost" size="sm" block @click="signOut"/>
				</aside>
				<main class="min-w-0">
					<Overview v-if="section.name === ''"/>
					<AppDetail v-else-if="section.name === 'apps' && section.arg" :key="section.arg" :slug="section.arg"/>
					<AppsList v-else-if="section.name === 'apps'"/>
					<Users v-else-if="section.name === 'users'"/>
					<Maintenance v-else-if="section.name === 'maintenance'"/>
					<UAlert v-else color="neutral" variant="subtle" title="Not found" icon="i-lucide-circle-help"/>
				</main>
			</div>
		</div>
	</UApp>
</template>
