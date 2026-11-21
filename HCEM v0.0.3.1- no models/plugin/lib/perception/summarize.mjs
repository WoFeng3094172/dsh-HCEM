// 感知汇总：把视觉/听觉各模型的分析结果，交给 OmniDimen 整理成一段话
//
// 用户定（1.5）：
//   视觉、听觉链路分析出的大量信息，最终都是交给 OmniDimen 整理输出文本内容，
//   OmniDimen 分析不了的才送云端。
//
// 但每次都调 OmniDimen 太贵（一次推理几百毫秒到几秒），所以分两档：
//   · 简单场景（只有画面或只有声音、文本很短）→ 直接拼接，不调模型
//   · 复杂场景（画面 + 声音都有，或信息量大）→ 交给 OmniDimen 整理
//
// 1.2 也在这里落地：音乐情感（VibeNet）和画面一起进这条汇总，一起写记忆。

const OMNI_URL = process.env.HCEM_OMNI_LLM || 'http://127.0.0.1:8098/v1/chat/completions'

/** 简单场景阈值：文本总长超过这个就走模型整理 */
const MODEL_THRESHOLD = 120

/** 人脸表情 → 中文 */
const FACE_CN = {
  happiness: '高兴',
  neutral: '平静',
  sadness: '悲伤',
  anger: '生气',
  fear: '害怕',
  disgust: '厌恶',
  surprise: '惊讶',
  contempt: '轻蔑',
}

/**
 * 汇总一次感知
 * @param {object} p {
 *   visionText, audioText, face, music, fp, categoryName,
 *   L, S,                       AI 当时的情绪（用于挑选语气）
 *   useModel?: 强制用/不用模型
 * }
 * @returns {Promise<{ ok:boolean, text:string, usedModel:boolean, error?:string }>}
 */
export async function summarizePerception(p = {}) {
  const visionText = String(p.visionText || '').trim()
  const audioText = String(p.audioText || '').trim()
  const face = p.face || null
  const music = p.music || null
  const fp = String(p.fp || '')
  const categoryName = String(p.categoryName || '')
  const L = Number(p.L ?? 55)
  const S = Number(p.S ?? 15)
  const useModel = p.useModel

  // ── 拼装原始素材 ──
  const bits = []
  if (visionText) bits.push('画面：' + visionText)
  if (face && face.emotion) bits.push('画面上的人看起来' + (FACE_CN[String(face.emotion)] || face.emotion))
  if (audioText) bits.push('声音：' + audioText)
  if (music) {
    const v = Number(music.valence ?? 0)
    const e = Number(music.energy ?? 0)
    const feel = v >= 0.6 ? '明快' : v <= 0.4 ? '忧郁' : '中性'
    const power = e >= 0.6 ? '强烈' : e <= 0.4 ? '安静' : '中等'
    bits.push('音乐情感：' + feel + '、' + power)
  }
  if (fp) bits.push('这首歌认得（有指纹）')

  const raw = bits.join('；')
  if (!raw) return { ok: true, text: '', usedModel: false }

  // ── 判断走不走模型 ──
  const simple =
    useModel === false ||
    (!visionText && !audioText) ||
    (visionText && !audioText && visionText.length < MODEL_THRESHOLD) ||
    (audioText && !visionText && audioText.length < MODEL_THRESHOLD)

  if (simple) {
    return { ok: true, text: raw, usedModel: false }
  }

  // ── 交给 OmniDimen 整理 ──
  try {
    const tone = L < 40 ? '语气可以安静、简短些' : L > 65 ? '语气轻快些' : '语气平实'
    const sys = [
      '你在帮你（AI）把刚看到和听到的东西整理成一句自然的中文描述，用于写入记忆。',
      '要求：',
      '1. 只输出一句到两句话，不要分点、不要解释；',
      '2. 保留关键信息（谁、在哪、在做什么、听到什么）；',
      '3. 用第一人称视角（"我看到…"或直接陈述），不要用"画面："这种标签；',
      '4. ' + tone + '；',
      '5. 不要编造没有提供的信息。',
    ].join('\n')

    const res = await fetch(OMNI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: raw },
        ],
        max_tokens: 160,
        temperature: 0.4,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (!text) throw new Error('空回复')
    return { ok: true, text, usedModel: true }
  } catch (e) {
    // 模型不可用就退回拼接（不丢信息）
    return { ok: true, text: raw, usedModel: false, error: String((e && e.message) || e) }
  }
}

/**
 * 判断是否需要送云端
 * 用户定：OmniDimen 分析不了的才送云端。
 * 这里给出"要不要考虑云端"的判断依据（真正发送还要过 cloud-board 的闸门）。
 */
export function needsCloud(p = {}) {
  const visionText = String(p.visionText || '')
  const audioText = String(p.audioText || '')
  const modelFailed = Boolean(p.modelError)
  const tooLong = visionText.length + audioText.length > 1200
  return { needs: modelFailed || tooLong, reason: modelFailed ? '本地整理失败' : tooLong ? '信息量过大' : '' }
}
