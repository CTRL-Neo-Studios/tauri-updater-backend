<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {navigateTo} from '#imports'
import UBadge from '@nuxt/ui/components/Badge.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCard from '@nuxt/ui/components/Card.vue'
import UEmpty from '@nuxt/ui/components/Empty.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import USelectMenu from '@nuxt/ui/components/SelectMenu.vue'
import ConfirmDelete from '../components/ConfirmDelete.vue'
import RepoBranchFields from '../components/RepoBranchFields.vue'
import {formatDate, formatSize, useAdmin} from '../use-admin'
import type {Channel, Release} from '../use-admin'

const props = defineProps<{slug: string}>()
const {api, base, run, busy} = useAdmin()

interface Detail {app: {slug: string, repo: string, ref: string}, channels: Channel[], releases: Release[]}
const data = ref<Detail>()
const load = async () => {
	data.value = await run(() => api<Detail>(`/apps/${props.slug}`)) ?? data.value
}
onMounted(load)

const channelFilter = ref<string>('all')
const releases = computed(() => (data.value?.releases ?? []).filter(r => channelFilter.value === 'all' || r.channel === channelFilter.value))
/** Newest live release each channel would serve, following includes. */
const serving = computed(() => {
	const live = (data.value?.releases ?? []).filter(r => r.status === 'published' && !r.yanked_at)
	return Object.fromEntries((data.value?.channels ?? []).map(c => {
		const names = new Set([c.name, ...c.includes])
		return [c.name, live.find(r => names.has(r.channel))?.version ?? null]
	}))
})

// app settings. The API stores the full git ref (refs/heads/<branch>); people only ever see and type the branch.
const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, '')
const appForm = ref({repo: '', branch: ''})
const settingsOpen = ref(false)
function editApp() {
	appForm.value = {repo: data.value!.app.repo, branch: branchOf(data.value!.app.ref)}
	settingsOpen.value = true
}
async function saveApp() {
	if (await run(() => api(`/apps/${props.slug}`, {method: 'PUT', body: appForm.value}), 'Saved')) {
		settingsOpen.value = false
		await load()
	}
}
async function deleteApp(confirm: string) {
	if (await run(() => api(`/apps/${props.slug}`, {method: 'DELETE', body: {confirm}}), `Deleted ${props.slug}`)) await navigateTo(`${base}/apps`)
}

// channels
const accessItems = [{label: 'Public', value: 'public'}, {label: 'Restricted (token)', value: 'restricted'}]
const channelOpen = ref(false)
const channelForm = ref<Channel & {isNew: boolean}>({name: '', access: 'public', includes: [], isNew: true})
const includeOptions = computed(() => (data.value?.channels ?? []).map(c => c.name).filter(n => n !== channelForm.value.name))
function editChannel(channel?: Channel) {
	channelForm.value = channel ? {...channel, includes: [...channel.includes], isNew: false} : {name: '', access: 'public', includes: [], isNew: true}
	channelOpen.value = true
}
async function saveChannel() {
	const {isNew, name, access, includes} = channelForm.value
	const saved = isNew
		? await run(() => api(`/apps/${props.slug}/channels`, {method: 'POST', body: {name, access, includes}}), `Created ${name}`)
		: await run(() => api(`/apps/${props.slug}/channels/${name}`, {method: 'PUT', body: {access, includes}}), `Saved ${name}`)
	if (saved) {
		channelOpen.value = false
		await load()
	}
}
async function deleteChannel(name: string, confirm: string) {
	if (await run(() => api(`/apps/${props.slug}/channels/${name}`, {method: 'DELETE', body: {confirm}}), `Deleted ${name}`)) await load()
}

// releases
async function setYanked(release: Release, yanked: boolean) {
	if (await run(() => api(`/apps/${props.slug}/releases/${release.version}/yank`, {method: 'POST', body: {yanked}}), yanked ? `Yanked ${release.version}` : `Restored ${release.version}`)) await load()
}
async function deleteRelease(release: Release, confirm: string) {
	if (await run(() => api(`/apps/${props.slug}/releases/${release.version}`, {method: 'DELETE', body: {confirm}}), `Deleted ${release.version}`)) await load()
}
/** Total stored bytes; a file shared by several platforms (universal macOS build) counts once. */
function size(r: Release) {
	const files = new Map([...Object.values(r.platforms), ...Object.values(r.installers)].map(f => [f.file, f.size]))
	return formatSize([...files.values()].reduce((a, b) => a + b, 0))
}
</script>

