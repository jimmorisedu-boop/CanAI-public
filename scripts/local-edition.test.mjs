import assert from 'node:assert/strict'
import test from 'node:test'
import { assertLocalEditionRuntime, isLocalEditionSourcePath, localOverridePath, transformLocalPackage } from './local-edition.mjs'

test('combined local policy preserves each runtime root and excludes shared-network tools', () => {
  for (const filename of ['client/src/App.tsx', 'server/src/index.ts', 'packages/agent-protocol/index.ts', 'scripts/scan-secrets.mjs', 'package.json']) {
    assert.equal(isLocalEditionSourcePath(filename), true, filename)
  }
  for (const filename of ['scripts/network-board-e2e.mjs', 'scripts/hybrid-cloud-e2e.mjs', 'scripts/package-cloud-tablet.test.mjs', 'packages/model-catalog/cloudRefs.ts', 'client/src/cloud/transport.ts', 'server/src/cloud/transport.ts', '/server/src/index.ts', 'server/../secret.ts']) {
    assert.equal(isLocalEditionSourcePath(filename), false, filename)
  }
})

test('override paths cannot bypass source policy or escape the client/server roots', () => {
  assert.equal(localOverridePath('local-edition/overrides/client/src/App.tsx'), 'client/src/App.tsx')
  assert.equal(localOverridePath('client/src/App.tsx'), null)
  for (const name of ['local-edition/overrides/../private.ts', 'local-edition/overrides/server/src/cloudBoardGateway.ts', 'local-edition/overrides/scripts/tool.mjs']) {
    assert.throws(() => localOverridePath(name), /Invalid local edition override/u)
  }
})

test('root scripts retain local tests and drop excluded Cloud-only commands', () => {
  const source = JSON.stringify({ scripts: {
    test: 'node --test scripts/tool.test.mjs scripts/package-cloud-tablet.test.mjs && npm --prefix server test',
    pretest: 'tsx --test server/src/cloudBoardGateway.test.ts && tsx --test client/src/local.test.ts client/src/spaces/canvas/cloudUndo.test.ts',
    'test:network': 'tsx scripts/network-board-e2e.mjs',
    'build:tablet:cloud': 'vite build --mode cloud',
    build: 'npm --prefix client run build',
  } })
  const local = transformLocalPackage(source)
  const scripts = JSON.parse(local).scripts
  assert.equal(scripts.test, 'node --test scripts/tool.test.mjs && npm --prefix server test')
  assert.equal(scripts.pretest, 'tsx --test client/src/local.test.ts')
  assert.equal(scripts['test:network'], undefined)
  assert.equal(scripts['build:tablet:cloud'], undefined)
  assert.equal(scripts.build, 'npm --prefix client run build')
  assert.equal(transformLocalPackage(local), local)
})

test('local export removes web-demo scripts and standalone demo gates', () => {
  const source = JSON.stringify({ scripts: {
    'demo:build': 'npm --prefix client exec -- vite --config ./web-demo/vite.config.ts build',
    'demo:dev': 'npm --prefix client exec -- vite --config ./web-demo/vite.config.ts',
    'demo:preview': 'npm --prefix client exec -- vite --config ./web-demo/vite.config.ts preview',
    'demo:check': 'npm --prefix client exec -- tsc -p ./web-demo/tsconfig.json --noEmit && npm --prefix client exec -- tsc -p ./web-demo/tsconfig.worker.json --noEmit',
    'demo:test': 'npm --prefix client exec -- tsx --test web-demo/runtime/worker.smoke.test.ts',
    check: 'npm run check:help && npm run demo:check && npm --prefix server run check && npm --prefix client run check',
    test: 'node --test scripts/tool.test.mjs && npm run demo:test && npm --prefix server test',
    build: 'npm --prefix client run build',
  } })
  const scripts = JSON.parse(transformLocalPackage(source)).scripts
  for (const name of ['demo:build', 'demo:dev', 'demo:preview', 'demo:check', 'demo:test']) {
    assert.equal(scripts[name], undefined, name)
  }
  assert.equal(scripts.check, 'npm run check:help && npm --prefix server run check && npm --prefix client run check')
  assert.equal(scripts.test, 'node --test scripts/tool.test.mjs && npm --prefix server test')
  assert.equal(scripts.build, 'npm --prefix client run build')
  assert.equal(transformLocalPackage(JSON.stringify({ scripts })), JSON.stringify({ scripts }, null, 2) + '\n')
})

test('a locally named source cannot smuggle a Cloud endpoint through an override', () => {
  assert.throws(() => assertLocalEditionRuntime('client/src/api.ts', Buffer.from("fetch('/api/cloud-account/login')")), /Cloud endpoint/u)
  assert.throws(() => assertLocalEditionRuntime('server/src/routes.ts', Buffer.from("fetch('/v3/boards/socket')")), /Cloud endpoint/u)
  assert.throws(() => assertLocalEditionRuntime('packages/shared/transport.ts', Buffer.from("fetch('/api/cloud-account')")), /Cloud endpoint/u)
  assert.doesNotThrow(() => assertLocalEditionRuntime('client/src/api.ts', Buffer.from("fetch('/api/projects')")))
  assert.doesNotThrow(() => assertLocalEditionRuntime('server/src/fal.ts', Buffer.from("fetch('https://queue.fal.run/model')")))
})
