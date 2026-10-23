// @ts-check
import {createConfigForNuxt} from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({
	features: {
		tooling: true,
		// the repo uses tabs, no semicolons and single quotes (.editorconfig); stylistic rules would fight that
		stylistic: false
	},
	dirs: {src: ['./playground']}
}).append(
	{ignores: ['**/.data/**', '**/.output/**', 'test/fixtures/**/.nuxt/**', 'test/fixtures/**/server/db/migrations/**']},
	// route files and locally imported admin sections, never registered as global components
	{files: ['playground/app/pages/**/*.vue', 'src/runtime/app/**/*.vue'], rules: {'vue/multi-word-component-names': 'off'}}
)
