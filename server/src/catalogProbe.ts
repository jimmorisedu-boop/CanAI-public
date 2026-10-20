/**
 * Живая проверка каталога моделей.
 *
 * Схемы openapi отвечают на вопрос «какие поля есть», но не на вопрос «примет
 * ли модель то, что мы реально шлём». Этот пробник гоняет КАЖДЫЙ пресет через
 * настоящий путь приложения — POST /api/generate → runner → fal → storage, —
 * а не мимо него: смысл в том, чтобы поймать нашу ошибку, а не проверить fal.
 *
 * Деньги настоящие, поэтому по умолчанию печатается только план и оценка:
 *   npx tsx src/catalogProbe.ts            — план и цена, НИ ОДНОГО запуска
 *   npx tsx src/catalogProbe.ts --run      — запустить
 *   npx tsx src/catalogProbe.ts --run --kind=image   — только картинки
 *   npx tsx src/catalogProbe.ts --run --only=grok,veo-omni
 *
 * Параметры каждой модели берутся САМЫЕ ДЕШЁВЫЕ из её же описания: минимальное
 * разрешение, минимальная длительность, одно изображение. Цель — проверить
 * договор вызова, а не качество картинки.
 *
 * Запускать имеет смысл против ИЗОЛИРОВАННОГО сервера (свой CANAI_DATA_DIR),
 * чтобы результаты не падали в рабочие доски.
 */
import { CATALOG, type CatalogModel, type ParamSpec } from './catalog.js'

const BASE = process.env.CANAI_PROBE_URL ?? 'http://127.0.0.1:8788'
const args = process.argv.slice(2)
const RUN = args.includes('--run')
// можно перечислить несколько: --kind=text,image,other
const KIND = args.find((a) => a.startsWith('--kind='))?.split('=')[1]?.split(',')
const ONLY = args.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',')

const PROMPT_BY_KIND: Record<string, string> = {
  text: 'Reply one word: works',
  image: 'a plain grey square, flat, minimal',
  video: 'a plain grey square, static shot',
  other: 'square',
}

// ── самые дешёвые настройки ───────────────────────────────────────────────

function priceMap(model: CatalogModel, name: string): Record<string, number> | null {
  const byParam = model.pricing?.byParam
  return byParam && byParam.name === name ? byParam.usd : null
}

function cheapestOption(spec: ParamSpec, prices: Record<string, number> | null): unknown {
  const values = spec.options?.map((o) => o.value) ?? []
  if (values.length === 0) return spec.default
  if (prices) {
    const priced = values.filter((v) => prices[v] !== undefined)
    if (priced.length > 0) {
      return priced.reduce((best, v) => (prices[v] < prices[best] ? v : best), priced[0])
    }
  }
  return spec.default
}

function cheapestValue(model: CatalogModel, spec: ParamSpec): unknown {
  if (spec.name === 'seed') return undefined
  if (spec.name === 'num_images') return 1
  // звук у видео обычно платный отдельно и для проверки договора не нужен
  if (spec.name === 'generate_audio') return false
  if (spec.widget === 'boolean') return spec.default
  if (spec.widget === 'number' || spec.widget === 'slider') {
    // именно min, а не «что-нибудь маленькое»: сервер проверяет границы, и
    // просить меньше минимума — значит получить отказ ещё до вызова fal
    return spec.min ?? spec.default
  }
  if (spec.widget === 'select') {
    // длительность у Seedance — СТРОКА в списке, а не число
    if (spec.name === 'duration') {
      const numeric = (spec.options ?? [])
        .map((option) => ({ value: option.value, n: Number(option.value) }))
        .filter((option) => Number.isFinite(option.n))
      if (numeric.length > 0) {
        return numeric.reduce((best, option) => (option.n < best.n ? option : best), numeric[0]).value
      }
    }
    if (spec.name === 'quality') return cheapestOption(spec, { low: 0, medium: 1, high: 2 })
    return cheapestOption(spec, priceMap(model, spec.name))
  }
  return spec.default
}

function cheapestParams(model: CatalogModel): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of model.params ?? []) {
    const value = cheapestValue(model, spec)
    if (value !== undefined) out[spec.name] = value
  }
  return out
}

// ── оценка цены ───────────────────────────────────────────────────────────

function estimate(model: CatalogModel, params: Record<string, unknown>): number | null {
  const pricing = model.pricing
  if (!pricing) return null
  let usd = pricing.usd
  const byParam = pricing.byParam
  if (byParam) {
    const chosen = params[byParam.name]
    if (typeof chosen === 'string' && byParam.usd[chosen] !== undefined) usd = byParam.usd[chosen]
  }
  if (pricing.unit === 'second') {
    const duration = Number(params.duration ?? pricing.defaultDuration ?? 5)
    return usd * (Number.isFinite(duration) ? duration : 5)
  }
  return usd
}

// ── план ──────────────────────────────────────────────────────────────────

interface Step {
  model: CatalogModel
  params: Record<string, unknown>
  usd: number | null
  needs: 'none' | 'image' | 'video'
}

