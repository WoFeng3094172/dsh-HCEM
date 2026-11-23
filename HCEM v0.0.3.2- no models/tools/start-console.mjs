// 启动控制台（detached，不受父进程退出影响）
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(__dirname, '..', 'plugin')

const child = spawn(process.execPath, ['ui/server.mjs'], {
  cwd: pluginDir,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
console.log(`控制台启动中（pid ${child.pid}）… http://127.0.0.1:8082`)
