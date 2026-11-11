import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.HCEM_DATA_DIR || join(__dirname, '..', '..', 'data')
export const DB_PATH = process.env.HCEM_DB_PATH || join(DATA_DIR, 'hcem.sqlite')
export const SCHEMA_VERSION = 6

// 记忆分区：每区一个独立 SQLite 文件（data/zones/<file>.sqlite）
// 生活/知识区共用 life_knowledge.sqlite（zone 字段区分）
// 冷存按年分文件：data/zones/cold/<yyyy>.sqlite
export const ZONES = ['context', 'pool_fast', 'pool_observe', 'pool_keep', 'life', 'knowledge', 'cold', 'reincarnation']
const ZONE_FILE = {
  context: 'context',
  pool_fast: 'pool_fast',
  pool_observe: 'pool_observe',
  pool_keep: 'pool_keep',
  life: 'life_knowledge',
  knowledge: 'life_knowledge',
  cold: 'cold',
  reincarnation: 'reincarnation',
}

function getMetaValue(db, key) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : null
  } catch {
    return null
  }
}

function setMetaValue(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

const MEMORY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    summary TEXT,
    level TEXT NOT NULL DEFAULT 'full',
    L REAL NOT NULL DEFAULT 1.0,
    alpha_H REAL,
    alpha_S REAL,
    beta_H REAL,
    gamma TEXT,
    zone TEXT NOT NULL DEFAULT 'context',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT,
    access_count INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    embedding BLOB,
    embedding_dim INTEGER,
    gamma_value REAL,
    modality TEXT NOT NULL DEFAULT 'text',
    sensory REAL NOT NULL DEFAULT 1,
    time_start REAL,
    time_end REAL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
`

function migrateMain(db, logger) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS emotions (
      id TEXT PRIMARY KEY,
      H REAL NOT NULL,
      S REAL NOT NULL,
      L REAL NOT NULL,
      session_id TEXT,
      cold INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `)
  // 主库也保留一张 memories 表（兼容旧代码 + 迁移来源）
  db.exec(MEMORY_TABLE_SQL)
  setMetaValue(db, 'schema_version', String(SCHEMA_VERSION))
  logger.info?.('[hcem] main store ready')
}

function migrateZone(db, zone, logger) {
  db.exec(MEMORY_TABLE_SQL)
  const cols = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.name)
  if (!cols.includes('gamma_value')) db.exec('ALTER TABLE memories ADD COLUMN gamma_value REAL')
  if (!cols.includes('modality')) db.exec("ALTER TABLE memories ADD COLUMN modality TEXT NOT NULL DEFAULT 'text'")
  if (!cols.includes('sensory')) db.exec('ALTER TABLE memories ADD COLUMN sensory REAL NOT NULL DEFAULT 1')
  if (!cols.includes('time_start')) db.exec('ALTER TABLE memories ADD COLUMN time_start REAL')
  if (!cols.includes('time_end')) db.exec('ALTER TABLE memories ADD COLUMN time_end REAL')
  // v6：重要标记（0~2）与延寿截止时间
  if (!cols.includes('pinned')) db.exec('ALTER TABLE memories ADD COLUMN pinned REAL NOT NULL DEFAULT 0')
  if (!cols.includes('extended_until')) db.exec('ALTER TABLE memories ADD COLUMN extended_until TEXT')
  if (!cols.includes('zone_since')) db.exec('ALTER TABLE memories ADD COLUMN zone_since TEXT')
  // v7：δ 拆分为缓冲池 δ₁ 与长期区 δ₂
  if (!cols.includes('delta_pool')) db.exec('ALTER TABLE memories ADD COLUMN delta_pool REAL NOT NULL DEFAULT 0')
  if (!cols.includes('delta_long')) db.exec('ALTER TABLE memories ADD COLUMN delta_long REAL NOT NULL DEFAULT 0')
  if (!cols.includes('delta_decayed_at')) db.exec('ALTER TABLE memories ADD COLUMN delta_decayed_at TEXT')
  // v8：trauma 戳（辱骂记忆的痛感强度 + 来源）
  if (!cols.includes('trauma')) db.exec('ALTER TABLE memories ADD COLUMN trauma REAL NOT NULL DEFAULT 0')
  if (!cols.includes('trauma_source')) db.exec('ALTER TABLE memories ADD COLUMN trauma_source TEXT')
  logger?.info?.(`[hcem] zone store ready: ${zone}`)
}

