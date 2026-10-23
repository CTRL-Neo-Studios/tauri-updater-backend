<script setup lang="ts">
import {onMounted, ref} from 'vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UBadge from '@nuxt/ui/components/Badge.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UEmpty from '@nuxt/ui/components/Empty.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UInputTags from '@nuxt/ui/components/InputTags.vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import ConfirmDelete from '../components/ConfirmDelete.vue'
import {formatDate, useAdmin} from '../use-admin'
import type {User} from '../use-admin'

const {api, run, busy} = useAdmin()
const users = ref<User[]>([])
const load = async () => {
	users.value = await run(() => api<User[]>('/users')) ?? users.value
}
onMounted(load)

// a freshly issued token is shown exactly once, then dropped
const issued = ref<{user: string, token: string}>()
const copied = ref(false)
async function copy() {
	await navigator.clipboard.writeText(issued.value!.token)
	copied.value = true
}

const createOpen = ref(false)
const form = ref({name: '', note: '', grants: [] as string[]})
async function create() {
	const result = await run(() => api<{token: string}>('/users', {method: 'POST', body: form.value}), `Created ${form.value.name}`)
	if (!result) return
	issued.value = {user: form.value.name, token: result.token}
	copied.value = false
	createOpen.value = false
	form.value = {name: '', note: '', grants: []}
	await load()
}

async function rotate(user: User) {
	const result = await run(() => api<{token: string}>(`/users/${user.name}/rotate`, {method: 'POST'}), `New token for ${user.name}`)
	if (!result) return
	issued.value = {user: user.name, token: result.token}
	copied.value = false
}

const grantInput = ref<Record<string, string>>({})
async function addGrant(user: User) {
	const grant = grantInput.value[user.name]?.trim()
	if (!grant) return
	if (await run(() => api(`/users/${user.name}/grants`, {method: 'POST', body: {grant}}))) {
		grantInput.value[user.name] = ''
		await load()
	}
}
async function removeGrant(user: User, grant: string) {
	if (await run(() => api(`/users/${user.name}/grants`, {method: 'DELETE', body: {grant}}))) await load()
}
async function remove(user: User, confirm: string) {
	if (await run(() => api(`/users/${user.name}`, {method: 'DELETE', body: {confirm}}), `Deleted ${user.name}`)) await load()
}
</script>

<template>
	<div class="space-y-6">
		<div class="flex items-center justify-between gap-4">
			<div>
				<h1 class="text-2xl font-semibold text-highlighted">Users & tokens</h1>
				<p class="text-sm text-muted">Tokens unlock restricted channels. Grants look like <code class="font-mono">app:channel</code>; <code class="font-mono">*</code> matches anything.</p>
			</div>
			<UModal v-model:open="createOpen" title="New token user">
				<UButton label="New user" icon="i-lucide-plus"/>
				<template #body>
					<form class="space-y-4" @submit.prevent="create">
						<UFormField label="Name" hint="lowercase, digits, dashes"><UInput v-model="form.name" class="w-full" autofocus/></UFormField>
						<UFormField label="Note" hint="who, why"><UInput v-model="form.note" class="w-full"/></UFormField>
						<UFormField label="Grants" hint="press Enter after each">
							<UInputTags v-model="form.grants" placeholder="my-app:beta" class="w-full"/>
						</UFormField>
						<div class="flex justify-end"><UButton type="submit" label="Create and show token" :loading="busy"/></div>
					</form>
				</template>
			</UModal>
		</div>

		<UAlert
			v-if="issued"
			color="success"
			variant="subtle"
			icon="i-lucide-key-round"
			:title="`Token for ${issued.user}`"
			description="Shown once. Copy it now and hand it over; only its hash is stored."
			:close="{onClick: () => { issued = undefined }}"
		>
			<template #actions>
				<code class="block w-full select-all break-all rounded bg-elevated p-2 font-mono text-xs">{{ issued.token }}</code>
				<UButton :label="copied ? 'Copied' : 'Copy'" :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" size="sm" @click="copy"/>
			</template>
		</UAlert>

		<UEmpty v-if="!users.length" icon="i-lucide-users" title="No token users" description="Only needed for restricted channels."/>
		<UCard v-for="user in users" :key="user.name">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<p class="font-semibold text-highlighted">{{ user.name }}</p>
					<p class="text-sm text-muted">{{ user.note || 'No note' }} · since {{ formatDate(user.created_at) }}</p>
				</div>
				<div class="flex gap-2">
					<UButton label="Rotate token" icon="i-lucide-refresh-cw" color="neutral" variant="outline" size="sm" :loading="busy" @click="rotate(user)"/>
					<ConfirmDelete
						title="Delete user"
						:description="`${user.name}'s token stops working immediately.`"
						:expected="user.name"
						@confirm="typed => remove(user, typed)"
					/>
				</div>
			</div>
			<div class="mt-4 flex flex-wrap items-center gap-2">
				<UBadge v-for="g in user.grants" :key="g" color="neutral" variant="subtle" class="font-mono">
					{{ g }}
					<button type="button" class="ms-1 text-muted hover:text-error" :aria-label="`Remove ${g}`" @click="removeGrant(user, g)">×</button>
				</UBadge>
				<form class="flex gap-1" @submit.prevent="addGrant(user)">
					<UInput v-model="grantInput[user.name]" size="sm" placeholder="app:channel" class="w-40 font-mono"/>
					<UButton type="submit" icon="i-lucide-plus" size="sm" variant="soft" aria-label="Add grant"/>
				</form>
			</div>
		</UCard>
	</div>
</template>
