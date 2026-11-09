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
// Fixture with "other" category items
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
  
  assert.ok(text.includes('v1.7.1'), 'Missing version badge')
  assert.ok(text.includes('Released Nov 8, 2026'), 'Missing release date')
  assert.ok(/other changes/iu.test(text), 'Missing Other changes category')
  assert.ok(text.includes('OTHER'), 'Missing OTHER badge')
  assert.ok(text.includes('Tweak the tooltip shadow'), 'Missing "other" item')
  assert.ok(text.includes('Adjust the layout spacing'), 'Missing "other" item 2')
  assert.ok(text.includes('Bump version number'), 'Missing "other" item 3')
  assert.ok(!text.includes('New Contributors'), 'New Contributors section should be hidden')
  const modal = find(window, 'update-changelog')
  assert.ok(modal, 'Missing changelog modal')

  const content = find(window, 'update-changelog-content')
  assert.ok(content, 'Missing changelog content')
  const contentBounds = window.getElementBounds(content.id)
  assert.ok(contentBounds, 'Missing painted changelog content bounds')
  window.simulateScrollWheel(
    contentBounds.x + contentBounds.width / 2,
    contentBounds.y + contentBounds.height / 2,
    0,
    -400,
  )
  await until(
    () => (window.getScrollOffset(content.id)?.[1] ?? 0) < -10,
    'changelog content scrolls',
  )

  const continueButton = find(window, 'update-changelog-continue')
  assert.ok(continueButton, 'Missing Continue button')
  const bounds = window.getElementBounds(continueButton.id)
  assert.ok(bounds, 'Missing painted Continue bounds')
  window.simulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 0)

  await until(() => !find(window, 'update-changelog'), 'changelog closes')

  const check = new Database(dbPath, { readonly: true })
  const row = check
    .query<{ value: string }, []>(
      "SELECT value FROM settings WHERE key = 'gpuix_last_seen_version'",
    )
    .get()
  check.close()
  assert.equal(row?.value, '1.7.1')

  await Bun.write(
    join(session, 'changelog-result.json'),
    JSON.stringify({ ok: true }, null, 2),
  )
  console.log('Other changes QA passed.')

  if (manager !== undefined) await manager.quit()
} catch (error) {
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
  console.error(error)
  process.exit(1)
}
