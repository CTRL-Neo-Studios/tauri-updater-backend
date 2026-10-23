<script setup lang="ts">
// Repo + branch fields with a live GitHub check: as owner/name is typed, shows whether the repo exists and is
// public/private, then offers its branches in a searchable menu. Advisory only; any branch name can still be typed.
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UInputMenu from '@nuxt/ui/components/InputMenu.vue'
import UBadge from '@nuxt/ui/components/Badge.vue'
import {useAdmin} from '../use-admin'

type Lookup =
	| {status: 'found', repo: string, private: boolean, defaultBranch: string, branches: string[], branchesTruncated: boolean}
	| {status: 'not-found', authenticated: boolean}
	| {status: 'unavailable', reason: string}

const repo = defineModel<string>('repo', {required: true})
const branch = defineModel<string>('branch', {required: true})
const {api} = useAdmin()

/** Accepts owner/name or a pasted GitHub URL (https://github.com/owner/name[.git][/...]). */
const normalized = computed(() => {
	const m = repo.value.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/)
	return m ? `${m[1]}/${m[2]}` : ''
})

const lookup = ref<Lookup>()
const checking = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

watch(normalized, (value) => {
	clearTimeout(timer)
	lookup.value = undefined
	if (!value) return
	// wait for typing to pause; GitHub allows 60 anonymous lookups an hour
	timer = setTimeout(async () => {
		const mine = ++seq
		checking.value = true
		try {
			const result = await api<Lookup>('/github/repo', {method: 'POST', body: {repo: value}})
			if (mine !== seq) return
			lookup.value = result
			if (result.status === 'found') {
				if (repo.value !== result.repo) repo.value = result.repo // canonical casing, and URLs become owner/name
				if (!branch.value || !result.branches.includes(branch.value)) branch.value = result.defaultBranch
			}
		}
		catch {
			if (mine === seq) lookup.value = {status: 'unavailable', reason: 'Lookup failed'}
		}
		finally {
			if (mine === seq) checking.value = false
		}
	}, 450)
}, {immediate: true})
onBeforeUnmount(() => clearTimeout(timer))

const branches = computed(() => lookup.value?.status === 'found' ? lookup.value.branches : [])
const repoHint = computed(() => {
	const l = lookup.value
	if (!normalized.value) return repo.value.trim() ? 'Use owner/name, or paste the GitHub URL' : undefined
	if (checking.value || !l) return 'Checking GitHub…'
	if (l.status === 'not-found') return l.authenticated
		? 'Not found, or the configured GitHub token can\'t see it'
		: 'Not found. If it\'s private, set NUXT_TAURI_UPDATER_GITHUB_TOKEN so it can be checked (saving still works)'
	if (l.status === 'unavailable') return `Couldn't check: ${l.reason}. Saving still works.`
	return undefined
})
</script>

<template>
	<UFormField label="GitHub repository" :help="repoHint" description="The repo whose CI publishes this app's releases.">
		<UInput
			v-model="repo"
			placeholder="my-org/my-app"
			class="w-full font-mono"
			:loading="checking"
			icon="i-lucide-github"
			autocomplete="off"
		>
			<template v-if="lookup?.status === 'found'" #trailing>
				<UBadge
					:label="lookup.private ? 'private' : 'public'"
					:icon="lookup.private ? 'i-lucide-lock' : 'i-lucide-globe'"
					:color="lookup.private ? 'warning' : 'success'"
					variant="subtle"
					size="sm"
				/>
			</template>
		</UInput>
	</UFormField>

	<UFormField
		label="Release branch"
		description="Only CI runs on this branch can publish. Pushes to other branches, pull requests and forks are refused."
		:help="lookup?.status === 'found' && lookup.branchesTruncated ? 'Showing the first 500 branches; type any other name.' : undefined"
	>
		<UInputMenu
			v-model="branch"
			mode="autocomplete"
			:items="branches"
			placeholder="main"
			icon="i-lucide-git-branch"
			class="w-full font-mono"
			open-on-focus
			open-on-click
			autocomplete="off"
		/>
	</UFormField>
</template>
