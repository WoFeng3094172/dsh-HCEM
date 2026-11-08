import { openStore } from '../lib/store.mjs'
import { rmSync } from 'node:fs'

// 测试专用库，避免改动真实数据
const TEST_DB = 'E:/HCEM/.test-data/store.test.sqlite'

const store = openStore(console, TEST_DB)
if (!store) {
  console.error('FAIL: store not opened')
  process.exit(1)
}

console.log('OK: dbPath =', TEST_DB)
console.log('OK: emotion write =', JSON.stringify(store.setEmotion({ H: 300, S: 20, L: 50 })))
console.log('OK: emotion read =', JSON.stringify(store.getEmotion()))

const id = store.putMemory({ text: '测试记忆：鲸鲸喜欢睡觉', zone: 'context', L: 0.9 })
console.log('OK: memory id =', id)
console.log('OK: memories =', JSON.stringify(store.listMemories()))

store.saveJSON('test.json', { hello: 'HCEM' })
console.log('OK: json roundtrip =', JSON.stringify(store.loadJSON('test.json')))

// 重置为设计默认值，避免污染真实状态
store.setEmotion({ H: 360, S: 15, L: 55 })
store.close()

// 清理本次测试产生的文件（JSON + 测试库）
for (const f of ['test.json', 'store.test.sqlite', 'store.test.sqlite-wal', 'store.test.sqlite-shm']) {
  rmSync('E:/HCEM/.test-data/' + f, { force: true })
}
console.log('ALL OK')
