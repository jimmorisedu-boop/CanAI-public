import fs from 'node:fs'
import os from 'node:os'
import { buildInfo, formatBuildLine } from './buildInfo.js'
import { config } from './config.js'
import { logFilePaths } from './log.js'
import { redactReportText } from './reportRedact.js'

/**
 * Жалоба с журналами (пункт 5.9 списка исправлений): что прислал человек плюс
 * то, что знает о себе сервер приложения.
 *
 * ⚠️ Серверный журнал берётся ХВОСТОМ: важны последние события перед жалобой,
 * а журнал живёт до мегабайта в каждом из двух файлов. Ни ключа fal, ни
 * содержимого досок сюда не попадает — только журнал и сведения о сборке.
 */

const LIMITS = {
  description: 4_000,
  build: 200,
  userAgent: 400,
  clientLog: 1_400_000,
  serverLog: 700_000,
}

export interface ReportInput {
  description: string
  clientLog: string
  clientBuild: string
  userAgent: string
}

export interface DiagnosticReport {
  description: string
  source: 'desktop'
  createdAt: string
  client: { build: string; userAgent: string; log: string }
  server: { build: string; platform: string; info: Record<string, unknown>; log: string }
}

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

function tail(value: string, limit: number): string {
  return value.length > limit ? `…[beginning truncated]\n${value.slice(value.length - limit)}` : value
}

export function parseReportInput(body: unknown): ReportInput {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  return {
    description: text(input.description).trim().slice(0, LIMITS.description),
    clientLog: text(input.clientLog),
    clientBuild: text(input.clientBuild).slice(0, LIMITS.build),
    userAgent: text(input.userAgent).slice(0, LIMITS.userAgent),
  }
}

/** Хвост серверного журнала: старый файл, затем текущий. Нет файла — пусто. */
export function serverLogTail(files: string[] = logFilePaths(), limit = LIMITS.serverLog): string {
  const parts: string[] = []
  for (const file of files) {
    try {
      parts.push(fs.readFileSync(file, 'utf8'))
    } catch {
      // файла нет — ничего страшного, у свежей установки журнал пуст
    }
  }
  return tail(parts.join(''), limit)
}

export function buildDiagnosticReport(
  input: ReportInput,
  options: { now?: Date; serverLog?: string; extra?: Record<string, unknown> } = {},
): DiagnosticReport {
  const memory = process.memoryUsage()
  return {
    description: redactReportText(input.description),
    source: 'desktop',
    createdAt: (options.now ?? new Date()).toISOString(),
    client: {
      build: redactReportText(input.clientBuild),
      userAgent: redactReportText(input.userAgent),
      log: redactReportText(tail(input.clientLog, LIMITS.clientLog)),
    },
    server: {
      build: formatBuildLine(buildInfo()),
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      info: {
        node: process.version,
        uptimeMinutes: Math.round(process.uptime() / 60),
        memoryMb: Math.round(memory.rss / 1048576),
        heapMb: Math.round(memory.heapUsed / 1048576),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        falConfigured: Boolean(config.falKey),
        mockMode: config.mockMode,
        ...options.extra,
      },
      log: redactReportText(options.serverLog ?? serverLogTail()),
    },
  }
}
