// HCEM 情绪语义分析（embedding 方案）
// 不做"关键词→情绪标签"的硬匹配，而是把文本 embedding 后
// 与色环上六个语义锚点比相似度，直接得到"色环角度（H）"。
// 六种情绪名只是给人类看的标签，数据层只认 H（0~360°）。

const EMBEDDING_URL = process.env.HCEM_EMBED_URL || 'http://127.0.0.1:8081/v1/embeddings'

// 每个 H 角度一组"语义原型句"。AI 靠相似度理解语义，而不是数关键词。
const ANCHORS = [
  { angle: 0, samples: ['我今天特别开心', '太好了，终于成功了', '哈哈哈哈笑死我了', '我很幸福', '他升职了，恭喜'] },
  { angle: 60, samples: ['哇，居然是这样', '没想到会这样', '太意外了', '我被吓了一跳'] },
  { angle: 120, samples: ['我好害怕', '太恐怖了', '我不知道会发生什么', '我很焦虑'] },
  { angle: 180, samples: ['我很难过', '他去世了，我再也见不到他了', '我忍不住想哭', '失去了最重要的人', '我很孤独'] },
  { angle: 240, samples: ['真恶心', '我讨厌这个', '太烦人了', '我嫌弃他'] },
  { angle: 300, samples: ['气死我了', '我很愤怒', '混蛋', '火大'] },
]

async function embed(texts) {
  const res = await fetch(EMBEDDING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: texts }),
  })
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}`)
  const data = await res.json()
  return data.data.map((d) => d.embedding)
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// 启动时预计算六个锚点的平均 embedding；返回 analyze(text) 函数
export async function createEmbeddingAnalyzer(logger = console) {
  const anchorVectors = []
  for (const anchor of ANCHORS) {
    const embs = await embed(anchor.samples)
    const avg = new Array(embs[0].length).fill(0)
    for (const e of embs) {
      for (let i = 0; i < e.length; i++) avg[i] += e[i] / embs.length
    }
    anchorVectors.push({ angle: anchor.angle, vec: avg })
  }
  logger.info?.(`[hcem] embedding anchors ready (${anchorVectors.length})`)

  async function analyze(text) {
    const segments = splitText(text)
    const embs = await embed(segments)
    let best = null
    for (let i = 0; i < segments.length; i++) {
      const vec = embs[i]
      const sims = anchorVectors
        .map((a) => ({ angle: a.angle, sim: cosine(vec, a.vec) }))
        .sort((x, y) => y.sim - x.sim)
      const top1 = sims[0]
      const top2 = sims[1] || { sim: 0 }
      const margin = top1.sim - top2.sim
      if (top1.sim >= 0.32 && margin >= 0.08) {
        if (!best || top1.sim > best.similarity) {
          best = {
            targetHue: top1.angle,
            similarity: top1.sim,
            margin,
            intensity: Math.min(1, Math.max(0.2, (top1.sim - 0.3) / 0.4)),
          }
        }
      }
    }
    return best
  }

  return { analyze, embed }
}

function splitText(text) {
  const parts = String(text || '')
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const out = []
  for (const p of parts) {
    if (p.length > 200) {
      out.push(
        ...p
          .split(/[，,；;]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      )
    } else {
      out.push(p)
    }
  }
  return out.length > 0 ? out : [String(text || '')]
}
