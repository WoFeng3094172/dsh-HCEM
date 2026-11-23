/**
 * 陪伴意图软识别（Q5）
 *
 * 先规则、后模型：
 *   - 规则命中直接给 intent（置信度 0.85）
 *   - 没命中返回 none（0.5），调用方按普通对话处理
 *   - 以后训练出 intent-head.json 再叠加模型分（未训练时不存在，不影响）
 *
 * 类别：
 *   watch   要一起看视频
 *   listen  要一起听音频
 *   quiet   在看/听，但别说话
 *   working 在忙，不用陪
 *   no-need 明确不需要陪看
 *   leave   不看了/结束了
 *   none    没表态
 */

export const INTENTS = ['watch', 'listen', 'quiet', 'working', 'no-need', 'leave', 'none']

const RULES = [
  { intent: 'leave', confidence: 0.9, re: /(不看了|关了吧|看完了|别看了|不用看了|结束吧|退出吧|关掉吧)/ },
  { intent: 'working', confidence: 0.85, re: /(我在工作|我在忙|忙着呢|在写代码|在开会|先忙|让我专心|工作中)/ },
  { intent: 'no-need', confidence: 0.9, re: /(不用陪|不用一起|不需要陪|不用看|别陪|我自己看|不用管我)/ },
  { intent: 'quiet', confidence: 0.9, re: /(别说话|安静|不要说话|别出声|闭嘴|静音陪|安静陪|别吵)/ },
  { intent: 'watch', confidence: 0.9, re: /(一起看|陪我看|一起看个|看这个|看看这个|陪我看个|我们看)/ },
  { intent: 'listen', confidence: 0.85, re: /(一起听|陪我听|听这个|听听这个)/ },
]

/**
 * @param {string} text
 * @returns {{intent:string, confidence:number, matched:string, source:'rule'|'none'}}
 */
export function classifyIntent(text) {
  const s = String(text || '').trim()
  if (!s) return { intent: 'none', confidence: 0, matched: '', source: 'none' }
  for (const r of RULES) {
    const m = s.match(r.re)
    if (m) return { intent: r.intent, confidence: r.confidence, matched: m[0], source: 'rule' }
  }
  return { intent: 'none', confidence: 0.5, matched: '', source: 'none' }
}

/** 需要「陪看」的意图（要保活/分析） */
export function isWatchIntent(intent) {
  return intent === 'watch' || intent === 'listen' || intent === 'quiet'
}

/** 明确「不需要陪」的意图（可休眠） */
export function isNoNeedIntent(intent) {
  return intent === 'working' || intent === 'no-need' || intent === 'leave'
}
