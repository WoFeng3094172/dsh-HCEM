import fs from 'node:fs'
import { createEmbeddingAnalyzer } from '../lib/emotion-embedding.mjs'

const analyzer = await createEmbeddingAnalyzer(console)

const cases = [
  ['我好难过，想哭', 180],
  ['气死我了，混蛋', 300],
  ['今天好开心，哈哈', 0],
  ['哇，居然是这样', 60],
  ['我好害怕', 120],
  ['真恶心，讨厌', 240],
  ['今天天气不错', null],
]

for (const [text, expect] of cases) {
  const r = await analyzer.analyze(text)
  const got = r ? r.targetHue : null
  const mark = got === expect ? '✅' : `❌ 期望 ${expect}`
  console.log(
    `「${text}」→ H=${got} 强度=${r ? r.intensity.toFixed(2) : '-'} 相似度=${r ? r.similarity.toFixed(3) : '-'} margin=${r ? r.margin.toFixed(3) : '-'} ${mark}`,
  )
}

const virginia = fs.readFileSync(new URL('./fixtures/sad-virginia.txt', import.meta.url), 'utf8')
const rv = await analyzer.analyze(virginia)
console.log(
  '弗吉尼亚文本 →',
  rv ? `H=${rv.targetHue} 强度=${rv.intensity.toFixed(2)} 相似度=${rv.similarity.toFixed(3)}` : 'null',
)

const early =
  '一八一五年爱伦一家搬至苏格兰，在那儿，埃德加过上了很长一段无忧无虑的生活，但几年后因为拿破仑在欧洲发动战争，埃德加养父约翰的生意受到战火的严重影响，加之养母弗朗西斯患上了重病，爱伦家一时陷入窘境'
const re = await analyzer.analyze(early)
console.log(
  '爱伦早年文本 →',
  re ? `H=${re.targetHue} 强度=${re.intensity.toFixed(2)} 相似度=${re.similarity.toFixed(3)}` : 'null',
)
