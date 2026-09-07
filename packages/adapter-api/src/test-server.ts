import type { Server, ServerResponse } from 'node:http'
import type { JsonValue } from './json.js'

export function testServerBaseUrl(server: Server): string {
  const address = server.address()
  if (!address || typeof address === 'string' || address.port < 1) {
    throw new Error('test server did not bind')
  }
  return `http://127.0.0.1:${address.port}/v1`
}

export function writeJsonResponse(response: ServerResponse, value: JsonValue | undefined): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
