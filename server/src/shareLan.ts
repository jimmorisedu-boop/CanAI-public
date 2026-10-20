import os from 'node:os'

/** Литерал приватного IPv4 — то, чем выглядит компьютер в домашней или
 *  офисной сети. Проверяем именно литерал: чужой домен, подсунутый через
 *  DNS-rebinding, сюда не попадёт, потому что Host у него будет доменом. */
export function isPrivateIpv4Host(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) return false
  const [first, second] = octets as [number, number, number, number]
  if (first === 10) return true
  if (first === 192 && second === 168) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  return false
}

/**
 * Похоже ли подключение на виртуальное.
 *
 * ⚠️ У виртуальных адаптеров адрес такой же приватный, как у настоящего
 * Wi-Fi, и по самому адресу их не отличить. А разница решающая: до
 * `vEthernet (WSL)` или `VirtualBox Host-Only` планшет не достучится
 * НИКОГДА, потому что этой сети физически нет за пределами компьютера.
 *
 * Поймано живым случаем 27.08.2026: настройки показали `10.0.0.33`, человек
 * набирал его на планшете и видел вечную загрузку, тогда как рабочим был
 * `192.168.0.20` со второго подключения. Отличить их можно только по ИМЕНИ
 * подключения — его и смотрим.
 */
export function looksVirtualInterface(name: string): boolean {
  return /^(utun|tun|tap|awdl|llw|bridge|vmnet|docker|veth|zt|tailscale|wg)/i.test(name)
    || /(virtualbox|vmware|hyper-v|vethernet|wsl|loopback|npcap|zerotier|tailscale|wireguard|openvpn|nordlynx|proton|radmin|hamachi)/i.test(name)
}

export interface LocalAddress {
  /** Адрес IPv4 без схемы и порта. */
  address: string
  /** Имя сетевого подключения — по нему человек и узнаёт своё Wi-Fi. */
  name: string
  /** Похоже ли на виртуальное подключение: такие уезжают в конец списка. */
  virtual: boolean
}

/**
 * Адреса этого компьютера в локальной сети — их и показываем автору,
 * когда он разрешает доступ по сети.
 *
 * Настоящие подключения идут ПЕРВЫМИ: первый адрес в списке человек и
 * попробует, а промах здесь стоит ему часа поисков несуществующей проблемы.
 * Виртуальные не выбрасываем — бывает, что сеть устроена именно так, — но
 * ставим в конец.
 */
export function localNetworkInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LocalAddress[] {
  const found: LocalAddress[] = []
  const seen = new Set<string>()
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && String(entry.family) !== '4') continue
      if (!isPrivateIpv4Host(entry.address)) continue
      if (seen.has(entry.address)) continue
      seen.add(entry.address)
      found.push({ address: entry.address, name, virtual: looksVirtualInterface(name) })
    }
  }
  // Устойчивый порядок: настоящие подключения раньше виртуальных, внутри
  // группы — как отдала система.
  return [
    ...found.filter((entry) => !entry.virtual),
    ...found.filter((entry) => entry.virtual),
  ]
}

/** Только адреса, в том же порядке. */
export function localNetworkAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  return localNetworkInterfaces(interfaces).map((entry) => entry.address)
}
