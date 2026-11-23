// 用插件自己的 services.mjs 启动模型（detached，不随 pwsh 退出）
// 用法：node start-model.mjs <serviceKey> [waitSeconds]
import { startService, portUp, stopService, SERVICES } from '../plugin/lib/services.mjs'

const key = process.argv[2]
const waitSec = Number(process.argv[3] || 40)
const spec = SERVICES[key]
if (!spec) {
  console.log('unknown service:', key, '| 可用:', Object.keys(SERVICES).join(', '))
  process.exit(1)
}
if (await portUp(spec.port)) {
  console.log(`${key} 已在运行 (:${spec.port})`)
  process.exit(0)
}
const r = startService(key, { info: (m) => console.log(m), warn: (m) => console.log(m) })
console.log('start:', JSON.stringify(r))
for (let i = 0; i < waitSec; i += 1) {
  await new Promise((res) => setTimeout(res, 1000))
  if (await portUp(spec.port, 500)) {
    console.log(`${key} UP (:${spec.port})，用时 ${i + 1}s`)
    process.exit(0)
  }
}
console.log(`${key} 启动超时（${waitSec}s）`)
process.exit(2)
