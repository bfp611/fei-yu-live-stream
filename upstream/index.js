import z from '@deepseek-ai/schemastery'
import { mountService } from './launcher.mjs'
import { registerAvatarTools } from './avatar-tools.mjs'
export const name='dsh-live-studio'
export const inject=['connection','tools','webServer']
export const Config=z.object({enabled:z.boolean().default(false),home:z.string().default(''),
  persona:z.string().default(''),python:z.string().default('python'),port:z.number().default(3088),
  jingyuUrl:z.string().default(''),model:z.string().default(''),cubismCore:z.string().default(''),pet:z.string().default(''),
  room:z.number().default(0),credential:z.string().default(''),ledger:z.string().default('')})
export function apply(ctx,config){mountService(ctx,config,name);if(config.enabled&&config.cubismCore)registerAvatarTools(ctx,config)}
