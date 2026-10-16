import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from './json.js'
import { readJsonPost, testServerBaseUrl } from './test-server.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  )
})

async function recordingServer() {
  const requests: JsonObject[] = []
  const server = createServer(async (request, response) => {
    const json = await readJsonPost(request, response, '/v1/responses')
    if (!json) return
    requests.push(json)
    response.writeHead(200).end()
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: testServerBaseUrl(server), requests }
}

describe('fake provider server', () => {
  it('answers stray connections from other test processes instead of throwing', async () => {
    const { url, requests } = await recordingServer()

    expect((await fetch(`${url}/`)).status).toBe(404)
    expect((await fetch(`${url}/models`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${url}/responses`, { method: 'POST' })).status).toBe(400)
    expect((await fetch(`${url}/responses`, { method: 'POST', body: '{"model"' })).status).toBe(400)
    expect(requests).toEqual([])
  })

  it('records the JSON body of the expected request', async () => {
    const { url, requests } = await recordingServer()
    const response = await fetch(`${url}/responses`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-test' }),
    })
    expect(response.status).toBe(200)
    expect(requests).toEqual([{ model: 'gpt-test' }])
  })
})
