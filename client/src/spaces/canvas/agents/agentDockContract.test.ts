import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('local board keeps the disabled agent surface out of CanvasSpace', () => {
  const canvas = source('../CanvasSpace.tsx')
  const panel = source('./AgentPanel.tsx')
  assert.doesNotMatch(canvas, /useAgentPanel\(/)
  assert.doesNotMatch(canvas, /<AgentPanel/)
  assert.doesNotMatch(panel, /useAgentPanel\(/)
  assert.doesNotMatch(panel, /AgentConnectionsPanel|AgentLaunchSection/)
  assert.match(panel, /controller: AgentPanelController/)
})

test('filled narrow viewport collapses agents instead of using an asset-overlapping fallback', () => {
  const panel = source('./AgentPanel.tsx')
  const css = source('../../../styles/agents-dock.css')
  assert.match(panel, /compactPositionUnavailable\s*=\s*compactLayout\s*&&\s*panelLayout\?\.compactPosition\s*===\s*null/)
  assert.match(panel, /if \(compactPositionUnavailable\) return null/)
  assert.match(panel, /if \(compactPositionUnavailable && !controller\.collapsed\) controller\.setCollapsed\(true\)/)
  assert.doesNotMatch(panel, /--agent-panel-compact-right[^\n]*8px/)
  assert.match(css, /\.agent-panel\.agent-panel--compact\s*\{[\s\S]*right:\s*var\(--agent-panel-compact-right, auto\)/)
  assert.match(css, /\.agent-panel-collapsed\.agent-panel-collapsed--compact\s*\{[\s\S]*right:\s*auto[\s\S]*left:\s*var\(--agent-panel-compact-left\)/)
})

test('settings package controller does not open a board task stream', () => {
  const settingsHook = source('./useAgentSettingsController.ts')
  assert.doesNotMatch(settingsHook, /listTasks\(/)
  assert.doesNotMatch(settingsHook, /subscribe\(/)
  assert.match(settingsHook, /listPackageLibrary\(/)
})

test('compact launcher keeps advanced input behind a disclosure and consent visible', () => {
  const launch = [source('./AgentLaunchSection.tsx'), source('./AgentLaunchFields.tsx'), source('./AgentSpendBudgetSection.tsx')].join('\n')
  assert.match(launch, /compact\?: boolean/)
  assert.match(launch, /Additional parameters/)
  assert.match(launch, /I allow this computer to send the instructions to the selected model\./)
  assert.match(launch, /readyPackages\.length > 1/)
  assert.match(launch, /selectedPackage\.taskTypes[^\n]*length > 1/)
})

test('compact launcher fills the dock and keeps long fields scrollable', () => {
  const launch = [source('./AgentLaunchSection.tsx'), source('./AgentLaunchFields.tsx'), source('./AgentSpendBudgetSection.tsx')].join('\n')
  const css = source('../../../styles/agents-dock.css')
  assert.match(launch, /agent-launch-choice-row/)
  assert.match(css, /\.action-dock-agents-composer\s*\{[\s\S]*width: 100%/)
  assert.match(css, /\.agent-launch-composer\s*\{[\s\S]*max-width: none/)
  assert.match(css, /\.agent-panel-launch--compact \.agent-task-advanced\s*\{[\s\S]*overflow: auto/)
  assert.match(css, /\.agent-panel-launch--compact \.agent-llm-budget\s*\{[\s\S]*overflow: auto/)
})

test('tight task panel keeps a side toggle and scrolls tasks only when there is room', () => {
  const panel = source('./AgentPanel.tsx')
  const layout = source('./agentPanelLayout.ts')
  const css = source('../../../styles/agents-dock.css')
  assert.match(layout, /availableHeight:\s*Math\.max\(0, canvasRect\.height - 32 - bottomReserve\)/)
  assert.match(layout, /compactPosition:\s*agentPanelCompactPosition\(canvasRect, blockers\)/)
  assert.match(panel, /agentPanelHasHeaderRoom\(panelLayout\.availableHeight\)/)
  assert.match(panel, /agent-panel--compact/)
  assert.match(css, /\.agent-panel\.agent-panel--compact\s*\{[\s\S]*height: 48px[\s\S]*max-height: 48px[\s\S]*overflow: hidden/)
  assert.match(css, /\.agent-panel--compact > :not\(\.agent-panel-header\)\s*\{\s*display: none;/)
  assert.match(css, /\.agent-panel:not\(\.agent-panel--compact\) \.agent-panel-scroll\s*\{[\s\S]*min-height: 0[\s\S]*overflow-y: auto/)
})
