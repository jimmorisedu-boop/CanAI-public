import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GenerationLaunchGroup, GenerationLaunchMeta } from './generationLaunches'
import { groupGenerationTasks } from './generationLaunches'
import type {
  GenerationRetryDescriptor,
  GenerationTask,
  GenerationTaskState,
} from './generationRegistry'
import {
  GenerationLaunchGroupRow,
  generationLaunchGroupActionIds,
} from './GenerationLaunchGroupRow'

const retry: GenerationRetryDescriptor = {
  kind: 'image',
  prompt: 'Северный берег',
  refs: [],
}

function launch(variantIndex: number): GenerationLaunchMeta {
  return {
    launchId: 'launch-1',
    variantIndex,
    variantCount: 4,
    projectId: 'project-1',
    projectName: 'Кампания',
    promptPreview: 'Северный берег на рассвете',
    modelId: 'model-1',
    modelName: 'GPT Image 2',
    estimatedTotalCostUsd: 0.56,
    createdAt: 1_000,
  }
}

function task(
  variantIndex: number,
  state: GenerationTaskState,
  options: { retry?: GenerationRetryDescriptor; error?: string } = {},
): GenerationTask {
  return {
    jobId: `job-${variantIndex}`,
    jobKind: 'image',
    target: { kind: 'canvas', projectId: 'project-1' },
    state,
    launch: launch(variantIndex),
    retry: options.retry,
    error: options.error,
    createdAt: 1_000 + variantIndex,
  }
}

const group = groupGenerationTasks([
  task(1, 'done'),
  task(2, 'done'),
  task(3, 'running'),
  task(4, 'error', { retry, error: 'Нет связи' }),
])[0]

function render(expanded: boolean): string {
  return renderGroup(group, expanded)
}

function renderGroup(value: GenerationLaunchGroup, expanded = false): string {
  return renderToStaticMarkup(
    <GenerationLaunchGroupRow
      group={value}
      expanded={expanded}
      currentProjectId="project-1"
      onToggle={() => {}}
      onShow={() => {}}
      onCancel={() => {}}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  )
}

test('terminal-only dismiss stays in the task heading instead of creating an orphan action row', () => {
  const terminalGroup = groupGenerationTasks([
    task(1, 'error', { error: 'Нет связи' }),
  ])[0]
  const html = renderGroup(terminalGroup)

  assert.match(
    html,
    /class="task-launch-heading"[\s\S]*class="task-launch-disclosure"[\s\S]*aria-label="Remove run from list"[\s\S]*<\/div>/,
  )
  assert.doesNotMatch(html, /class="task-launch-group-actions"/)
})

test('primary task actions stay separate from the compact heading dismiss control', () => {
  const settledGroup = groupGenerationTasks([
    task(1, 'done'),
    task(2, 'done'),
    task(3, 'error', { retry, error: 'Нет связи' }),
    task(4, 'error', { retry, error: 'Нет связи' }),
  ])[0]
  const html = renderGroup(settledGroup)
  const heading = html.match(/<div class="task-launch-heading">([\s\S]*?)<\/div>/)?.[1] ?? ''
  const actions = html.match(/<div class="task-launch-group-actions">([\s\S]*?)<\/div>/)?.[1] ?? ''

  assert.match(heading, /aria-label="Remove run from list"/)
  assert.match(actions, /Show results/)
  assert.match(actions, /Retry failed/)
  assert.doesNotMatch(actions, /Remove run from list/)
})

test('collapsed group names the work, progress, cost and available result action', () => {
  const html = render(false)

  assert.match(html, /Северный берег на рассвете/)
  assert.match(html, /GPT Image 2/)
  // ⚠️ Про СВОЮ доску строка молчит: человек на ней и так стоит, а десяток
  // одинаковых приписок «эта доска» и был половиной того шума, из-за которого
  // список стало тяжело читать (жалоба 07.09.2026). Чужую доску называем —
  // см. соседний тест.
  assert.doesNotMatch(html, /эта доска/)
  assert.match(html, /2 of 4/)
  assert.match(html, /≈ \$0\.56/)
  assert.match(html, /role="progressbar"/)
  assert.match(html, /aria-valuenow="3"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /Show results/)
  assert.doesNotMatch(html, /Show variant 2/)
})

test('expanded group gives every variant a unique accessible action name', () => {
  const html = render(true)

  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /aria-label="Show variant 2"/)
  assert.match(html, /aria-label="Stop variant 3"/)
  assert.match(html, /aria-label="Retry variant 4"/)
  assert.match(html, /Connection lost\./)
  assert.doesNotMatch(html, /Нет связи/)
})

test('group actions target only variants for which the action is valid', () => {
  // «Показать» берёт и идущие задачи: заглушка уезжает за край экрана, и без
  // этого её не найти — а вместе с ней и кнопку «Стоп» на карточке.
  assert.deepEqual(generationLaunchGroupActionIds(group), {
    show: ['job-1', 'job-2', 'job-3'],
    showLabel: 'Show results',
    cancel: ['job-3'],
    retry: ['job-4'],
    dismiss: ['job-1', 'job-2', 'job-4'],
  })
})

test('пока готового нет, кнопка обещает показать место, а не результат', () => {
  const running = {
    ...group,
    variants: group.variants
      .filter((variant) => variant.state === 'running')
      .map((variant) => ({ ...variant })),
  }
  const actions = generationLaunchGroupActionIds(running)
  assert.deepEqual(actions.show, ['job-3'])
  assert.equal(actions.showLabel, 'Show on canvas')
})
