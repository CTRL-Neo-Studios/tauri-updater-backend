// Repo and branch lookup for the admin's "add app" form. Advisory only: the publish check (oidc.ts) is the real gate,
// so a failed or rate-limited lookup never blocks saving an app.

export type RepoLookup =
	| {status: 'found', repo: string, private: boolean, defaultBranch: string, branches: string[], branchesTruncated: boolean}
	/** 404: doesn't exist, or private and invisible to the configured token (GitHub answers the same for both) */
	| {status: 'not-found', authenticated: boolean}
	/** rate limit, network failure, GitHub outage */
	| {status: 'unavailable', reason: string}

// ponytail: first 5 pages (500 branches); a typed branch name still works past that. Page further if someone needs it.
const MAX_BRANCH_PAGES = 5

/** Looks up owner/name on GitHub with an optional token (needed to see private repos, and for more than 60 calls/hour). */
export async function lookupRepo(repo: string, token: string, apiBase = 'https://api.github.com'): Promise<RepoLookup> {
	const headers: Record<string, string> = {'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'tauri-updater-backend'}
	if (token) headers.authorization = `Bearer ${token}`
	const get = (path: string) => fetch(`${apiBase}${path}`, {headers}).catch(() => null)

	const res = await get(`/repos/${repo}`)
	if (!res) return {status: 'unavailable', reason: 'GitHub could not be reached'}
	if (res.status === 404) return {status: 'not-found', authenticated: !!token}
	if (res.status === 403 || res.status === 429) return {status: 'unavailable', reason: token ? 'GitHub rate limit reached' : 'GitHub rate limit reached; set NUXT_TAURI_UPDATER_GITHUB_TOKEN to raise it'}
	if (res.status === 401) return {status: 'unavailable', reason: 'The configured GitHub token was rejected'}
	if (!res.ok) return {status: 'unavailable', reason: `GitHub answered ${res.status}`}
	const info = await res.json() as {full_name: string, private: boolean, default_branch: string}

	const branches: string[] = []
	let truncated = false
	for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
		const list = await get(`/repos/${info.full_name}/branches?per_page=100&page=${page}`)
		if (!list?.ok) break
		branches.push(...(await list.json() as {name: string}[]).map(b => b.name))
		if (!/rel="next"/.test(list.headers.get('link') ?? '')) break
		if (page === MAX_BRANCH_PAGES) truncated = true
	}
	// the default branch first: it's what most apps publish from
	const ordered = [info.default_branch, ...branches.filter(b => b !== info.default_branch)]
	return {status: 'found', repo: info.full_name, private: info.private, defaultBranch: info.default_branch, branches: ordered, branchesTruncated: truncated}
}
