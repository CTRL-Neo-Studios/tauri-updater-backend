<script setup lang="ts">
import {onMounted, ref} from 'vue'
import {navigateTo} from '#imports'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UEmpty from '@nuxt/ui/components/Empty.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import {useAdmin} from '../use-admin'
import type {AppSummary} from '../use-admin'

const {api, base, run, busy} = useAdmin()
const apps = ref<AppSummary[]>([])
const load = async () => {
	apps.value = await run(() => api<AppSummary[]>('/apps')) ?? apps.value
}
onMounted(load)

const open = ref(false)
const form = ref({slug: '', repo: '', ref: 'refs/heads/main'})

async function create() {
	const created = await run(() => api<AppSummary>('/apps', {method: 'POST', body: form.value}), `Created ${form.value.slug}`)
	if (!created) return
	open.value = false
	await navigateTo(`${base}/apps/${created.slug}`)
}
</script>

<template>
	<div class="space-y-6">
		<div class="flex items-center justify-between gap-4">
			<h1 class="text-2xl font-semibold text-highlighted">Apps</h1>
			<UModal v-model:open="open" title="New app" description="The slug appears in every URL and storage path: pick it once.">
				<UButton label="New app" icon="i-lucide-plus"/>
				<template #body>
					<form class="space-y-4" @submit.prevent="create">
						<UFormField label="Slug" hint="lowercase, digits, dashes">
							<UInput v-model="form.slug" placeholder="my-app" class="w-full" autofocus/>
						</UFormField>
						<UFormField label="Publishing repo" hint="owner/name">
							<UInput v-model="form.repo" placeholder="my-org/my-app" class="w-full"/>
						</UFormField>
						<UFormField label="Publishing ref">
							<UInput v-model="form.ref" class="w-full font-mono"/>
						</UFormField>
						<div class="flex justify-end">
							<UButton type="submit" label="Create" :loading="busy"/>
						</div>
					</form>
				</template>
			</UModal>
		</div>

		<UEmpty v-if="!apps.length" icon="i-lucide-package" title="No apps yet" description="Register an app, then point its CI at the release workflow."/>
		<div v-else class="grid gap-4 sm:grid-cols-2">
			<UCard v-for="app in apps" :key="app.slug" class="cursor-pointer hover:ring-primary" @click="navigateTo(`${base}/apps/${app.slug}`)">
				<div class="flex items-start justify-between gap-2">
					<div class="min-w-0">
						<p class="font-semibold text-highlighted">{{ app.slug }}</p>
						<p class="truncate font-mono text-sm text-muted">{{ app.repo }}</p>
					</div>
					<span class="font-mono text-sm">{{ app.latest ?? 'no release' }}</span>
				</div>
				<p class="mt-3 text-xs text-muted">{{ app.channels }} channel{{ app.channels === 1 ? '' : 's' }}</p>
			</UCard>
		</div>
	</div>
</template>
