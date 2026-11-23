/* HCEM client：侧栏情绪按钮 + 输入框语音通话（五条电平表）
 *
 * 通话 UI 抄自 voice-call 的 client-ui-voice-conversation：
 *   · 挂在 conversation.input.activity（输入框工具栏，模型选择器右边那个位置）
 *   · 五条竖条由 --voice-level 驱动，阶段用 data-phase 切动画
 *   · 只在通话中展开（onActiveChange 让宿主把工具栏宽度让出来）
 *
 * 和 voice-call 的差别：它走 Typert RPC 跟 Host 通信，HCEM 直接打自己插件的
 * 本地端点 127.0.0.1:8097/call（那个服务已经开了 CORS）。少一层，够用。
 */
try {
  const probe = new Image()
  probe.src = 'http://127.0.0.1:8082/api/probe?stage=hcem-client&t=' + Date.now()
} catch (e) {}
window.__ModuleLoader__.load({
  id: 'hcem',
  factory: (require) => {
    const React = require('react')
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch (e) {}
    const h = React.createElement
    const { useEffect, useState, useRef } = React

    const VOICE_URL = 'http://127.0.0.1:8097/call'
    const BUBBLE_URL = 'http://127.0.0.1:8097/bubble'
    const TALK_LABEL = ['话痨', '好奇', '安静']

    const PHASE_TEXT = {
      connecting: '连接中',
      listening: '在听',
      recognizing: '识别中',
      thinking: '在想',
      speaking: '在说',
      stopping: '结束中',
      paused: '暂停',
      error: '出错了',
    }

    /** 打插件端点。失败安静返回 null，不打扰界面。 */
    async function callApi(action, sessionId) {
      try {
        const res = await fetch(VOICE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sessionId ? { action, sessionId } : { action }),
        })
        if (!res.ok) return null
        return await res.json()
      } catch (_e) {
        return null
      }
    }

    /** 电话听筒图标（挂断时旋转135°），和 voice-call 的 PhoneIcon 一致 */
    function PhoneIcon({ hangup = false }) {
      return h(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: hangup ? { transform: 'rotate(135deg)' } : undefined,
        },
        h('path', {
          d: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z',
        }),
      )
    }

    /* 样式抄 voice-call 的 VoiceConversation.module.css，适配成内联一份。
       用 React 渲染 <style>，组件卸载时自动移除。 */
    const STYLE_ID = 'hcem-voice-call-style'
    const CSS = `
.hcem-call-row { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.hcem-call-row button { appearance: none; border: 0; background: transparent; padding: 4px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #777); }
.hcem-call-row button:hover { background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.12)); }
.hcem-call-row .hcem-call-error { color: var(--dsw-alias-state-error-primary, #d33); font-size: 12px; }

.hcem-call { --voice-level: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 14px; width: 100%; min-height: 200px; padding: 20px 16px; }
.hcem-call .hcem-bars { display: flex; align-items: center; justify-content: center; gap: 6px;
  height: 92px; color: var(--dsw-alias-label-primary, #333); }
.hcem-call .hcem-bars span { --amplitude: 30px; display: block; width: 5px;
  height: calc(3px + var(--voice-level) * var(--amplitude)); border-radius: 4px;
  background: currentColor; opacity: .9; transition: height 60ms linear; }
.hcem-call .hcem-bars span:nth-child(2), .hcem-call .hcem-bars span:nth-child(4) { --amplitude: 56px; }
.hcem-call .hcem-bars span:nth-child(3) { --amplitude: 84px; }
.hcem-call[data-phase='thinking'] .hcem-bars span,
.hcem-call[data-phase='recognizing'] .hcem-bars span { height: 5px; animation: hcem-voice-wait 1.6s ease-in-out infinite; }
.hcem-call[data-phase='speaking'] .hcem-bars span {
  height: calc(16px + var(--amplitude) * .6); animation: hcem-voice-answer .9s ease-in-out infinite alternate; }
.hcem-call .hcem-bars span:nth-child(2) { animation-delay: -1.1s; }
.hcem-call .hcem-bars span:nth-child(3) { animation-delay: -.7s; }
.hcem-call .hcem-bars span:nth-child(4) { animation-delay: -.3s; }
.hcem-call .hcem-bars span:nth-child(5) { animation-delay: -.9s; }
.hcem-call[data-phase='paused'] .hcem-bars span,
.hcem-call[data-phase='stopping'] .hcem-bars span { height: 8px; opacity: .3; animation: none; }
.hcem-call .hcem-call-status { color: var(--dsw-alias-label-secondary, #777); font-size: 12px; }
.hcem-call .hcem-call-hangup { gap: 8px; border-radius: 24px;
  color: var(--dsw-alias-state-error-primary, #d33); }
@keyframes hcem-voice-wait { 50% { opacity: .3; } }
@keyframes hcem-voice-answer { to { height: 8px; } }
@media (prefers-reduced-motion: reduce) { .hcem-call .hcem-bars span { animation: none; transition: none; height: 8px; } }
`

    function StyleOnce() {
      return h('style', { id: STYLE_ID, dangerouslySetInnerHTML: { __html: CSS } })
    }

    /** 输入框工具栏里的通话控件：空闲是电话图标，通话中展开成电平表 + 挂断 */
    function VoiceCallActivity({ sessionId, onActiveChange }) {
      // hcem: null=还不知道（先不显示），true/false=插件说这个会话是不是 HCEM
      const [state, setState] = useState({ phase: 'idle', hcem: null, level: 0 })
      const panel = useRef(null)
      const levelTarget = useRef(0)   // 插件给的目标电平
      const levelShown = useRef(0)    // 正在显示的平滑电平
      const rafRef = useRef(0)

      // 250ms 一次：800ms 太粗，声波跟不上说话节奏。
      // 一次请求就是本机回环，开销可以忽略。
      useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          const r = await callApi('status', sessionId)
          if (!alive) return
          if (r && r.ok) {
            const phase = r.active ? (r.phase || (r.speaking ? 'speaking' : 'listening')) : 'idle'
            const lv = Number(r.level)
            levelTarget.current = Number.isFinite(lv) ? Math.max(0, Math.min(1, lv)) : 0
            setState({ phase, hcem: r.isHcem, level: levelTarget.current })
          }
          timer = setTimeout(tick, 250)
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [sessionId])

      // 电平平滑：250ms 一个采样点直接渲染会一格一格跳，
      // 这里用 rAF 向目标缓动。上升跟得快、下降慢慢落，看起来才有"跟着说话"的弹性。
      useEffect(() => {
        const step = () => {
          const target = levelTarget.current
          const now = levelShown.current
          const k = target > now ? 0.62 : 0.26
          const next = now + (target - now) * k
          levelShown.current = Math.abs(target - next) < 0.004 ? target : next
          if (panel.current) {
            panel.current.style.setProperty('--voice-level', String(levelShown.current.toFixed(3)))
          }
          rafRef.current = requestAnimationFrame(step)
        }
        rafRef.current = requestAnimationFrame(step)
        return () => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current)
        }
      }, [])

      const active = state.phase !== 'idle' && state.phase !== 'error'

      // 展开时要让宿主把工具栏宽度让出来；卸载必须收回
      useEffect(() => {
        onActiveChange(active)
        return () => {
          onActiveChange(false)
        }
      }, [active, onActiveChange])

      // 非 HCEM 会话：语音不往那儿送，就别显示按钮
      if (state.hcem === false && !active) return null

      if (state.phase === 'idle') {
        return h(React.Fragment, null,
          h(StyleOnce, null),
          h('div', { className: 'hcem-call-row' },
            h('button', {
              type: 'button',
              title: '开始语音通话',
              'aria-label': '开始语音通话',
              onClick: async () => {
                const r = await callApi('start', sessionId)
                if (r && r.ok) setState({ phase: 'listening', hcem: true, level: 0 })
              },
            }, h(PhoneIcon, null)),
          ),
        )
      }

      return h(React.Fragment, null,
        h(StyleOnce, null),
        h('div', {
          ref: panel,
          className: 'hcem-call',
          'data-phase': state.phase,
        },
          h('div', { className: 'hcem-bars', 'aria-hidden': 'true' },
            h('span', null), h('span', null), h('span', null), h('span', null), h('span', null),
          ),
          h('span', { className: 'hcem-call-status', role: 'status' },
            PHASE_TEXT[state.phase] || state.phase),
          h('button', {
            type: 'button',
            className: 'hcem-call-hangup',
            'aria-label': '挂断',
            onClick: async () => {
              await callApi('stop', sessionId)
              levelTarget.current = 0
              setState({ phase: 'idle', hcem: true, level: 0 })
            },
          }, h(PhoneIcon, { hangup: true }), h('span', null, '挂断')),
        ),
      )
    }

    /* ── 主动说话（冒泡）：状态栏三档开关 ─────────────────────────────
     * 位置和参考插件 proactive-bubble 一样，挂在 conversation.composer.dock。
     * 档位（0 话痨 / 1 好奇 / 2 安静）写回插件的 settings.json，
     * 和 HCEM.exe 菜单「角色卡」页的搭话度是同一个字段，两边靠这条路由同步。
     */
    const BUBBLE_CSS = `
.hcem-bubble { display: inline-flex; align-items: center; gap: 6px; }
.hcem-bubble > button { appearance: none; border: 0; background: transparent; padding: 0;
  font: inherit; font-size: 12.5px; line-height: 1; cursor: pointer; letter-spacing: normal; }
.hcem-bubble > button:hover { opacity: .85; }
.hcem-bubble-menu { position: fixed; z-index: 99999; min-width: 92px; padding: 5px;
  border-radius: 8px; border: 1px solid rgba(255,255,255,.12);
  background: rgba(28,26,22,.98); box-shadow: 0 6px 24px rgba(0,0,0,.45); font-size: 12.5px; }
.hcem-bubble-menu .it { padding: 5px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
.hcem-bubble-menu .it:hover { background: rgba(255,255,255,.08); }
`

    function BubbleToggle({ sessionId }) {
      const [talk, setTalk] = useState(1)
      const [isHcem, setIsHcem] = useState(null)
      const [open, setOpen] = useState(false)
      const [pos, setPos] = useState({ x: 0, y: 0 })
      const btnRef = useRef(null)

      // 聚焦上报：只有「DSH 被最小化 / 收进托盘」才算后台。
      // 不用 document.hasFocus()——那要求 DSH 是当前活动窗口，
      // 用户看着悬浮球或别的窗口时会被误判成后台（实测因此 12 分钟不冒泡）。
      useEffect(() => {
        const report = () => {
          const on = document.visibilityState === 'visible'
          try {
            fetch(BUBBLE_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, focused: on }),
            }).catch(() => {})
          } catch (e) {}
        }
        report()
        window.addEventListener('focus', report)
        window.addEventListener('blur', report)
        document.addEventListener('visibilitychange', report)
        return () => {
          window.removeEventListener('focus', report)
          window.removeEventListener('blur', report)
          document.removeEventListener('visibilitychange', report)
        }
      }, [sessionId])

      // 2 秒轮询：拿当前档位 + 是否 HCEM 会话（exe 菜单改了这边也能跟上）
      useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const res = await fetch(BUBBLE_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
            const r = res.ok ? await res.json() : null
            if (alive && r && r.ok) {
              setTalk(Number(r.talk) || 0)
              setIsHcem(r.isHcem)
            }
          } catch (e) {}
          if (alive) timer = setTimeout(tick, 2000)
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [sessionId])

      const pick = (t) => {
        setTalk(t)
        setOpen(false)
        try {
          fetch(BUBBLE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, talk: t }),
          }).catch(() => {})
        } catch (e) {}
      }

      // 非 HCEM 会话不显示（和「开始语音通话」按钮一致）
      if (isHcem === false) return null
      if (!sessionId) return null

      const label = TALK_LABEL[talk] || '好奇'
      const color = talk === 2 ? 'rgba(255,255,255,.45)' : talk === 0 ? 'rgba(232,196,106,.95)' : 'rgba(255,255,255,.72)'

      const menu = !open ? null : (() => {
        const items = h('div', { className: 'hcem-bubble-menu', style: { left: pos.x + 'px', top: pos.y + 'px' } },
          TALK_LABEL.map((name, t) =>
            h('div', {
              key: t,
              className: 'it',
              style: { color: t === talk ? '#e8c46a' : 'inherit' },
              onClick: (e) => {
                e.stopPropagation()
                pick(t)
              },
            }, name)),
        )
        // 宿主 composer 有裁剪，能 portal 就 portal
        if (ReactDOM && ReactDOM.createPortal) return ReactDOM.createPortal(items, document.body)
        return items
      })()

      return h(React.Fragment, null,
        h('style', null, BUBBLE_CSS),
        h('span', { className: 'hcem-bubble' },
          h('button', {
            ref: btnRef,
            type: 'button',
            style: { color },
            title: '主动搭话档位（和 HCEM 菜单「角色卡」里的搭话度是同一个）',
            onClick: () => {
              const r = btnRef.current && btnRef.current.getBoundingClientRect()
              if (r) setPos({ x: Math.max(8, r.left), y: Math.max(8, r.top - 8 - 3 * 28 - 12) })
              setOpen((v) => !v)
            },
          }, label),
        ),
        menu,
      )
    }

    return {
      name: 'hcem',
      inject: ['slots'],
      apply(ctx) {        // 输入框工具栏：语音通话（五条电平表 + 挂断）
        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            { name: 'conversation.input.activity', id: 'hcem.voicecall' },
            VoiceCallActivity,
          ),
        )
        // 状态栏：主动说话三档开关（和参考插件 proactive-bubble 同位置）
        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'hcem.bubble', order: 60 },
              (props) => h(BubbleToggle, { sessionId: (props && props.sessionId) || null }),
            ),
          )
        } catch (e) {
          try {
            console.warn('[hcem] bubble slot 注册失败', e)
          } catch (_e) {}
        }
        // 侧栏底部的情绪按钮（蓝紫方块）是老版悬浮窗的入口，已废弃，不再注册
      },
    }
  },
})
