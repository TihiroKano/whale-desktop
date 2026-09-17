// 桌面背景截取模块（Round 7 补遗：材质必须覆盖窗口全部像素）。
// 设置窗是 transparent:true，CSS backdrop-filter 读不到文档外真实桌面的像素——
// 旧 .env 自绘光斑又没有锐利细节，blur 等于"看不出在糊"，标题栏/侧边栏/卡片
// 间隙因此裸透桌面图标。这里把窗口所在屏幕截成位图喂给页面 .env 做环境层：
// blur/saturate/边缘环全部作用于真实桌面，全窗统一有材质。
// 截取时机：初次（页面未加载、窗口表面为空，天然不含自己）；窗口移动只推新
// 坐标不重截（位图是屏幕空间快照，对齐靠 background-position）；显示器变化 /
// 还原 / 壁纸更换才闪烁重截——可见状态下不隐藏窗口层就截，会把窗口自己的
// 旧背景+UI 截进去，对齐后形成逐次累积的鬼影。
const { desktopCapturer, screen, ipcMain, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const WALLPAPER_FILE = path.join(
  process.env.APPDATA || '',
  'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper',
)

let attached = null
let ipcBound = false

// 内容刷新节奏：探测到变化先只记录；变化停下 QUIET_MS 后补一帧（离散变化
// ≈2s 内跟上）；若桌面持续在变（流式输出/动画），至少每 STALE_MAX_MS 补一帧
// 兜底，避免永久冻结。两次重截之间至少隔 COOLDOWN_MS
const QUIET_MS = 1800
const COOLDOWN_MS = 2500
const STALE_MAX_MS = 12000

function capturePayload(win) {
  if (!win || win.isDestroyed()) return Promise.resolve(null)
  const display = screen.getDisplayMatching(win.getBounds())
  const sf = display.scaleFactor || 1
  return desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(display.bounds.width * sf)),
      height: Math.max(1, Math.round(display.bounds.height * sf)),
    },
  }).then((sources) => {
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return null
    const b = win.getBounds()
    return {
      displayId: String(display.id),
      dataUrl: 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(92).toString('base64'),
      screenX: display.bounds.x,
      screenY: display.bounds.y,
      screenW: display.bounds.width,
      screenH: display.bounds.height,
      winX: b.x,
      winY: b.y,
    }
  }).catch((err) => {
    console.log('[backdrop] capture error:', err && err.message)
    return null
  })
}

function push(win, payload) {
  if (win && !win.isDestroyed() && payload) {
    // 新位图入档 = 内容已刷新，探测基线作废，下一轮重新取基线
    if (attached) attached.pokeHash = null
    win.webContents.send('settings-backdrop', payload)
  }
}

// 本应用其它窗口（桌宠等）的屏幕矩形：它们自己动画/挪位与玻璃内容无关，
// 但不排除会让探针持续误报，空转重截
function appWindowRects(win) {
  const rects = []
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w === win || w.isDestroyed() || !w.isVisible()) continue
      const b = w.getBounds()
      if (b.width > 0 && b.height > 0) rects.push(b)
    }
  } catch (e) {}
  return rects
}

// 桌面变化探针：160px 小缩略图 + 网格采样哈希。排除设置窗自身矩形
// （窗口内玻璃/UI 会自变化，不排除会自我触发形成循环）和应用自身其它
// 窗口；只比较其余桌面像素——桌面上的东西动了就能察觉，静态时零重截
function pollHash(win) {
  const display = screen.getDisplayMatching(win.getBounds())
  const w = 160
  const h = Math.max(1, Math.round(w * display.bounds.height / display.bounds.width))
  return desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: h },
  }).then((sources) => {
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return null
    const size = src.thumbnail.getSize()
    const bmp = src.thumbnail.toBitmap() // BGRA
    const sx = size.width / display.bounds.width
    const sy = size.height / display.bounds.height
    const ex = [win.getBounds()].concat(appWindowRects(win)).map((r) => ({
      x0: Math.max(0, (r.x - display.bounds.x) * sx - 2),
      x1: Math.min(size.width, (r.x - display.bounds.x + r.width) * sx + 2),
      y0: Math.max(0, (r.y - display.bounds.y) * sy - 2),
      y1: Math.min(size.height, (r.y - display.bounds.y + r.height) * sy + 2),
    }))
    let hash = 2166136261 >>> 0
    const stepX = Math.max(1, Math.floor(size.width / 96))
    const stepY = Math.max(1, Math.floor(size.height / 54))
    for (let py = (stepY >> 1); py < size.height; py += stepY) {
      for (let px = (stepX >> 1); px < size.width; px += stepX) {
        let skip = false
        for (let k = 0; k < ex.length; k++) {
          if (px >= ex[k].x0 && px <= ex[k].x1 && py >= ex[k].y0 && py <= ex[k].y1) { skip = true; break }
        }
        if (skip) continue
        const i = (py * size.width + px) * 4
        hash = (hash ^ bmp[i]) >>> 0
        hash = (hash * 16777619) >>> 0
        hash = (hash ^ bmp[i + 1]) >>> 0
        hash = (hash * 16777619) >>> 0
        hash = (hash ^ bmp[i + 2]) >>> 0
        hash = (hash * 16777619) >>> 0
      }
    }
    return hash
  }).catch(() => null)
}

