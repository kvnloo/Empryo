import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'

import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import { Session, type Surface, View } from '@stencil-hq/tern'
import { GatewayClient } from '@tui/gatewayClient.js'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { App } from '../app.js'

const isolated = await vi.hoisted(async () => {
  // History binds its home at module load, before the App constructor runs.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'hermes-overlay-ownership-'))
  const previous = process.env.HERMES_HOME
  process.env.HERMES_HOME = home

  return { home, previous }
})

const rendered = () => new Promise<void>(resolve => setImmediate(resolve))
const nativeViews = new WeakMap<Surface, View>()

function denyEvent(surface: Surface, id: string) {
  const key = `prompt:${id}`

  const root = nativeViews.get(surface)?.regions[2]?.children.find(node => {
    const nodeKey = node.props.key

    return typeof nodeKey === 'string' && (nodeKey === key || nodeKey.startsWith(`${key}:`))
  })

  if (!root) {
    throw new Error('The approval fixture did not render its native root')
  }

  return { act: 'click', ev: 'action', id: `${root.id}.body.actions.deny`, raw: {}, sf: 'hermes' } as const
}

function approval(id: string) {
  const replies: unknown[] = []

  const req: ServerRequest = {
    fail: () => { throw new Error('Unexpected request failure') },
    id,
    method: 'approval',
    params: { command: 'printf fixture', request_id: `approval-${id}`, session_id: 'session-1' },
    respond: value => { replies.push(value) }
  }

  return { replies, req }
}

function deny(surface: Surface, id: string) {
  const handler = surface.dispatch(denyEvent(surface, id))

  if (!handler) {
    throw new Error('The approval fixture did not install its deny action')
  }

  return handler
}

async function withApp(run: (app: App, gw: GatewayClient, surface: Surface) => Promise<void>) {
  const tern = new Session(new EventEmitter(), { write() {} }, { exitHooks: false, record: '' })
  const gw = new GatewayClient()
  const app = new App(tern, gw, 'test')
  app.sid = 'session-1'
  const running = app.run()
  const surface = tern.surfaces[0]!
  const render = surface.render.bind(surface)

  surface.render = view => {
    nativeViews.set(surface, View.from(view))
    render(view)
  }

  try {
    await run(app, gw, surface)
  } finally {
    app.quit()
    await running
  }
}

afterAll(() => {
  if (isolated.previous === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = isolated.previous
  }

  rmSync(isolated.home, { force: true, recursive: true })
})

describe('native overlay ownership', () => {
  it('does not answer a withdrawn approval from its retained native view', async () => {
    await withApp(async (app, gw, surface) => {
      const pending = approval('first')
      gw.emit('request', pending.req)
      await rendered()
      gw.emit('event', { payload: { request_ids: ['approval-first'] }, session_id: 'session-1', type: 'approval.cancelled' })

      // Tern can still dispatch from the last rendered view before the next render.
      await deny(surface, 'first')()
      expect(pending.replies).toEqual([])
      expect(app.overlays).toEqual([])
    })
  })

  it('rejects a queued callback after a same-key prompt replacement', async () => {
    await withApp(async (app, gw, surface) => {
      const old = approval('same')
      gw.emit('request', old.req)
      await rendered()
      const stale = deny(surface, 'same')
      const next = approval('same')
      gw.emit('request', next.req)
      await rendered()

      await stale()
      expect(old.replies).toEqual([])
      expect(next.replies).toEqual([])
      expect(app.overlays).toHaveLength(1)
      await deny(surface, 'same')()
      expect(next.replies).toEqual([{ choice: 'deny' }])
      expect(app.overlays).toEqual([])
    })
  })

  it('keeps a covered prompt pending until it owns the top layer again', async () => {
    await withApp(async (_app, gw, surface) => {
      const lower = approval('lower')
      gw.emit('request', lower.req)
      await rendered()
      const lowerAction = deny(surface, 'lower')
      const upper = approval('upper')
      gw.emit('request', upper.req)
      await rendered()

      await lowerAction()
      expect(lower.replies).toEqual([])
      await deny(surface, 'upper')()
      expect(upper.replies).toEqual([{ choice: 'deny' }])
      await lowerAction()
      expect(lower.replies).toEqual([{ choice: 'deny' }])
    })
  })

  it('rejects an old native id after a same-key replacement render', async () => {
    await withApp(async (_app, gw, surface) => {
      const old = approval('same')
      gw.emit('request', old.req)
      await rendered()
      const oldEvent = denyEvent(surface, 'same')
      const next = approval('same')
      gw.emit('request', next.req)
      await rendered()

      // Native input can arrive from the previous painted view while credits are blocked.
      await surface.dispatch(oldEvent)?.()
      expect(old.replies).toEqual([])
      expect(next.replies).toEqual([])
      await deny(surface, 'same')()
      expect(next.replies).toEqual([{ choice: 'deny' }])
    })
  })

  it('answers only once when two native callbacks were queued before close', async () => {
    await withApp(async (_app, gw, surface) => {
      const pending = approval('first')
      gw.emit('request', pending.req)
      await rendered()
      const first = deny(surface, 'first')
      const second = deny(surface, 'first')

      await first()
      await second()
      expect(pending.replies).toEqual([{ choice: 'deny' }])
    })
  })
})
