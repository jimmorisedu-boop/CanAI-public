import { execFile, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'

async function killDescendantPids(rootPid: number): Promise<void> {
  const allDescendants: number[] = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const parentPid = queue.shift()!
    const children = await new Promise<number[]>((resolve) => {
      execFile('pgrep', ['-P', String(parentPid)], { timeout: 3000 }, (error, stdout) => {
        if (error || !stdout) return resolve([])
        const pids = stdout
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((p) => Number.isInteger(p) && p > 0)
        resolve(pids)
      })
    })
    for (const childPid of children) {
      allDescendants.push(childPid)
      queue.push(childPid)
    }
  }

  for (let i = allDescendants.length - 1; i >= 0; i--) {
    try {
      process.kill(allDescendants[i]!, 'SIGKILL')
    } catch {
      // процесс уже завершился
    }
  }
}

/** Portable gallery-dl/yt-dlp запускают дочерний процесс (или ffmpeg).
 * child.kill() завершает только оболочку, оставляя скачивание и файлы занятыми. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null
  if (!child.pid || exited()) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill.exe', taskkillArgs(child.pid!, child.spawnfile), {
        windowsHide: true,
        timeout: 10_000,
      }, (error, stdout, stderr) => {
        // ⚠️ «Нет таких задач» — это НЕ сбой: процесс уже ушёл сам либо номер
        // достался чужому и фильтр нас уберёг. Оба случая означают, что убивать
        // нечего, и жаловаться не на что.
        if (!error || nothingToKill(`${stdout}${stderr}`)) resolve()
        else reject(error)
      })
    })
  } else {
    try {
      await killDescendantPids(child.pid)
    } catch {
      // обход потомков не удался — завершаем родительский процесс напрямую
    }
    child.kill('SIGKILL')
  }
  if (!exited()) await once(child, 'exit')
}

/**
 * ⚠️ **Номер процесса Windows переиспользует, и бить по нему вслепую опасно.**
 * Между выходом дочернего процесса и тем мигом, когда Node это заметит
 * (`exitCode` ещё null), номер уже может достаться ЧУЖОМУ процессу — например
 * оболочке лаунчера. Тогда `taskkill /T /F` снёс бы её вместе с деревом:
 * консоль у сервера пропадает, он получает SIGHUP и уходит, а окно остаётся
 * открытым — ровно то, на что жаловались 20.09.2026 («вылетел», «ничего не
 * закрывалось»).
 *
 * Страховка — фильтр по имени программы: своих детей мы запускаем сами и знаем
 * их (`spawnfile`, причём без оболочки — значит имя ровно наше). Проверено
 * вживую: с чужим именем taskkill отвечает «нет таких задач» и НИЧЕГО не
 * трогает, со своим — убивает дерево как прежде.
 */
export function taskkillArgs(pid: number, spawnfile: string | undefined): string[] {
  const args = ['/PID', String(pid), '/T', '/F']
  const image = spawnfile ? path.basename(spawnfile) : ''
  if (image) args.push('/FI', `IMAGENAME eq ${image}`)
  return args
}

/** taskkill отвечает так, когда под условия не попал никто. */
export function nothingToKill(output: string): boolean {
  return /No tasks running with the specified criteria|не выполняются задачи/iu.test(output)
}
