#!/usr/bin/env node
/**
 * check-imports.mjs —— 检查 ESM 的 import 问题
 *
 * 为什么需要它：
 *   2026-11-19 通宵排查，挖出 8 个同类 BUG，全是「调用了但没 import」或
 *   「import 了但模块没导出」，而且都被 `try {} catch {}` 吞掉，
 *   表现成"功能没生效"而不是"报错"，极难查。
 *
 * 检查三类问题：
 *   1. 调用了但没 import / 没定义（ReferenceError 的源头）
 *   2. 从某个模块 import 了它没导出的名字（SyntaxError 的源头，
 *      但如果是运行时才走的代码路径，可能被 catch 吞掉）
 *   3. 同名文件（容易 import 错，如 lib/vision.mjs vs lib/perception/vision.mjs）
 *
 * 用法：
 *   node plugin/tools/check-imports.mjs            # 扫整个 plugin/
 *   node plugin/tools/check-imports.mjs index.mjs  # 只扫一个文件
 *
 * 退出码：发现问题返回 1，干净返回 0（可接 CI）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.join(HERE, '..')
const ROOT = path.join(PLUGIN_DIR, '..')

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

const RED = (s) => `\x1b[31m${s}\x1b[0m`
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`
const DIM = (s) => `\x1b[2m${s}\x1b[0m`

/** 递归收集 .mjs / .js 文件 */
function collectFiles(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'tests' || e.name.startsWith('.')) continue
      collectFiles(p, out)
    } else if (/\.(mjs|js)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

/**
 * 去掉注释、字符串、模板字符串、正则字面量，只留代码骨架。
 * 这样才能避免把注释里提到的函数名、字符串里的 `foo()` 误判成调用。
 *
 * 正则字面量必须处理：`/['"]/g` 里的引号会被误当成字符串开头，
 * 一吞就吞到下一个引号，把后面的 export 全遮住（这坑我踩过）。
 */
function stripCommentsAndStrings(src) {
  let out = ''
  let i = 0
  const n = src.length
  // 上一个非空白字符，用来判断 `/` 是除号还是正则开头
  let lastMeaningful = ''

  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]

    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    // 正则字面量：`/` 前面是运算符/括号/逗号/等号/return 之类 → 是正则
    if (c === '/' && (lastMeaningful === '' || /[(,=:[!&|?{};+\-*%<>~^]|return|typeof|case|in|of/.test(lastMeaningful))) {
      i++
      let inClass = false
      while (i < n) {
        const ch = src[i]
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) {
          i++
          break
        } else if (ch === '\n') break // 不正则，回退
        i++
      }
      // 跳过 flags
      while (i < n && /[a-z]/i.test(src[i])) i++
      out += '0'
      lastMeaningful = '0'
      continue
    }
    // 字符串
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < n) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === quote) {
          i++
          break
        }
        i++
      }
      out += '""'
      lastMeaningful = '"'
      continue
    }
    out += c
    if (!/\s/.test(c)) {
      // 累积多字符标识符的尾字符，方便判断 return
      if (/[\w$]/.test(c)) lastMeaningful = (lastMeaningful + c).slice(-10)
      else lastMeaningful = c
    }
    i++
  }
  return out
}

/** 提取 import 的名字 */
function extractImports(code) {
  const named = new Map() // 名字 -> 来源
  const namespaces = new Map() // ns 名 -> 来源
  const defaults = new Map() // 默认导出名 -> 来源

  // import { a, b as c } from 'x'
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const from = m[2]
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const asMatch = t.match(/^(?:type\s+)?(\S+)\s+as\s+(\S+)$/)
      const name = asMatch ? asMatch[2] : t.replace(/^type\s+/, '')
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) named.set(name, from)
    }
  }
  // import * as ns from 'x'
  for (const m of code.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g)) {
    namespaces.set(m[1], m[2])
  }
  // import def from 'x'
  for (const m of code.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!namespaces.has(m[1])) defaults.set(m[1], m[2])
  }
  // 动态 import 的解构：import('x').then(([{ a, b }]) => …)
  for (const m of code.matchAll(/import\([^)]*\)[\s\S]{0,100}?\[\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t2 = part.trim()
      if (!t2) continue
      const asMatch = t2.match(/^(\S+)\s+as\s+(\S+)$/)
      const name = asMatch ? asMatch[2] : t2
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) named.set(name, '(dynamic)')
    }
  }
  // import 'x'（副作用）
  // 忽略

  return { named, namespaces, defaults }
}

