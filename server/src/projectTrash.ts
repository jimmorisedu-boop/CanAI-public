import {
  deleteTrashedProjectFiles,
  listTrashedProjectFiles,
  restoreTrashedProjectFiles,
  trashProjectFiles,
} from './projects.js'
import { config } from './config.js'
import { deleteSessionDraft } from './sessionDraft.js'


export async function trashProject(id: string) {
  const result = await trashProjectFiles(id)
  return result
}
export const listTrashedProjects = listTrashedProjectFiles
export const restoreTrashedProject = restoreTrashedProjectFiles

export async function deleteTrashedProjectPermanently(id: string) {
  // Черновик сеанса переживает корзину (восстановленная доска возвращается
  // вместе с набранным промптом), но не окончательное удаление.
  await deleteSessionDraft(id)
  const result = await deleteTrashedProjectFiles(id)
  return result
}