function needsOf(model: CatalogModel): Step['needs'] {
  if (!model.refs) return 'none'
  return model.videoRefs ? 'video' : 'image'
}

function buildPlan(): Step[] {
  const chosen = CATALOG.filter((model) => {
    if (KIND && !KIND.includes(model.kind)) return false
    if (ONLY && !ONLY.includes(model.id)) return false
    return true
  })
  const steps = chosen.map((model) => {
    const params = cheapestParams(model)
    return { model, params, usd: estimate(model, params), needs: needsOf(model) }
  })
  // сначала то, что ничего не требует: их результаты станут референсами
  const order = { none: 0, image: 1, video: 2 } as const
  return steps.sort((a, b) => order[a.needs] - order[b.needs])
}

function money(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(3)}`
}

// ── выполнение ────────────────────────────────────────────────────────────

interface Outcome {
  id: string
  name: string
  kind: string
  ok: boolean
  note: string
  usd: number | null
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* сервер ответил не-JSON — важен сам текст */
  }
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`)
  return json
}

async function waitJob(jobId: string, kind: string): Promise<any> {
  const deadline = Date.now() + (kind === 'video' ? 16 * 60_000 : 5 * 60_000)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const res = await fetch(`${BASE}/api/jobs/${jobId}`)
    if (!res.ok) throw new Error(`job poll: HTTP ${res.status}`)
    const job = await res.json()
    if (job.status === 'done') return job
    if (job.status === 'error') throw new Error(job.error ?? 'generation did not succeed')
  }
  throw new Error('timeout waiting')
}

async function main(): Promise<void> {
  const plan = buildPlan()
  const total = plan.reduce((sum, step) => sum + (step.usd ?? 0), 0)

  console.log(`Presets: ${plan.length}. Server: ${BASE}`)
  for (const step of plan) {
    const params = Object.entries(step.params).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`  ${money(step.usd).padStart(8)}  ${step.model.kind.padEnd(6)} ${step.model.id.padEnd(24)} ${params}`)
  }
  console.log(`\nEstimated total: ${money(total)}`)

  if (!RUN) {
    console.log('\nThis is only a plan. To run it: --run')
    return
  }

  const results: Outcome[] = []
  let imageRef: string | null = null
  let videoRef: string | null = null

  for (const step of plan) {
    const { model } = step
    const refs: Array<{ kind: string; src: string }> = []
    if (step.needs === 'image') {
      if (!imageRef) {
        results.push({ id: model.id, name: model.name, kind: model.kind, ok: false, usd: null, note: 'skipped: no images-reference' })
        continue
      }
      refs.push({ kind: 'image', src: imageRef })
    }
    if (step.needs === 'video') {
      if (!videoRef) {
        results.push({ id: model.id, name: model.name, kind: model.kind, ok: false, usd: null, note: 'skipped: no video-reference' })
        continue
      }
      refs.push({ kind: 'video', src: videoRef })
    }

    process.stdout.write(`→ ${model.id} … `)
    try {
      const { jobId } = await post('/api/generate', {
        kind: model.kind,
        prompt: PROMPT_BY_KIND[model.kind] ?? 'test',
        refs,
        model: model.id,
        params: step.params,
      })
      const job = await waitJob(jobId, model.kind)
      const result = job.result ?? {}
      const url: string | undefined = result.imageUrl ?? result.videoUrl ?? result.url
      const text: string | undefined = result.text
      if (model.kind === 'image' && url && !imageRef) imageRef = url
      if (model.kind === 'video' && url && !videoRef) videoRef = url
      const note = text ? `text: ${text.slice(0, 40)}` : url ? `file: ${url}` : `empty: ${JSON.stringify(result).slice(0, 80)}`
      const ok = Boolean(text || url)
      console.log(ok ? 'ok' : 'EMPTY RESULT')
      results.push({ id: model.id, name: model.name, kind: model.kind, ok, usd: step.usd, note })
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error)
      console.log(`FAILED — ${note}`)
      results.push({ id: model.id, name: model.name, kind: model.kind, ok: false, usd: step.usd, note })
    }
  }

  // Считаем только УДАВШИЕСЯ. Иначе отчёт врёт в самую неприятную сторону:
  // при отказе ключа не запускается ничего, а сумма выглядит потраченной.
  const spent = results.filter((r) => r.ok).reduce((sum, r) => sum + (r.usd ?? 0), 0)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n── total ──`)
  console.log(`Passed: ${results.length - bad.length} from ${results.length}. Spent about ${money(spent)}`)
  if (bad.length > 0) {
    console.log('Failures are not included in this amount. But if generation failed')
    console.log('after the model call (for example, if uploading the result was interrupted),')
    console.log('it is still charged; these cases are shown in the error text.')
  }
  if (bad.length > 0) {
    console.log('\nFailed:')
    for (const r of bad) console.log(`  ${r.kind.padEnd(6)} ${r.id.padEnd(24)} ${r.note}`)
  }
}

void main()
