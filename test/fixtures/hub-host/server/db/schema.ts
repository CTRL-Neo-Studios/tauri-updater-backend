import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core'

// The host's own table. Named like the module's on purpose: if the two shared a database, this would collide.
export const tu_apps = sqliteTable('tu_apps', {
	id: integer().primaryKey({autoIncrement: true}),
	label: text().notNull()
})
