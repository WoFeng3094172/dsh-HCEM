// 捕获管理器（视觉优化 S1）：多屏监视 + 帧级漏斗（动态 fps + 段内 top-K）+ 小模型描述
// 流程：
//   启动时检测屏幕数量
//   每 intervalMs 对每块屏幕截图（缩放 1280）
//   → 帧差 → FrameFunnel（10s 段窗口，高/中/低变化段不同 fps）
//   → 段边界 flush：段内 top-K 帧送 Qwen2.5-VL 描述（不再「每变化帧都描述」）
//   → 连续 settleFrames 无变化：标记「恢复常态」
// enableFunnel=false 时回退旧逻辑（变化即描述）
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureScreen, listScreens } from './screen.mjs'
import { AudioCapture } from './audio.mjs'
import { frameDiff } from '../perception/frame-diff.mjs'
import { getForegroundWindow, isVideoWindow, listVideoWindows, windowsOnScreen } from './window.mjs'
import { FrameFunnel } from '../perception/frame-funnel.mjs'
import { fpsFromEmotion } from '../perception/emotion-fps.mjs'
import { describeWithScore } from '../perception/vision.mjs'
import { getGpuQueue, PRIORITY } from '../perception/gpu-queue.mjs'
import { createMousePatrol } from './mouse-watch.mjs'
import { analyzeBrightness, classifyScreen } from '../perception/router.mjs'
import { detectFaceEmotion } from '../perception/face-emotion.mjs'
import { aHash, hammingDistance } from '../perception/compress.mjs'

