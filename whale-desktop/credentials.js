// 凭据模块：手动保存的 Token 存储 + 统一解析链。
// 解析优先级：手动保存（设置窗填写，DPAPI 加密落盘）> 环境变量 > DSH 凭据文件
// （~/.dsh/.credentials.yaml 的 refs 段，与旧版 server.js readCredential 语义一致）。
// 本模块不依赖 electron：加密编解码由 main.js 注入（Electron safeStorage/DPAPI），
// 注入前（以及纯 node 测试里）退化为明文存储。
const fs = require('fs')
const os = require('os')
const path = require('path')

let storagePath = path.join(process.env.WHALE_DATA_DIR || __dirname, '.dshw-credentials.json')
let dshPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')
// codec = { encrypt(plain)->Buffer, decrypt(data)->string }；null 表示明文存储
let codec = null

function setStoragePath(p) { storagePath = p }
function setDshPath(p) { dshPath = p }
function setCodec(impl) { codec = impl || null }

// ---------- 文件读写 ----------
function readStore() {
  try {
    const p = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
    return p && typeof p === 'object' ? p : {}
  } catch (e) {
    return {} // 不存在/损坏一律按空配置处理
  }
}
function writeStore(store) {
  store.updatedAt = new Date().toISOString()
  try { fs.writeFileSync(storagePath, JSON.stringify(store), 'utf8') } catch (e) {}
}

// ---------- 手动保存的 Token ----------
// 返回解密后的字符串；未设置/解密失败/文件损坏返回 ''（解密失败等于没配，
// 不能因为它抛异常挂掉整个余额链路）。
function getStored(name) {
  const entry = readStore()[name]
  if (!entry || typeof entry !== 'object') return ''
  if (entry.enc) {
    if (!codec) return ''
    try {
      const v = codec.decrypt(Buffer.from(String(entry.data || ''), 'base64'))
      return typeof v === 'string' ? v : ''
    } catch (e) {
      return ''
    }
  }
  return typeof entry.data === 'string' ? entry.data : ''
}

// value 为 null/undefined/'' 时删除该条目
function setStored(name, value) {
  const store = readStore()
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) {
    delete store[name]
  } else if (codec) {
    store[name] = { enc: true, data: codec.encrypt(v).toString('base64') }
  } else {
    store[name] = { enc: false, data: v }
  }
  writeStore(store)
}

// 掩码展示：只露前 3 后 4，太短的完全不露
function hintFor(value) {
  const v = String(value || '')
  if (!v) return ''
  if (v.length < 8) return '***'
  return v.slice(0, 3) + '***' + v.slice(-4)
}

// ---------- DSH 凭据文件（refs 段的极简 YAML 子集，沿用原实现语义） ----------
function readDshCredential(name) {
  try {
    const text = fs.readFileSync(dshPath, 'utf8')
    const lines = text.split(/\r?\n/)
    let inRefs = false
    for (const ln of lines) {
      const t = ln.trim()
      if (/^refs:\s*$/.test(t)) { inRefs = true; continue }
      if (inRefs && /^\s/.test(ln)) {
        const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(ln)
        if (m && m[2] === name && m[3]) return { ok: true, value: m[3].trim() }
      }
    }
    return { ok: true, value: undefined }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, value: undefined }
    return { ok: false, error: String((err && err.message) || err) }
  }
}

// 统一剥离可选的 "Bearer " 前缀（三种来源统一处理）
function stripBearer(v) {
  return String(v).replace(/^Bearer\s+/i, '')
}

// ---------- 解析链 ----------
// resolve(name, { envName, dsh }) →
//   { ok: true,  value, source: 'saved'|'env'|'dsh'|'none' }
//   { ok: false, error }                      （DSH 凭据文件读不出时）
function resolve(name, opts) {
  const o = opts || {}
  const saved = getStored(name)
  if (saved) return { ok: true, value: stripBearer(saved), source: 'saved' }
  const envName = o.envName || name
  if (process.env[envName]) return { ok: true, value: stripBearer(process.env[envName]), source: 'env' }
  const r = (o.dsh || readDshCredential)(name)
  if (!r.ok) return { ok: false, error: r.error }
  if (r.value) return { ok: true, value: stripBearer(r.value), source: 'dsh' }
  return { ok: true, value: '', source: 'none' }
}

// ---------- 状态汇总（给设置窗展示；永不返回全值） ----------
// keys: [{ key: 'apiKey', name, envName? }] → { apiKey: {set, hint, source}, ..., secure: bool }
function getStatus(keys) {
  const out = { secure: !!codec }
  for (const k of keys || []) {
    const r = resolve(k.name, { envName: k.envName })
    const value = r.ok ? r.value : ''
    out[k.key || k.name] = { set: !!value, hint: hintFor(value), source: r.ok ? r.source : 'error' }
  }
  return out
}

module.exports = {
  setStoragePath, setDshPath, setCodec,
  getStored, setStored, hintFor, resolve, getStatus,
  // 仅供测试注入使用
  _readDshCredential: readDshCredential,
}