/** 提取本文件内定义的名字 */
function extractLocalDefs(code) {
  const defs = new Set()

  // function foo / async function foo
  for (const m of code.matchAll(/(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) defs.add(m[1])
  // const/let/var foo = / const { a, b } = / const [a, b] =
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defs.add(m[1])
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().trim().split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defs.add(n)
    }
  }
  for (const m of code.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defs.add(n)
    }
  }
  // class Foo
  for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) defs.add(m[1])
  // 函数参数（含解构）
  for (const m of code.matchAll(/(?:function\s*\w*\s*|\(|,)\s*\{([^}]*)\}\s*\)?\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':')[0].split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defs.add(n)
    }
  }
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defs.add(n)
    }
  }
  // 解构参数：({ a, b: c, d = 1 }) / ([x, y]) 里的名字也要算已声明，
  // 否则 `function f({ onStart = null }) { onStart() }` 会被误报成「调用了没 import 的 onStart」。
  const addPatternNames = (src) => {
    if (!src) return
    for (const m of src.matchAll(/\{([^{}]*)\}|\[([^\[\]]*)\]/g)) {
      const body = m[1] ?? m[2] ?? ''
      for (const id of body.matchAll(/[A-Za-z_$][\w$]*/g)) defs.add(id[0])
    }
  }
  // 参数表要用括号配对来取：正则 [^)]* 会在默认值 `() => {}` 的第一个 ) 处断开
  for (const m of code.matchAll(/function\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/g)) {
    const open = m.index + m[0].length - 1
    let depth = 0
    for (let i = open; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') {
        depth--
        if (depth === 0) {
          addPatternNames(code.slice(open + 1, i))
          break
        }
      }
    }
  }
  for (const m of code.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) addPatternNames(m[1])
  // for...of / for...in 的循环变量
  for (const m of code.matchAll(/for\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) defs.add(m[1])
  // catch (e)
  for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) defs.add(m[1])

  return defs
}

/**
 * 常见的方法名 / 回调参数名，出现在「调用了但没 import」的误报里。
 * 这些几乎总是对象方法或 Promise 回调参数，不是全局函数。
 */
const METHOD_LIKE = new Set(
  (
    'constructor start stop status push pop shift unshift slice splice map filter reduce forEach find findIndex some every ' +
    'resolve reject render apply call bind dispose close destroy open read write send recv emit on off once then catch ' +
    'finally get set has add delete clear size keys values entries next throw return await load save run init update ' +
    'refresh reload reset sync flush commit rollback connect disconnect listen accept handle process tick step trigger ' +
    'notify subscribe unsubscribe publish dispatch invoke execute perform cancel abort pause resume ' +
    // 回调参数 / 局部变量常见的名字
    'onFrame onChunk onMerged onEvent onResult onError onDone getEmotion setEmotion getMood getPersona getMeta setMeta ' +
    // 解构参数里的回调名（createVoiceCall({ sendText, onState, isSpeaking }) 这类）
    'onState onStart onLevel sendText isSpeaking sendFn writeFn onChunkHandler getOriginal readFileSync ' +
    'isSignificantChange logDebugBridge ' +
    'ctxSelf self this2 that el els doc win'
  ).split(/\s+/),
)

