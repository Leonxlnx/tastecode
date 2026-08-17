import type { Server, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { JsonValue } from './json.js'

const BoundAddressSchema = z.object({ port: z.number().int().positive() })

export function testServerBaseUrl(server: Server): string {
  const result = BoundAddressSchema.safeParse(server.address())
  if (!result.success) throw new Error('test server did not bind')
  return `http://127.0.0.1:${result.data.port}/v1`
}

export function writeJsonResponse(response: ServerResponse, value: JsonValue | undefined): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
