import fs from 'node:fs'
import { createEmbeddingAnalyzer } from '../lib/emotion-embedding.mjs'

// 服务不可用（8094 未启动）时跳过（环境依赖），不影响本地测试
let analyzer
try {
  analyzer = await createEmbeddingAnalyzer(console)
} catch (error) {
  console.log('SKIP: Qwen3-Embedding (8094) 不可用：' + String((error && error.message) || error))
  process.exit(0)
}

const cases = [
  ['我好难过，想哭', 180],
  ['气死我了，混蛋', 300],
  ['今天好开心，哈哈', 0],
  ['哇，居然是这样', 60],
  ['我好害怕', 120],
  ['真恶心，讨厌', 240],
  ['今天天气不错', null],
]

let fail = 0
for (const [text, expect] of cases) {
  const r = await analyzer.analyze(text)
  const got = r ? r.targetHue : null
  const mark = got === expect ? '✅' : `❌ 期望 ${expect}`
  if (got !== expect) fail += 1
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
if (fail > 0) {
  console.error(fail + ' 个用例未匹配')
  process.exit(1)
}
