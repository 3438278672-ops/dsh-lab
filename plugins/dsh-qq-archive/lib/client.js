// 群聊档案馆 · DSH 网页半边
//   - 侧栏加一个「群聊档案馆」入口
//   - 点开在对话区显示看板（/qq-archive/，Host 那边由 lib/web.mjs 提供）
// 看板本身是午夜墨风格的单文件 HTML，和 DSH 的暗色主题一致，直接铺满主区域。
window.__ModuleLoader__.load({
  id: 'dsh-qq-archive',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const PANEL = 'qq-archive'
    const SRC = '/qq-archive/'
    const LABEL = '群聊档案馆'

    // 侧栏图标：一只档案盒，盖子上贴着标签
    function ArchiveIcon(props) {
      const s = (props && props.size) || 18
      return h(
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
        h('rect', { x: 3.4, y: 6.4, width: 17.2, height: 13.2, rx: 1.6 }),
        h('path', { d: 'M3.4 10.6h17.2' }),
        h('path', { d: 'M7.2 14.4h5.2' }),
        h('path', { d: 'M7.2 17.1h3.1' }),
        h('path', { d: 'M9.6 6.4V4.4h4.8v2' }),
      )
    }

    function ArchivePanel() {
      return h('iframe', {
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

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 7, label: () => LABEL }, ArchiveIcon),
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, ArchivePanel))
    }

    exports.isPlugin = true
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
