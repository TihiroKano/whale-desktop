// 桌面版鲸鱼挂件的本地数据/素材服务。
// 复用 DSH 插件的余额 + 峰谷定价 + 小鲸鱼记账逻辑，
// 以便前端 widget.js 零改动直接跑。
const fs = require('fs')
const path = require('path')
const http = require('http')
const credentials = require('./credentials')

const APP_DIR = __dirname
const ASSET_DIR = path.join(APP_DIR, 'assets')
const DATA_DIR = process.env.WHALE_DATA_DIR || APP_DIR

// ---------- 峰谷定价（与插件一致） ----------
const PEAK_HOURS = [[9, 12], [14, 18]]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25000

// 设置窗管理的两个凭据（getStatus 的展示键 → 凭据名/环境变量名映射）
const CREDENTIAL_KEYS = [
  { key: 'apiKey', name: 'DEEPSEEK_API_KEY' },
  { key: 'platformToken', name: 'DEEPSEEK_PLATFORM_TOKEN' },
]

// ---------- 工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function todayKey(now) {
  const d = now ? new Date(now) : new Date()
  const p = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const num = x => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
  return (
    infos.find(x => x && x.currency === 'CNY' && num(x) > 0) ||
    infos.find(x => num(x) > 0) ||
    infos.find(x => x && x.currency === 'CNY') ||
    infos[0]
  )
}

// ---------- 余额拉取 ----------
async function fetchBalance(apiKey) {
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(20000),
      })
    } catch (err) {
      lastErr = err
      if (attempt === 0) await sleep(500)
      continue
    }
    if (!res.ok) {
      lastErr = new Error('HTTP ' + res.status)
      if (res.status < 500) break
      if (attempt === 0) await sleep(500)
      continue
    }
    let data
    try { data = await res.json() } catch (e) {
      return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
    }
    const info = pickBalanceInfo(data && data.balance_infos)
    if (!info || info.total_balance === undefined) {
      return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
    }
    return {
      ok: true,
      totalBalance: Number(info.total_balance),
      currency: String(info.currency || 'CNY'),
      updatedAt: new Date().toISOString(),
    }
  }
  const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
  return {
    ok: false,
    code: 'HTTP',
    transient,
    error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
  }
}

// ---------- 小鲸鱼记账（余额差值） ----------
const USAGE_FILE = path.join(DATA_DIR, '.dshw-usage.json')
function readUsageLedger() {
  try {
    const p = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
    if (p && typeof p === 'object' && typeof p.date === 'string') return p
  } catch (e) {}
  return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
}
function writeUsageLedger(led) {
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(led), 'utf8') } catch (e) {}
}
function recordLedgerUsage(currentBalance, currency) {
  const t = todayKey()
  let led = readUsageLedger()
  const cur = String(currency || '')
  const currencyChanged = typeof led.lastCurrency === 'string' && led.lastCurrency !== '' &&
    cur !== '' && led.lastCurrency !== cur
  if (led.date !== t) {
    if (led.date && typeof led.todayUsage === 'number') {
      led.history = led.history || {}
      led.history[led.date] = led.todayUsage
    }
    led.date = t
    led.lastBalance = currentBalance
    led.lastCurrency = cur
    led.todayUsage = 0
  } else if (currencyChanged) {
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
    if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
      led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  }
  const keys = Object.keys(led.history || {}).sort()
  while (keys.length > 30) delete led.history[keys.shift()]
  writeUsageLedger(led)
  return led
}

