import fs from 'node:fs'
import { analyzeText } from '../lib/emotion.mjs'

const text = fs.readFileSync(new URL('./fixtures/sad-virginia.txt', import.meta.url), 'utf8')
const result = analyzeText(text)

console.log('analyzeText result:', result)
if (result) {
  console.log('识别为:', result.emotion, 'H =', result.targetHue, '强度 =', result.intensity)
} else {
  console.log('⚠️ 词表未能识别出「悲伤」——需要升级情绪分析（见建议）')
}
