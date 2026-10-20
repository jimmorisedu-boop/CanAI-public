import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Сторожа маковских скриптов. Текстовые проверки идут везде, запуск zsh — только
// там, где он есть: у второго разработчика Windows, и прогон не должен краснеть
// из-за отсутствия чужой оболочки.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (name: string) => fsSync.readFileSync(path.join(repoRoot, name), 'utf8')

const MAC_SCRIPTS = [
  'start.command',
  'stop.command',
  'make-dist.sh',
  'Start CanAI.command',
  'Stop CanAI.command',
  'migrate-data.command',
  'Migrate data.command',
]

const hasZsh = spawnSync('zsh', ['-c', 'exit 0']).status === 0
const zshTest = hasZsh ? test : test.skip

zshTest('маковские скрипты синтаксически целы', () => {
  for (const name of MAC_SCRIPTS) {
    const result = spawnSync('zsh', ['-n', path.join(repoRoot, name)], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${name}: ${result.stderr}`)
  }
})

// ⚠️ Дважды подряд наступил на это: `modules` и `status` в zsh — переменные
// только для чтения, и присваивание им обрывает скрипт на первой же строке.
// Ошибка не видна ни глазом, ни `zsh -n` — только запуском.
zshTest('скрипты не присваивают зарезервированные переменные zsh', () => {
  for (const name of MAC_SCRIPTS) {
    const source = read(name)
    const names = new Set(
      [...source.matchAll(/^\s*(?:local\s+)?([a-z_][a-z_0-9]*)=/gm)].map((match) => match[1]!),
    )
    for (const variable of names) {
      const result = spawnSync('zsh', ['-c', `${variable}=1`], { encoding: 'utf8' })
      assert.doesNotMatch(
        result.stderr ?? '',
        /read-only/,
        `${name}: имя «${variable}» занято самим zsh — возьмите другое`,
      )
    }
  }
})

// ⚠️ И вторая ловушка того же прогона: в одном `local` вторая переменная НЕ
// видит первую. Из-за этого граница диапазона портов считалась как 99, цикл не
// выполнялся ни разу, и лаунчер сообщал «не нашлось свободной пары портов» на
// совершенно пустой машине.
test('в одном local нет переменной, зависящей от соседней', () => {
  for (const name of MAC_SCRIPTS) {
    for (const line of read(name).split('\n')) {
      const declaration = /^\s*local\s+(.+)$/.exec(line)
      if (!declaration) continue
      const body = declaration[1]!
      const first = /([a-z_][a-z_0-9]*)=/.exec(body)?.[1]
      if (!first) continue
      const rest = body.slice(body.indexOf('=') + 1)
      if (!rest.includes('=')) continue
      assert.doesNotMatch(
        rest,
        new RegExp(`\\$\\{?${first}\\b|\\b${first}\\s*[+\\-*/]`),
        `${name}: «${line.trim()}» — вторая переменная не увидит первую, объявляйте отдельными строками`,
      )
    }
  }
})

test('окно после запуска остаётся открытым — иначе ошибку не прочитать', () => {
  for (const name of ['Start CanAI.command', 'Stop CanAI.command', 'Migrate data.command']) {
    assert.match(read(name), /read -k 1/, `${name}: окно закроется раньше, чем человек прочитает сообщение`)
  }
})

test('остановщик завершает сервер по токену, а не убивает процессы', () => {
  const source = read('stop.command')
  assert.match(source, /x-canai-shutdown-token/)
  assert.match(source, /api\/lifecycle\/shutdown/)
  // На порту может стоять чужая программа — принудительно её не трогаем.
  assert.doesNotMatch(source, /\bkill\s+-|\bpkill\s+-/, 'принудительное завершение запрещено')
})

// ⚠️ Скачать ffmpeg на маке неоткуда: LGPL-сборок под macOS не существует.
// Если он не попадёт в архив, у покупателя не будет ни таймлайна, ни звука.
test('поставка macOS кладёт ffmpeg внутрь архива', () => {
  const source = read('make-dist.sh')
  assert.match(source, /runtime\/media-tools/)
  assert.match(source, /ffprobe/, 'без ffprobe половина операций превращается в догадки')
  assert.match(source, /build-ffmpeg-macos\.sh/, 'человеку надо сказать, чем собрать')
  assert.match(source, /uname\s+-m/)
  assert.match(source, /Apple Silicon \(arm64\)/)
})

test('сборка ffmpeg не подхватывает внешние библиотеки хоста молча', () => {
  const source = read('scripts/build-ffmpeg-macos.sh')
  assert.match(source, /--disable-autodetect/)
  assert.match(source, /--enable-zlib/, 'PNG-кодеки должны явно включать системный zlib после disable-autodetect')
  for (const required of [
    '--enable-videotoolbox',
    '--enable-audiotoolbox',
    '--enable-encoder=h264_videotoolbox',
    '--enable-encoder=aac',
    '--enable-libmp3lame',
    '--enable-encoder=libmp3lame',
  ]) {
    assert.ok(source.includes(required), `в configure нет ${required}`)
  }
  assert.match(source, /--extra-ldflags="-L\$DEPS\/lib"/)
})

test('сборка ffmpeg проверяет PNG roundtrip после компиляции', () => {
  const source = read('scripts/build-ffmpeg-macos.sh')
  assert.match(source, /-f lavfi/)
  assert.match(source, /color=/)
  assert.match(source, /encoded\.png/)
  assert.match(source, /-f null/)
})

test('поставка отказывается класть сборку ffmpeg с GPL-компонентом', () => {
  const source = read('make-dist.sh')
  for (const forbidden of ['enable-gpl', 'libx264', 'libx265', 'nonfree']) {
    assert.ok(source.includes(forbidden), `в проверке нет ${forbidden}`)
  }
})

test('в поставку идут оба маковских лаунчера', () => {
  const source = read('make-dist.sh')
  for (const launcher of ['Start CanAI.command', 'Stop CanAI.command']) {
    assert.ok(source.includes(launcher), `в поставке нет «${launcher}»`)
  }
  // ⚠️ zip без прав доступа сделает двойной клик бесполезным.
  assert.match(source, /ditto -c -k/, 'архив обязан сохранять бит исполняемости')
  assert.match(source, /executable bit was lost/, 'права надо проверять до упаковки')
})

test('в macOS-пакет копируются внутренние launch-скрипты', () => {
  const source = read('make-dist.sh')
  const include = /INCLUDE=\(([\s\S]*?)\n\)/.exec(source)?.[1] ?? ''
  for (const launcher of ['start.command', 'stop.command']) {
    assert.match(include, new RegExp(`(?:^|\\s)${launcher.replace('.', '\\.')}(?:$|\\s)`), `в INCLUDE нет ${launcher}`)
  }
  assert.match(source, /for launcher in .*start\.command stop\.command/, 'пакет должен проверять оба внутренних launcher-файла')
})

// ⚠️ Опись собирается из УСТАНОВЛЕННЫХ пакетов, а они платформенные: запуск
// сборщика на маке подменил бы отслеживаемый файл darwin-сборками вместо win32.
test('опись лицензий пишется в поставку, а не в репозиторий', () => {
  const source = read('make-dist.sh')
  assert.match(source, /generate-third-party\.mjs" "\$OUT\/THIRD-PARTY-LICENSES\.txt/)
  assert.doesNotMatch(source, /npm run licenses/, 'без аргумента генератор пишет в корень репозитория')
})

test('секреты и личные доски в поставку не попадают', () => {
  const source = read('make-dist.sh')
  for (const check of ['server/.env', 'server/data']) {
    assert.ok(source.includes(check), `нет проверки на утечку ${check}`)
  }
})

test('сборщик macOS не оставляет висячий шаг удалённого relay', () => {
  const source = read('make-dist.sh')
  const lines = source.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (!/^\s*\|\|\s*die\b/.test(line)) continue
    assert.match(lines[index - 1]?.trimEnd() ?? '', /\\$/, `висячий || die на строке ${index + 1}`)
  }
  assert.doesNotMatch(source, /relay|share-enrollment|activate-share/i, 'relay и его активация удалены из поставки')
})

test('инструкция покупателя описывает реальные лаунчеры и ручное обновление ZIP', () => {
  const source = read('USER-GUIDE.md')
  assert.match(source, /Start CanAI\.(?:bat|command)/)
  assert.match(source, /extract the new release ZIP into a new folder and migrate your data/i, 'обновление покупателя приходит новым ZIP с переносом данных в новую папку')
  assert.match(source, /server\/data/)
  assert.match(source, /server\/\.env/)
  assert.doesNotMatch(source, /Активировать публичные ссылки|share-relay|GitHub/i, 'в buyer guide не должно быть удалённого activation/relay flow')
})

test('macOS launcher выбирает согласованную пару портов приложения', () => {
  const source = read('start.command')
  assert.match(source, /find_free_port/)
  assert.match(source, /CANAI_REMOTE_PORT/)
  assert.match(source, /remote=\$\(\( candidate \+ 2 \)\)/)
  assert.match(source, /! port_busy "\$candidate" && ! port_busy "\$remote"/)
  assert.match(source, /max_main=65533/)
  assert.match(source, /\[ -n "\$FIXED_REMOTE_PORT" \] && max_main=65535/)
  assert.match(source, /remote="\$FIXED_REMOTE_PORT"/)
  assert.match(source, /\[ "\$last" -gt "\$max_main" \]/)
  assert.doesNotMatch(source, /CANAI_SHARE_PORT/)
})

test('лаунчеры macOS не зависят от python3 и не триггерят диалог Xcode CLI Tools', () => {
  for (const script of ['start.command', 'stop.command']) {
    const source = read(script)
    assert.doesNotMatch(
      source,
      /\bpython3\b/,
      `${script}: не должен вызывать python3 — на чистом Mac это вызовет системный диалог Xcode`,
    )
  }
})

test('stop.command настраивает PATH для встроенного runtime/node', () => {
  const source = read('stop.command')
  assert.match(source, /runtime\/node/)
  assert.match(source, /export PATH="\$BUNDLED\/bin:\$PATH"/)
})

test('start.command поддерживает --no-browser, --unattended и не блокирует read -k 1 без TTY', () => {
  const source = read('start.command')
  assert.match(source, /--no-browser/)
  assert.match(source, /--unattended/)
  assert.match(source, /CANAI_NO_BROWSER/)
  assert.match(source, /CANAI_UNATTENDED/)
  assert.match(source, /\[ -t 0 \]/, 'read -k 1 должен проверяться на наличие терминала')
})

test('make-dist.sh создаёт файл контрольной суммы ZIP.sha256', () => {
  const source = read('make-dist.sh')
  assert.match(source, /shasum -a 256 "\$ZIP"/)
  assert.match(source, /> "\$ZIP\.sha256"/)
})

// ⚠️ packages/ — общие исходники: клиент собирает их в страницы (разбор ответа
// помощника, каталог моделей), сервер читает те же файлы на лету. В списке, по
// которому лаунчеры решают «пересобрать интерфейс», папки не было: правка,
// сделанная только там, после обновления через git доезжала до сервера и не
// доезжала до собранной планшетной страницы (проверка 03.10.2026). Запуск
// start.ps1 с тем же случаем — в launcher.test.ts; правишь один — правь оба.
test('оба лаунчера считают packages/ исходниками интерфейса', () => {
  const mac = read('start.command').replaceAll('\r\n', '\n')
  assert.match(mac, /newer="\$\(find [^)]*"\$ROOT\/packages"[^)]*-newer "\$DIST"/u)
  // Папки может не быть: find обязан промолчать о ней, а не оборвать лаунчер.
  assert.match(mac, /-newer "\$DIST" -print -quit 2>\/dev\/null \|\| true\)"/u)
  const windows = read('start.ps1')
  assert.match(windows, /\$sharedSources = Join-Path \$root 'packages'/u)
  assert.match(windows, /if \(Test-Path \$sharedSources\) \{ \$sourceDirs \+= \$sharedSources \}/u, 'нет папки — не ошибка')
  assert.match(windows, /\$sourceFiles = @\(Get-ChildItem \$sourceDirs -Recurse -File\)/u)
})

// Правило пересборки в start.command — обычный POSIX (find и [ ]), поэтому его
// можно исполнить и без zsh; у Windows это sh из Git, если он виден прогону.
// ⚠️ Проба нужна: рядом с таким sh `find` бывает системной программой Windows.
const posixShell = ['zsh', 'sh'].find((shell) => {
  const probe = spawnSync(shell, ['-c', 'find . -prune -print'], { cwd: repoRoot, encoding: 'utf8' })
  return probe.status === 0 && probe.stdout.trim() === '.'
})
const shellTest = posixShell ? test : test.skip

shellTest('start.command: правка только в packages/ пересобирает интерфейс, а без папки всё как раньше', (t) => {
  const source = read('start.command').replaceAll('\r\n', '\n')
  const start = source.indexOf('DIST="$ROOT/client/dist/index.html"')
  const end = source.indexOf('if [ "$needs_build" = 1 ]; then')
  assert.ok(start > 0 && end > start, 'правило пересборки стоит между DIST и самой сборкой')

  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'canai-launcher-mac-'))
  // Уборка проверку не роняет: на Windows папку на миг держит антивирус.
  t.after(() => { try { fsSync.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) } catch {} })
  const at = (name: string) => path.join(root, ...name.split('/'))
  const built = Date.now() - 3_600_000
  /** Файл с временем правки на `shiftSeconds` позже (или раньше) собранного интерфейса. */
  const touch = (name: string, shiftSeconds: number) => {
    fsSync.mkdirSync(path.dirname(at(name)), { recursive: true })
    fsSync.writeFileSync(at(name), '')
    const time = new Date(built + shiftSeconds * 1000)
    fsSync.utimesSync(at(name), time, time)
  }
  for (const name of ['client/dist/index.html', 'client/dist/tablet/tablet.html']) touch(name, 0)
  for (const name of ['src/main.tsx', 'public/icon.svg', 'package.json', 'package-lock.json', 'vite.config.ts', 'vite.tablet.config.ts']) {
    touch(`client/${name}`, -60)
  }
  const script = at('rule.sh')
  fsSync.writeFileSync(script, `ROOT="$1"\n${source.slice(start, end)}\nprintf '%s' "$needs_build"\n`)
  const needsBuild = () => {
    const run = spawnSync(posixShell!, [script.replaceAll('\\', '/'), root.replaceAll('\\', '/')], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return run.stdout
  }
  assert.equal(needsBuild(), '0', 'папки packages нет — это не ошибка и не повод собирать')
  touch('client/vite.config.ts', 60)
  assert.equal(needsBuild(), '1', 'без папки packages прежние исходники по-прежнему видны')
  touch('client/vite.config.ts', -60)
  touch('packages/prompt-chat/response.ts', -60)
  assert.equal(needsBuild(), '0', 'общие исходники старше сборки — собирать нечего')
  touch('packages/prompt-chat/response.ts', 60)
  assert.equal(needsBuild(), '1', 'новее сборки только файл в packages/ — интерфейс пересобирается')
  // Поставке покупателя по датам не судим — и по датам packages/ тоже.
  fsSync.writeFileSync(at('build-info.json'), '{}')
  assert.equal(needsBuild(), '0', 'поставка: интерфейс собран заранее')
})
