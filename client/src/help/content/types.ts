export type HelpTarget = 'first-generation' | 'reference-generation' | 'recovery' | 'save-for-later' | 'export'

export type HelpStep = {
  title: string
  body: string
  image: string
  alt: string
}

export type HelpShortcut = {
  keys: string
  action: string
}

export type HelpTopic = {
  id: string
  category: string
  title: string
  summary: string
  keywords: string[]
  steps: HelpStep[]
  notes?: string[]
  shortcuts?: HelpShortcut[]
  related?: string[]
  target?: HelpTarget
}

export type HelpCategory = {
  id: string
  title: string
}
