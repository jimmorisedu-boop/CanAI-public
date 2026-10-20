import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import test from 'node:test'
import { attachTabletHelpAssets } from './tabletHelpAssets.js'

function listen(server: ReturnType<typeof createServer>): Promise<{ origin: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('test server did not expose a TCP address'))
        return
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      })
    })
  })
}

function rawGet(origin: string, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(origin)
    const request = httpRequest({ hostname: target.hostname, port: target.port, path: requestPath, method: 'GET' }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end()
  })
}

test('tablet Help serves SVG bytes and never falls through for missing or unsafe paths', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canai-tablet-help-'))
  const helpDir = path.join(tempRoot, 'help')
  await mkdir(helpDir)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>fixture</text></svg>\n'
  await writeFile(path.join(helpDir, 'fixture.svg'), svg, 'utf8')
  await writeFile(path.join(tempRoot, 'secret.svg'), 'private', 'utf8')

  const app = express()
  attachTabletHelpAssets(app, helpDir)
  app.get('*', (_req, res) => res.send('<html>tablet fallback</html>'))
  const server = createServer(app)
  const running = await listen(server)
  try {
    const served = await fetch(`${running.origin}/help/fixture.svg`)
    assert.equal(served.status, 200)
    assert.match(served.headers.get('content-type') ?? '', /^image\/svg\+xml(?:;|$)/u)
    assert.match(served.headers.get('cache-control') ?? '', /no-cache/u)
    assert.doesNotMatch(served.headers.get('cache-control') ?? '', /immutable/u)
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), await readFile(path.join(helpDir, 'fixture.svg')))

    const missing = await fetch(`${running.origin}/help/missing.svg`)
    assert.equal(missing.status, 404, '/help/missing.svg')
    assert.doesNotMatch(await missing.text(), /tablet fallback/u)
    for (const requestPath of ['/help/%2e%2e/secret.svg', '/help/../secret.svg']) {
      const response = await rawGet(running.origin, requestPath)
      assert.equal(response.status, 404, requestPath)
      assert.doesNotMatch(response.body, /tablet fallback/u)
    }
  } finally {
    await running.close()
    const resolvedRoot = path.resolve(tempRoot)
    const resolvedTemp = path.resolve(os.tmpdir())
    if (!resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`)) throw new Error('refusing to remove a test path outside the temp directory')
    await rm(resolvedRoot, { recursive: true, force: true })
  }
})
