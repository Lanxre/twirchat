if (process.env.TWIRCHAT_GUI_QA !== '1') throw new Error('Use the isolated qa:gui launcher.')
process.env.TWIRCHAT_APP_VERSION = '1.7.1'

import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { z } from 'zod'

const { assertGuiQaEnvironment } = await import('../src/services/gui-qa')
assertGuiQaEnvironment()

const dbPath = process.env.DB_PATH
assert(dbPath, 'QA database path is missing')

const seed = new Database(dbPath, { create: true })
seed.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
seed.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
  'gpuix_last_seen_version',
  '1.7.0',
])
seed.close()

const releaseUrl = 'https://api.github.com/repos/Satont/twirchat/releases/tags/v1.7.1'
const releaseResponse = JSON.stringify({
  tag_name: 'v1.7.1',
  body: `## What's Changed
* Add a release date to the changelog dialog
* Fix scrolling issue in tall windows
* Tweak the tooltip shadow
* Adjust the layout spacing
* Bump version number

## New Contributors
* @user made first contribution

**Full Changelog**: https://github.com/Satont/twirchat/compare/v1.7.0...v1.7.1`,
  published_at: '2026-11-08T17:20:39Z',
  html_url: 'https://github.com/Satont/twirchat/releases/tag/v1.7.1',
})
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === releaseUrl)
    return Promise.resolve(
      new Response(releaseResponse, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  return originalFetch(input, init)
}

const { captureGuiQaDisplay } = await import('../src/services/gui-qa-screenshot')
await import('../src/gpuix/main')

interface AutomationNode {
  id: number
  testId?: string
  children: AutomationNode[]
}

interface QaRenderer {
  getAutomationTree(): string
  getPaintedText(): string[]
  getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null
  getScrollOffset(id: number): readonly number[] | null
  simulateClick(x: number, y: number, button: number): void
  simulateScrollWheel(x: number, y: number, deltaX: number, deltaY: number): void
}

const automationNodeSchema: z.ZodType<AutomationNode> = z.lazy(() =>
  z.object({
    id: z.number(),
    testId: z.string().optional(),
    children: z.array(automationNodeSchema).default([]),
  }),
)

function find(renderer: QaRenderer, testId: string): AutomationNode | undefined {
  const visit = (node: AutomationNode): AutomationNode | undefined =>
    node.testId === testId ? node : node.children.map(visit).find(Boolean)
  return visit(automationNodeSchema.parse(JSON.parse(renderer.getAutomationTree())))
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out: ${label}`)
}

const manager = Reflect.get(globalThis, '__twirchatWindows')
const mounts = Reflect.get(manager, 'mounted')
let main: QaRenderer | undefined
const session = process.env.TWIRCHAT_QA_SESSION_DIR
assert(session, 'Missing isolated QA session directory')

try {
  await until(() => mounts.has('main'), 'main window')
  main = mounts.get('main').renderer
  const window = main
  assert.ok(window, 'Missing main renderer')

  await until(() => find(window, 'update-changelog') !== undefined, 'changelog modal')
  const text = window.getPaintedText().join('')
  
  console.log('=== FULL MODAL TEXT ===')
  console.log(text)
  console.log('=======================')

  if (manager !== undefined) await manager.quit()
} catch (error) {
  console.error('ERROR:', error)
  if (process.env.TWIRCHAT_QA_COMPOSITOR === 'xvfb')
    await captureGuiQaDisplay('changelog-failure').catch(() => {})
  await Bun.write(
    join(session, 'changelog-failure.json'),
    JSON.stringify(
      {
        error: String(error),
        text: main?.getPaintedText() ?? [],
        tree: main ? JSON.parse(main.getAutomationTree()) : null,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}
