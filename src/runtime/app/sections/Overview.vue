<script setup lang="ts">
import {onMounted, ref} from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UBadge from '@nuxt/ui/components/Badge.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import {useAdmin} from '../use-admin'

interface Overview {
	counts: {apps: number, users: number, releases: number, pending: number}
	config: {
		prefix: string
		database: string
		storage: {endpoint: string | null, bucket: string | null, keyPrefix: string}
		oidc: {issuer: string, audience: string, allowedWorkflows: string[]}
		headers: {channel: string, token: string}
		auth: 'token' | 'host'
	}
}

const {api, run} = useAdmin()
const data = ref<Overview>()
onMounted(async () => {
	data.value = await run(() => api<Overview>('/overview'))
})

const stats = (o: Overview) => [
	{label: 'Apps', value: o.counts.apps},
	{label: 'Published releases', value: o.counts.releases},
	{label: 'Pending releases', value: o.counts.pending},
	{label: 'Token users', value: o.counts.users}
]
</script>

<template>
	<div v-if="data" class="space-y-6">
		<h1 class="text-2xl font-semibold text-highlighted">Overview</h1>

		<UAlert
			v-if="data.config.auth === 'token'"
			color="warning"
			variant="subtle"
			icon="i-lucide-triangle-alert"
			title="Signed in with the shared admin token"
			description="Anyone with this token can change which repos publish. In production, add a tauri-updater:authorize hook backed by your own auth."
		/>
		<UAlert
			v-if="!data.config.storage.bucket"
			color="error"
			variant="subtle"
			icon="i-lucide-hard-drive"
			title="Storage is not configured"
			description="Set NUXT_TAURI_UPDATER_S3_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY."
		/>
		<UAlert
			v-if="!data.config.oidc.allowedWorkflows.length"
			color="warning"
			variant="subtle"
			icon="i-lucide-lock"
			title="Publishing is disabled"
			description="No release workflow is allowed yet: set tauriUpdater.oidc.allowedWorkflows."
		/>

		<div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
			<UCard v-for="s in stats(data)" :key="s.label">
				<p class="text-sm text-muted">{{ s.label }}</p>
				<p class="text-3xl font-semibold text-highlighted">{{ s.value }}</p>
			</UCard>
		</div>

		<UCard>
			<template #header><h2 class="font-semibold text-highlighted">Configuration</h2></template>
			<dl class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[12rem_1fr]">
				<dt class="text-muted">Public routes</dt>
				<dd class="font-mono">{{ data.config.prefix }}/…</dd>
				<dt class="text-muted">Updater endpoint</dt>
				<dd class="font-mono break-all" v-text="`${data.config.prefix}/updates/<app>/{{target}}/{{arch}}/{{current_version}}`"/>
				<dt class="text-muted">Database</dt>
				<dd><UBadge :label="data.config.database" variant="subtle" color="neutral"/></dd>
				<dt class="text-muted">Storage</dt>
				<dd class="font-mono">{{ data.config.storage.endpoint ?? '—' }} / {{ data.config.storage.bucket ?? '—' }} / {{ data.config.storage.keyPrefix || '(root)' }}</dd>
				<dt class="text-muted">OIDC audience</dt>
				<dd class="font-mono">{{ data.config.oidc.audience }}</dd>
				<dt class="text-muted">Allowed workflows</dt>
				<dd class="space-y-1 font-mono break-all">
					<p v-for="w in data.config.oidc.allowedWorkflows" :key="w">{{ w }}</p>
					<p v-if="!data.config.oidc.allowedWorkflows.length" class="text-muted">none</p>
				</dd>
				<dt class="text-muted">Client headers</dt>
				<dd class="font-mono">{{ data.config.headers.channel }}, {{ data.config.headers.token }}</dd>
			</dl>
		</UCard>
	</div>
</template>