function toFloat32Array(buffer) {
  if (!buffer) return null
  try {
    if (buffer instanceof Float32Array) return buffer
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    const copy = new Uint8Array(u8.byteLength)
    copy.set(u8)
    return new Float32Array(copy.buffer)
  } catch {
    return null
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const INSERT_SQL = `INSERT INTO memories
   (id, text, summary, level, L, alpha_H, alpha_S, beta_H, gamma, zone, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding, embedding_dim, gamma_value, modality, sensory, time_start, time_end, pinned, extended_until, zone_since, delta_pool, delta_long, trauma, trauma_source)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   text = excluded.text, summary = excluded.summary, level = excluded.level, L = excluded.L,
   alpha_H = excluded.alpha_H, alpha_S = excluded.alpha_S, beta_H = excluded.beta_H, gamma = excluded.gamma,
   zone = excluded.zone, updated_at = excluded.updated_at,
   embedding = excluded.embedding, embedding_dim = excluded.embedding_dim,
   gamma_value = excluded.gamma_value, pinned = excluded.pinned, extended_until = excluded.extended_until, zone_since = excluded.zone_since, delta_pool = excluded.delta_pool, delta_long = excluded.delta_long, trauma = excluded.trauma, trauma_source = excluded.trauma_source`

export class Store {
  constructor(db, logger, dataDir = DATA_DIR) {
    this.db = db
    this.logger = logger
    this.dataDir = dataDir
    this.zonesDir = join(dataDir, 'zones')
    this.zoneDbs = new Map()
    // 内存向量索引：id → { vec, zone }，检索走内存不扫盘
    this.vectorIndex = new Map()
    this.vectorIndexReady = false
  }

  // 加载所有分区（含冷存各年份）的向量到内存
  ensureVectorIndex() {
    if (this.vectorIndexReady) return
    this.vectorIndex.clear()
    try {
      for (const db of this.allZoneDbs()) {
        const rows = db.prepare('SELECT id, zone, embedding FROM memories WHERE deleted_at IS NULL AND embedding IS NOT NULL').all()
        for (const row of rows) {
          const vec = toFloat32Array(row.embedding)
          if (vec) this.vectorIndex.set(row.id, { vec, zone: row.zone })
        }
      }
    } catch (error) {
      this.logger?.warn?.(`[hcem] vector index load failed: ${String((error && error.message) || error)}`)
    }
    this.vectorIndexReady = true
    this.logger?.info?.(`[hcem] vector index ready: ${this.vectorIndex.size} vectors`)
  }

  indexMemory(id, zone, embedding) {
    if (!this.vectorIndexReady || !embedding) return
    this.vectorIndex.set(id, { vec: embedding instanceof Float32Array ? embedding : new Float32Array(embedding), zone })
  }

  unindexMemory(id) {
    this.vectorIndex.delete(id)
  }

  // ---------- 分区库 ----------
  zoneDb(zone) {
    const z = ZONES.includes(zone) ? zone : 'context'
    const file = ZONE_FILE[z] || z
    let db = this.zoneDbs.get(file)
    if (!db) {
      mkdirSync(this.zonesDir, { recursive: true })
      const p = join(this.zonesDir, `${file}.sqlite`)
      db = new DatabaseSync(p)
      db.exec('PRAGMA journal_mode = WAL;')
      db.exec('PRAGMA busy_timeout = 5000;')
      migrateZone(db, z, this.logger)
      this.zoneDbs.set(file, db)
    }
    return db
  }

  // 冷存按年分文件：zones/cold/<yyyy>.sqlite
  coldDb(year) {
    const y = String(year || new Date().getFullYear())
    const file = `cold/${y}`
    let db = this.zoneDbs.get(file)
    if (!db) {
      const dir = join(this.zonesDir, 'cold')
      mkdirSync(dir, { recursive: true })
      db = new DatabaseSync(join(dir, `${y}.sqlite`))
      db.exec('PRAGMA journal_mode = WAL;')
      db.exec('PRAGMA busy_timeout = 5000;')
      migrateZone(db, 'cold', this.logger)
      this.zoneDbs.set(file, db)
    }
    return db
  }

  coldDbs() {
    const dir = join(this.zonesDir, 'cold')
    const years = new Set()
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.sqlite')) years.add(f.slice(0, -7))
      }
    } catch {
      // ignore
    }
    years.add(String(new Date().getFullYear()))
    return [...years].map((y) => this.coldDb(y))
  }

  allZoneDbs() {
    return [...ZONES.filter((z) => z !== 'cold').map((z) => this.zoneDb(z)), ...this.coldDbs()]
  }

  // 找到某条记忆所在的区库（cold 遍历所有年份）
  findZoneOf(id) {
    for (const z of ZONES) {
      if (z === 'cold') {
        for (const db of this.coldDbs()) {
          const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(id)
          if (row) return { zone: 'cold', db }
        }
        continue
      }
      const row = this.zoneDb(z).prepare('SELECT id FROM memories WHERE id = ?').get(id)
      if (row) return { zone: z, db: this.zoneDb(z) }
    }
    return null
  }

  // ---------- meta / 情绪（主库） ----------
  getMeta(key) {
    return getMetaValue(this.db, key)
  }

  setMeta(key, value) {
    setMetaValue(this.db, key, String(value))
  }

  getEmotion(id = 'global') {
    const row = this.db.prepare('SELECT * FROM emotions WHERE id = ?').get(id)
    return row || null
  }

  setEmotion(state, id = 'global') {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO emotions (id, H, S, L, session_id, cold, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           H = excluded.H, S = excluded.S, L = excluded.L,
           session_id = excluded.session_id, cold = excluded.cold, updated_at = excluded.updated_at`,
      )
      .run(id, state.H, state.S, state.L, state.sessionId ?? null, state.cold ? 1 : 0, now)
    return this.getEmotion(id)
  }

  // ---------- 记忆（分区库） ----------
  putMemory(memory) {
    const now = new Date().toISOString()
    const id = memory.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const zone = memory.zone ?? 'context'
    const embedding = Array.isArray(memory.embedding)
      ? Buffer.from(new Float32Array(memory.embedding).buffer)
      : null
    const targetDb =
      zone === 'cold' ? this.coldDb(new Date(memory.createdAt ?? now).getFullYear()) : this.zoneDb(zone)
    targetDb
      .prepare(INSERT_SQL)
      .run(
        id,
        memory.text,
        memory.summary ?? null,
        memory.level ?? 'full',
        memory.L ?? 1.0,
        memory.alphaH ?? null,
        memory.alphaS ?? null,
        memory.betaH ?? null,
        memory.gamma ?? null,
        zone,
        memory.createdAt ?? now,
        now,
        memory.lastAccessedAt ?? null,
        memory.accessCount ?? 0,
        memory.deletedAt ?? null,
        embedding,
        memory.embedding ? memory.embedding.length : null,
        memory.gammaValue ?? null,
        memory.modality ?? 'text',
        memory.sensory ?? 1,
        memory.timeStart ?? null,
        memory.timeEnd ?? null,
        memory.pinned ?? 0,
        memory.extendedUntil ?? null,
        memory.zoneSince ?? memory.createdAt ?? now,
        memory.deltaPool ?? 0,
        memory.deltaLong ?? 0,
        memory.trauma ?? 0,
        memory.traumaSource ?? null,
      )
    // 增量维护内存向量索引
    if (Array.isArray(memory.embedding)) this.indexMemory(id, zone, new Float32Array(memory.embedding))
    return id
  }

  getMemory(id) {
    const found = this.findZoneOf(id)
    if (!found) return null
    return found.db.prepare('SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL').get(id) || null
  }

  listMemories({ zone, limit = 100, includeDeleted = false } = {}) {
    const zones = zone ? [zone] : ZONES
    const rows = []
    for (const z of zones) {
      const dbs = z === 'cold' ? this.coldDbs() : [this.zoneDb(z)]
      for (const db of dbs) {
        let sql = 'SELECT * FROM memories WHERE 1 = 1'
        if (!includeDeleted) sql += ' AND deleted_at IS NULL'
        sql += ' AND zone = ?'
        const params = [z]
        sql += ' ORDER BY created_at DESC LIMIT ?'
        params.push(limit)
        try {
          rows.push(...db.prepare(sql).all(...params))
        } catch {
          // ignore
        }
      }
    }
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    return rows.slice(0, limit)
  }

  deleteMemory(id, hard = false) {
    const found = this.findZoneOf(id)
    if (!found) return
    if (hard) {
      found.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    } else {
      found.db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    }
    this.unindexMemory(id)
  }

  // 被调用：刷新访问时间/次数；bumpL 时提升清晰度；δ 按区累计
  touchMemory(id, bumpL = 0) {
    const found = this.findZoneOf(id)
    if (!found) return
    const row = found.db.prepare('SELECT L, gamma_value, delta_pool, delta_long, zone FROM memories WHERE id = ?').get(id)
    const current = Number(row?.L ?? 1)
    const nextL = Math.min(1, current + Number(bumpL || 0))
    // 被想起一次：δ 按区 +1（缓冲池 → δ₁；生活/知识 → δ₂），γ 也略微提升
    const isPool = ['context', 'pool_fast', 'pool_observe', 'pool_keep'].includes(row.zone)
    const nextPool = Number(row?.delta_pool ?? 0) + (isPool ? 1 : 0)
    const nextLong = Number(row?.delta_long ?? 0) + (isPool ? 0 : 1)
    const currentGamma = Number(row?.gamma_value ?? 0)
    const nextGamma = Math.min(1, currentGamma + 0.05)
    found.db
      .prepare(
        'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1, L = ?, gamma_value = ?, delta_pool = ?, delta_long = ? WHERE id = ?',
      )
      .run(new Date().toISOString(), nextL, nextGamma, nextPool, nextLong, id)
  }

  updateMemoryL(id, L, level) {
    const found = this.findZoneOf(id)
    if (!found) return
    found.db
      .prepare('UPDATE memories SET L = ?, level = ?, updated_at = ? WHERE id = ?')
      .run(L, level, new Date().toISOString(), id)
  }

  // δ 衰减后写回（支持浮点）
  setAccessCount(id, delta) {
    const found = this.findZoneOf(id)
    if (!found) return
    found.db.prepare('UPDATE memories SET access_count = ? WHERE id = ?').run(Number(delta ?? 0), id)
  }

  // 更新 δ₁/δ₂（decayedAt：本次衰减时间，用于幂等衰减）
  setDeltas(id, pool, long, decayedAt = null) {
    const found = this.findZoneOf(id)
    if (!found) return
    if (decayedAt) {
      found.db.prepare('UPDATE memories SET delta_pool = ?, delta_long = ?, delta_decayed_at = ? WHERE id = ?').run(Number(pool ?? 0), Number(long ?? 0), decayedAt, id)
    } else {
      found.db.prepare('UPDATE memories SET delta_pool = ?, delta_long = ? WHERE id = ?').run(Number(pool ?? 0), Number(long ?? 0), id)
    }
  }

  // 延寿：设置延寿截止时间
  extendMemory(id, untilIso) {
    const found = this.findZoneOf(id)
    if (!found) return
    found.db.prepare('UPDATE memories SET extended_until = ? WHERE id = ?').run(untilIso, id)
  }

  // 加 pin（按区上限：缓冲池 1、生活/知识/冷存 2）
  addPin(id, amount = 0.5) {
    const found = this.findZoneOf(id)
    if (!found) return null
    const row = found.db.prepare('SELECT pinned, zone FROM memories WHERE id = ?').get(id)
    if (!row) return null
    const cap = row.zone === 'life' || row.zone === 'knowledge' || row.zone === 'cold' ? 2 : 1
    const next = Math.max(0, Math.min(cap, Number(row.pinned ?? 0) + Number(amount || 0)))
    found.db.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(next, id)
    return next
  }

  // 跨区迁移：同库直接改 zone；跨库读出整行 → 写入新区库 → 删除旧行
  updateZone(id, zone, at = new Date().toISOString()) {
    const found = this.findZoneOf(id)
    if (!found) return
    if (found.zone === zone) return
    const sameFile = (ZONE_FILE[found.zone] || found.zone) === (ZONE_FILE[zone] || zone)
    if (sameFile) {
      found.db
        .prepare('UPDATE memories SET zone = ?, updated_at = ?, zone_since = ? WHERE id = ?')
        .run(zone, at, at, id)
      return
    }
    const row = found.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    if (!row) return
    // 冷存按记忆创建年份分文件
    const target = zone === 'cold' ? this.coldDb(new Date(row.created_at).getFullYear()) : this.zoneDb(zone)
    target.prepare(
      `INSERT INTO memories
         (id, text, summary, level, L, alpha_H, alpha_S, beta_H, gamma, zone, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding, embedding_dim, gamma_value, modality, sensory, time_start, time_end, pinned, extended_until, zone_since, delta_pool, delta_long)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET zone = excluded.zone, updated_at = excluded.updated_at, pinned = excluded.pinned, extended_until = excluded.extended_until, zone_since = excluded.zone_since`,
    ).run(
      row.id, row.text, row.summary, row.level, row.L, row.alpha_H, row.alpha_S, row.beta_H, row.gamma,
      zone, row.created_at, at, row.last_accessed_at, row.access_count, row.deleted_at,
      row.embedding, row.embedding_dim, row.gamma_value, row.modality, row.sensory, row.time_start, row.time_end,
      row.pinned ?? 0, row.extended_until ?? null, at, row.delta_pool ?? 0, row.delta_long ?? 0,
    )
    found.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    // 索引里的 zone 同步更新
    const indexed = this.vectorIndex.get(id)
    if (indexed) indexed.zone = zone
  }

  searchMemories(queryEmbedding, topK = 5) {
    // 优先走内存向量索引（不扫盘）；未就绪时回退全量扫描
    if (!this.vectorIndexReady) this.ensureVectorIndex()
    if (this.vectorIndexReady) {
      const scored = []
      for (const [id, item] of this.vectorIndex) {
        const similarity = cosineSimilarity(queryEmbedding, item.vec)
        if (similarity > 0) scored.push({ id, similarity })
      }
      scored.sort((a, b) => b.similarity - a.similarity)
      return scored
        .slice(0, topK)
        .map(({ id, similarity }) => {
          const row = this.getMemory(id)
          return row ? { ...row, similarity } : null
        })
        .filter(Boolean)
    }
    const scored = []
    for (const z of ZONES) {
      const dbs = z === 'cold' ? this.coldDbs() : [this.zoneDb(z)]
      for (const db of dbs) {
        let rows = []
        try {
          rows = db
            .prepare('SELECT * FROM memories WHERE deleted_at IS NULL AND embedding IS NOT NULL AND zone = ?')
            .all(z)
        } catch {
          continue
        }
        for (const row of rows) {
          const vec = toFloat32Array(row.embedding)
          if (!vec) continue
          const similarity = cosineSimilarity(queryEmbedding, vec)
          if (similarity > 0) scored.push({ ...row, similarity })
        }
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity)
    return scored.slice(0, topK)
  }

  loadJSON(name) {
    try {
      return JSON.parse(readFileSync(join(this.dataDir, name), 'utf8'))
    } catch {
      return null
    }
  }

  saveJSON(name, data) {
    mkdirSync(this.dataDir, { recursive: true })
    writeFileSync(join(this.dataDir, name), JSON.stringify(data, null, 2), 'utf8')
  }

  // 把主库旧 memories 表按 zone 拆分到分区库（只执行一次）
  migrateLegacyMemories() {
    try {
      const legacy = this.db.prepare('SELECT * FROM memories').all()
      if (legacy.length === 0) return 0
      let moved = 0
      for (const row of legacy) {
        const zone = ZONES.includes(row.zone) ? row.zone : 'context'
        const targetDb =
          zone === 'cold' ? this.coldDb(new Date(row.created_at).getFullYear()) : this.zoneDb(zone)
        targetDb
          .prepare(
            `INSERT OR REPLACE INTO memories
               (id, text, summary, level, L, alpha_H, alpha_S, beta_H, gamma, zone, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding, embedding_dim, gamma_value, modality, sensory, time_start, time_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id, row.text, row.summary, row.level, row.L, row.alpha_H, row.alpha_S, row.beta_H, row.gamma,
            zone, row.created_at, row.updated_at, row.last_accessed_at, row.access_count, row.deleted_at,
            row.embedding, row.embedding_dim, row.gamma_value, row.modality, row.sensory, row.time_start, row.time_end,
          )
        moved += 1
      }
      this.db.prepare('DELETE FROM memories').run()
      this.logger?.info?.(`[hcem] migrated ${moved} legacy memories into zone files`)
      return moved
    } catch (error) {
      this.logger?.warn?.(`[hcem] legacy memory migration failed: ${String((error && error.message) || error)}`)
      return 0
    }
  }

  close() {
    for (const db of this.zoneDbs.values()) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    this.zoneDbs.clear()
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}

export function openStore(logger = console, dbPath = DB_PATH) {
  try {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    migrateMain(db, logger)
    const store = new Store(db, logger, dirname(dbPath))
    // 隐藏的创建签名（不入提示词、不影响运行）
    try {
      if (!store.getMeta('_sig')) store.setMeta('_sig', '5p6C5p6rQuermVVJRDMwOTQxNzLlkozku5bnmoTlvpflipvliqnmiYtEZWVwU2Vlaw==')
    } catch {
      // ignore
    }
    const moved = store.migrateLegacyMemories()
    if (moved > 0) logger.info?.(`[hcem] store ready (${moved} memories split into zone files)`)
    else logger.info?.(`[hcem] store ready: ${dbPath}`)
    return store
  } catch (error) {
    logger.warn?.(`[hcem] store open failed: ${String((error && error.message) || error)}`)
    return null
  }
}