<template>
	<div v-if="data" class="space-y-6">
		<div class="flex flex-wrap items-start justify-between gap-4">
			<div>
				<UButton :to="`${base}/apps`" label="Apps" icon="i-lucide-chevron-left" variant="link" color="neutral" class="mb-1 px-0"/>
				<h1 class="text-2xl font-semibold text-highlighted">{{ data.app.slug }}</h1>
				<p class="flex items-center gap-1.5 font-mono text-sm text-muted">
					<UIcon name="i-lucide-github" class="size-4"/>{{ data.app.repo }}
					<UIcon name="i-lucide-git-branch" class="ms-2 size-4"/>{{ branchOf(data.app.ref) }}
				</p>
			</div>
			<div class="flex gap-2">
				<UButton label="Settings" icon="i-lucide-settings" color="neutral" variant="outline" size="sm" @click="editApp"/>
				<ConfirmDelete
					title="Delete app"
					:description="`Deletes ${data.app.slug}, all its channels and releases, and every stored file. Installed apps stop receiving updates.`"
					:expected="data.app.slug"
					label="Delete app"
					@confirm="deleteApp"
				/>
			</div>
		</div>

		<UCard>
			<template #header>
				<div class="flex items-center justify-between">
					<h2 class="font-semibold text-highlighted">Channels</h2>
					<UButton label="Add channel" icon="i-lucide-plus" size="sm" variant="soft" @click="editChannel()"/>
				</div>
			</template>
			<div class="divide-y divide-default">
				<div v-for="channel in data.channels" :key="channel.name" class="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
					<span class="font-mono font-medium text-highlighted">{{ channel.name }}</span>
					<UBadge :label="channel.access" :color="channel.access === 'public' ? 'success' : 'warning'" variant="subtle" size="sm"/>
					<span v-if="channel.includes.length" class="text-xs text-muted">+ {{ channel.includes.join(', ') }}</span>
					<span class="ms-auto font-mono text-sm">{{ serving[channel.name] ?? '—' }}</span>
					<UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" aria-label="Edit" @click="editChannel(channel)"/>
					<ConfirmDelete
						title="Delete channel"
						:description="`Deletes ${channel.name} and every release on it, including stored files.`"
						:expected="channel.name"
						@confirm="typed => deleteChannel(channel.name, typed)"
					/>
				</div>
			</div>
		</UCard>

		<UCard>
			<template #header>
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h2 class="font-semibold text-highlighted">Releases</h2>
					<USelect v-model="channelFilter" :items="[{label: 'All channels', value: 'all'}, ...data.channels.map(c => ({label: c.name, value: c.name}))]" size="sm" class="w-44"/>
				</div>
			</template>
			<UEmpty v-if="!releases.length" icon="i-lucide-rocket" title="No releases" :description="`Bump the version in tauri.conf.json and push to ${branchOf(data.app.ref)}.`"/>
			<div v-else class="divide-y divide-default">
				<div v-for="release in releases" :key="release.version" class="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
					<span class="font-mono font-medium text-highlighted" :class="release.yanked_at && 'line-through text-muted'">{{ release.version }}</span>
					<UBadge :label="release.channel" variant="outline" color="neutral" size="sm"/>
					<UBadge v-if="release.status === 'pending'" label="pending" color="warning" variant="subtle" size="sm"/>
					<UBadge v-if="release.yanked_at" label="yanked" color="error" variant="subtle" size="sm"/>
					<span class="text-xs text-muted">{{ Object.keys(release.platforms).join(', ') }} · {{ size(release) }}</span>
					<span class="ms-auto text-xs text-muted">{{ formatDate(release.pub_date ?? release.created_at) }}</span>
					<UButton
						v-if="release.status === 'published'"
						:label="release.yanked_at ? 'Restore' : 'Yank'"
						:icon="release.yanked_at ? 'i-lucide-undo-2' : 'i-lucide-ban'"
						color="neutral"
						variant="ghost"
						size="sm"
						:loading="busy"
						@click="setYanked(release, !release.yanked_at)"
					/>
					<ConfirmDelete
						title="Delete release"
						:description="`Deletes ${release.version} and its stored files. It can't be published again with the same version.`"
						:expected="release.version"
						@confirm="typed => deleteRelease(release, typed)"
					/>
				</div>
			</div>
		</UCard>

		<UModal v-model:open="settingsOpen" title="App settings" description="Who may publish releases for this app.">
			<template #body>
				<form class="space-y-4" @submit.prevent="saveApp">
					<RepoBranchFields v-if="settingsOpen" v-model:repo="appForm.repo" v-model:branch="appForm.branch"/>
					<div class="flex justify-end"><UButton type="submit" label="Save" :loading="busy" :disabled="!appForm.repo || !appForm.branch"/></div>
				</form>
			</template>
		</UModal>

		<UModal v-model:open="channelOpen" :title="channelForm.isNew ? 'New channel' : `Edit ${channelForm.name}`" description="Included channels are offered too; the newest version wins.">
			<template #body>
				<form class="space-y-4" @submit.prevent="saveChannel">
					<UFormField v-if="channelForm.isNew" label="Name" hint="e.g. beta">
						<UInput v-model="channelForm.name" class="w-full" autofocus/>
					</UFormField>
					<UFormField label="Access"><USelect v-model="channelForm.access" :items="accessItems" class="w-full"/></UFormField>
					<UFormField label="Also offers">
						<USelectMenu v-model="channelForm.includes" :items="includeOptions" multiple class="w-full" placeholder="none"/>
					</UFormField>
					<div class="flex justify-end"><UButton type="submit" label="Save" :loading="busy"/></div>
				</form>
			</template>
		</UModal>
	</div>
</template>
