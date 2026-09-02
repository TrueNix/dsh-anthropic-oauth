// dsh-anthropic-oauth — Client half (web).
//
// A non-invasive, theme-aware quota panel that docks in the composer's ambient
// readout slot (`conversation.composer.dock`). It reads the Host's
// /api/anthropic-oauth/quota endpoint and shows 5h/7d usage bars with a live
// reset countdown and a manual Check-quota button. It touches no shell chrome:
// it is purely additive to the Slot and removed cleanly on stop.
//
// Authored in the DSH client-bundle format (window.__ModuleLoader__.load with a
// require-factory). DSH serves this file verbatim; no bundler step is required.
window.__ModuleLoader__.load({
  id: 'dsh-anthropic-oauth',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const e = React.createElement

    const name = 'anthropic-oauth-quota'
    // Hard deps only. `modelDirectories` (from ui-model-selection) is read
    // OPTIONALLY via ctx.get so a missing model-selection plugin never blocks
    // or crashes this half — it just disables the provider gate.
    const inject = ['slots', 'timer']
    const ANTHROPIC_PROVIDER = 'anthropic'

    // ── Scoped, theme-tokened styles (deduped like shipped CSS modules) ──
    const CSS_ID = 'dsh-anthropic-oauth/quota'
    const CSS = `
.aoq-dock{box-sizing:border-box;width:100%;margin:0 auto;padding:0}
.aoq-panel{display:flex;align-items:center;gap:12px;padding:6px 12px;
  font:var(--dsw-font-xs-13, 13px/1.4 Inter, system-ui);
  color:var(--dsw-alias-label-primary, #e6e7ec);
  background:var(--dsw-specific-tip, transparent);
  border:1px solid var(--dsw-alias-border-l1, #34343c);
  border-radius:12px 12px 0 0;border-bottom:none;position:relative}
.aoq-bars{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}
.aoq-row{display:flex;align-items:center;gap:8px}
.aoq-lab{width:22px;flex:none;color:var(--dsw-alias-label-tertiary, #9a9ca6);
  font-variant-numeric:tabular-nums;font-size:11px}
.aoq-track{position:relative;flex:1;height:6px;border-radius:999px;
  background:var(--dsw-alias-bg-base, #2c2c32);overflow:hidden}
.aoq-fill{position:absolute;inset:0 auto 0 0;height:100%;border-radius:999px;
  background:var(--dsw-alias-state-business-primary, #6ab0f3);transition:width .4s ease}
.aoq-fill.aoq-warn{background:var(--dsw-alias-state-warning, #e0a13a)}
.aoq-fill.aoq-hot{background:var(--dsw-alias-state-danger, #e05a5a)}
.aoq-pct{width:34px;flex:none;text-align:right;color:var(--dsw-alias-label-secondary, #b7b9c2);
  font-variant-numeric:tabular-nums;font-size:11px}
.aoq-reset{white-space:nowrap;color:var(--dsw-alias-label-tertiary, #a9abb5);
  font-variant-numeric:tabular-nums;font-size:12px}
.aoq-btn{flex:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2, #3a3a42);
  background:var(--dsw-alias-bg-base, transparent);color:var(--dsw-alias-label-secondary, inherit);
  border-radius:8px;padding:3px 10px;font:inherit;font-size:12px;line-height:18px}
.aoq-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, #26262c)}
.aoq-btn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary, #7a7c86);outline-offset:-2px}
.aoq-btn:disabled{opacity:.5;cursor:default}
.aoq-err{color:var(--dsw-alias-state-danger, #e05a5a);font-size:12px}
.aoq-tier{color:var(--dsw-alias-label-tertiary, #8b8d98);font-size:11px;white-space:nowrap}`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      const sel = 'style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']'
      if (document.querySelector(sel) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-anthropic-oauth'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── Presentational bits ──────────────────────────────────────────────
    function Bar(props) {
      const util = props.util
      const pct = util == null ? 0 : Math.max(0, Math.min(100, Math.round(util * 100)))
      const cls = pct >= 90 ? ' aoq-hot' : pct >= 70 ? ' aoq-warn' : ''
      return e('div', { className: 'aoq-row' },
        e('span', { className: 'aoq-lab' }, props.label),
        e('div', { className: 'aoq-track' }, e('div', { className: 'aoq-fill' + cls, style: { width: pct + '%' } })),
        e('span', { className: 'aoq-pct' }, util == null ? '—' : pct + '%'),
      )
    }

    function fmtReset(ts) {
      if (!ts) return 'resets —'
      let d = ts - Math.floor(Date.now() / 1000)
      if (d < 0) d = 0
      const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), s = d % 60
      return 'resets in ' + (h > 0 ? (h + 'h ' + m + 'm') : m > 0 ? (m + 'm ' + s + 's') : (s + 's'))
    }
    function primaryReset(d) {
      return (d.representative === 'seven_day' ? (d.sevenDay && d.sevenDay.reset) : (d.fiveHour && d.fiveHour.reset)) || d.reset
    }

    // ── Live per-session provider gate ───────────────────────────────────
    // Returns true only when the session's currently selected model routes
    // through the Anthropic provider. Reads + subscribes to the shared model
    // directory store (the same state the /model picker drives), so switching
    // models hides/shows the panel immediately. Fails safe to `false` (hidden)
    // when the service or selection is unavailable.
    function useAnthropicActive(modelDirectories, sessionId) {
      // If the model-selection service is absent we cannot gate — show the
      // panel rather than hide it forever (missing gate ≠ non-Anthropic).
      const gateAvailable = !!(modelDirectories && sessionId)

      const read = React.useCallback(() => {
        if (!gateAvailable) return true
        try {
          const dir = modelDirectories.directoryFor(sessionId)
          const cur = dir && dir.store && dir.store.getSnapshot().current
          // Selection not yet loaded (current === null): show; a provider that
          // is present and non-anthropic: hide.
          if (!cur) return true
          return cur.provider === ANTHROPIC_PROVIDER
        } catch (_) { return true }
      }, [gateAvailable, modelDirectories, sessionId])

      const [active, setActive] = React.useState(read)
      React.useEffect(() => {
        setActive(read())
        if (!gateAvailable) return undefined
        let stop = null
        try {
          const dir = modelDirectories.directoryFor(sessionId)
          if (dir && dir.store && typeof dir.store.subscribe === 'function') {
            stop = dir.store.subscribe(() => setActive(read()))
          }
        } catch (_) { /* leave visible */ }
        return () => { if (typeof stop === 'function') stop() }
      }, [read, gateAvailable, modelDirectories, sessionId])
      return active
    }

    // ── The dock panel component ─────────────────────────────────────────
    function makePanel(timer, modelDirectories) {
      return function QuotaPanel(props) {
        const sessionId = props && props.sessionId
        const anthropicActive = useAnthropicActive(modelDirectories, sessionId)
        const [data, setData] = React.useState(null)
        const [loading, setLoading] = React.useState(false)
        const [, tickNow] = React.useState(0)

        const load = React.useCallback((force) => {
          setLoading(true)
          fetch('/api/anthropic-oauth/quota' + (force ? '?force=1' : ''), { cache: 'no-store' })
            .then((r) => r.json())
            .then((d) => setData(d))
            .catch((err) => setData({ ok: false, error: String((err && err.message) || err) }))
            .finally(() => setLoading(false))
        }, [])

        const completedTurns = props && props.session && props.session.turnEnds ? props.session.turnEnds.size : 0
        const completion = React.useRef({ sessionId, turns: completedTurns })

        React.useEffect(() => {
          const completed = completion.current.sessionId === sessionId && completedTurns > completion.current.turns
          completion.current = { sessionId, turns: completedTurns }
          if (anthropicActive && completed) load(true)
        }, [anthropicActive, completedTurns, load, sessionId])

        React.useEffect(() => {
          // Only probe/poll while the Anthropic provider is the active model.
          if (!anthropicActive) return undefined
          load(false)
          const disposeRefresh = timer.interval(() => load(false), 60000)
          const disposeTick = timer.interval(() => tickNow((n) => n + 1), 1000)
          return () => { disposeRefresh(); disposeTick() }
        }, [load, anthropicActive])

        // Non-invasive: render nothing for non-Anthropic models. All hooks above
        // have already run, so hook order stays stable across this early return.
        if (!anthropicActive) return null

        const btn = e('button', {
          className: 'aoq-btn', disabled: loading,
          onClick: () => load(true), title: 'Force a fresh quota probe',
        }, loading ? '…' : 'Check quota')

        let inner
        if (!data) {
          inner = e('span', { className: 'aoq-tier' }, 'Quota: loading…')
        } else if (!data.ok) {
          inner = e('span', { className: 'aoq-err' }, 'Quota: ' + (data.error || 'unavailable'))
        } else {
          const tier = [data.sub, data.tier].filter(Boolean).join(' · ')
          inner = e(React.Fragment, null,
            e('div', { className: 'aoq-bars' },
              e(Bar, { label: '5h', util: data.fiveHour && data.fiveHour.utilization }),
              e(Bar, { label: '7d', util: data.sevenDay && data.sevenDay.utilization }),
            ),
            e('span', { className: 'aoq-reset' }, fmtReset(primaryReset(data))),
            tier ? e('span', { className: 'aoq-tier' }, tier) : null,
          )
        }

        return e('div', { className: 'aoq-dock' },
          e('div', { className: 'aoq-panel' }, inner, btn))
      }
    }

    function apply(ctx) {
      ensureStyles()
      const Panel = makePanel(ctx.timer, ctx.get ? ctx.get('modelDirectories') : ctx.modelDirectories)
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'anthropic-quota', order: 40 },
        Panel,
      ))
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
