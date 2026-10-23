import {z} from 'zod'
import {branch, channelAccess, grant, repo, slug} from './model'

/** Admins pick a branch; the stored value is the full ref GitHub puts in the CI login token. */
const toRef = (name: string) => `refs/heads/${name}`

export const appInput = z.object({slug, repo, branch: branch.default('main')}).transform(({branch, ...app}) => ({...app, ref: toRef(branch)}))
export const appPatch = z.object({repo, branch}).transform(({branch, ...app}) => ({...app, ref: toRef(branch)}))
export const repoLookupInput = z.object({repo})
export const channelInput = z.object({name: slug, access: channelAccess, includes: z.array(slug).default([])})
export const channelPatch = z.object({access: channelAccess, includes: z.array(slug)})
export const userInput = z.object({name: slug, note: z.string().max(500).nullish(), grants: z.array(grant).default([])})
export const userPatch = z.object({note: z.string().max(500).nullable()})
export const grantInput = z.object({grant})
export const yankInput = z.object({yanked: z.boolean()})
export const purgeInput = z.object({olderThanHours: z.number().int().min(1).max(24 * 365)})
export const sweepInput = z.object({apply: z.boolean().default(false)})
/** Destructive deletes repeat the target's name, so a misclick can't wipe the wrong thing. */
export const confirmInput = z.object({confirm: z.string()})
