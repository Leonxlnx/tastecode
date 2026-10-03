import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { jsonObject, parseJsonValue, type JsonObject, type JsonValue } from './json.js'

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

/**
 * The JSON body of a POST to `path`, or undefined after answering anything else.
 * A parallel workspace run reuses ports, so a stray connection from another
 * test process can reach these servers. It gets a 404 or 400 instead of an
 * exception thrown inside the request handler, which fails the run without
 * failing any test. A malformed request from the code under test still fails
 * its test, because the client sees the error status.
 */
export async function readJsonPost(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<JsonObject | undefined> {
  if (request.method !== 'POST' || request.url !== path) {
    response.writeHead(404).end()
    return undefined
  }
  try {
    let text = ''
    for await (const chunk of request) text += chunk
    return jsonObject(parseJsonValue(text))
  } catch {
    if (!response.headersSent) response.writeHead(400).end()
    return undefined
  }
}
