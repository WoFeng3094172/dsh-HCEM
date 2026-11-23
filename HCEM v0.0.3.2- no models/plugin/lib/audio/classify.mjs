// 声音分类：把 PANNs 的 AudioSet 标签翻译成「这是什么声音」
//
// 分工（用户定）：
//   · 人声 → 转写 + 情绪 + 声纹（谁在说、说了什么、什么语气）
//   · 音乐 → 音乐情感（valence/energy）+ 指纹（同一首歌认出来）
//   · 其它 → 只做简单分析：直接给一句"这是什么声音"，不跑重模型
//
// 关键：**看视频时人声和音乐是同时存在的**（对白 + 配乐）。
// 所以这里不是"二选一"，而是分别判断「有没有人声分量」「有没有音乐分量」，
// 两个都跑 —— 协同工作。

/** 类别 → 中文描述模板（按优先级从高到低匹配） */
const RULES = [
  {
    category: 'alarm',
    words: ['alarm', 'siren', 'buzzer', 'beep', 'bell', 'smoke detector', 'fire alarm', 'error'],
    desc: '警报/提示音',
  },
  {
    category: 'keyboard',
    words: ['keyboard', 'typing', 'typewriter', 'computer keyboard', 'mouse', 'click'],
    desc: '键盘/鼠标操作声',
  },
  {
    category: 'impact',
    words: ['thump', 'bang', 'knock', 'crash', 'smash', 'slam', 'tap', 'thud', 'clatter'],
    desc: '碰撞/敲击声',
  },
  {
    category: 'vehicle',
    words: ['vehicle', 'car', 'engine', 'motorcycle', 'truck', 'bus', 'aircraft', 'train', 'horn'],
    desc: '车辆/引擎声',
  },
  {
    category: 'nature',
    words: ['rain', 'wind', 'water', 'stream', 'thunder', 'bird', 'insect', 'fire', 'rustle'],
    desc: '自然声',
  },
  {
    category: 'crowd',
    words: ['crowd', 'chatter', 'laughter', 'applause', 'clapping', 'cheering'],
    desc: '人群/笑声',
  },
  {
    category: 'animal',
    words: ['dog', 'cat', 'bark', 'meow', 'roar', 'chirp', 'animal'],
    desc: '动物叫声',
  },
  {
    category: 'machine',
    words: ['machine', 'fan', 'air conditioner', 'vacuum', 'printer', 'motor', 'drill', 'saw'],
    desc: '机器运转声',
  },
  {
    category: 'noise',
    words: ['noise', 'static', 'hum', 'hiss', 'crackle', 'white noise', 'pink noise'],
    desc: '噪声/底噪',
  },
  {
    category: 'voice',
    words: ['speech', 'male', 'female', 'narration', 'conversation', 'singing', 'whisper', 'child'],
    desc: '人声',
  },
  {
    category: 'music',
    words: [
      'music',
      'musical',
      'guitar',
      'piano',
      'drum',
      'violin',
      'bass',
      'instrument',
      'orchestra',
      'synthesizer',
      'electronic',
      'rock',
      'pop',
      'jazz',
      'classical',
      'hip hop',
      'rap',
      'choir',
    ],
    desc: '音乐',
  },
]

const VOICE_WORDS = [
  'speech',
  'male',
  'female',
  'narration',
  'conversation',
  'whisper',
  'child',
  'vocal',
  'singing',
  'singer',
  'choir',
]
const MUSIC_WORDS = [
  'music',
  'musical',
  'guitar',
  'piano',
  'drum',
  'violin',
  'bass',
  'instrument',
  'orchestra',
  'synthesizer',
  'electronic',
  'rock',
  'pop',
  'jazz',
  'classical',
  'hip hop',
  'rap',
  'melody',
  'chord',
]

/** 判定某个分量是否存在的分数门槛 */
const PRESENCE_THRESHOLD = 0.15

/**
 * 把 AudioSet 标签分类
 *
 * @param {Array<{label:string, score:number}>} tags
 * @returns {{
 *   category:string, desc:string, confidence:number, topLabel:string,
 *   heavy:boolean, hasVoice:boolean, hasMusic:boolean, components:string[]
 * }}
 */