export function createCaptureManager({
  dataDir,
  modelsDir,
  intervalMs: intervalMsInit = 1000, // 1fps 采样上限（可由 setIntervalMs 动态调整）
  keep = 20,
  logger = console,
  onChange = null,
  threshold = 0.03,
  settleFrames = 3,
  enableVision = true,
  enableFunnel = true,
  getEmotion = null, // 返回 { H, S, L }；用于情绪挂钩抽帧
  cloudBoard = null, // 云端兜底（低预算）：本地连续失败时才启用
  enableMousePatrol = true, // 鼠标巡逻：快速划鼠标 3 秒 → 看一眼那块区域（带冷却）
  shouldFocusVideo = null, // 看视频时只截视频所在屏（() => boolean）
} = {}) {
  const QUIET_POLL_MS = 30 * 1000
  let intervalMs = intervalMsInit
  let timer = null
  let captures = 0
  let lastError = null
  let screens = []
  let lastDescription = null
  const states = new Map()
  const audio = new AudioCapture()
  let patrol = null // 鼠标巡逻器
  const dir = join(dataDir, 'captures')

  function stateOf(index) {
    if (!states.has(index)) {
      states.set(index, {
        lastShot: null,
        lastDiff: 0,
        quiet: 0,
        quietTicks: 0,
        nextCaptureAt: 0,
        lastHash: null,
        lastDesktopKey: '',
        lastDesktopAt: 0,
        recentFrames: [],
        recentDescriptions: [],
        groupStart: null,
        groupShots: 0,
        lastGroupEmotion: 0,
        funnel: enableFunnel
          ? new FrameFunnel({
              // 情绪系数：S 越高越专注、γ 越高越清醒 → 多抽；L 低（疲惫）→ 少抽
              baseFps: () => {
                try {
                  const e = getEmotion ? getEmotion() : null
                  if (!e) return 0.6
                  return fpsFromEmotion({ L: e.L, gamma: e.gamma })
                } catch {
                  return 0.6
                }
              },
            })
          : null,
        framePaths: new Map(), // ts -> path
      })
    }
    return states.get(index)
  }

  let fgCache = { at: 0, val: null }
  function foregroundCached() {
    if (Date.now() - fgCache.at < 2000) return fgCache.val
    const v = getForegroundWindow()
    fgCache = { at: Date.now(), val: v }
    return v
  }

  function prune() {
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
      const limit = keep * Math.max(1, screens.length)
      while (files.length > limit) {
        const old = files.shift()
        try {
          unlinkSync(join(dir, old.f))
        } catch {}
      }
    } catch {}
  }

  /** L → 分辨率缩放系数：L=0→0.8，L=50→1.0，L=100→1.2 */
  function getLScale() {
    try {
      const e = getEmotion ? getEmotion() : null
      const l = Number(e && e.L != null ? e.L : 55)
      return 1 + ((Math.max(0, Math.min(100, l)) - 50) / 100) * 0.4
    } catch {
      return 1
    }
  }

  async function describeFrame(shot, screen) {
    if (!enableVision || !modelsDir) return null
    try {
      // 唯一视觉模型：Qwen2.5-VL-3B（8091）。
      // isVideo 仍要检测：它不是用来选模型，而是随结果传给上层（判断是不是在放视频）。
      let isVideo = false
      try {
        // 只要这块屏上有视频窗口就算视频（不要求前台：用户可能一边看一边聊天）
        isVideo = listVideoWindows().some((w) => {
          const cx = w.left + w.width / 2
          const cy = w.top + w.height / 2
          return cx >= screen.x && cx < screen.x + screen.width && cy >= screen.y && cy < screen.y + screen.height
        })
      } catch {}

      let r
      try {
        const ds = await getGpuQueue().run(
          () => describeWithScore(shot, {
            prompt:
              '用一到两句中文描述这个画面：正在用什么软件、画面主体是什么。' +
              '如果画面里有文字、字幕、歌词、聊天或界面文字，逐字抄录最关键的 1-4 行，不要总结，不要反问用户。',
          }),
          { priority: PRIORITY.visionFine, label: 'vision-fine' },
        )
        r = { text: ds.text, ms: ds.ms, score: ds.score, error: ds.error }
      } catch (error) {
        r = { text: '', ms: 0, score: null, error: String((error && error.message) || error) }
      }

      let text = r.text
      // 看不清 → 居中裁剪再问一次（视频用精看模型，桌面用轻量模型）
      if (text && /看不清|模糊|无法|不清楚|cannot see|unclear|not clear/i.test(text)) {
        const region = {
          left: screen.x + Math.floor(screen.width * 0.25),
          top: screen.y + Math.floor(screen.height * 0.25),
          width: Math.floor(screen.width * 0.5),
          height: Math.floor(screen.height * 0.5),
        }
        const zoomShot = join(dir, `zoom${screen.index}-${Date.now()}.png`)
        // 放大倍数随 L：L 高 → 看得更清（最多 1600），L 低 → 省一点（最少 960）
        const zoomWidth = Math.max(960, Math.min(1600, Math.round(1280 * getLScale())))
        await captureScreen(zoomShot, { maxWidth: zoomWidth, region })
        const r2 = await describeWithScore(zoomShot, { prompt: '用一两句中文描述这个放大后的局部画面。' })
        if (r2.text) text = r2.text
      }
      // 模型反问“请提供内容” = 没认字；换全分辨率 + OCR 提示再问一次
      if (text && /请提供|请告诉我|请上传|需要您|无法看清|看不清|不确定|没看到|认不清/.test(text)) {
        try {
          const ocrShot = join(dir, `ocr${screen.index}-${Date.now()}.png`)
          await captureScreen(ocrShot, { maxWidth: 2048, screenIndex: screen.index })
          const ocr = await getGpuQueue().run(
            () =>
              describeWithScore(ocrShot, {
                prompt:
                  '逐字抄录画面中可见的文字、字幕、歌词、聊天或界面文字，保持原文，不要总结，不要反问用户。',
                maxTokens: 500,
              }),
            { priority: PRIORITY.visionFine, label: 'vision-ocr' },
          )
          if (ocr.text) text = ocr.text
        } catch {}
      }

      // 云端兜底计数：本地有结果就算成功，空/报错算失败
      if (cloudBoard) {
        if (text && !r.error) cloudBoard.noteLocalSuccess()
        else cloudBoard.noteLocalFailure(r.error || 'empty description')
      }
      return { text, ms: r.ms, error: r.error, isVideo, score: r.score ?? null }
    } catch (error) {
      if (cloudBoard) cloudBoard.noteLocalFailure(String((error && error.message) || error))
      return { text: '', ms: 0, error: String((error && error.message) || error) }
    }
  }

  async function tickScreen(screen) {
    const st = stateOf(screen.index)
    // 不再靠窗口标题判断“是不是视频”：只有搭话快照检测到画面在动，
    // 才给这块屏开一小段视频模式（globalThis.__hcemVideoActive）
    let videoHere = false
    let forcedRect = null
    try {
      const f = globalThis.__hcemVideoActive
      if (f && f.screen === screen.index && f.until > Date.now()) {
        videoHere = true
        if (f.rect && f.rect.width > 320 && f.rect.height > 240) forcedRect = f.rect
      }
    } catch {}
    // 桌面屏完全不自动截：只有搭话快照 / 用户明确要求 / 鼠标巡逻才截
    if (!videoHere) return
    // 安静一段时间后降频：暂停视频/不动的桌面不再每 6 秒截一张
    if (st.nextCaptureAt && Date.now() < st.nextCaptureAt) return
    try {
      // 空桌面（只有壁纸/任务栏）没有截的意义：直接跳过，不占视觉模型
      if (windowsOnScreen(screen).length === 0) return
      mkdirSync(dir, { recursive: true })
      const shot = join(dir, `screen${screen.index}-${Date.now()}.png`)
      // 分辨率按场景分：
      //   视频 → 360（只看人物/场景/动作，不需要细节，也快）
      //   桌面 → 720（要看清界面文字和按钮）
      // L（自信/精神）仍参与缩放：L 低（疲惫）降一档省资源；L 高看得更清。
      let isVideoNow = false
      let region = null
      if (forcedRect) {
        isVideoNow = true
        const left = Math.max(screen.x, forcedRect.left)
        const top = Math.max(screen.y, forcedRect.top)
        const right = Math.min(screen.x + screen.width, forcedRect.left + forcedRect.width)
        const bottom = Math.min(screen.y + screen.height, forcedRect.top + forcedRect.height)
        if (right - left > 320 && bottom - top > 240) {
          region = { left, top, width: right - left, height: bottom - top }
        }
      }
      try {
        // 先找这块屏上的视频窗口（不要求前台：用户可能一边看视频一边聊天）
        const wins = listVideoWindows()
        let best = null
        for (const w of wins) {
          const cx = w.left + w.width / 2
          const cy = w.top + w.height / 2
          if (cx >= screen.x && cx < screen.x + screen.width && cy >= screen.y && cy < screen.y + screen.height) {
            if (!best || w.width * w.height > best.width * best.height) best = w
          }
        }
        // 没有枚举到视频窗口时，用画面变化所在的窗口（前台）做 ROI；
        // 这里不再靠标题判断“是不是视频”
        if (!best && !forcedRect) {
          const win = getForegroundWindow()
          if (win.ok && win.width > 320 && win.height > 240) best = { ...win, _foreground: true }
        }
        if (best && best.width > 320 && best.height > 240) {
          isVideoNow = true
          const left = Math.max(screen.x, best.left)
          const top = Math.max(screen.y, best.top)
          const right = Math.min(screen.x + screen.width, best.left + best.width)
          const bottom = Math.min(screen.y + screen.height, best.top + best.height)
          if (right - left > 320 && bottom - top > 240) {
            region = { left, top, width: right - left, height: bottom - top }
          }
        }
      } catch {}
      const baseWidth = isVideoNow ? 480 : 720
      const capWidth = isVideoNow ? 720 : 1280
      const spatialWidth = Math.max(240, Math.min(capWidth, Math.round(baseWidth * getLScale())))
      await captureScreen(shot, {
        maxWidth: spatialWidth,
        screenIndex: screen.index,
        ...(region ? { region, trimBlack: true } : {}),
      })
      captures += 1
      lastError = null
      prune()

      if (st.lastShot) {
        let diff = await frameDiff(st.lastShot, shot)
        // 光标/时钟的小变化也会让 diff 偏高；用 aHash 再判一次“同一画面”
        let sameScene = false
        try {
          const h = await aHash(shot)
          if (st.lastHash && hammingDistance(h, st.lastHash) <= 8) sameScene = true
          st.lastHash = h
        } catch {}
        if (sameScene) diff = 0
        st.lastDiff = diff
        if (diff < threshold) {
          st.quietTicks += 1
          if (st.quietTicks >= 3) st.nextCaptureAt = Date.now() + QUIET_POLL_MS
        } else {
          st.quietTicks = 0
          st.nextCaptureAt = 0
        }

        if (enableFunnel && st.funnel) {
          // ── 帧级漏斗：镜头切分（自动阈值）+ 密度分配 + 段内 top-K ──
          const now = Date.now()
          st.funnel.push(now, diff)
          st.framePaths.set(now, shot)
          if (st.funnel.shouldFlush(now)) {
            let ready = st.funnel.flush()
            // 切点后还有剩余帧 + 时间窗口也到 → 再兜底 flush 一次
            if (st.funnel.hasPending() && st.funnel.segmentStart && now - st.funnel.segmentStart >= st.funnel.windowMs) {
              ready = ready.concat(st.funnel.flush())
            }
            // 静默窗口不写记忆：暂停/不动的桌面只保留 lastShot，不送 VLM
            const gate = Math.max(0.02, threshold * 0.6)
            ready = ready.filter((f) => Number(f.score) >= gate)
            let described = 0
            let lastHash = null
            for (const f of ready) {
              const path = st.framePaths.get(f.ts)
              if (!path) continue
              // 新颖性：与上一张已选帧的 aHash 距离过小 → 跳过（不重复送 VLM）
              try {
                const h = await aHash(path)
                if (lastHash && hammingDistance(h, lastHash) <= 5) continue
                lastHash = h
              } catch {}
              const d = await describeFrame(path, screen)
              if (d && d.text) {
                described += 1
                lastDescription = d.text
                st.recentFrames.push({ path, t: f.ts })
                st.recentDescriptions.push(d.text)
                if (st.recentFrames.length > 10) st.recentFrames.shift()
                if (st.recentDescriptions.length > 10) st.recentDescriptions.shift()
                // 人脸表情 → 中文
                const FACE_CN = { happiness: '高兴', neutral: '平静', sadness: '悲伤', anger: '生气', fear: '害怕', disgust: '厌恶', surprise: '惊讶', contempt: '轻蔑' }
                const priority = f.score >= 0.15 ? 'high' : f.score >= 0.05 ? 'mid' : 'low'
                let face = null
                // 人脸情绪：只要不是低优先级帧就看一眼（结果会拼进描述）
                if (priority !== 'low') {
                  try {
                    const fe = await detectFaceEmotion(path, { python: process.env.HCEM_PYTHON, modelsDir })
                    if (fe.ok && fe.faces.length > 0) face = fe.faces[0]
                  } catch {}
                }
                onChange?.({
                  screen: screen.index,
                  diff: f.score,
                  image: path,
                  description: face && face.emotion ? (d.text + '（画面上的人看起来' + (FACE_CN[String(face.emotion)] || face.emotion) + '）') : d.text,
                  baseDescription: d.text,
                  error: d.error,
                  ms: d.ms,
                  priority,
                  truncationRisk: priority === 'low',
                  face,
                  modelScore: d.score ?? null,
                  isVideo: d.isVideo === true,
                })
              }
            }
            // 评论/搭话判定统一由 perception/sense-scheduler.mjs 负责（它同时知道
            // 搭话度档位、L、变化率、音频上下文），这里只上报「有新描述」这一事实。
            // （原 comment-opportunity.json 通道已废弃，避免两套调度打架）

            if (described === 0) st.nextCaptureAt = Date.now() + QUIET_POLL_MS
            else st.nextCaptureAt = 0
            // 清理过期路径（保留最近 2 分钟）
            const cutoff = Date.now() - 2 * 60000
            for (const [ts] of st.framePaths) {
              if (ts < cutoff) st.framePaths.delete(ts)
            }
            st.quiet = 0
          }
          // 连续性判断：低分帧累积
          if (diff < threshold) {
            st.quiet += 1
            if (st.quiet === settleFrames) {
              onChange?.({ screen: screen.index, diff, settled: true, image: shot })
            }
          } else {
            st.quiet = 0
          }
        } else {
          // ── 旧逻辑（变化即描述）──
          if (isSignificantChange(diff, threshold)) {
            st.quiet = 0
            const d = await describeFrame(shot, screen)
            if (d && d.text) {
              lastDescription = d.text
              st.recentFrames.push({ path: shot, t: Date.now() })
              st.recentDescriptions.push(d.text)
              if (st.recentFrames.length > 10) st.recentFrames.shift()
              if (st.recentDescriptions.length > 10) st.recentDescriptions.shift()
              onChange?.({ screen: screen.index, diff, image: shot, description: d.text, error: d.error, ms: d.ms })
            }
          } else {
            st.quiet += 1
            if (st.quiet === settleFrames) {
              onChange?.({ screen: screen.index, diff, settled: true, image: shot })
            }
          }
        }
      }
      st.lastShot = shot
    } catch (error) {
      lastError = String((error && error.message) || error)
      logger?.warn?.(`[hcem] capture screen ${screen.index} failed: ${lastError}`)
    }
  }

  async function tick() {
    // 看视频时只跑视频所在的那块屏：不再顺手截桌面
    let focusScreens = null
    try {
      const focus = typeof shouldFocusVideo === 'function' ? shouldFocusVideo() : Boolean(shouldFocusVideo)
      if (focus) {
        const wins = listVideoWindows()
        if (wins.length > 0) {
          focusScreens = new Set()
          for (const w of wins) {
            const cx = w.left + w.width / 2
            const cy = w.top + w.height / 2
            for (const sc of screens) {
              if (cx >= sc.x && cx < sc.x + sc.width && cy >= sc.y && cy < sc.y + sc.height) {
                focusScreens.add(sc.index)
              }
            }
          }
        }
      }
    } catch {}
    for (const screen of screens) {
      if (focusScreens && focusScreens.size > 0 && !focusScreens.has(screen.index)) continue
      await tickScreen(screen)
    }
  }

  /** 鼠标巡逻触发：截那块区域（有窗口就截窗口）→ 描述 → 上报 */
  async function handleMousePatrol(ev) {
    const region = ev && ev.region
    if (!region || !(region.width > 0) || !(region.height > 0)) return
    try {
      // 有窗口就按窗口截（更贴合用户正在做什么）
      let shotRegion = region
      try {
        const win = getForegroundWindow()
        if (win && win.ok && win.width > 0 && win.height > 0) {
          const il = Math.max(win.left, region.left)
          const it = Math.max(win.top, region.top)
          const ir = Math.min(win.left + win.width, region.left + region.width)
          const ib = Math.min(win.top + win.height, region.top + region.height)
          if (ir > il && ib > it) {
            shotRegion = { left: il, top: it, width: ir - il, height: ib - it }
          }
        }
      } catch {}

      const shot = join(dir, 'patrol-' + Date.now() + '.png')
      await captureScreen(shot, { maxWidth: 1280, region: shotRegion })
      captures += 1
      const fakeScreen = { index: -1, x: shotRegion.left, y: shotRegion.top, width: shotRegion.width, height: shotRegion.height }
      const d = await describeFrame(shot, fakeScreen)
      if (d && d.text) {
        try {
          if (patrol) patrol.noteDescription(d.text)
        } catch {}
        onChange?.({
          screen: -1,
          diff: 0.25,
          image: shot,
          description: d.text,
          baseDescription: d.text,
          error: d.error,
          ms: d.ms,
          priority: 'mid',
          truncationRisk: false,
          face: null,
          modelScore: d.score != null ? d.score : null,
          isVideo: false,
          patrol: true,
          patrolRegion: shotRegion,
          cooldownMs: ev.cooldownMs,
        })
      }
      logger?.info?.('[鼠标巡逻] 已看一次：' + String((d && d.text) || '').slice(0, 60))
    } catch (e) {
      logger?.warn?.('[鼠标巡逻] 处理失败: ' + String((e && e.message) || e))
    }
  }

  return {
    async start() {
      if (timer) return { ok: true, already: true }
      screens = await listScreens()
      if (screens.length === 0) screens = [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true }]
      audio.start()
      timer = setInterval(tick, intervalMs)
      tick()
      // 鼠标巡逻：桌面监视开着时启用，快速划鼠标 3 秒 → 看一眼那块区域
      if (enableMousePatrol && !patrol) {
        try {
          patrol = createMousePatrol({
            getL: () => {
              try {
                const e = getEmotion ? getEmotion() : null
                return Number((e && e.L) != null ? e.L : 55)
              } catch {
                return 55
              }
            },
            onChange: (ev) => {
              handleMousePatrol(ev).catch(() => {})
            },
            logger,
          })
          patrol.start()
        } catch (e) {
          logger?.warn?.('[鼠标巡逻] 启动失败: ' + String((e && e.message) || e))
          patrol = null
        }
      }
      logger?.info?.(`[hcem] desktop listening started (${screens.length} screen(s), interval ${intervalMs}ms, funnel=${enableFunnel})`)
      return { ok: true, screens: screens.length, funnel: enableFunnel }
    },
    /** 动态调整采样间隔（由感知调度器调用；间隔变化时重建定时器） */
    setIntervalMs(ms) {
      const next = Math.max(500, Math.min(60000, Number(ms) || 1000))
      if (next === intervalMs) return { ok: true, same: true, intervalMs }
      intervalMs = next
      if (timer) {
        clearInterval(timer)
        timer = setInterval(tick, intervalMs)
      }
      logger?.info?.(`[hcem] capture interval -> ${intervalMs}ms`)
      return { ok: true, intervalMs }
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
      audio.stop()
      if (patrol) {
        try {
          patrol.stop()
        } catch {}
        patrol = null
      }
      logger?.info?.('[hcem] desktop listening stopped')
      return { ok: true }
    },
    status() {
      const screenStates = {}
      for (const [index, st] of states.entries()) {
        screenStates[index] = {
          lastDiff: st.lastDiff,
          quiet: st.quiet,
          funnel: st.funnel ? st.funnel.stats() : null,
        }
      }
      return {
        running: !!timer,
        screens: screens.map((s) => ({ index: s.index, width: s.width, height: s.height, primary: s.primary })),
        captures,
        lastError,
        lastDescription,
        screenStates,
        audio: audio.status(),
        intervalMs,
        funnel: enableFunnel,
        patrol: patrol ? patrol.status() : null,
      }
    },
  }
}
