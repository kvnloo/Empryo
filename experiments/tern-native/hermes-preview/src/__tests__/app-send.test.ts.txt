import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'

import { Session } from '@stencil-hq/tern'
import { GatewayClient } from '@tui/gatewayClient.js'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { App, INPUT_ID } from '../app.js'

const isolated = await vi.hoisted(async () => {
  // History binds its home at module load. vi.hoisted must set the isolated home before static app imports execute.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'hermes-native-send-'))
  const previous = process.env.HERMES_HOME
  process.env.HERMES_HOME = home

  return { home, previous }
})

const key = (name: string) => ({ alt: false, ctrl: false, meta: false, name, shift: false })

afterAll(() => {
  if (isolated.previous === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = isolated.previous
  }

  rmSync(isolated.home, { force: true, recursive: true })
})

describe('native composer submission', () => {
  it('consumes atomic multiline send once and recalls the submitted text, not the old draft', async () => {
    const tern = new Session(new EventEmitter(), { write() {} }, { exitHooks: false, record: '' })
    const app = new App(tern, new GatewayClient(), 'test')
    app.sid = 'session-1'
    app.busy = { label: 'Working', since: {}, startedAt: 0 }
    app.composer.set('old draft')
    const running = app.run()

    try {
      const surface = tern.surfaces[0]!
      const send = surface.dispatch({ ev: 'send', id: INPUT_ID, raw: {}, sf: 'hermes', text: 'first line\nsecond 😀' })
      expect(send).toBeTypeOf('function')
      send!()

      expect(app.queue).toEqual(['first line\nsecond 😀'])
      expect(app.composer.text).toBe('')
      expect(app.composer.cursor).toBe(0)
      app.composer.undo()
      expect(app.composer.text).toBe('')

      // Once idle, a following Enter must not submit the old draft again.
      app.busy = null
      app.changed()
      await new Promise<void>(resolve => setImmediate(resolve))
      const submit = surface.dispatch({ act: 'click', ev: 'action', id: 'dock.composer.bar.send', raw: {}, sf: 'hermes' })
      expect(submit).toBeTypeOf('function')
      submit!()
      expect(app.queue).toEqual(['first line\nsecond 😀'])
      expect(app.busy).toBeNull()
      app.composer.key(key('up'))
      expect(app.composer.text).toBe('first line\nsecond 😀')
    } finally {
      app.quit()
      await running
    }
  })
})
