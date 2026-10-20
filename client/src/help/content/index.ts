import guide from './guide.json'
import type { HelpCategory, HelpTopic, HelpStep, HelpShortcut, HelpTarget } from './types'

const guideData = guide as unknown as { categories: HelpCategory[]; topics: HelpTopic[] }

export const HELP_CATEGORIES: HelpCategory[] = guideData.categories
export const HELP_TOPICS: HelpTopic[] = guideData.topics

export type { HelpCategory, HelpTopic, HelpStep, HelpShortcut, HelpTarget } from './types'