/** JS 全局内置 + Node 全局 + 常见 Error 类 */
const BUILTIN = new Set(
  (
    'if for while switch catch function return typeof new await import require console Math JSON Object Array String ' +
    'Number Boolean Promise Set Map WeakMap WeakSet Date Error RegExp parseInt parseFloat isNaN setTimeout setInterval ' +
    'clearTimeout clearInterval encodeURIComponent decodeURIComponent Symbol BigInt Intl process Buffer URL fetch ' +
    'structuredClone queueMicrotask globalThis undefined null true false void delete in of instanceof do else try ' +
    'throw yield async class const let var export default from as get set static super this arguments eval Infinity ' +
    'NaN isFinite Reflect Proxy Atomics SharedArrayBuffer ArrayBuffer DataView Float32Array Float64Array ' +
    'Int8Array Int16Array Int32Array Uint8Array Uint16Array Uint32Array BigInt64Array BigUint64Array TextEncoder ' +
    'TextDecoder AbortController AbortSignal performance crypto setImmediate clearImmediate ' +
    'RangeError TypeError SyntaxError ReferenceError URIError EvalError AggregateError ' +
    // 浏览器全局（client.js 跑在页面里）
    'requestAnimationFrame cancelAnimationFrame requestIdleCallback document window navigator location ' +
    'localStorage sessionStorage Image Audio matchMedia getComputedStyle btoa atob HTMLElement Event ' +
    'CustomEvent MutationObserver ResizeObserver IntersectionObserver ' +
    'readFileSync writeFileSync appendFileSync existsSync unlinkSync mkdirSync readdirSync statSync rmSync copyFileSync ' +
    'createReadStream createWriteStream openSync closeSync readSync writeSync lstatSync realpathSync'
  ).split(/\s+/),
)

/**
 * 提取「被当作函数调用」的标识符。
 * 关键：排除 `obj.foo()` / `this.foo()` / `?.foo()` 里的 foo（那是方法，不是全局函数），
 * 以及对象字面量的键（`status: () => {}`）和类方法定义。
 */
function extractCalls(code) {
  const calls = new Map() // 名字 -> 首次出现的行号
  const lines = code.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    for (const m of line.matchAll(/([.?]?)(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const prefix = m[1]
      const name = m[2]
      // 前面有 . 或 ?. → 是方法调用，跳过
      if (prefix === '.' || prefix === '?') continue
      const before = line.slice(0, m.index).trimEnd()
      // function 声明本身
      if (/\b(function|async\s+function)\s*\*?$/.test(before)) continue
      // 对象字面量的键：`status: (` 或 `status: async (`
      if (/[A-Za-z_$][\w$]*\s*:\s*(async\s+)?$/.test(before) && !/\?\s*[^:]*:/.test(before)) continue
      // 类方法定义（缩进 + 名字 + 参数 + {）
      if (/^\s*$/.test(before.replace(/^\s*(async\s+|static\s+|get\s+|set\s+)*/, '')) && /\)\s*\{\s*$/.test(line.trim())) continue
      if (!calls.has(name)) calls.set(name, li + 1)
    }
  }
  return calls
}

/** 解析一个模块导出了哪些名字 */
function parseExports(filePath, cache = new Map()) {
  if (cache.has(filePath)) return cache.get(filePath)
  let src
  try {
    src = fs.readFileSync(filePath, 'utf8')
  } catch {
    cache.set(filePath, null)
    return null
  }
  const code = stripCommentsAndStrings(src)
  const names = new Set()

  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // export { a, b as c }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const asMatch = t.match(/(\S+)\s+as\s+(\S+)/)
      names.add(asMatch ? asMatch[2] : t)
    }
  }
  // export default
  if (/export\s+default/.test(code)) names.add('default')

  const result = { names, hasStar: /export\s*\*\s*from/.test(code) }
  cache.set(filePath, result)
  return result
}

