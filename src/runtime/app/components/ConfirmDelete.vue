<script setup lang="ts">
// Destructive actions repeat the target's name, matching the server's `confirm` check.
import {computed, ref} from 'vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UModal from '@nuxt/ui/components/Modal.vue'

const props = defineProps<{title: string, description: string, expected: string, label?: string}>()
const emit = defineEmits<{confirm: [typed: string]}>()

const open = ref(false)
const typed = ref('')
const matches = computed(() => typed.value === props.expected)

function submit() {
	if (!matches.value) return
	emit('confirm', typed.value)
	open.value = false
	typed.value = ''
}
</script>

<template>
	<UModal v-model:open="open" :title="title" :description="description">
		<UButton :label="label ?? 'Delete'" color="error" variant="soft" icon="i-lucide-trash-2" size="sm"/>
		<template #body>
			<form class="space-y-3" @submit.prevent="submit">
				<p class="text-sm text-muted">Type <code class="font-mono text-highlighted">{{ expected }}</code> to confirm.</p>
				<UInput v-model="typed" autofocus class="w-full" :placeholder="expected"/>
				<div class="flex justify-end gap-2">
					<UButton label="Cancel" color="neutral" variant="ghost" @click="open = false"/>
					<UButton type="submit" :label="label ?? 'Delete'" color="error" :disabled="!matches"/>
				</div>
			</form>
		</template>
	</UModal>
</template>
