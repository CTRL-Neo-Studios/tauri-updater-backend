<script setup lang="ts">
import {ref} from 'vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import {formatSize, useAdmin} from '../use-admin'

const {api, run, busy} = useAdmin()

const hours = ref(24)
const purged = ref<string[]>()
async function purge() {
	purged.value = (await run(() => api<{purged: string[]}>('/maintenance/purge-pending', {method: 'POST', body: {olderThanHours: hours.value}})))?.purged
}

interface Sweep {orphans: {key: string, size: number, lastModified: string}[], deleted: boolean}
const sweep = ref<Sweep>()
async function scan(apply: boolean) {
	sweep.value = await run(() => api<Sweep>('/maintenance/sweep', {method: 'POST', body: {apply}}), apply ? 'Orphans deleted' : undefined)
}
</script>

<template>
	<div class="space-y-6">
		<h1 class="text-2xl font-semibold text-highlighted">Maintenance</h1>

		<UCard>
			<template #header>
				<h2 class="font-semibold text-highlighted">Purge abandoned releases</h2>
				<p class="text-sm text-muted">Pending releases come from CI runs that never published (failed builds, cancelled jobs). This deletes them and their uploads.</p>
			</template>
			<form class="flex flex-wrap items-end gap-3" @submit.prevent="purge">
				<UFormField label="Older than (hours)"><UInput v-model.number="hours" type="number" min="1" class="w-32"/></UFormField>
				<UButton type="submit" label="Purge pending" color="warning" :loading="busy"/>
			</form>
			<p v-if="purged" class="mt-3 text-sm text-muted">{{ purged.length ? `Purged ${purged.join(', ')}` : 'Nothing to purge.' }}</p>
		</UCard>

		<UCard>
			<template #header>
				<h2 class="font-semibold text-highlighted">Orphaned files</h2>
				<p class="text-sm text-muted">Bucket objects under the key prefix that no release references. Scanning is read-only.</p>
			</template>
			<div class="flex gap-2">
				<UButton label="Scan" icon="i-lucide-search" color="neutral" variant="outline" :loading="busy" @click="scan(false)"/>
				<UButton v-if="sweep && !sweep.deleted && sweep.orphans.length" :label="`Delete ${sweep.orphans.length} files`" color="error" :loading="busy" @click="scan(true)"/>
			</div>
			<div v-if="sweep" class="mt-4 text-sm">
				<p v-if="!sweep.orphans.length" class="text-muted">No orphaned files.</p>
				<ul v-else class="divide-y divide-default font-mono text-xs">
					<li v-for="o in sweep.orphans" :key="o.key" class="flex justify-between gap-4 py-1.5" :class="sweep.deleted && 'line-through text-muted'">
						<span class="truncate">{{ o.key }}</span><span class="shrink-0">{{ formatSize(o.size) }}</span>
					</li>
				</ul>
			</div>
		</UCard>
	</div>
</template>
