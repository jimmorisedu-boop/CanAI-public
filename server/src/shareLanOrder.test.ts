import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type os from 'node:os'
import { localNetworkInterfaces, looksVirtualInterface } from './shareLan.js'

// Порядок адресов планшетной двери.
//
// ⚠️ Первый адрес в списке человек и набирает на планшете. Промах здесь стоит
// ему часа поисков несуществующей проблемы: 27.08.2026 настройки показали
// 10.0.0.33 с виртуального адаптера, планшет крутил вечную загрузку, а
// рабочим был 192.168.0.20 со второго подключения. По самому адресу их не
// отличить — оба приватные; отличает только имя подключения.

function iface(address: string): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  } as os.NetworkInterfaceInfo
}

test('настоящее подключение идёт раньше виртуального', () => {
  const order = localNetworkInterfaces({
    'vEthernet (WSL)': [iface('10.0.0.33')],
    'Wi-Fi': [iface('192.168.0.20')],
  })
  assert.deepEqual(order.map((entry) => entry.address), ['192.168.0.20', '10.0.0.33'])
  assert.equal(order[0]!.virtual, false)
  assert.equal(order[1]!.virtual, true)
})

test('виртуальные не выбрасываются: бывает, что сеть устроена именно так', () => {
  const order = localNetworkInterfaces({ 'VirtualBox Host-Only Network': [iface('192.168.56.1')] })
  assert.deepEqual(order.map((entry) => entry.address), ['192.168.56.1'])
})

test('имя подключения доезжает до человека — по нему он и узнаёт своё Wi-Fi', () => {
  const [first] = localNetworkInterfaces({ 'Wi-Fi': [iface('192.168.1.5')] })
  assert.equal(first?.name, 'Wi-Fi')
})

test('узнаём привычные виртуальные подключения обеих систем', () => {
  for (const name of ['utun4', 'vEthernet (Default Switch)', 'VirtualBox Host-Only Network',
    'VMware Network Adapter VMnet1', 'docker0', 'tailscale0', 'bridge100', 'ZeroTier One']) {
    assert.equal(looksVirtualInterface(name), true, name)
  }
  for (const name of ['Wi-Fi', 'Ethernet', 'en0', 'eth0', 'Беспроводная сеть']) {
    assert.equal(looksVirtualInterface(name), false, name)
  }
})

test('внутренние и IPv6 не попадают в список вовсе', () => {
  const order = localNetworkInterfaces({
    lo0: [{ ...iface('127.0.0.1'), internal: true } as os.NetworkInterfaceInfo],
    en0: [{ ...iface('fe80::1'), family: 'IPv6' } as unknown as os.NetworkInterfaceInfo, iface('192.168.1.7')],
  })
  assert.deepEqual(order.map((entry) => entry.address), ['192.168.1.7'])
})

test('на Windows приложение само предупреждает про брандмауэр', () => {
  // ⚠️ Живой случай 27.08.2026: планшет и компьютер в ОДНОЙ сети
  // (192.168.0.30 и 192.168.0.20, маска /24), адрес верный, доступ включён —
  // и Safari всё равно отвечает «нет соединения». Причина снаружи кода:
  // Windows по умолчанию режет входящие подключения. Молчать об этом нельзя,
  // человек ищет причину в планшете, которой там нет.
  const source = readFileSync(new URL('../../client/src/settings/RemoteAccessSection.tsx', import.meta.url), 'utf8')
  assert.match(source, /platform === 'win32'/)
  assert.match(source, /New-NetFirewallRule/)
  // Разрешаем ОДИН порт, а не выключаем брандмауэр целиком.
  assert.doesNotMatch(source, /Set-NetFirewallProfile[^\n]*Enabled False/)
  // Сервер обязан сообщать свою систему, иначе подсказке неоткуда взяться.
  const runtime = readFileSync(new URL('./remoteRuntime.ts', import.meta.url), 'utf8')
  assert.match(runtime, /platform: process\.platform/)
})
