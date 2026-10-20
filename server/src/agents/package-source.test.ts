import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GitHubSourceTransport, type ResolvedGitSource } from './package-source.js'

const sha = 'b'.repeat(40)

describe('GitHub package source boundary', () => {
  it('resolves a public source to a normalized full SHA and follows only codeload', async () => {
    const calls: string[] = []
    const transport = new GitHubSourceTransport({
      fetchImpl: async (url) => {
        calls.push(String(url))
        if (String(url).endsWith('/acme/repo')) return new Response(JSON.stringify({ private: false, default_branch: 'main' }), { status: 200 })
        if (String(url).includes('/commits/main')) return new Response(JSON.stringify({ sha: sha.toUpperCase() }), { status: 200 })
        if (String(url).includes('/zipball/')) return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/acme/repo/legacy.zip/${sha}` } })
        if (String(url).startsWith('https://codeload.github.com/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        throw new Error('unexpected URL')
      }, timeoutMs: 2000,
    })
    const resolved = await transport.resolve({ kind: 'git', url: 'https://github.com/Acme/Repo', ref: 'main' })
    assert.equal(resolved.canonicalUrl, 'https://github.com/acme/repo')
    assert.equal(resolved.resolvedSha, sha)
    assert.deepEqual([...(await transport.download(resolved))], [1, 2, 3])
    assert.equal(calls.length, 4)
  })

  it('rejects private/credential/unsafe sources and aborts a stalled body', async () => {
    const privateTransport = new GitHubSourceTransport({ fetchImpl: async () => new Response(JSON.stringify({ private: true }), { status: 200 }) })
    await assert.rejects(privateTransport.resolve({ kind: 'git', url: 'https://github.com/acme/private' }), { code: 'SOURCE_PRIVATE' })
    const transport = new GitHubSourceTransport({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) } }), { status: 200 }), timeoutMs: 1000 })
    const source: ResolvedGitSource = { kind: 'git', canonicalUrl: 'https://github.com/acme/repo', requestedRef: 'main', resolvedSha: sha, archiveUrl: `https://api.github.com/repos/acme/repo/zipball/${sha}` }
    await assert.rejects(transport.download(source), { code: 'GIT_TIMEOUT' })
    await assert.rejects(new GitHubSourceTransport().resolve({ kind: 'git', url: 'https://user:pass@github.com/acme/repo' }), { code: 'SOURCE_UNSUPPORTED' })
    await assert.rejects(new GitHubSourceTransport().resolve({ kind: 'git', url: 'http://github.com/acme/repo' }), { code: 'SOURCE_UNSUPPORTED' })
  })

  it('binds archive redirects to the resolved repository and SHA', async () => {
    const source: ResolvedGitSource = {
      kind: 'git', canonicalUrl: 'https://github.com/acme/repo', requestedRef: 'main', resolvedSha: sha,
      archiveUrl: `https://api.github.com/repos/acme/repo/zipball/${sha}`,
    }
    const transport = new GitHubSourceTransport({
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: `https://codeload.github.com/evil/other/legacy.zip/${sha}` },
      }),
    })
    await assert.rejects(transport.download(source), { code: 'GIT_REDIRECT_UNSAFE' })
    await assert.rejects(transport.download({ ...source, archiveUrl: `https://codeload.github.com/acme/repo/legacy.zip/${'c'.repeat(40)}` }), { code: 'GIT_ARCHIVE_URL_UNSAFE' })
  })
})