// ---------- 令牌模式（可选，精确到每小时） ----------
function computeTodayUsage(data) {
  let d = data
  if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
  else if (d && d.data && Array.isArray(d.data.series)) d = d.data
  const series = Array.isArray(d.series) ? d.series : null
  if (!series || series.length === 0) return null
  let cost = 0
  let tokens = 0
  let hitTokens = 0
  let missTokens = 0
  let found = false
  for (const s of series) {
    if (!s || typeof s !== 'object') continue
    const p = priceFor(s.model)
    const buckets = Array.isArray(s.buckets) ? s.buckets : []
    for (const b of buckets) {
      const u = b && b.usage
      if (!u || typeof u !== 'object') continue
      const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
      const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
      const out = Number(u.RESPONSE_TOKEN) || 0
      if (hit + miss + out === 0) continue
      found = true
      tokens += hit + miss + out
      hitTokens += hit
      missTokens += miss
      const pi = isPeakTime(b.time) ? 1 : 0
      cost += (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi]
    }
  }
  return found ? { amount: cost, tokens, hitTokens, missTokens } : null
}
async function fetchUsageByToken(token) {
  const clean = String(token).replace(/^Bearer\s+/i, '')
  try {
    const now = new Date()
    const tz = -now.getTimezoneOffset() * 60
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
    const end = start + 86400
    const url = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=' + start + '&end=' + end + '&tz=' + tz
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + clean }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { error: 'http ' + res.status }
    const data = await res.json()
    const u = computeTodayUsage(data)
    if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens, hitTokens: u.hitTokens, missTokens: u.missTokens }
    return { error: 'no usage' }
  } catch (err) {
    return { error: String((err && err.message) || err) }
  }
}

// ---------- size 配置 ----------
// 字段集与 DSH 插件 v0.2.10 的 size.json 保持一致（turnCost/scrollGap 三项
// 在桌面版没有对应功能，但照常存取，保证配置文件格式互通）。
const SIZE_FILE = path.join(DATA_DIR, '.dshw-size.json')
const SIZE_DEFAULTS = {
  sound: true, vol: 0.9, soundSet: 'duck', usageMode: 'ledger',
  peakMode: 'default', bubbleOn: true, taskbarFloat: true,
  turnCostOn: true, turnCostCloseMs: 5000, scrollGapOn: false, scrollGapPx: 17,
}
function normalizeSizeConfig(src) {
  const o = src && typeof src === 'object' ? src : {}
  const out = {}
  out.scale = typeof o.scale === 'number' && isFinite(o.scale)
    ? Math.min(2.5, Math.max(0.6, o.scale))
    : 1.5
  for (const k of Object.keys(SIZE_DEFAULTS)) {
    const dv = SIZE_DEFAULTS[k]
    const v = o[k]
    if (typeof dv === 'boolean') out[k] = typeof v === 'boolean' ? v : dv
    else if (typeof dv === 'number') out[k] = typeof v === 'number' && isFinite(v) ? v : dv
    else out[k] = typeof v === 'string' && v ? v : dv
  }
  return out
}
function readRawSizeConfig() {
  try { const p = JSON.parse(fs.readFileSync(SIZE_FILE, 'utf8')); return p && typeof p === 'object' ? p : {} } catch (e) { return {} }
}
// 读取视图：缺失字段补默认值（只补缺，不覆盖用户已保存的值）
function readSizeConfig() { return normalizeSizeConfig(readRawSizeConfig()) }
function writeSizeConfig(body) {
  const merged = normalizeSizeConfig({ ...readRawSizeConfig(), ...(body && typeof body === 'object' ? body : {}) })
  merged.updatedAt = new Date().toISOString()
  try { fs.writeFileSync(SIZE_FILE, JSON.stringify(merged), 'utf8') } catch (e) {}
  return merged
}