export function classifySound(tags = []) {
  const list = (Array.isArray(tags) ? tags : []).filter((t) => t && typeof t.label === 'string')
  if (list.length === 0) {
    return {
      category: 'unknown',
      desc: '听不清是什么声音',
      confidence: 0,
      topLabel: '',
      heavy: false,
      hasVoice: false,
      hasMusic: false,
      components: [],
    }
  }

  const top = list.reduce((a, b) => (Number(b.score) > Number(a.score) ? b : a))
  const text = list.map((t) => String(t.label).toLowerCase()).join(' | ')

  // ── 分量检测（不是二选一，各自判断）──
  const hasVoice = list.some(
    (t) => Number(t.score) >= PRESENCE_THRESHOLD && VOICE_WORDS.some((w) => String(t.label).toLowerCase().includes(w)),
  )
  const hasMusic = list.some(
    (t) => Number(t.score) >= PRESENCE_THRESHOLD && MUSIC_WORDS.some((w) => String(t.label).toLowerCase().includes(w)),
  )
  // 分量「有多重」：取该类标签里的最高分。
  // hasMusic 只回答「有没有」，音乐分析很吃算力，得靠这个判断「够不够强」。
  const maxOf = (words) =>
    list
      .filter((t) => words.some((w) => String(t.label).toLowerCase().includes(w)))
      .reduce((m, t) => Math.max(m, Number(t.score) || 0), 0)
  const musicScore = maxOf(MUSIC_WORDS)
  const voiceScore = maxOf(VOICE_WORDS)

  // ── 主类别：先按最高分标签精确匹配，再退到全列表 ──
  const topLower = String(top.label).toLowerCase()
  let matched = null
  for (const rule of RULES) {
    if (rule.words.some((w) => topLower.includes(w))) {
      matched = rule
      break
    }
  }
  if (!matched) {
    for (const rule of RULES) {
      if (rule.words.some((w) => text.includes(w))) {
        matched = rule
        break
      }
    }
  }

  // 同时有人声和音乐 → 归为「影视/多媒体」（对白 + 配乐）
  let category = matched ? matched.category : 'other'
  const components = []
  if (hasVoice) components.push('voice')
  if (hasMusic) components.push('music')
  if (hasVoice && hasMusic) category = 'multimedia'

  const confidence = Number(Number(top.score || 0).toFixed(3))
  const topLabel = String(top.label || '')

  // ── 描述 ──
  let desc
  if (category === 'multimedia') {
    desc = '有对白也有配乐（像是在看视频/影视）'
  } else if (matched) {
    desc = matched.desc
    if (['other', 'nature', 'impact', 'machine'].includes(category) && topLabel) {
      desc = matched.desc + '（' + topLabel + '）'
    }
  } else {
    desc = '环境声（' + (topLabel || '无法识别') + '）'
  }

  return {
    category,
    desc,
    confidence,
    topLabel,
    // 只要有人声或音乐分量，就要跑重模型（协同，不是二选一）
    heavy: hasVoice || hasMusic,
    hasVoice,
    hasMusic,
    /** 人声/音乐分量的最高标签分（0~1），用于决定要不要跑重模型 */
    voiceScore,
    musicScore,
    components,
  }
}

/** 类别 → 中文名（给日志和提示词用） */
export const CATEGORY_NAMES = Object.freeze({
  voice: '人声',
  music: '音乐',
  multimedia: '影视音',
  alarm: '警报',
  keyboard: '键鼠',
  impact: '碰撞',
  vehicle: '车辆',
  nature: '自然',
  animal: '动物',
  crowd: '人群',
  machine: '机器',
  noise: '噪声',
  other: '其它',
  unknown: '未知',
})

/**
 * 把分类结果 + 各模型输出拼成一句给模型看的话
 * 支持多分量同时存在（对白 + 配乐）
 *
 * @param {object} r classifySound 的结果
 * @param {object} extra { text, emotion, music, fp }
 */
export function describeSound(r, extra = {}) {
  const parts = []

  if (r.hasVoice) {
    if (extra.text) parts.push('有人说话：「' + String(extra.text).slice(0, 80) + '」')
    else parts.push('有人在说话（没听清内容）')
    if (extra.emotion) parts.push('语气' + extra.emotion)
  }

  if (r.hasMusic) {
    let m = '在放音乐'
    if (extra.music) {
      const v = Number(extra.music.valence ?? 0)
      const e = Number(extra.music.energy ?? 0)
      const feel = v >= 0.6 ? '偏明快' : v <= 0.4 ? '偏忧郁' : '中性'
      const power = e >= 0.6 ? '节奏强' : e <= 0.4 ? '安静' : '中等'
      m += '（' + feel + '、' + power + '）'
    }
    if (extra.fp) m += '，认得这首'
    parts.push(m)
  }

  if (parts.length === 0) parts.push(r.desc)
  return parts.join('，')
}
