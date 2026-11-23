// HCEM 本地服务启动器（node 脚本，避免 cmd 编码/引号问题）
// 用法：node start-services.mjs
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODELS = join(__dirname, 'models')
const LLAMA = join(MODELS, 'llama.cpp-cuda', 'llama-server.exe')

function portUp(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port, timeout: 800 })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => { resolve(false) })
  })
}

const services = [
  {
    name: 'Qwen3-0.6B (分流)',
    port: 8093,
    model: join(MODELS, 'Qwen3-0.6B-Q4_K_M-GGUF', 'qwen3-0.6b-q4_k_m.gguf'),
    args: ['-c', '4096', '-ngl', '99'],
  },
  {
    name: 'Qwen3-Embedding (向量)',
    port: 8094,
    model: join(MODELS, 'Qwen3-Embedding-0.6B-Q8_0', 'Qwen3-Embedding-0.6B-Q8_0.gguf'),
    args: ['-c', '2048', '-ngl', '99', '--embedding', '--pooling', 'mean'],
  },


]

if (!existsSync(LLAMA)) {
  console.error('找不到 llama-server：' + LLAMA)
  process.exit(1)
}

for (const s of services) {
  if (await portUp(s.port)) {
    console.log(`[skip] ${s.name} 已在 :${s.port} 运行`)
    continue
  }
  if (!existsSync(s.model)) {
    console.log(`[warn] ${s.name} 模型不存在：${s.model}`)
    continue
  }
  const argv = ['-m', s.model, '--host', '127.0.0.1', '--port', String(s.port), ...s.args]
  if (s.mmproj) argv.push('--mmproj', s.mmproj)
  try {
    const child = spawn(LLAMA, argv, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    console.log(`[start] ${s.name} -> :${s.port} (pid ${child.pid})`)
  } catch (error) {
    console.log(`[fail] ${s.name}: ${String((error && error.message) || error)}`)
  }
}

// 等 3 秒看看是否起来
await new Promise((r) => setTimeout(r, 3000))
for (const s of services) {
  const up = await portUp(s.port)
  console.log(`[check] ${s.name} :${s.port} -> ${up ? 'UP' : 'DOWN（可能还在加载）'}`)
}