// ---------- 余额响应（缓存 + 并发合并） ----------
let balanceCache = null
let balanceInFlight = null
async function getBalancePayload() {
  const now = Date.now()
  if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.payload
  if (balanceInFlight) return balanceInFlight
  balanceInFlight = (async () => {
    // 解析链：手动保存（设置窗）> 环境变量 > DSH 凭据文件
    const cred = credentials.resolve('DEEPSEEK_API_KEY')
    if (!cred.ok) return { ok: false, code: 'NO_KEY', error: '凭据读取失败: ' + cred.error }
    if (!cred.value) return { ok: false, code: 'NO_KEY', error: '未配置 Token：右键鲸鱼打开设置' }
    const payload = await getBalancePayloadInner(cred.value)
    if (payload.ok) {
      balanceCache = { at: now, payload }
      return payload
    }
    // 网络抖动等瞬时故障：沿用上次成功余额并带 stale 标记，气泡里继续
    // 显示旧数字而不是闪成 "--"（与插件"静默保留上次余额"行为一致）。
    if (payload.transient && balanceCache) {
      return { ...balanceCache.payload, stale: true, error: payload.error }
    }
    return payload
  })()
  try { return await balanceInFlight } finally { balanceInFlight = null }
}
async function getBalancePayloadInner(apiKey) {
  const payload = await fetchBalance(apiKey)
  if (!payload.ok) return payload
  const led = recordLedgerUsage(Number(payload.totalBalance), payload.currency)
  const cfg = readSizeConfig() || {}
  const mode = cfg.usageMode === 'token' ? 'token' : 'ledger'
  const full = { ...payload }
  full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
  // token/命中率这类明细数据，只有"token 模式"（配置了 DEEPSEEK_PLATFORM_TOKEN）
  // 才拿得到；"ledger 模式"只是靠余额差值推算消费金额，没有 token 级别的明细。
  full.todayTokens = null
  full.todayHitTokens = null
  full.todayMissTokens = null
  if (mode === 'ledger') {
    full.todayUsage = led.todayUsage
    full.usageMode = 'ledger'
    return full
  }
  const tok = credentials.resolve('DEEPSEEK_PLATFORM_TOKEN')
  if (tok.ok && tok.value) {
    const u = await fetchUsageByToken(tok.value)
    if (u && u.amount !== undefined) {
      full.todayUsage = u.amount
      full.usageMode = 'token'
      full.todayTokens = typeof u.tokens === 'number' ? u.tokens : null
      full.todayHitTokens = typeof u.hitTokens === 'number' ? u.hitTokens : null
      full.todayMissTokens = typeof u.missTokens === 'number' ? u.missTokens : null
      return full
    }
  }
  full.todayUsage = led.todayUsage
  full.usageMode = 'ledger'
  return full
}

// ---------- 素材 ----------
const IMAGE_CANDIDATES = ['DSniang1.png', 'DSniang02.png']
const GIF_CANDIDATES = ['rua.gif']
const SOUND_SETS = {
  duck: { press: ['Ya1.mp3'], release: ['Ya2.mp3'] },
  fx1: { press: ['D1.mp3'], release: ['D2.mp3'] },
}
const assetCache = {}
function loadAsset(names) {
  for (const n of names) {
    const f = path.join(ASSET_DIR, n)
    try {
      if (assetCache[f] !== undefined) return assetCache[f]
      const bytes = fs.readFileSync(f)
      if (bytes && bytes.length > 0) { assetCache[f] = bytes; return bytes }
    } catch (e) {}
  }
  return null
}
function contentTypeFor(pathname) {
  if (pathname.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8'
  if (pathname.endsWith('.png')) return 'image/png'
  if (pathname.endsWith('.gif')) return 'image/gif'
  if (pathname.endsWith('.mp3')) return 'audio/mpeg'
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8'
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}
function sendJson(res, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
  res.end(body)
}

// 读取 JSON 请求体（8KB 上限），交给 onBody 处理
function readBody(req, res, onBody) {
  let raw = ''
  let tooLarge = false
  req.on('data', c => { raw += c; if (raw.length > 8192) tooLarge = true })
  req.on('end', () => {
    if (tooLarge) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'TOO_LARGE', error: '请求体超过 8KB' }))
      return
    }
    let body
    try { body = JSON.parse(raw || '{}') } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'BAD', error: '请求体不是合法 JSON' }))
      return
    }
    onBody(body)
  })
}
function sendCorsHeaders(res) {
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '600',
  })
  res.end()
}