// 纯坐标更新（拖动实时对齐）：只发 winX/winY，不再重复传 700KB 位图，
// 渲染端用上次完整位图合并后重排 background-position
function pushPos(win, winX, winY) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('settings-backdrop-pos', { winX, winY })
  }
}

async function blinkCapture(win) {
  if (!win || win.isDestroyed()) return null
  if (!win.isVisible() || win.isMinimized()) return null
  win.setOpacity(0)
  await new Promise((r) => setTimeout(r, 90))
  const p = await capturePayload(win)
  if (!win.isDestroyed()) win.setOpacity(1)
  return p
}

function detachSettingsBackdrop() {
  const st = attached
  if (!st) return
  attached = null
  if (st.timer) clearInterval(st.timer)
  if (st.moveTimer) clearTimeout(st.moveTimer)
  if (st.metricsTimer) clearTimeout(st.metricsTimer)
  if (st.blurTimer) clearTimeout(st.blurTimer)
  if (st.retryTimer) clearTimeout(st.retryTimer)
  if (st.pollTimer) clearInterval(st.pollTimer)
  screen.off('display-metrics-changed', st.onMetrics)
  screen.off('display-added', st.onMetrics)
  screen.off('display-removed', st.onMetrics)
  win.off('move', st.onMoveTick)
  win.off('moved', st.onMoveTick)
  win.off('moved', st.onMovedSettle)
  win.off('blur', st.onBlur)
}

