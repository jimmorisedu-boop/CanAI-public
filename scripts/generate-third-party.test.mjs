import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ⚠️ Генератор пишет НАСТОЯЩИЙ файл, поэтому тест обязан увести его вывод во
// временную папку. Пока он писал в корень, каждый `npm test` на macOS менял
// отслеживаемый THIRD-PARTY-LICENSES.txt: список берётся из установленных
// пакетов, а они платформенные (@img/sharp-darwin-arm64 вместо win32-x64).
// Закоммитить такое — отдать Windows-покупателю лицензии не на те бинарники.
const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'canai-licenses-')), 'THIRD-PARTY-LICENSES.txt')

test('генератор распознаёт стандартное имя LICENSE-MIT.txt', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'generate-third-party.mjs'), outFile],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const licenses = fs.readFileSync(outFile, 'utf8')
  const emojiRegexSection = licenses.match(
    /PACKAGE: emoji-regex@8\.0\.0[\s\S]*?(?=\n={80}\nPACKAGE:|\s*$)/,
  )?.[0] ?? ''
  assert.match(emojiRegexSection, /--- LICENSE-MIT\.txt ---/)
  assert.match(emojiRegexSection, /Permission is hereby granted, free of charge/)
})

test('генератор включает полную MIT-лицензию isarray из проверенного override', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'generate-third-party.mjs'), outFile],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const licenses = fs.readFileSync(outFile, 'utf8')
  const isarraySection = licenses.match(
    /PACKAGE: isarray@1\.0\.0[\s\S]*?(?=\n={80}\nPACKAGE:|\s*$)/,
  )?.[0] ?? ''
  assert.match(isarraySection, /DECLARED LICENSE: MIT/)
  assert.match(isarraySection, /Copyright \(c\) 2013 Julian Gruber/)
  assert.match(isarraySection, /Permission is hereby granted, free of charge/)
  assert.match(isarraySection, /THE SOFTWARE IS PROVIDED "AS IS"/)
})

test('платформенный sharp/libvips получает полные LGPL/GPL тексты и upstream notices из override', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'generate-third-party.mjs'), outFile],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const licenses = fs.readFileSync(outFile, 'utf8')
  const libvipsSection = licenses.match(
    /PACKAGE: @img\/(?:sharp-libvips-[^@\n]+@1\.3\.4|sharp-win32-[^@\n]+@0\.35\.5)[\s\S]*?(?=\n={80}\nPACKAGE:|\s*$)/,
  )?.[0] ?? ''
  assert.match(libvipsSection, /DECLARED LICENSE: .*LGPL-3\.0-or-later/)
  assert.match(libvipsSection, /GNU LESSER GENERAL PUBLIC LICENSE/)
  assert.match(libvipsSection, /GNU GENERAL PUBLIC LICENSE/)
  assert.match(libvipsSection, /Third-party notices/)
  assert.match(libvipsSection, /libvips\s+\| LGPLv3/)
})

test('платформенный esbuild получает полную MIT-лицензию из override', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'generate-third-party.mjs'), outFile],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const licenses = fs.readFileSync(outFile, 'utf8')
  const esbuildSection = licenses.match(
    /PACKAGE: @esbuild\/[^@\n]+@[^\n]+[\s\S]*?(?=\n={80}\nPACKAGE:|\s*$)/,
  )?.[0] ?? ''
  assert.match(esbuildSection, /DECLARED LICENSE: MIT/)
  assert.match(esbuildSection, /Copyright \(c\) 2020 Evan Wallace/)
  assert.match(esbuildSection, /Permission is hereby granted, free of charge/)
})

test('платформенный keyring получает MIT-лицензию родительского upstream-пакета', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'generate-third-party.mjs'), outFile],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const licenses = fs.readFileSync(outFile, 'utf8')
  const keyringSection = licenses.match(
    /PACKAGE: @napi-rs\/keyring-[^@\n]+@1\.2\.0[\s\S]*?(?=\n={80}\nPACKAGE:|\s*$)/,
  )?.[0] ?? ''
  assert.match(keyringSection, /DECLARED LICENSE: MIT/)
  assert.match(keyringSection, /Copyright \(c\) 2020 N-API for Rust/)
  assert.match(keyringSection, /Permission is hereby granted, free of charge/)
})

// Сторож: генератор без аргумента обязан писать туда же, куда и раньше, —
// иначе `npm run licenses` и make-dist тихо перестанут обновлять файл.
test('без аргумента путь вывода прежний', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'generate-third-party.mjs'), 'utf8')
  assert.match(source, /process\.argv\[2\][\s\S]*?'THIRD-PARTY-LICENSES\.txt'/)
})

// И сторож на сам тест: если вызов снова начнёт писать в корень репозитория,
// каждый прогон на другой платформе будет незаметно подменять файл.
test('тест не пишет в отслеживаемый файл репозитория', () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /path\.join\(root, 'THIRD-PARTY-LICENSES\.txt'\)/,
    'вывод генератора должен уходить во временную папку',
  )
})
