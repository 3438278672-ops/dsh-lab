// 灵感账本 · DSH 网页半边
//   - 侧栏加一个「灵感账本」入口
//   - 点开在对话区显示灵感墙（/idea-log/，Host 那边由 lib/web.mjs 提供）
//   - 灵感墙里点「开工」，这里开一个新对话并把任务预填进输入框
// 页面是午夜墨风格的单页，直接铺满主区域；数据走 /idea-log/api/*。
//
// 协议常量与 lib/start.mjs 的 START 一致（那份是 Host 侧的权威定义，
// tests/start.test.mjs 会守住两边不漂）。
window.__ModuleLoader__.load({
  id: 'dsh-idea-log',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const PANEL = 'idea-log'
    const SRC = '/idea-log/'
    const LABEL = '灵感账本'

    const START_REQUEST = 'dsh-idea-log:start'
    const START_STARTED = 'dsh-idea-log:started'
    const START_FAILED = 'dsh-idea-log:start-failed'
    const PROMPT_MAX = 12000

    // 侧栏图标：一张钉在墙上的便签，角上折一下。
    // 有孵化对话跑完一轮时，右上角点一个小圆点（每 20 秒问一次 Host）。
    function IdeaIcon(props) {
      const s = (props && props.size) || 18
      const [pending, setPending] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const r = await fetch('/idea-log/api/awaiting', { cache: 'no-store', credentials: 'same-origin' })
            if (!r.ok) return
            const j = await r.json()
            if (alive) setPending(Number(j && j.count) || 0)
          } catch {}
        }
        load()
        const timer = setInterval(load, 20000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      return h(
        'span',
        {
          style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
          title: pending > 0 ? pending + ' 条孵化完成，等你确认' : undefined,
        },
        h(
          'svg',
          {
            width: s,
            height: s,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('path', { d: 'M5 3.6h9.4L20 9.2v11.2H5z' }),
          h('path', { d: 'M14.4 3.6v5.6H20' }),
          h('path', { d: 'M8.2 12.4h6.4' }),
          h('path', { d: 'M8.2 16.2h4.2' }),
        ),
        pending > 0
          ? h('span', {
              'aria-hidden': true,
              style: {
                position: 'absolute',
                top: -1,
                right: -1,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#d4a04a',
                boxShadow: '0 0 0 2px #161311',
              },
            })
          : null,
      )
    }

    function apply(ctx) {
      // 灵感墙是 iframe（同源）：页面点「开工」→ postMessage 到这里 →
      // ctx.uiWorkspace.startSession 打开空白对话并把任务填进输入框。
      // 不自动发送：先让人看一眼、改两个字再回车。
      function IdeaPanel() {
        const ref = React.useRef(null)

        React.useEffect(() => {
          const frameWindow = () => (ref.current ? ref.current.contentWindow : null)
          const reply = (msg) => {
            const win = frameWindow()
            if (!win) return
            try {
              win.postMessage(msg, window.location.origin)
            } catch {}
          }

          const onMessage = (e) => {
            if (e.origin !== window.location.origin) return
            const win = frameWindow()
            if (!win || e.source !== win) return
            const data = e.data || {}
            if (data.type !== START_REQUEST) return

            const id = Number(data.id)
            const prompt = typeof data.prompt === 'string' ? data.prompt.trim().slice(0, PROMPT_MAX) : ''
            if (!Number.isFinite(id) || !prompt) {
              reply({ type: START_FAILED, id: data.id, error: '开工请求不完整' })
              return
            }

            const uiWorkspace = (typeof ctx.get === 'function' && ctx.get('uiWorkspace')) || ctx.uiWorkspace
            if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
              reply({ type: START_FAILED, id, error: '当前界面打不开新对话（uiWorkspace 不可用）' })
              return
            }

            try {
              uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'replace' })
              reply({ type: START_STARTED, id })
            } catch (err) {
              reply({ type: START_FAILED, id, error: (err && err.message) || String(err) })
            }
          }

          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        }, [])

        return h('iframe', {
          ref,
          src: SRC,
          title: LABEL,
          allow: 'fullscreen',
          style: {
            width: '100%',
            height: '100%',
            border: 0,
            display: 'block',
            background: '#0e0d0c',
          },
        })
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 8, label: () => LABEL }, IdeaIcon),
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, IdeaPanel))
    }

    exports.isPlugin = true
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
