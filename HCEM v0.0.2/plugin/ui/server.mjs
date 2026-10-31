// HCEM 本地设置页（阶段 7）
import { createServer } from 'node:http'
import { readFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { loadSettings, saveSettings } from '../lib/settings.mjs'
import { loadPersona, savePersona } from '../lib/persona.mjs'
import { DB_PATH } from '../lib/store.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.HCEM_UI_PORT || 8082)
const DATA_DIR = process.env.HCEM_DATA_DIR || join(__dirname, '..', '..', 'data')
const SETTINGS_PATH = join(DATA_DIR, 'settings.json')

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => {
      s += c
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function readDbState() {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const row = db.prepare("SELECT H, S, L FROM emotions WHERE id = 'global'").get()
    const count = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL').get().c
    db.close()
    return { hsl: row ? { H: row.H, S: row.S, L: row.L } : null, memories: Number(count) }
  } catch (e) {
    return { hsl: null, memories: 0, dbError: String((e && e.message) || e) }
  }
}

function readMemories(limit = 20) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const rows = db
      .prepare(
        'SELECT text, zone, L, created_at FROM memories WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit)
    db.close()
    return rows.map((r) => ({
      text: String(r.text).slice(0, 120),
      zone: r.zone,
      L: Number(r.L),
      createdAt: r.created_at,
    }))
  } catch {
    return []
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readFileSync(join(__dirname, 'index.html')))
      return
    }

    if (req.method === 'GET' && p === '/hsl') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(readFileSync(join(__dirname, 'hsl.html')))
      return
    }

    if (p === '/api/probe' && req.method === 'GET') {
      try {
        const line = `${new Date().toISOString()} hit from ${req.headers.referer || req.headers.origin || 'unknown'}\n`
        const fs = await import('node:fs')
        fs.appendFileSync(join(DATA_DIR, 'client-probe.log'), line)
      } catch {}
      res.writeHead(200, { 'content-type': 'image/gif' })
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
      return
    }

    // 呼出本地情绪悬浮窗（启动 HCEM情绪悬浮窗.cmd）
    if (p === '/api/launch-window' && req.method === 'POST') {
      try {
        const cmdPath = join(__dirname, 'HCEM情绪悬浮窗.cmd')
        const child = spawn('cmd.exe', ['/c', 'start', '', cmdPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        child.unref()
        return json(res, 200, { ok: true })
      } catch (error) {
        return json(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    }

    if (p === '/api/state' && req.method === 'GET') {
      let pluginRunning = false
      try {
        const hb = JSON.parse(readFileSync(join(DATA_DIR, 'plugin-heartbeat.json'), 'utf8'))
        pluginRunning = Date.now() - Number(hb.ts ?? 0) < 45000
      } catch {}
      const s = loadSettings(SETTINGS_PATH)
      return json(res, 200, {
        enabled: s.enabled,
      pluginRunning,
        sliders: s.sliders,
        natural: s.natural,
        talkativeness: s.talkativeness,
        emergencyContacts: s.emergencyContacts,
        hasDeletePassword: !!s.deletePassword,
        ...readDbState(),
        personaChars: (loadPersona() || '').length,
      })
    }

    if (p === '/api/settings' && req.method === 'PUT') {
      const body = await readBody(req)
      const cur = loadSettings(SETTINGS_PATH)
      const next = {
        ...cur,
        ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
        ...(body.sliders ? { sliders: { ...cur.sliders, ...body.sliders } } : {}),
        ...(body.talkativeness !== undefined ? { talkativeness: body.talkativeness } : {}),
        ...(body.emergencyContacts !== undefined ? { emergencyContacts: body.emergencyContacts } : {}),
        ...(body.deletePassword !== undefined ? { deletePassword: String(body.deletePassword) } : {}),
      }
      const saved = saveSettings(SETTINGS_PATH, next)
      return json(res, 200, {
        ok: true,
        enabled: saved.enabled,
        sliders: saved.sliders,
        talkativeness: saved.talkativeness,
        emergencyContacts: saved.emergencyContacts,
        hasDeletePassword: !!saved.deletePassword,
      })
    }

    if (p === '/api/persona') {
      if (req.method === 'GET') return json(res, 200, { ok: true, text: loadPersona() || '' })
      if (req.method === 'PUT') {
        const body = await readBody(req)
        savePersona(String(body.text ?? ''))
        return json(res, 200, { ok: true, chars: String(body.text ?? '').length })
      }
    }

    if (p === '/api/memories' && req.method === 'GET') {
      return json(res, 200, { ok: true, entries: readMemories(20) })
    }

    if (p === '/api/delete-all' && req.method === 'POST') {
      const body = await readBody(req)
      if (body.confirm !== 'DELETE') return json(res, 400, { ok: false, error: 'confirm-required' })
      const s = loadSettings(SETTINGS_PATH)
      if (s.deletePassword && String(body.password ?? '') !== s.deletePassword) {
        return json(res, 403, { ok: false, error: 'wrong-password' })
      }
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const trash = join(DATA_DIR, `_trash-${stamp}`)
      mkdirSync(trash, { recursive: true })
      const moved = []
      for (const f of ['hcem.sqlite', 'hcem.sqlite-wal', 'hcem.sqlite-shm', 'settings.json']) {
        try {
          renameSync(join(DATA_DIR, f), join(trash, f))
          moved.push(f)
        } catch {
          // 文件可能不存在
        }
      }
      for (const dir of ['persona', 'people', 'journal']) {
        try {
          renameSync(join(DATA_DIR, dir), join(trash, dir))
          moved.push(dir)
        } catch {
          // 目录可能不存在
        }
      }
      return json(res, 200, { ok: true, moved, trash, note: '数据已移入 _trash 目录，可手动删除；请重启 DSH' })
    }

    json(res, 404, { ok: false, error: 'not-found' })
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[hcem-ui] http://127.0.0.1:${PORT}`)
})