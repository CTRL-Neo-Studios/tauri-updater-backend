// Own database connection via db0, never the host's hub:db or Nitro's useDatabase().
// One portable DDL for SQLite (libSQL/Turso, D1) and PostgreSQL (pg, Neon, PGlite): TEXT/BIGINT only, no autoincrement,
// no ON DELETE CASCADE (FK enforcement differs across SQLite flavours), no interactive transactions (D1 has none).
import {createDatabase} from 'db0'
import type {Connector, Database} from 'db0'

/** Ordered, append-only. Each runs once per database, tracked in tu_migrations. Never edit a shipped entry. */
export const migrations: {id: string, sql: string[]}[] = [
	{
		id: '0001_init',
		sql: [
			`CREATE TABLE IF NOT EXISTS tu_apps (
				slug TEXT PRIMARY KEY,
				repo TEXT NOT NULL,
				ref TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS tu_channels (
				app TEXT NOT NULL,
				name TEXT NOT NULL,
				access TEXT NOT NULL,
				includes TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (app, name)
			)`,
			`CREATE TABLE IF NOT EXISTS tu_users (
				name TEXT PRIMARY KEY,
				token_hash TEXT NOT NULL UNIQUE,
				note TEXT,
				created_at TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS tu_grants (
				user_name TEXT NOT NULL,
				grant_value TEXT NOT NULL,
				PRIMARY KEY (user_name, grant_value)
			)`,
			`CREATE TABLE IF NOT EXISTS tu_releases (
				app TEXT NOT NULL,
				version TEXT NOT NULL,
				channel TEXT NOT NULL,
				status TEXT NOT NULL,
				notes TEXT,
				pub_date TEXT,
				yanked_at TEXT,
				run_id TEXT,
				created_at TEXT NOT NULL,
				PRIMARY KEY (app, version)
			)`,
			`CREATE TABLE IF NOT EXISTS tu_files (
				app TEXT NOT NULL,
				version TEXT NOT NULL,
				kind TEXT NOT NULL,
				platform TEXT NOT NULL,
				file TEXT NOT NULL,
				size BIGINT NOT NULL,
				signature TEXT,
				PRIMARY KEY (app, version, kind, platform)
			)`,
			'CREATE INDEX IF NOT EXISTS tu_releases_channel ON tu_releases (app, channel, status)'
		]
	}
]

/** Runs pending migrations. Concurrent instances are safe: DDL is IF NOT EXISTS and the id insert ignores conflicts. */
export async function migrate(db: Database) {
	await db.exec('CREATE TABLE IF NOT EXISTS tu_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
	const {rows = []} = await db.sql`SELECT id FROM tu_migrations`
	const applied = new Set(rows.map(r => r.id))
	for (const migration of migrations) {
		if (applied.has(migration.id)) continue
		// ponytail: statements run one by one, not in a transaction (D1 has none); a crash mid-migration needs a manual
		// cleanup. Fine while the only migration is table creation.
		for (const statement of migration.sql) await db.exec(statement)
		await db.sql`INSERT INTO tu_migrations (id, applied_at) VALUES (${migration.id}, ${new Date().toISOString()}) ON CONFLICT (id) DO NOTHING`
	}
}

/**
 * Opens and migrates lazily on first use: a D1 binding only exists inside a request on Workers, and serverless cold
 * starts shouldn't pay for a connection the request doesn't need.
 */
export function createUpdaterDatabase(connector: () => Connector) {
	let ready: Promise<Database> | undefined
	return () => ready ??= (async () => {
		const db = createDatabase(connector())
		await migrate(db)
		return db
	})().catch((error) => {
		ready = undefined
		throw error
	})
}
