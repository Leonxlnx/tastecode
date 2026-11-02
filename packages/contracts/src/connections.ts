import { z } from 'zod'
import { ModelSchema } from './domain.js'

export const ModelTransportSchema = z.enum([
  'openai-responses',
  'anthropic-messages',
  'openai-compatible',
])
export type ModelTransport = z.infer<typeof ModelTransportSchema>

export const ModelConnectionPresetSchema = z.enum([
  'openai',
  'anthropic',
  'openrouter',
  'kimi',
  'zai',
  'custom',
])
export type ModelConnectionPreset = z.infer<typeof ModelConnectionPresetSchema>

export const ModelEndpointSchema = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')
}, 'expected HTTPS or loopback HTTP on 127.0.0.1')

export const ModelTransportCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  images: z.boolean(),
  reasoning: z.boolean(),
  modelDiscovery: z.boolean(),
  usage: z.boolean(),
})
export type ModelTransportCapabilities = z.infer<typeof ModelTransportCapabilitiesSchema>

const ModelConnectionBaseSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1),
  preset: ModelConnectionPresetSchema,
  transport: ModelTransportSchema,
  baseUrl: ModelEndpointSchema,
  defaultModel: z.string().trim().min(1).optional(),
  enabled: z.boolean(),
})

/** Server-owned configuration. The reference is opaque and never contains a secret. */
export const StoredModelConnectionSchema = ModelConnectionBaseSchema.extend({
  credentialRef: z.string().min(1),
})
export type StoredModelConnection = z.infer<typeof StoredModelConnectionSchema>

/** Sanitized connection state returned to clients. */
export const ModelConnectionSchema = ModelConnectionBaseSchema.extend({
  credentialConfigured: z.boolean(),
  capabilities: ModelTransportCapabilitiesSchema.optional(),
  problem: z.string().min(1).optional(),
})
export type ModelConnection = z.infer<typeof ModelConnectionSchema>

export const ModelConnectionListSchema = z.object({
  connections: z.array(ModelConnectionSchema),
})
export type ModelConnectionList = z.infer<typeof ModelConnectionListSchema>

export const ModelConnectionModelsSchema = z.object({
  models: z.array(ModelSchema),
})
export type ModelConnectionModels = z.infer<typeof ModelConnectionModelsSchema>
