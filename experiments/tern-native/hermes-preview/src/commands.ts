// Slash commands this frontend runs through the live session: quitting,
// clearing, reasoning settings and native sheets (model, sessions, help).
// Everything else goes to the gateway's `slash.exec`.

import type { ConfigGetResult, ConfigSetResult } from '@hermes/shared/gateway-events'

import type { App } from './app.js'
import { openHelp } from './overlays/help.js'
import { openModelPicker, switchModel } from './overlays/models.js'
import { confirmOverlay } from './overlays/prompts.js'
import { openSessionPicker } from './overlays/sessions.js'

/** A client-side slash command. */
export interface LocalCommand {
  name: string
  aliases?: readonly string[]
  /**
   * Runs `/name arg`. Returning false hands the command to `slash.exec`
   * instead (a form this frontend leaves to the backend).
   */
  run(app: App, arg: string): boolean | void | Promise<boolean | void>
}

const COMMANDS: readonly LocalCommand[] = [
  {
    aliases: ['exit', 'q'],
    name: 'quit',
    run: app => app.quit()
  },
  {
    aliases: ['reset'],
    name: 'new',
    run: app => app.newSession()
  },
  {
    name: 'clear',
    run: app => {
      app.transcript.clear()
      app.transcript.push({ id: app.transcript.id('w'), kind: 'welcome' })
    }
  },
  {
    name: 'model',
    run: async (app, arg) => {
      if (!arg) {
        return openModelPicker(app)
      }

      const r = await switchModel(app, arg)

      if (r.confirm_required) {
        app.open(
          confirmOverlay(app, {
            confirm: 'Switch anyway',
            detail: r.confirm_message || r.warning || '',
            onConfirm: () => void switchModel(app, arg, true),
            title: 'Switch to an expensive model?'
          })
        )
      }
    }
  },
  {
    name: 'reasoning',
    run: async (app, arg) => {
      const sid = app.sid

      if (!sid) {
        return
      }

      if (!arg) {
        const r = await app.gw.request<ConfigGetResult>('config.get', { key: 'reasoning', session_id: sid })

        if (app.sid === sid && typeof r.value === 'string') {
          app.info = { ...app.info, reasoning_effort: r.value }
          app.transcript.panel('/reasoning', `Reasoning effort: ${r.value} (display: ${r.display ?? 'show'}).`)
        }

        return
      }

      let scope: 'global' | 'session' | undefined

      const value = arg
        .split(/\s+/)
        .filter(part => {
          const flag = part.toLowerCase()

          if (flag === '--global') {
            scope = 'global'

            return false
          }

          if (flag === '--session') {
            scope ??= 'session'

            return false
          }

          return true
        })
        .join(' ')

      const r = await app.gw.request<ConfigSetResult>('config.set', {
        key: 'reasoning',
        session_id: sid,
        value,
        ...(scope ? { scope } : {})
      })

      if (app.sid !== sid) {
        return
      }

      // A lazy session has no agent yet, so config.set cannot emit session.info.
      const current = await app.gw.request<ConfigGetResult>('config.get', { key: 'reasoning', session_id: sid })

      if (app.sid === sid && typeof current.value === 'string') {
        app.info = { ...app.info, reasoning_effort: current.value }
      }

      if (app.sid === sid && typeof r.value === 'string') {
        app.transcript.panel(`/reasoning ${arg}`, `Reasoning: ${r.value}.`)
      }
    }
  },
  {
    aliases: ['resume', 'session', 'switch'],
    name: 'sessions',
    run: (app, arg) => {
      if (!arg) {
        return openSessionPicker(app)
      }

      return arg === 'new' ? app.newSession() : app.resume(arg)
    }
  },
  {
    // `/help <command>` is the backend's detailed usage.
    name: 'help',
    run: (app, arg) => (arg ? false : openHelp(app))
  }
]

/** The client-side command `name` (without the slash) answers to, if any. */
export function localCommand(name: string): LocalCommand | undefined {
  return COMMANDS.find(c => c.name === name || c.aliases?.includes(name))
}
