import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Express } from 'express'

/**
 * Mount the tablet Help illustrations before the SPA fallback.
 *
 * A missing illustration must remain a 404 instead of being answered with
 * tablet.html, which browsers cannot use as an image and which hides broken
 * asset paths during release checks.
 */
export function attachTabletHelpAssets(app: Pick<Express, 'use'>, helpDir: string): void {
  const root = path.resolve(helpDir)
  app.use((req, res, next) => {
    const rawPath = req.originalUrl.split('?', 1)[0]
    if (rawPath !== '/help' && !rawPath.startsWith('/help/')) {
      next()
      return
    }
    if (rawPath === '/help') {
      res.status(404).end()
      return
    }
    let relative: string
    try {
      relative = decodeURIComponent(rawPath.slice('/help/'.length)).replaceAll('\\', '/')
    } catch {
      res.status(404).end()
      return
    }
    const parts = relative.split('/')
    if (!relative || relative.includes('\0') || path.extname(relative).toLowerCase() !== '.svg'
      || parts.some((part) => part === '' || part === '.' || part === '..')) {
      res.status(404).end()
      return
    }
    const candidate = path.resolve(root, ...parts)
    if (!candidate.startsWith(`${root}${path.sep}`)) {
      res.status(404).end()
      return
    }
    void Promise.all([realpath(root), realpath(candidate), stat(candidate)]).then(([realRoot, realCandidate, info]) => {
      if (!info.isFile() || !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
        res.status(404).end()
        return
      }
      // Help drawings use stable names, so never cache a stale illustration
      // across an app update. Express still supplies an ETag for revalidation.
      res.setHeader('Cache-Control', 'no-cache')
      res.type('image/svg+xml')
      res.sendFile(realCandidate, (error) => {
        if (error && !res.headersSent) {
          const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
          res.status(statusCode === 404 ? 404 : 500).end()
        }
      })
    }).catch(() => res.status(404).end())
  })
}