// size.json 被改（设置窗写入）后的通知回调，由 main.js 注入：
// main 据此把 'config-changed' 推给挂件窗，触发重读配置/同步缩放
let configChangedCb = null

function startServer(port, opts) {
  configChangedCb = opts && typeof opts.onConfigChanged === 'function' ? opts.onConfigChanged : null
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost')
    const pathname = u.pathname
    const q = u.searchParams
    if (req.method === 'OPTIONS') return sendCorsHeaders(res)

    // 只允许本机访问
    const host = req.headers.host || ''
    if (!/^127\.0\.0\.1|^localhost|^\[::1\]/.test(host.split(':')[0])) {
      res.writeHead(403); res.end('forbidden'); return
    }

    if (pathname === '/') {
      const html = fs.readFileSync(path.join(APP_DIR, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html)
      return
    }
    // 设置窗页面与它的静态资源
    if (pathname === '/settings') {
      const html = fs.readFileSync(path.join(APP_DIR, 'settings.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html)
      return
    }
    if (pathname === '/dsh-whale/settings.js') {
      const b = loadAsset([path.join('dist', 'settings.js')])
      if (!b) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(b)
      return
    }
    if (pathname === '/dsh-whale/glass.css') {
      const b = loadAsset([path.join('dist', 'settings.css')])
      if (!b) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(b)
      return
    }
    if (pathname === '/dsh-whale/widget.js') {
      const b = loadAsset(['widget.js'])
      if (!b) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(b)
      return
    }
    if (pathname === '/dsh-whale/hit-test.js') {
      const b = loadAsset(['hit-test.js'])
      if (!b) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(b)
      return
    }
    if (pathname === '/dsh-whale/image.png') {
      const b = loadAsset(IMAGE_CANDIDATES)
      if (!b) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
      res.end(b)
      return
    }
    if (pathname === '/dsh-whale/rua.gif') {
      const b = loadAsset(GIF_CANDIDATES)
      if (!b) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' })
      res.end(b)
      return
    }
    if (pathname === '/dsh-whale/sound/press.mp3' || pathname === '/dsh-whale/sound/release.mp3') {
      const set = q.get('set') === 'fx1' ? 'fx1' : 'duck'
      const kind = pathname.endsWith('/press.mp3') ? 'press' : 'release'
      const b = loadAsset(SOUND_SETS[set][kind])
      if (!b) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' })
      res.end(b)
      return
    }
    if (pathname === '/dsh-whale/balance.json') {
      getBalancePayload().then(p => sendJson(res, p)).catch(err => sendJson(res, { ok: false, code: 'ERR', error: String((err && err.message) || err) }))
      return
    }
    if (pathname === '/dsh-whale/size.json') {
      if (req.method === 'PUT' || req.method === 'POST') {
        readBody(req, res, (body) => {
          if (typeof body.scale !== 'number' || !isFinite(body.scale)) {
            sendJson(res, { ok: false, code: 'BAD', error: 'missing scale' })
            return
          }
          const prevMode = readRawSizeConfig().usageMode
          writeSizeConfig(body)
          // 用量模式切换立即生效：作废余额缓存，下一次拉取按新模式计算
          if ((body.usageMode === 'token' ? 'token' : 'ledger') !== (prevMode === 'token' ? 'token' : 'ledger')) {
            balanceCache = null
          }
          // 通知主进程"配置变了"（main.js 据此让挂件窗重读配置并同步缩放）
          if (configChangedCb) { try { configChangedCb() } catch (e) {} }
          sendJson(res, { ok: true })
        })
        return
      }
      sendJson(res, readSizeConfig())
      return
    }
    // ---------- 凭据（设置窗用） ----------
    // 今日/本月已用（本地记账汇总，无网络请求；设置窗用量统计卡用）
    if (pathname === '/dsh-whale/usage.json' && req.method === 'GET') {
      const led = readUsageLedger()
      const ym = todayKey().slice(0, 7)
      let month = 0
      if (typeof led.date === 'string' && led.date.startsWith(ym) && isFinite(led.todayUsage)) {
        month += led.todayUsage
      }
      for (const [d, v] of Object.entries(led.history || {})) {
        if (typeof d === 'string' && d.startsWith(ym) && isFinite(v)) month += v
      }
      sendJson(res, { todayUsage: led.todayUsage || 0, monthUsage: month })
      return
    }
    // GET：只回掩码/来源，全值永不出主进程
    if (pathname === '/dsh-whale/credentials.json' && req.method === 'GET') {
      sendJson(res, credentials.getStatus(CREDENTIAL_KEYS))
      return
    }
    if (pathname === '/dsh-whale/credentials.json' && (req.method === 'PUT' || req.method === 'POST')) {
      readBody(req, res, (body) => {
        try {
          if (body.apiKey !== undefined) {
            if (typeof body.apiKey !== 'string' || body.apiKey.length > 4096) {
              sendJson(res, { ok: false, code: 'BAD', error: 'apiKey 不合法' }); return
            }
            credentials.setStored('DEEPSEEK_API_KEY', body.apiKey)
          }
          if (body.platformToken !== undefined) {
            if (typeof body.platformToken !== 'string' || body.platformToken.length > 4096) {
              sendJson(res, { ok: false, code: 'BAD', error: 'platformToken 不合法' }); return
            }
            credentials.setStored('DEEPSEEK_PLATFORM_TOKEN', body.platformToken)
          }
          if (body.clearApiKey) credentials.setStored('DEEPSEEK_API_KEY', null)
          if (body.clearPlatformToken) credentials.setStored('DEEPSEEK_PLATFORM_TOKEN', null)
          // 凭据可能影响余额拉取，作废缓存让下一次拉取走新解析链
          balanceCache = null
          sendJson(res, { ok: true, status: credentials.getStatus(CREDENTIAL_KEYS) })
        } catch (err) {
          sendJson(res, { ok: false, code: 'ERR', error: String((err && err.message) || err) })
        }
      })
      return
    }
    // 连通性测试：不给 value 就按当前解析链测；apiKey 走余额接口，
    // platformToken 走平台用量接口
    if (pathname === '/dsh-whale/test-credential.json' && req.method === 'POST') {
      readBody(req, res, (body) => {
        const kind = body.kind === 'platformToken' ? 'platformToken' : 'apiKey'
        const name = kind === 'platformToken' ? 'DEEPSEEK_PLATFORM_TOKEN' : 'DEEPSEEK_API_KEY'
        let key = typeof body.value === 'string' ? body.value.trim() : ''
        if (!key) {
          const r = credentials.resolve(name)
          if (!r.ok) { sendJson(res, { ok: false, error: '凭据读取失败: ' + r.error }); return }
          key = r.value
        }
        if (!key) {
          sendJson(res, { ok: false, error: kind === 'apiKey' ? '未填 API Key' : '未填平台令牌' })
          return
        }
        const p = kind === 'apiKey' ? fetchBalance(key) : fetchUsageByToken(key).then(u =>
          u && u.amount !== undefined ? { ok: true } : { ok: false, error: u && u.error ? String(u.error) : '令牌无效或无用量数据' })
        p.then(r => {
          if (r && r.ok) sendJson(res, { ok: true })
          else sendJson(res, { ok: false, error: String((r && r.error) || '验证失败') })
        }).catch(err => sendJson(res, { ok: false, error: String((err && err.message) || err) }))
      })
      return
    }
    if (pathname === '/dsh-whale/last-turn.json') {
      sendJson(res, { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null })
      return
    }
    res.writeHead(404); res.end()
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

module.exports = { startServer, readSizeConfig }
