import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = process.env.CANAI_DATA_DIR
  ? path.resolve(process.env.CANAI_DATA_DIR)
  : path.join(serverRoot, 'data')

// ключ из server/.env приоритетнее системной переменной окружения:
// файл, который редактирует пользователь (или настройки в UI), должен побеждать
// В тестах и изолированных запусках можно явно выбрать отдельный env-файл,
// не читая и не изменяя пользовательский server/.env.
export const envFile = process.env.CANAI_ENV_FILE
  ? path.resolve(process.env.CANAI_ENV_FILE)
  : path.join(serverRoot, '.env')
const fileEnv = dotenv.config({ path: envFile }).parsed ?? {}

export const serverRootDir = serverRoot

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // мутируется при сохранении ключа из настроек (settings.saveFalKey)
  falKey: process.env.CANAI_MOCK === '1' ? null : fileEnv.FAL_KEY?.trim() || process.env.FAL_KEY?.trim() || null,
  mockMode: process.env.CANAI_MOCK === '1',
  // Подключение к серверу CanAI: адрес и токен рабочего места. Лежат рядом с
  // ключом fal в server/.env — это секреты, и наружу не отдаются (клиент видит
  // только «подключено/нет» и имя студии). Мутируются при сохранении настроек.
  serverFingerprint: process.env.CANAI_SERVER_FINGERPRINT?.trim() || null,
  mediaDir: path.join(dataRoot, 'media'),
  // Кратковременно использовавшийся путь: переносим обратно в portable data/.
  legacyMediaDir: process.env.CANAI_DATA_DIR
    ? path.join(dataRoot, 'legacy-output')
    : path.join(serverRoot, '..', 'output'),
  projectFile: path.join(dataRoot, 'project.json'),
  onboardingFile: path.join(dataRoot, 'onboarding.json'),
  jobsFile: path.join(dataRoot, 'jobs.json'),
  mediaImportsFile: path.join(dataRoot, 'media-imports.json'),
  settingsFile: path.join(dataRoot, 'settings.json'),
  personalDraftOutboxFile: path.join(dataRoot, 'personal-draft-outbox.json'),
  personalDraftAssetsFile: path.join(dataRoot, 'personal-draft-assets.json'),
  runtimeControlFile: path.join(dataRoot, 'runtime-control.json'),
  // Локальный journal задач агентных пакетов и отдельные рабочие каталоги.
  // В API не отдаются абсолютные пути; они вычисляются из этого portable data.
  agentTasksFile: path.join(dataRoot, 'agent-tasks.json'),
  agentWorkspaceDir: path.join(dataRoot, 'agent-workspaces'),
  agentCheckpointDir: path.join(dataRoot, 'agent-checkpoints'),
  // Immutable installer records live beside the task journal. The package
  // roots are never exposed through the API; only portable relative keys are
  // persisted in the library document.
  agentLibraryFile: path.join(dataRoot, 'agent-library.json'),
  agentPackageDir: path.join(dataRoot, 'agents', 'packages'),
  agentPackageStateDir: path.join(dataRoot, 'agents', 'state'),
  agentPackageStagingDir: path.join(dataRoot, 'agents', 'staging'),
  // Binary package uploads stay inside portable data/agents and are addressed
  // only by the immutable archiveId returned by the upload store.
  agentPackageUploadRoot: path.join(dataRoot, 'agents'),
  // Одноразовая активация поставляется рядом с server/, а после обмена удаляется.
  // Портативный cloudflared лежит рядом с портативным Node — в runtime/.
  // Папка не в git и переезжает вместе с приложением.
  runtimeDir: path.join(serverRoot, '..', 'runtime'),
  mediaToolsDir: path.join(serverRoot, '..', 'runtime', 'media-tools'),
  // В production это 8788; изолированные smoke/integration-запуски задают свой
  // PORT, поэтому гостевой listener автоматически следует за ним и не спорит
  // с параллельным тестовым процессом за глобальный 8788.
  // Планшетный слушатель. По умолчанию третий подряд (8789): у гостевого уже
  // занят второй. Изолированные прогоны задают свой PORT, и этот следует за
  // ним — иначе параллельные процессы спорили бы за один порт.
  remotePort: Number(process.env.CANAI_REMOTE_PORT ?? Number(process.env.PORT ?? 8787) + 2),
}
