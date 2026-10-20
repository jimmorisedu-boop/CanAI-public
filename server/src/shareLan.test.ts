import assert from 'node:assert/strict'
import test from 'node:test'
import { isPrivateIpv4Host, localNetworkAddresses } from './shareLan.js'

test('приватным считается только настоящий адрес домашней сети', () => {
  for (const host of ['192.168.1.14', '10.0.0.5', '172.16.4.9', '172.31.255.255']) {
    assert.equal(isPrivateIpv4Host(host), true, host)
  }
  for (const host of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.1.1', 'example.com', 'evil.192.168.1.1.nip.io', '', '999.1.1.1']) {
    assert.equal(isPrivateIpv4Host(host), false, host)
  }
})

test('адреса компьютера в сети — только внешние интерфейсы и без дублей', () => {
  const addresses = localNetworkAddresses({
    'Wi-Fi': [
      { address: '192.168.1.14', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
      { address: '192.168.1.14', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
      { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 },
    ],
    'Loopback': [
      { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null },
    ],
    'VPN': [
      { address: '100.64.1.2', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
    ],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>)

  assert.deepEqual(addresses, ['192.168.1.14'])
})