/** 把 import 来源解析成绝对路径 */
function resolveModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null // node: 内置或裸包，跳过
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const ext of ['', '.mjs', '.js', '/index.mjs', '/index.js']) {
    const p = base + ext
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {}
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

const target = process.argv[2]
let files
if (target) {
  const p = path.isAbsolute(target) ? target : path.join(PLUGIN_DIR, target)
  files = fs.existsSync(p) ? [p] : []
  if (!files.length) {
    console.error(RED(`文件不存在: ${p}`))
    process.exit(1)
  }
} else {
  files = collectFiles(PLUGIN_DIR)
}

console.log(DIM(`扫描 ${files.length} 个文件…\n`))

const problems = { missingImport: [], badExport: [], allExports: new Map() }

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  let src
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }

  const code = stripCommentsAndStrings(src)
  // 注意：extractImports 必须用原始源码 —— strip 会把 import 里的模块路径也变成空字符串
  const { named, namespaces, defaults } = extractImports(src)
  const defs = extractLocalDefs(code)
  const calls = extractCalls(code)

  // ── 检查 1：调用了但没 import / 没定义 ──
  for (const [name, lineNo] of calls) {
    if (named.has(name) || namespaces.has(name) || defaults.has(name)) continue
    if (defs.has(name)) continue
    if (BUILTIN.has(name)) continue
    if (METHOD_LIKE.has(name)) continue
    // 只报「看起来像模块函数」的：长度 >= 6 且含大写字母（describeScreen / installLlmBridge / ingestReincarnation）
    // 纯小写短名（resolve / status / start / push）大多是方法或回调参数，误报率太高
    if (name.length < 6) continue
    if (!/[A-Z]/.test(name) && name.length < 10) continue
    problems.missingImport.push({ file: rel, line: lineNo, name })
  }

  // ── 检查 2：import 了模块没导出的名字 ──
  for (const [name, spec] of named) {
    const resolved = resolveModule(file, spec)
    if (!resolved) continue
    const ex = parseExports(resolved)
    if (!ex) continue
    if (!ex.names.has(name) && !ex.hasStar) {
      problems.badExport.push({
        file: rel,
        name,
        from: spec,
        resolved: path.relative(ROOT, resolved).replace(/\\/g, '/'),
        available: [...ex.names],
      })
    }
  }
}

// ── 检查 3：同名文件 ──
const byBasename = new Map()
for (const f of files) {
  const base = path.basename(f)
  if (!byBasename.has(base)) byBasename.set(base, [])
  byBasename.get(base).push(path.relative(ROOT, f).replace(/\\/g, '/'))
}
const dupNames = [...byBasename.entries()].filter(([, list]) => list.length > 1)

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────

let fail = 0

if (problems.missingImport.length) {
  fail += problems.missingImport.length
  console.log(RED('=== ❌ 调用了但没 import / 没定义 ==='))
  for (const p of problems.missingImport) {
    console.log(`  ${RED('✗')} ${p.file}:${p.line}  ${RED(p.name)}`)
  }
  console.log(DIM('  → 这些会在运行时抛 ReferenceError，如果外面有 catch {} 就会被静默吞掉\n'))
} else {
  console.log(GREEN('=== ✅ 没有漏 import ===') + '\n')
}

if (problems.badExport.length) {
  fail += problems.badExport.length
  console.log(RED('=== ❌ import 了模块没导出的名字 ==='))
  for (const p of problems.badExport) {
    console.log(`  ${RED('✗')} ${p.file}  从 ${p.from} 导入 ${RED(p.name)}`)
    console.log(DIM(`     实际导出: ${p.available.join(', ') || '(无)'}`))
  }
  console.log(DIM('  → 这类是 SyntaxError 的源头：模块加载时就崩，但如果只在不常走的路径上，可能很久才发现\n'))
} else {
  console.log(GREEN('=== ✅ 所有 import 的名字都有对应导出 ===') + '\n')
}

if (dupNames.length) {
  console.log(YELLOW('=== ⚠️ 同名文件（容易 import 错）==='))
  for (const [name, list] of dupNames) {
    console.log(`  ${YELLOW('!')} ${name}`)
    for (const p of list) console.log(DIM(`      ${p}`))
  }
  console.log(DIM('  → 2026-11-19 就栽过：lib/vision.mjs 和 lib/perception/vision.mjs 同名，import 错了\n'))
} else {
  console.log(GREEN('=== ✅ 没有同名文件冲突 ===') + '\n')
}

// ─────────────────────────────────────────────────────────────
console.log('─'.repeat(60))
const hasErrors = fail > 0
if (!hasErrors && dupNames.length === 0) {
  console.log(GREEN(`✅ 全部通过（${files.length} 个文件）`))
  process.exit(0)
}
if (!hasErrors) {
  // 只有同名文件：是提醒，不是错误，退出码 0（不阻塞脚本链）
  console.log(YELLOW(`⚠️ ${dupNames.length} 组同名文件（提醒，不算错误）`) + DIM(` — 扫了 ${files.length} 个文件`))
  process.exit(0)
}
console.log(
  RED(`${fail} 个错误`) +
    (dupNames.length ? '，' + YELLOW(`${dupNames.length} 组同名文件`) : '') +
    DIM(` — 扫了 ${files.length} 个文件`),
)
process.exit(1)
