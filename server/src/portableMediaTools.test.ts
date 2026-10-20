import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  PortableMediaTools,
  portableToolAsset,
  type GitHubRelease,
  type PortableMediaToolsDeps,
} from './portableMediaTools.js'

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function byteStream(chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk))
      controller.close()
    },
  })
}

function release(asset: string, bytes: Uint8Array, digestOverride?: string): GitHubRelease {
  return {
    tag_name: 'v2026.08.17',
    assets: [{
      name: asset,
      browser_download_url: `https://github.test/${asset}`,
      digest: digestOverride ?? digest(bytes),
      size: bytes.byteLength,
    }],
  }
}

test('selects exact portable assets for supported platforms', () => {
  assert.deepEqual(portableToolAsset('gallery-dl', 'win32', 'x64'), {
    repo: 'gdl-org/builds', asset: 'gallery-dl_windows.exe', fileName: 'gallery-dl.exe',
  })
  assert.equal(portableToolAsset('gallery-dl', 'win32', 'arm64'), null)
  assert.deepEqual(portableToolAsset('gallery-dl', 'linux', 'x64'), {
    repo: 'gdl-org/builds', asset: 'gallery-dl_linux', fileName: 'gallery-dl',
  })
  assert.deepEqual(portableToolAsset('gallery-dl', 'linux', 'arm64'), {
    repo: 'gdl-org/builds', asset: 'gallery-dl_linux', fileName: 'gallery-dl',
  })
  assert.deepEqual(portableToolAsset('gallery-dl', 'darwin', 'x64'), {
    repo: 'gdl-org/builds', asset: 'gallery-dl_macos', fileName: 'gallery-dl',
  })
  assert.deepEqual(portableToolAsset('gallery-dl', 'darwin', 'arm64'), {
    repo: 'gdl-org/builds', asset: 'gallery-dl_macos', fileName: 'gallery-dl',
  })
  assert.deepEqual(portableToolAsset('yt-dlp', 'win32', 'x64'), {
    repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp.exe', fileName: 'yt-dlp.exe',
  })
  assert.deepEqual(portableToolAsset('yt-dlp', 'win32', 'arm64'), {
    repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_arm64.exe', fileName: 'yt-dlp.exe',
  })
  assert.deepEqual(portableToolAsset('yt-dlp', 'linux', 'x64'), {
    repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_linux', fileName: 'yt-dlp',
  })
  assert.deepEqual(portableToolAsset('yt-dlp', 'linux', 'arm64'), {
    repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_linux_aarch64', fileName: 'yt-dlp',
  })
  assert.deepEqual(portableToolAsset('yt-dlp', 'darwin', 'x64'), {
    repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_macos', fileName: 'yt-dlp',
  })
  assert.deepEqual(portableToolAsset('yt-dlp', 'darwin', 'arm64'), {
    repo: 'yt-dlp/yt-dlp', asset: 'yt-dlp_macos', fileName: 'yt-dlp',
  })
})

async function withTools(
  overrides: Partial<PortableMediaToolsDeps>,
  run: (tools: PortableMediaTools, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canai-media-tools-'))
  const bytes = Uint8Array.from([1, 2, 3, 4])
  const deps: PortableMediaToolsDeps = {
    toolsDir: dir,
    platform: () => 'win32',
    arch: () => 'x64',
    now: () => Date.UTC(2026, 7, 17),
    fetchRelease: async () => release('yt-dlp.exe', bytes),
    fetchAsset: async () => ({ body: byteStream([[1, 2], [3, 4]]), size: 4 }),
    ...overrides,
  }
  try {
    await run(new PortableMediaTools(deps), dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  }
}

test('rejects a binary whose sha256 differs from GitHub asset digest', async () => {
  await withTools({
    fetchRelease: async () => release('yt-dlp.exe', Uint8Array.from([9]), `sha256:${'0'.repeat(64)}`),
    fetchAsset: async () => ({ body: byteStream([[9]]), size: 1 }),
  }, async (tools, dir) => {
    await assert.rejects(tools.locate('yt-dlp'), /checksum/u)
    await assert.rejects(fs.access(path.join(dir, 'yt-dlp.exe')))
    assert.deepEqual(await fs.readdir(dir), [])
  })
})

test('two callers await one physical download and both receive progress', async () => {
  let fetchAssetCalls = 0
  const binary = Uint8Array.from([1, 2, 3, 4])
  await withTools({
    fetchRelease: async (_repo) => release('gallery-dl_windows.exe', binary),
    fetchAsset: async () => {
      fetchAssetCalls++
      return { body: byteStream([[1, 2], [3, 4]]), size: 4 }
    },
  }, async (tools) => {
    const firstProgress: number[] = []
    const secondProgress: number[] = []
    const [a, b] = await Promise.all([
      tools.locate('gallery-dl', { onProgress: (_received, _total, percent) => firstProgress.push(percent ?? -1) }),
      tools.locate('gallery-dl', { onProgress: (_received, _total, percent) => secondProgress.push(percent ?? -1) }),
    ])
    assert.equal(a, b)
    assert.equal(fetchAssetCalls, 1)
    assert.deepEqual(firstProgress, [50, 100])
    assert.deepEqual(secondProgress, [50, 100])
    assert.deepEqual(tools.getState('gallery-dl'), { state: 'ready', path: a })
  })
})

test('a verified local binary remains usable when forced refresh is offline', async () => {
  let offline = false
  const bytes = Uint8Array.from([1, 2, 3, 4])
  await withTools({
    fetchRelease: async () => {
      if (offline) throw new Error('network offline')
      return release('yt-dlp.exe', bytes)
    },
  }, async (tools) => {
    const installed = await tools.locate('yt-dlp')
    offline = true
    assert.equal(await tools.locate('yt-dlp', { forceRefresh: true }), installed)
    assert.deepEqual(tools.getState('yt-dlp'), { state: 'ready', path: installed })
  })
})

test('missing GitHub digest is a hard failure', async () => {
  await withTools({
    fetchRelease: async () => ({
      tag_name: 'v1',
      assets: [{ name: 'yt-dlp.exe', browser_download_url: 'https://github.test/yt-dlp.exe', size: 1 }],
    }),
  }, async (tools) => {
    await assert.rejects(tools.locate('yt-dlp'), /digest|checksum/i)
  })
})
