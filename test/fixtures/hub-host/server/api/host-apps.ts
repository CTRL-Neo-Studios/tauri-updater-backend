// Host route on hub:db: inserts and lists the host's own tu_apps rows.
import {db, schema} from 'hub:db'

export default defineEventHandler(async (event) => {
	if (event.method === 'POST') await db.insert(schema.tu_apps).values({label: 'host-row'})
	return db.select().from(schema.tu_apps)
})
