// 设置窗模块：16:9 桌面应用式液态玻璃设置窗口。
// 与挂件窗口完全解耦：这里是可获焦、可缩放的普通桌面窗口（Token 输入/IME
// 需要真正的键盘焦点，而挂件窗口 focusable:false 不能给）。
// Win11 22H2+ 启用系统级 Acrylic（背景实时模糊 = 真·液态玻璃）；旧系统自动
// 忽略该选项，页面内的玻璃材质仍然成立（优雅降级）。
const { BrowserWindow, screen, ipcMain } = require('electron')
const path = require('path')
const { attachSettingsBackdrop } = require('./desktop-backdrop')

let win = null
let ipcBound = false

// 窗口控制 IPC（由 settings-preload.js 暴露给设置页）
function bindSettingsIpc() {
  if (ipcBound) return
  ipcBound = true
  ipcMain.on('settings-win-minimize', () => {
    if (win && !win.isDestroyed()) win.minimize()
  })
  // "最大化"在 960×540 与 1280×720（窗口上限）之间切换，居中落位——
  // 圆角玻璃窗不做全屏 maximize（会失去圆角与玻璃边缘）
  ipcMain.on('settings-win-toggle-max', () => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    if (b.width >= 1280 - 8) {
      const nb = { width: 960, height: 540 }
      const { workArea } = screen.getPrimaryDisplay()
      nb.x = workArea.x + Math.round((workArea.width - nb.width) / 2)
      nb.y = workArea.y + Math.round((workArea.height - nb.height) / 2)
      win.setBounds(nb)
    } else {
      const nb = { width: 1280, height: 720 }
      const { workArea } = screen.getPrimaryDisplay()
      nb.x = workArea.x + Math.round((workArea.width - nb.width) / 2)
      nb.y = workArea.y + Math.round((workArea.height - nb.height) / 2)
      win.setBounds(nb)
    }
  })
  ipcMain.on('settings-win-close', () => {
    if (win && !win.isDestroyed()) win.close()
  })
}

function createSettingsWindow(port) {
  bindSettingsIpc()
  // 小屏保护：目标 1152×680（Round 6 预览图布局需要更高的双列空间；
  // 工作区不够时收缩，内容区列内滚动兜底）
  const wa = screen.getPrimaryDisplay().workArea
  const width = Math.min(1152, wa.width - 40)
  const height = Math.min(680, Math.max(450, wa.height - 40))
  win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    minWidth: 800,
    minHeight: 450,
    maxWidth: 1280,
    maxHeight: 720,
    // 不要 show:false + ready-to-show 的组合：透明窗没有白闪问题，而
    // "隐藏等首帧 → 首帧等可见出帧"在部分环境下互相等待死锁（窗口永远
    // 不显示、渲染帧停发、CSS 动画冻结在第一帧，capturePage 强制出帧
    // 才有画面）。直接随构造显示。
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    fullscreenable: false,
    maximizable: false,
    // 【E1 排查】显式关闭系统圆角：Win11 DWM 会按窗口矩形画自己的圆角
    // 与边框，和 CSS border-radius 的手动圆角错位时出现"圆角外还有一层
    // 矩形边界"
    roundedCorners: false,
    // 【E2 排查】关闭 DWM 原生阴影：无边框透明窗的原生阴影轮廓是窗口
    // 矩形包围盒，内容内缩 10px 时会露出矩形"框"；外阴影改由 .win 的
    // CSS box-shadow 承担
    hasShadow: false,
    // 不用 backgroundMaterial: 'acrylic'——真机 A/B 实测（DEV_MATERIAL 排查
    // 开关已移除）：transparent:true 时 DWM 材质不生效（窗口直接透出锐利
    // 桌面）；transparent:false 时同样不渲染亚克力。故实时半透明材质在本
    // 环境不可用，背景模糊只能走页面内快照位图（desktop-backdrop.js）。
    backgroundColor: '#00000000',
    title: '小鲸鱼设置',
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 设置窗失焦/被判定为背景时 Chromium 会停发渲染帧（动画/淡入冻结在
      // 首帧）——设置窗是短暂交互窗，禁用节流保证动画与渲染始终推进
      backgroundThrottling: false,
    },
  })
  win.setMenuBarVisibility(false)
  // Round 7 补遗：真实桌面位图环境层（材质覆盖全窗）。初次截取必须在
  // loadURL 之前完成——页面未渲染时窗口表面为空，截图天然不含自己。
  // dev-shot 不截真机，用确定性 fixture（棋盘格等）验证模糊覆盖。
  const w = win
  // DEV_NOBD=1：诊断开关——跳过桌面位图接入，复现"无位图兜底"状态
  // （验证伪元素 backdrop 链在该状态下的边缘环白边问题）
  const backdropReady = (process.env.DEV_SHOT || process.env.DEV_NOBD) ? null : attachSettingsBackdrop(w)
  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return
    win.focus()
  })
  win.on('closed', () => { win = null })
  // dev-shot 环境下渲染帧停发会让入场动画冻结在中间态、截图必糊——
  // 带 devshot 参数让页面禁用全部动画，截图永远落在最终状态。
  // DEV_OPEN_SETTINGS=2 额外带 autoselect=1（真实帧环境诊断：自动展开音效下拉）
  const params = []
  if (process.env.DEV_SHOT) params.push('devshot=1')
  if (process.env.DEV_SHOT) params.push('envfix=' + (process.env.DEV_ENVFIX || 'checker'))
  if (process.env.DEV_OPEN_SETTINGS === '2') params.push('autoselect=1')
  if (process.env.DEV_NOSHADOW === '1') params.push('noshadow=1')
  // Round 7 诊断：放慢玻璃展开动画（毫秒），供屏摄核验 SDF Smooth Union 形变
  if (process.env.DEV_GLASS_SLOW) params.push('glassslow=' + process.env.DEV_GLASS_SLOW)
  const qs = params.length ? '?' + params.join('&') : ''
  const url = 'http://127.0.0.1:' + port + '/settings' + qs
  if (backdropReady) {
    backdropReady.then(() => { if (!w.isDestroyed()) w.loadURL(url) })
  } else {
    w.loadURL(url)
  }
  return win
}

// 单例：已打开就聚焦置前
function openSettingsWindow(port) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return win
  }
  return createSettingsWindow(port)
}

function getSettingsWindow() {
  return win && !win.isDestroyed() ? win : null
}

function closeSettingsWindow() {
  if (win && !win.isDestroyed()) win.close()
}

module.exports = { openSettingsWindow, closeSettingsWindow, getSettingsWindow }
