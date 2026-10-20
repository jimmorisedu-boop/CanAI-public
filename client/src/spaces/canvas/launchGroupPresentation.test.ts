import assert from 'node:assert/strict'
import test from 'node:test'
import type { GenerationLaunchGroup, GenerationLaunchMeta } from './generationLaunches'
import type { GenerationTask, GenerationTaskState } from './generationRegistry'
import { launchGroupView } from './launchGroupPresentation'

function meta(extra: Partial<GenerationLaunchMeta> = {}): GenerationLaunchMeta {
  return {
    launchId: 'launch-1',
    variantIndex: 1,
    variantCount: 1,
    projectId: 'project-1',
    projectName: 'Кампания',
    promptPreview: 'Северный берег',
    modelId: 'model-1',
    modelName: 'GPT Image 2',
    estimatedTotalCostUsd: 0.11,
    createdAt: 1_000,
    ...extra,
  }
}

function variant(state: GenerationTaskState, error?: string): GenerationTask {
  return {
    jobId: `job-${state}`,
    state,
    createdAt: 0,
    updatedAt: 0,
    target: { kind: 'canvas', projectId: 'project-1' },
    launch: meta(),
    ...(error ? { error } : {}),
  } as GenerationTask
}

function group(variants: GenerationTask[], launch = meta()): GenerationLaunchGroup {
  return {
    launchId: 'launch-1',
    status: 'done',
    variantCount: variants.length,
    variants,
    launch: { ...launch, variantCount: variants.length },
    createdAt: 0,
    updatedAt: 0,
  } as GenerationLaunchGroup
}

/**
 * ⚠️ Список задач — служебное окно, и оно разрослось до четырёх строк с полосой
 * прогресса на каждый запуск: десяток одиночных генераций читался как стена
 * одинаковых карточек (жалоба 07.09.2026). Правило: строка говорит ровно то,
 * чего нет рядом.
 */
test('у одиночного запуска состояние словами, а не арифметика «1 из 1»', () => {
  const view = launchGroupView(group([variant('done')]), { currentProjectId: 'project-1' })
  assert.equal(view.summary, 'Done')
  assert.equal(view.expandable, false, 'разворачивать нечего: внутри то же самое')
  assert.equal(view.showProgress, false, 'полная полоса у законченного не сообщает ничего')
})

test('ошибка одиночного запуска называет причину прямо в строке', () => {
  const view = launchGroupView(group([variant('error', 'нет связи')]))
  assert.equal(view.summary, 'Error: Connection lost.')
})

test('счётчик остаётся там, где вариантов действительно несколько', () => {
  const view = launchGroupView(group([variant('done'), variant('running'), variant('error')]))
  assert.match(view.summary, /1 of 3 ready/)
  assert.match(view.summary, /1 creating/)
  assert.equal(view.expandable, true)
  assert.equal(view.showProgress, true, 'пока есть чего ждать — полоса на месте')
})

test('про свою доску молчим, чужую называем', () => {
  const own = launchGroupView(group([variant('done')]), { currentProjectId: 'project-1' })
  assert.doesNotMatch(own.meta, /доска/)
  const foreign = launchGroupView(group([variant('done')]), { currentProjectId: 'other' })
  assert.match(foreign.meta, /Кампания/)
})

test('заголовком становится модель, когда промпта нет — заглушек не показываем', () => {
  const view = launchGroupView(group([variant('done')], meta({ promptPreview: '' })))
  assert.equal(view.title, 'GPT Image 2')
  assert.doesNotMatch(view.meta, /GPT Image 2/, 'имя модели не повторяется вторым рядом')
  const bare = launchGroupView(group([variant('done')], meta({ promptPreview: '', modelName: '' })))
  assert.equal(bare.title, 'Generation')
})

/**
 * ⚠️ У моделей с тарифом «по факту» (GPT Image 2.5) цену заранее не знает
 * никто: fal объявляет расход после генерации, а сервер команды до тех пор
 * держит резерв-потолок — те самые «до $2.00». Показывая оценку, мы показывали
 * потолок, и человек не мог узнать, во что обошлась работа (вопрос
 * 09.09.2026: «почему мы до сих пор не поняли цену на модели гпт»).
 */
function charged(state: GenerationTaskState, chargedUsd?: number): GenerationTask {
  return { ...variant(state), jobId: `job-${state}-${chargedUsd ?? 'none'}`, ...(chargedUsd != null ? { chargedUsd } : {}) }
}

test('списанное перебивает оценку, когда его сообщил сервер', () => {
  const view = launchGroupView(
    group([charged('done', 0.34)], meta({ estimatedTotalCostUsd: 2 })),
    { currentProjectId: 'project-1' },
  )
  assert.match(view.meta, /\$0\.34/)
  assert.doesNotMatch(view.meta, /≈/, 'факт не сопровождают знаком «примерно»')
  assert.doesNotMatch(view.meta, /\$2\.00/, 'потолок резерва — не цена')
})

test('пока расход не сверен, честно остаётся оценка', () => {
  const view = launchGroupView(
    group([charged('done')], meta({ estimatedTotalCostUsd: 2 })),
    { currentProjectId: 'project-1' },
  )
  assert.match(view.meta, /≈ \$2\.00/)
})

test('у серии складываются все списания, а незавершённые ждут', () => {
  const settled = launchGroupView(
    group([charged('done', 0.2), charged('done', 0.3)], meta({ variantCount: 2, estimatedTotalCostUsd: 4 })),
    { currentProjectId: 'project-1' },
  )
  assert.match(settled.meta, /\$0\.50/)
  // Одна ещё считается — суммы всей серии пока нет, показываем оценку.
  const running = launchGroupView(
    group([charged('done', 0.2), charged('running')], meta({ variantCount: 2, estimatedTotalCostUsd: 4 })),
    { currentProjectId: 'project-1' },
  )
  assert.match(running.meta, /≈ \$4\.00/)
})
