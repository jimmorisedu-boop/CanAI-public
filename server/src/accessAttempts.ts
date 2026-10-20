/** Скользящее окно неудачных попыток.
 *
 * Считает отметки времени по ключу и говорит, исчерпан ли лимит. Вынесено
 * из ShareAuth отдельно, потому что окон теперь ДВА: по гостю и по самой
 * публикации (см. `shareAuth.ts`), а логика у них одна и её надо проверять
 * тестом без сети и файлов. */
export class AttemptWindow {
  private readonly max: number
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly hits = new Map<string, number[]>()

  constructor(input: { max: number; windowMs: number; maxKeys?: number; now?: () => number }) {
    this.max = input.max
    this.windowMs = input.windowMs
    this.maxKeys = input.maxKeys ?? 10_000
    this.now = input.now ?? Date.now
  }

  private fresh(key: string): number[] {
    const now = this.now()
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (recent.length > 0) this.hits.set(key, recent)
    else this.hits.delete(key)
    return recent
  }

  /** Исчерпан ли лимит по ключу — без регистрации новой попытки. */
  blocked(key: string): boolean {
    return this.fresh(key).length >= this.max
  }

  /** Отметить неудачную попытку. */
  register(key: string): void {
    const recent = this.fresh(key)
    recent.push(this.now())
    this.hits.set(key, recent)
    this.evict()
  }

  /** Забыть ключ — вызывается после успешного входа. */
  clear(key: string): void {
    this.hits.delete(key)
  }

  /** Карта не должна расти бесконечно: сначала выбрасываем протухшие
   *  ключи, и лишь если это не помогло — самые старые по порядку вставки. */
  private evict(): void {
    if (this.hits.size <= this.maxKeys) return
    const now = this.now()
    for (const [key, attempts] of this.hits) {
      if (!attempts.some((at) => now - at < this.windowMs)) this.hits.delete(key)
      if (this.hits.size <= this.maxKeys) return
    }
    for (const key of this.hits.keys()) {
      this.hits.delete(key)
      if (this.hits.size <= this.maxKeys) return
    }
  }
}
