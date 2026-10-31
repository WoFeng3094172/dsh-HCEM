/* HCEM client：插件详情页（插件 → HCEM）下的「HCEM 设置」面板 */
try {
  const probe = new Image()
  probe.src = 'http://127.0.0.1:8082/api/probe?stage=hcem-client&t=' + Date.now()
} catch (e) {}
window.__ModuleLoader__.load({
  id: 'hcem',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // 侧栏底部：情绪悬浮窗呼出按钮（只显示小方块，排在回收站上面）
    function EmotionButton() {
      return h('button', {
        type: 'button',
        title: '打开 HCEM 情绪悬浮窗',
        onClick: () => {
          fetch('http://127.0.0.1:8082/api/launch-window', { method: 'POST' }).catch(() => {})
        },
        style: {
          appearance: 'none',
          border: 0,
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
      },
        h('span', {
          style: {
            width: 22,
            height: 22,
            borderRadius: 7,
            background: 'linear-gradient(135deg,#5b8cff,#9b6bff)',
            display: 'block',
            boxShadow: '0 1px 4px rgba(91,140,255,0.45)',
          },
        }),
      )
    }

    function SettingsPanel(props) {
      const subject = props && props.subject
      const pkg = subject && subject.pkg
      const name = pkg && pkg.name
      const [open, setOpen] = React.useState(true)
      if (!subject || subject.kind !== 'bundle' || name !== 'hcem') return null
      return h('div', {
        style: {
          marginTop: 12,
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.03)',
        },
      },
        h('div', {
          onClick: () => setOpen((v) => !v),
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            cursor: 'pointer',
            fontSize: 13,
            userSelect: 'none',
          },
        },
          h('span', null, 'HCEM 设置'),
          h('span', { style: { opacity: 0.6, fontSize: 12 } }, open ? '收起 ▾' : '展开 ▸'),
        ),
        open
          ? h('iframe', {
              src: 'http://127.0.0.1:8082/',
              title: 'HCEM 设置',
              style: { width: '100%', height: 720, border: 0, display: 'block', background: '#14161a' },
            })
          : null,
      )
    }

    return {
      name: 'hcem',
      inject: ['slots'],
      apply(ctx) {
        // 侧栏底部：情绪按钮（order 590 < 回收站 600，排在它上面）
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'hcem.emotion', order: 590 },
            EmotionButton,
          ),
        )
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            { name: 'plugins.detail.section', id: 'hcem.settings', order: 100 },
            SettingsPanel,
          ),
        )
      },
    }
  },
})