import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { safeEnvironment } from './host-wire.js'

/**
 * 📌 Секреты Host не должны просачиваться в окружение процесса агента.
 *
 * Агент — это чужой (недоверенный) код, который бежит под тем же
 * пользователем ОС, что и сервер. Прямой обход (fs.readFile server/.env)
 * здесь не лечится никаким кодом — это работа для ОС-песочницы и
 * задокументированный остаточный риск. Но вектор «агент читает
 * process.env» закрывается и обязан закрываться НАВСЕГДА: если кто-то
 * добавит копию сервера в окружение (FAL_KEY, токен планшета, ключи
 * прокси, CANAI_* внутренние секреты) и забудет убрать её из
 * allowlist-фильтра, этот тест упадёт и не пустит такой регресс.
 *
 * Строго «в чью-то пользу»: test не зависит ни от каких реальных
 * переменных окружения машины — сам кладёт секреты в process.env ПЕРЕД
 * вызовом и требует, чтобы они не дошли до агента.
 */
test('safeEnvironment никогда не отдаёт секреты агенту', () => {
  const secrets = {
    FAL_KEY: 'tlv_00000000-0000-0000-0000-000000000000',
    falKey: 'fal-holder',
    FAL_API_KEY: 'fal-api-key',
    CANAI_REMOTE_TOKEN: 'remote-token-secret',
    CANVA_TOKEN: 'canva-token',
    HTTPS_PROXY: 'http://user:pass@proxy.invalid:8080',
    NO_PROXY: '*',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    OPENAI_API_KEY: 'sk-openai-secret',
  }
  const saved: Array<[string, string | undefined]> = []
  for (const key of Object.keys(secrets)) {
    saved.push([key, process.env[key]])
    process.env[key] = secrets[key as keyof typeof secrets]
  }

  try {
    const env = safeEnvironment('task-sec-1', 'exec-sec-1', path.join('work', 'board-1'), {
      packageDir: path.join('pkg'),
      stateDir: path.join('work', 'board-1', 'state'),
    })

    for (const key of Object.keys(secrets)) {
      assert.equal(env[key], undefined, `секрет ${key} не должен попасть в окружение агента`)
    }

    // Служебные переменные allowlist остаются, чтобы не сломать протокол.
    assert.equal(env.CANAI_AGENT_PROTOCOL_VERSION, '1.0')
    assert.equal(env.CANAI_AGENT_TASK_ID, 'task-sec-1')
    // Полный allowlist — замкнутый набор: NODE_ENV, PATH, системные пути и
    // ровно шесть CANAI_AGENT_* идентификаторов. Если в safeEnvironment кто-то
    // добавил ещё ключ, он провалится здесь — а не «проедет» в открытом regex.
    const agentKeys = Object.keys(env).filter((key) => key.startsWith('CANAI_AGENT_'))
    assert.deepEqual(
      agentKeys.sort(),
      [
        'CANAI_AGENT_EXECUTION_ID',
        'CANAI_AGENT_PACKAGE_DIR',
        'CANAI_AGENT_PROTOCOL_VERSION',
        'CANAI_AGENT_STATE_DIR',
        'CANAI_AGENT_TASK_ID',
        'CANAI_AGENT_WORK_DIR',
        'CANAI_AGENT_WORKSPACE',
      ].sort(),
      'набор CANAI_AGENT_* переменных не должен дрейфовать',
    )
    const inherited = Object.keys(env).filter((key) => !key.startsWith('CANAI_AGENT_'))
    for (const key of inherited) {
      if (key === 'NODE_ENV' || key === 'PATH' || key === 'Path') continue
      assert.ok(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT'].includes(key), `неожиданный унаследованный ключ: ${key}`)
    }
  } finally {
    for (let i = 0; i < saved.length; i++) {
      const [key, value] = saved[i]!
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('safeEnvironment не наследует ключи секретов из чужого окружения', () => {
  // Самый строгий вариант: даже если агент мог бы наследовать «всё,
  // кроме» — allowlist всё равно должен исключить секреты. Проверяем, что
  // объект результата НЕ содержит ни одного ключа из чёрного списка.
  const blacklist = ['FAL_KEY', 'canva_token', 'access_token', 'refresh_token', 'authorization', 'apiKey', 'api_key']
  const env = safeEnvironment('task-sec-2', 'exec-sec-2', path.join('work', 'b2'), { packageDir: path.join('pkg') })
  const present = Object.keys(env).filter((key) => blacklist.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase())))
  assert.deepEqual(present, [], `не должно быть ключей-секретов, а есть: ${present.join(', ')}`)
})