function attachSettingsBackdrop(win) {
  if (!ipcBound) {
    ipcBound = true
    ipcMain.handle('settings-backdrop-get', () => (attached && attached.last) || null)
  }
  detachSettingsBackdrop()
  const st = { win, last: null, lastPush: 0, moveTimer: null, metricsTimer: null, blurTimer: null, retryTimer: null, timer: null, wallMtime: -1, pollTimer: null, pollBusy: false, pokeHash: null, lastRefresh: 0, lastChangeAt: 0 }
  attached = st
  // 首截失败（合成器未就绪等）时页面照常加载，但 .env 无位图会退化到"裸透
  // 桌面"兜底态；这里静默重试补位，直到成功（不阻塞 loadURL）
  st.retryCapture = () => {
    st.retryTimer = setTimeout(async () => {
      st.retryTimer = null
      if (attached !== st || st.last) return
      const q = (win.isVisible() && !win.isMinimized()) ? await blinkCapture(win) : await capturePayload(win)
      if (attached !== st) return
      if (q) { st.last = q; push(win, q); return }
      st.retryCapture()
    }, 1500)
  }
  // 初次截取：页面未加载、窗口表面为空，截图天然不含自己。返回该 promise，
  // 调用方据此推迟 loadURL——若首帧抢在截取完成前渲染，位图会带上 UI 鬼影
  st.initial = capturePayload(win).then((p) => {
    if (attached !== st) return null
    if (p) { st.last = p; push(win, p); return p }
    st.retryCapture()
    return null
  })
  // 拖动实时对齐：位图是屏幕空间快照，窗口每移动一点就立刻补偿坐标，
  // 内容才会"钉"在屏幕上、像真玻璃扫过桌面；否则拖动中内容跟着窗口滑、
  // 松手后再跳变（观感：背景随拖动乱变）。节流 ~16ms 约一帧一次
  st.onMoveTick = () => {
    if (attached !== st || !st.last) return
    const now = Date.now()
    if (now - st.lastPush < 16) return
    st.lastPush = now
    const b = win.getBounds()
    if (String(screen.getDisplayMatching(b).id) !== st.last.displayId) return
    st.last = Object.assign({}, st.last, { winX: b.x, winY: b.y })
    pushPos(win, b.x, b.y)
  }
  st.onMovedSettle = () => {
    if (st.moveTimer) clearTimeout(st.moveTimer)
    st.moveTimer = setTimeout(async () => {
      st.moveTimer = null
      if (!st.last || attached !== st) return
      const b = win.getBounds()
      // 跨屏拖拽：位图属于旧屏幕，必须重截；同屏移动只推坐标重排背景
      if (String(screen.getDisplayMatching(b).id) !== st.last.displayId) {
        const p = await blinkCapture(win) || await capturePayload(win)
        if (p && attached === st) { st.last = p; push(win, p) }
        return
      }
      st.last = Object.assign({}, st.last, { winX: b.x, winY: b.y })
      pushPos(win, b.x, b.y)
    }, 180)
  }
  win.on('move', st.onMoveTick)
  win.on('moved', st.onMoveTick)
  win.on('moved', st.onMovedSettle)
  st.onMetrics = () => {
    if (st.metricsTimer) clearTimeout(st.metricsTimer)
    st.metricsTimer = setTimeout(async () => {
      st.metricsTimer = null
      if (attached !== st) return
      const p = await blinkCapture(win)
      if (p && attached === st) { st.last = p; push(win, p) }
    }, 400)
  }
  // 失焦即刷新：用户去改动桌面（换壁纸/拖窗口/开应用）必然先让设置窗失焦，
  // 此刻其注意力在别处，闪烁重截不可见；等回到设置窗时背景已是最新桌面，
  // 消除"快照冻结、桌面变了背景却不变"的突兀感
  st.onBlur = () => {
    if (st.blurTimer) clearTimeout(st.blurTimer)
    st.blurTimer = setTimeout(async () => {
      st.blurTimer = null
      if (attached !== st) return
      if (!win.isVisible() || win.isMinimized() || win.isFocused()) return
      const p = await blinkCapture(win)
      if (p && attached === st) { st.last = p; push(win, p) }
    }, 150)
  }
  screen.on('display-metrics-changed', st.onMetrics)
  screen.on('display-added', st.onMetrics)
  screen.on('display-removed', st.onMetrics)
  win.on('restore', st.onMetrics)
  win.on('blur', st.onBlur)
  try { st.wallMtime = fs.statSync(WALLPAPER_FILE).mtimeMs } catch { st.wallMtime = -1 }
  st.timer = setInterval(async () => {
    if (attached !== st) return
    let m = -1
    try { m = fs.statSync(WALLPAPER_FILE).mtimeMs } catch { m = -1 }
    // st.last 为空 = 首截一直未成功（兜底态），与换壁纸同样需要重截
    if (m === st.wallMtime && st.last) return
    st.wallMtime = m
    // 窗口可见时闪烁重截（否则会把自身 UI 截进位图）；隐藏/最小化时窗口
    // 表面不在屏幕上，直接截即为干净桌面
    const p = (win.isVisible() && !win.isMinimized()) ? await blinkCapture(win) : await capturePayload(win)
    if (p && attached === st) { st.last = p; push(win, p) }
  }, 5000)
  // 桌面内容刷新（近实时）：位图"截完即冻结"，拖动对齐只解决窗口自身移动；
  // 用户去挪图标/别的窗口时内容会变。失焦期间（注意力不在窗口上，闪烁不可见）
  // 每 ~0.6s 探测一次窗口外的桌面像素作为"桌面在变"的信号。
  // 策略：变化只记录、不立即重截（连续动画/流式输出期间不闪烁）；变化停下
  // QUIET_MS 后补一帧（离散变化 ≈2s 内跟上）；若桌面持续变化，每 STALE_MAX_MS
  // 兜底补一帧，玻璃不会永久冻结。聚焦期间不探测（桌面不变且闪可见）。
  // 完全被窗口盖住的区域无解：除非把窗口从捕获里剔除（那会连用户自己的
  // 截图一起剔除，不可取）。
  st.pollTimer = setInterval(async () => {
    if (attached !== st || !st.last) return
    if (!win.isVisible() || win.isMinimized() || win.isFocused()) return
    if (st.pollBusy) return
    st.pollBusy = true
    try {
      const h = await pollHash(win)
      if (attached !== st || h == null) return
      const now = Date.now()
      // 基线：重截推送后重新取样；期间的变化已含在新位图里，一并清零
      if (st.pokeHash == null) { st.pokeHash = h; st.lastChangeAt = 0; return }
      // 变化只记录不重截；静默 QUIET_MS 后的第一轮才补帧（离散变化 ≈2s 内跟上）
      let due = false
      if (h !== st.pokeHash) {
        st.pokeHash = h
        st.lastChangeAt = now
      } else if (st.lastChangeAt && now - st.lastChangeAt >= QUIET_MS) {
        due = true
      }
      // 兜底：持续变化时每轮都在记录 change、"静默"永不成立，按期补帧防冻结
      if (!due && st.lastChangeAt && now - st.lastRefresh >= STALE_MAX_MS) due = true
      if (!due || now - st.lastRefresh < COOLDOWN_MS) return
      st.lastChangeAt = 0
      st.lastRefresh = now
      const p = await blinkCapture(win)
      if (p && attached === st) { st.last = p; push(win, p) }
    } finally {
      st.pollBusy = false
    }
  }, 600)
  win.on('closed', () => { if (attached === st) detachSettingsBackdrop() })
  return st.initial
}

module.exports = { attachSettingsBackdrop, detachSettingsBackdrop }
