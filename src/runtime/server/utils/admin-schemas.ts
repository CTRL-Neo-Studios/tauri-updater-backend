import {z} from 'zod'
import {channelAccess, gitRef, grant, repo, slug} from './model'

export const appInput = z.object({slug, repo, ref: gitRef.default('refs/heads/main')})
export const appPatch = z.object({repo, ref: gitRef})
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
