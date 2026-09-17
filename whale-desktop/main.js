const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const { startServer, readSizeConfig } = require('./server')
const { openSettingsWindow } = require('./settings-window')
const credentials = require('./credentials')

// 卸载维护模式：由安装时注入的维护入口接管，不进正常启动流程
// （CommonJS 顶层 return 合法：阻止本文件后续的正常启动代码执行）
if (process.argv.includes('--uninstall')) {
  const entry = path.join(__dirname, 'installer-maintenance', 'entry.js')
  if (fs.existsSync(entry)) require(entry).run()
  else { console.log('[whale] installer-maintenance 缺失，跳过维护模式'); app.quit() }
  return
}

// 禁用 Chromium 在 Windows 上的"原生窗口遮挡检测"（Native Window
// Occlusion）功能——这是一个已知会对透明、分层（layered）窗口产生
// 诡异原生尺寸/重绘副作用的功能，社区里有不少类似"窗口莫名其妙自己
// 变大/闪烁"问题最终定位到这个开关。和之前误改的"关闭硬件加速"不是
// 一回事，这个更精确、副作用也小得多。必须在 app 就绪之前调用。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const PORT = 3123
const WHALE_SIZE = 132
const EDGE_MARGIN = 0
const START_MARGIN = 0
const SNAP_THRESHOLD = 30
const LOG_FILE = path.join(__dirname, 'renderer.log')
const POS_FILE = path.join(__dirname, '.dshw-window.json')

// 窗口尺寸跟随缩放比例（上游根盒子模型，严格按效果图）：构图盒是正方形，
// 鲸鱼贴图占构图盒的 59.45%，气泡 SVG 占满构图盒宽（1026:700）。鲸鱼尺寸
// = 132×scale，构图盒边长 = 鲸鱼尺寸 / 0.5945。窗口比构图盒大一圈（常年
// 预留设置菜单的空间）——菜单开合完全不改窗口尺寸，从根源消除 Windows
// 透明窗 resize 闪烁和关菜单后的内容位移。渲染端 widget.js 里有同一公式，
// 两边必须保持一致。
function sizeForScale(s) {
  const ww = Math.round(WHALE_SIZE * s)
  const S = Math.round(ww / 0.5945)
  return { w: Math.max(S, 372), h: Math.max(S, ww + 300) }
}

// curW/curH 永远代表"窗口此刻应有的逻辑尺寸"——所有磁吸/限位/纠偏
// 计算只用它们，绝不读 win.getBounds() 的宽高（150% 缩放下读数会漂移）。
// 只在 resize-for-scale（用户改缩放）和建窗时更新。
let curW = 340
let curH = 430
let winScale = 1
let win = null
let tray = null
let topmost = true
let keepTopTimer = null
// 拖动自采样循环句柄（见 sampleDrag/startDragLoop）
let dragLoopTimer = null
// 换边/镜像补偿后的暂停截止时间：补偿平移（窗口挪）和渲染端构图盒换位
// 必须落在同一个绘制帧里，否则中间被采样循环再挪一次窗口，就会出现
// "窗口已到新位置、内容还在旧偏移"的一帧残影。补偿后暂停，渲染端在
// 补偿后的下一绘制帧发 dragResume 恢复（安全上限 80ms 防丢消息）。
let dragHoldUntil = 0
// 松手后的宽限期：拖动中频繁 setPosition 会让随后的尺寸/位置"读数"说谎
// （150% 缩放的已知现象），这些谎言事件在 dragEnd 置空 dragAnchor 之后
// 排队回来——若此时纠偏器照单全收，会用过期坐标 setBounds（把窗口瞬移
// 回旧位置 = 松手后"回弹到起点"），读数偏差超过 50px 还会引爆熔断器
// 销毁重建窗口（= 鲸鱼消失一会儿、重现后拖拽失灵）。宽限期内这些事件
// 一律忽略：真实尺寸已由 snapWindow 的 setSize 恢复，min/max 锁兜底。
let dragQuietUntil = 0
// 本次拖动的锚点：光标起始位置 + 窗口起始位置，两者都在拖动开始的瞬间
// 通过 screen.getCursorScreenPoint() / win.getBounds() 一次性采样，
// 之后拖动过程中只用"当前光标位置 - 起始光标位置"的位移量去平移窗口——
// 全程只用主进程 screen 模块的坐标系，不掺杂渲染进程的 MouseEvent 坐标，
// 从根本上避免系统缩放（如150%）导致的坐标换算不一致问题。
let dragAnchor = null

// 日志轮转：renderer.log 超过 1MB 就挪到 .old，避免无限增长
function appendLog(line) {
  try {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
        try { fs.unlinkSync(LOG_FILE + '.old') } catch (e) {}
        fs.renameSync(LOG_FILE, LOG_FILE + '.old')
      }
    } catch (e) {}
    fs.appendFileSync(LOG_FILE, line)
  } catch (e) {}
}

// ---------- 窗口位置记忆（.dshw-window.json） ----------
// 上游插件把挂件位置存在 localStorage；桌面版没有页面生命周期概念，
// 位置随窗口存盘，重启后恢复。只在"我们主动落位"（磁吸/缩放补偿）时
// 保存，纠偏类的被动 setBounds 不算用户意图、不保存。
function saveWindowPos() {
  if (!win || win.isDestroyed()) return
  try {
    const b = win.getBounds()
    fs.writeFileSync(POS_FILE, JSON.stringify({
      x: Math.round(b.x), y: Math.round(b.y), w: curW, h: curH, scale: winScale,
    }), 'utf8')
  } catch (e) {}
}
function findDisplayForPos(x, y, w, h) {
  try {
    const displays = screen.getAllDisplays()
    for (const d of displays) {
      const wa = d.workArea
      const ix = Math.max(0, Math.min(x + w, wa.x + wa.width) - Math.max(x, wa.x))
      const iy = Math.max(0, Math.min(y + h, wa.y + wa.height) - Math.max(y, wa.y))
      // 至少 40px 落在某个工作区内才认为这个位置可见、可用
      if (ix > 40 && iy > 40) return d
    }
  } catch (e) {}
  return null
}
function loadWindowPos(w, h) {
  try {
    const p = JSON.parse(fs.readFileSync(POS_FILE, 'utf8'))
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !isFinite(p.x) || !isFinite(p.y)) return null
    if (!findDisplayForPos(Math.round(p.x), Math.round(p.y), w, h)) return null
    return { x: Math.round(p.x), y: Math.round(p.y) }
  } catch (e) { return null }
}

function applyTopmost() {
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(topmost, 'screen-saver')
}

function startKeepTop() {
  stopKeepTop()
  if (!topmost) return
  keepTopTimer = setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
  }, 2500)
}

function stopKeepTop() {
  if (keepTopTimer) { clearInterval(keepTopTimer); keepTopTimer = null }
}

function setTopmost(on) {
  topmost = !!on
  applyTopmost()
  if (topmost) startKeepTop(); else stopKeepTop()
  if (tray) tray.setContextMenu(buildTrayMenu())
}

function buildTrayMenu() {
  let autostart = false
  try { autostart = app.getLoginItemSettings().openAtLogin } catch (e) {}
  return Menu.buildFromTemplate([
    { label: '设置', click: () => openSettingsWindow(PORT) },
    { label: '显示鲸鱼', click: () => { if (win && !win.isDestroyed()) win.show() } },
    { label: '总在最前', type: 'checkbox', checked: topmost, click: (item) => setTopmost(item.checked) },
    { label: '开机自启', type: 'checkbox', checked: autostart, click: (item) => {
      try { app.setLoginItemSettings({ openAtLogin: item.checked }) } catch (e) {}
    } },
    { label: '打开调试工具', click: () => { if (win && !win.isDestroyed()) win.webContents.openDevTools({ mode: 'detach' }) } },
    { label: '退出鲸鱼', click: () => app.quit() },
  ])
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'DSniang1.png'))
    tray = new Tray(img)
    tray.setToolTip('DeepSeek 余额小鲸鱼')
    tray.setContextMenu(buildTrayMenu())
  } catch (e) {}
}

// 取"与给定矩形重叠最多"的显示器，而不是永远用主屏——
// 这样多屏环境下拖到副屏也能正确算出工作区，不会被主屏边界卡住（"空气墙"）。
// 但只有真正多屏时才用这个更复杂的匹配逻辑：单屏环境下直接用 getPrimaryDisplay()，
// 避免 getDisplayMatching 在部分 Windows 高缩放（如150%）环境下偶发返回
// 不一致尺寸的问题（表现为拖动时莫名撞上一个比实际屏幕小的方形边界）。
function displayForBounds(bounds) {
  try {
    if (screen.getAllDisplays().length <= 1) return screen.getPrimaryDisplay()
    return screen.getDisplayMatching(bounds)
  } catch (e) {
    return screen.getPrimaryDisplay()
  }
}

// 取"离给定点最近"的显示器，用于拖动开始时按鼠标位置判断当前所在屏幕。
// 同样只有真正多屏时才用 getDisplayNearestPoint，单屏直接用 getPrimaryDisplay()。
function displayForPoint(point) {
  try {
    if (screen.getAllDisplays().length <= 1) return screen.getPrimaryDisplay()
    return screen.getDisplayNearestPoint(point)
  } catch (e) {
    return screen.getPrimaryDisplay()
  }
}

// 坐标取整：Electron 的 setPosition 只接受整数 DIP（小数会直接抛
// "conversion failure"）。整数 DIP 经 Chromium → Windows 的换算是确定的
// （同一坐标永远映射到同一物理像素），所以取整本身不会带来来回抖动；
// 真正的重影来源是别处（尺寸纠偏抢窗口、中线翻转抖动），已分别处理。
// 注意不能用 round(v*scaleFactor)/f 做物理网格对齐——150% 缩放下那会
// 产生非整数 DIP（如 997.33），setPosition 每拍抛异常，窗口直接卡死。
function physSnap(disp, v) {
  return Math.round(v)
}

// 朝向（贴靠哪个角）的"迟滞"判断完全在渲染进程完成（见 assets/widget.js
// 的 handleWinPos / initOrientationFromRealPosition）——只有它知道鲸鱼贴图
// 在容器内的真实偏移量（依赖缩放比例），主进程不知道贴图在哪，按容器
// 矩形算会误判。主进程这里只负责执行渲染进程算好的贴边落位（snapWindow）。
function snapWindow(offsetX, offsetY, ww) {
  if (!win) return
  const b = win.getBounds()
  const { workArea } = displayForBounds(b)
  // 不再信任 win.getBounds() 读到的宽高——在你的 150% 缩放环境下，
  // 哪怕只是移动窗口（连 setBounds 都没调用），Windows/Electron 内部
  // 对逻辑像素/物理像素的换算也会让读数逐渐"跑偏变大"。
  // 永远只用 curW/curH（当前缩放对应的约定尺寸），不把任何读到的
  // 派生值带入下一次计算。
  const W = curW, H = curH
  // 鲸鱼贴图在容器内的本地偏移量 + 贴图边长：磁吸判断必须按"贴图自身"
  // 离屏幕边缘的距离来算，而不是容器矩形——容器比贴图大得多（留了给
  // 气泡弹窗用的空间），容器边缘先进入阈值时，贴图本身可能还离真实
  // 边缘有相当一段距离，会导致"离边缘还有较大距离就被磁吸"的问题。
  const oX = (typeof offsetX === 'number') ? offsetX : 0
  const oY = (typeof offsetY === 'number') ? offsetY : 0
  const oW = (typeof ww === 'number') ? ww : W
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height
  let x = b.x
  let y = b.y
  const whaleX = x + oX, whaleY = y + oY
  const distLeft = whaleX - workArea.x
  const distRight = right - (whaleX + oW)
  const distTop = whaleY - workArea.y
  const distBottom = bottom - (whaleY + oW)
  // 磁吸：仅当贴图自身靠近边缘才贴边；否则原地停留。目标坐标反推回
  // "容器"应该在哪（贴图目标位置 - 本地偏移量），而不是直接把容器边
  // 贴到屏幕边上。
  if (distLeft < SNAP_THRESHOLD && distLeft <= distRight) x = workArea.x - oX + EDGE_MARGIN
  else if (distRight < SNAP_THRESHOLD && distRight < distLeft) x = right - oW - oX - EDGE_MARGIN
  if (distTop < SNAP_THRESHOLD && distTop <= distBottom) y = workArea.y - oY + EDGE_MARGIN
  else if (distBottom < SNAP_THRESHOLD && distBottom < distTop) y = bottom - oW - oY - EDGE_MARGIN
  // 越界钳制：同样按"贴图不超出屏幕"来算，允许容器在必要时探出自身
  // 名义边界之外一截（和 drag-move 的限位逻辑保持一致）。
  const minX = workArea.x - oX, maxX = workArea.x + workArea.width - oX - oW
  const minY = workArea.y - oY, maxY = workArea.y + workArea.height - oY - oW
  x = Math.min(Math.max(x, minX), maxX)
  y = Math.min(Math.max(y, minY), maxY)
  // 落位同样吸附到物理像素网格（避免磁吸后贴图抖 1 物理像素）
  const snapDisp = displayForBounds(b)
  x = physSnap(snapDisp, x)
  y = physSnap(snapDisp, y)
  win.setPosition(Math.round(x), Math.round(y))
  // 主动把尺寸掰回约定值——不管刚才 getBounds() 读到的宽高是不是已经跑偏，
  // 这里都强制纠正回来，不让误差有机会累积到下一次。
  win.setSize(W, H)
  // 落位是用户意图的最终结果，保存位置供下次启动恢复。
  saveWindowPos()
  // 注意：这里不再广播 anchor。上面这次贴边位置，已经是渲染进程
  // 用"鲸鱼贴图自身的真实位置"（offsetX/offsetY/ww）算出正确的朝向之后
  // 传过来的——渲染进程自己维护的朝向已经是准确的，主进程按容器矩形
  // 再算一次只会引入不一致。
}

function createWindow(initialPos) {
  // 初始尺寸按配置文件里的缩放比例算（渲染端加载后会用同一公式校对，
  // 不一致时会通过 resize-for-scale 再对齐一次）
  const size = sizeForScale(winScale)
  curW = size.w
  curH = size.h
  const { workArea } = screen.getPrimaryDisplay()
  const restored = initialPos ? null : loadWindowPos(curW, curH)
  const x = initialPos ? initialPos.x : (restored ? restored.x : (workArea.x + workArea.width - curW - START_MARGIN))
  const y = initialPos ? initialPos.y : (restored ? restored.y : (workArea.y + workArea.height - curH - START_MARGIN))
  const created = new BrowserWindow({
    x, y,
    width: curW,
    height: curH,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      transparent: true,
    },
  })
  win = created

  // 在部分 Windows 高缩放（150%）环境下，哪怕设置了 resizable:false，
  // 窗口在被拖动到"没去过"的新位置时，仍会被系统异步地重新计算一次尺寸
  // （这个重算发生在我们自己的 setPosition/setSize 调用之后的下一个事件循环，
  // 所以"事后调用一次 setSize 纠正"经常会被这个异步重算覆盖掉）。
  // 用 setMinimumSize/setMaximumSize 把尺寸硬锁在常量值上，
  // 再监听窗口自身的 resize 事件——不管这次 resize 是谁、什么时候触发的，
  // 只要和约定的常量不一致就立刻纠正回去，形成事件驱动的持续纠偏，
  // 而不是只在我们自己调用 setPosition 之后被动纠正一次。
  created.setMinimumSize(curW, curH)
  created.setMaximumSize(curW, curH)
  created.on('resize', () => {
    // 用 created（这个闭包创建时就固定住的窗口实例）而不是模块级的 win
    // 来做身份判断——如果 win 已经被换成别的窗口（比如熔断重建过一次），
    // 说明这个事件来自一个已经过时的旧窗口，不应该再触发任何动作。
    if (created.isDestroyed() || win !== created) return
    const cur = created.getBounds()
    // 期望尺寸是 curW/curH（模块级变量，随缩放变化；缩放流程会先更新
    // 它们再 setBounds，所以这里的比较始终针对"当前约定值"）。
    // 不再要求严格相等——在你这台 150% 缩放的机器上，哪怕纠正到精确的
    // 目标尺寸，读回来的值也不会精确相等（系统级取整误差），
    // 于是"纠正"这个动作本身又会不精确地触发下一次 resize、被判定为
    // "还是不相等"从而再纠正一次，如此死循环，哪怕窗口完全静止不动
    // 也停不下来——这才是持续闪烁/重绘的真正原因。改成容差判断：
    // ±6px 内的抖动是这个环境下正常的取整噪声，肉眼也看不出来，
    // 直接忽略；只有真正出现大幅度偏移（比如之前那种涨到几百像素的
    // 情况）才纠正，从根源上打破这个死循环。
    const TOL = 6
    if (Math.abs(cur.width - curW) <= TOL && Math.abs(cur.height - curH) <= TOL) return
    // 拖动中不纠正：频繁的 setPosition 会触发系统对窗口的内部重算，此刻
    // 读回的尺寸短暂不可信，纠正动作本身会和拖动抢窗口——表现为肉眼可见
    // 的抖动/闪烁/重影。拖动结束后 snapWindow 会强制 setSize 纠回约定值，
    // 漂移不会带出拖动现场。
    if (dragAnchor) return
    // 松手后的宽限期同理：排队的漂移读数事件一律忽略（详见 dragQuietUntil
    // 注释——在宽限期里纠正=用过期坐标瞬移窗口，偏差大还会误触发熔断重建）
    if (Date.now() < dragQuietUntil) return
    // 从日志来看，这些"意外 resize"并不是只有宽高在变——相邻两条记录之间
    // x/y 往往也跟着悄悄挪动了（而且是持续朝左上方向），说明触发它的那次
    // 原生 resize 本身就带着一次隐式的位移，不是我们主动 setPosition 造成
    // 的。这里以前"只纠正尺寸、不碰坐标"，是为了避免我们自己的纠正动作
        // 把窗口带偏；但这没法防住"Windows 这次 resize 自己就已经把坐标带
    // 偏了"的情况——纠正尺寸时如果继续沿用这个已经跑偏的坐标，偏移就会
    // 一直累积下去，窗口跟着持续往左上角滑，这正是熔断总在屏幕左上区域
    // 触发、以及贴图/气泡在左上区域被真实窗口边界裁切错位的根源。
    // 这里加一层防御：纠正尺寸的同时，把坐标钳制回当前显示器工作区以内，
    // 不再放任它继续往屏幕外滑；坐标本来就在工作区内时钳制不改变数值，
    // 不影响正常情况下的行为。
    const { workArea } = displayForBounds(cur)
    const clampedX = Math.min(Math.max(cur.x, workArea.x), workArea.x + workArea.width - curW)
    const clampedY = Math.min(Math.max(cur.y, workArea.y), workArea.y + workArea.height - curH)
    // 熔断阈值：如果偏移已经严重到这个地步，说明 setSize/setBounds
    // 在这次会话里已经完全不起作用了（曾经出现过反复调用 setSize 却
    // 越纠正越大、涨到上千像素的情况）。这种时候不再跟它周旋，直接
    // 销毁重建窗口——这是唯一能确保拿回正确尺寸的办法。这个安全网不要
    // 删掉：删掉之后失控的窗口不会自己停下来，只会一直涨下去。
    const SEVERE = 50
    if (Math.abs(cur.width - curW) > SEVERE || Math.abs(cur.height - curH) > SEVERE) {
      try {
        appendLog('[main] severe size drift, recreating window: ' + JSON.stringify(cur) + '\n')
      } catch (e) {}
      dragAnchor = null
      createWindow({ x: clampedX, y: clampedY })
      try { created.destroy() } catch (e) {}
      return
    }
    try {
      appendLog('[main] unexpected resize -> correcting: ' + JSON.stringify(cur) + '\n')
    } catch (e) {}
    // 用 setBounds 把坐标（钳制后的）和尺寸一起纠正，而不是只纠正尺寸——
    // 这样即使这次原生 resize 顺带带偏了坐标，也会在同一次调用里被拉回来，
    // 不给偏移留下累积到下一次的机会。
    created.setBounds({ x: clampedX, y: clampedY, width: curW, height: curH })
  })

  applyTopmost()
  startKeepTop()
  created.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    appendLog('[' + level + '] ' + message + ' (' + sourceId + ':' + line + ')\n')
  })
  created.webContents.on('did-fail-load', (_e, code, desc) => {
    appendLog('did-fail-load ' + code + ' ' + desc + '\n')
  })
  created.webContents.on('render-process-gone', (_e, d) => {
    appendLog('renderer-gone ' + d.reason + '\n')
  })
  created.setIgnoreMouseEvents(true, { forward: true })
  created.loadURL('http://127.0.0.1:' + PORT + '/')
  created.on('closed', () => {
    stopKeepTop()
    // 只有当模块级 win 恰好还是"我自己"时才清空——避免这个窗口被
    // 熔断机制主动销毁之后，它自己异步触发的 closed 事件，把早已
    // 指向新窗口的 win 变量错误地清空成 null，导致新窗口明明还在、
    // 却所有 IPC 处理函数都因为 "!win" 判断为真而直接失效退出。
    if (win === created) win = null
  })
}

ipcMain.on('setMouseEnable', (_event, enable) => {
  if (!win) return
  win.setIgnoreMouseEvents(!enable, { forward: true })
})

// 挂件窗（汉堡/右键）请求打开设置窗
ipcMain.on('open-settings', () => openSettingsWindow(PORT))

ipcMain.on('drag-start', (_event, offsetX, offsetY, ww) => {
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const b = win.getBounds()
  // 工作区只在拖动开始这一刻查询/缓存一次，整个拖动过程全部复用。
  // 宽高不再用 win.getBounds() 读到的值——在150%这类非整数缩放下，
  // 哪怕只是移动窗口，Electron/Windows 内部的物理像素换算也会让这个
  // 读数逐渐跑偏变大，进而让"能拖动的范围"越来越小（"方形囚笼"）。
  // 永远只用创建时写死的常量 WIN_W/WIN_H。
  const { workArea } = displayForPoint({ x: cursor.x, y: cursor.y })
  dragAnchor = {
    cursorX: cursor.x, cursorY: cursor.y,
    winX: b.x, winY: b.y,
    width: curW, height: curH,
    workArea,
    // 拖动所在显示器（物理像素对齐用），整个拖动过程复用这一份
    disp: displayForPoint({ x: cursor.x, y: cursor.y }),
    // 鲸鱼贴图当前在容器内的本地偏移量 + 贴图边长——限位要按"鲸鱼贴图
    // 本身不超出屏幕"来算，而不是按"容器矩形不超出屏幕"来算，否则当
    // 鲸鱼贴的那一侧和拖动方向不一致时（比如贴左侧却往右拖），容器会
    // 在鲸鱼真正到达屏幕边缘之前就先撞上限位，形成一堵提前很多的墙。
    offsetX: (typeof offsetX === 'number' ? offsetX : 0),
    offsetY: (typeof offsetY === 'number' ? offsetY : 0),
    ww: (typeof ww === 'number' ? ww : 0),
  }
  try {
    appendLog('[main] drag-start displays=' + screen.getAllDisplays().length +
      ' cursor=' + cursor.x + ',' + cursor.y +
      ' winBounds=' + JSON.stringify(b) +
      ' offset=' + offsetX + ',' + offsetY + ' ww=' + ww +
      ' workArea=' + JSON.stringify(workArea) + '\n')
  } catch (e) {}
  // 拖动改为"主进程自采样驱动"：不再依赖渲染进程 rAF → IPC 的触发链。
  // 8ms 一拍，窗口跟随延迟从 1-2 帧降到 ~8ms，且不受渲染进程掉帧影响——
  // 这是拖动"不跟手/不流畅"的最大单项改善。
  startDragLoop()
})

// 主进程自采样：读一次光标 → 计算目标位置（物理像素对齐）→ 只有真的
// 变化时才 setPosition（冗余的 SetWindowPos 本身就会触发 DWM 重绘、
// 造成重影）。win-pos 只在移动时推送。
function sampleDrag() {
  if (!win || win.isDestroyed() || !dragAnchor) { stopDragLoop(); return }
  // 换边/镜像补偿后短暂停拍：等渲染端把构图盒换位的那一帧画出来再继续
  // 跟光标，否则会出现一帧"窗口新位置 + 内容旧偏移"的残影（见
  // dragHoldUntil 注释）。恢复后按绝对目标一步追上，跟手性不受影响。
  if (Date.now() < dragHoldUntil) return
  const a = dragAnchor
  const cursor = screen.getCursorScreenPoint()
  const targetX = a.winX + (cursor.x - a.cursorX)
  const targetY = a.winY + (cursor.y - a.cursorY)
  const { workArea, offsetX, offsetY, ww, disp } = a
  const minX = workArea.x - offsetX
  const maxX = workArea.x + workArea.width - offsetX - ww
  const minY = workArea.y - offsetY
  const maxY = workArea.y + workArea.height - offsetY - ww
  const nx = physSnap(disp, Math.min(Math.max(targetX, minX), maxX))
  const ny = physSnap(disp, Math.min(Math.max(targetY, minY), maxY))
  const cur = win.getPosition()
  if (Math.abs(cur[0] - nx) < 0.5 && Math.abs(cur[1] - ny) < 0.5) return
  win.setPosition(nx, ny)
  if (win.isDestroyed()) { stopDragLoop(); return }
  win.webContents.send('win-pos', { x: nx, y: ny, width: a.width, height: a.height, workArea })
}

function startDragLoop() {
  stopDragLoop()
  dragLoopTimer = setInterval(sampleDrag, 8)
}

function stopDragLoop() {
  if (dragLoopTimer) { clearInterval(dragLoopTimer); dragLoopTimer = null }
}

// 渲染进程的 drag-move 通知保留为兜底：自采样循环正常时是冗余的
//（同一目标位置，重复调用会被"变化才移动"过滤掉），直接忽略，避免
// 双重 setPosition 叠加触发额外的 DWM 重绘。
ipcMain.on('drag-move', () => {})

ipcMain.on('compensate-offset', (event, dx, dy, offsetX, offsetY) => {
  if (!win || !dragAnchor) { event.returnValue = false; return }
  const b = win.getBounds()
  // 渲染进程刚把鲸鱼贴图在容器内的本地偏移量改了 (dx, dy)（比如从贴右侧
  // 切换到贴左侧），这里把容器反向平移相同的量，抵消掉这次本地偏移变化，
  // 让鲸鱼贴图的绝对屏幕位置在换边前后保持连续、不产生跳动。
  const nx = b.x - dx
  const ny = b.y - dy
  win.setPosition(Math.round(nx), Math.round(ny))
  // 尺寸只有在真的漂移时才纠正——拖动中每次换边都 setSize 会让系统对
  // 窗口做一轮内部重算，是拖动闪烁的来源之一
  const b2 = win.getBounds()
  if (Math.abs(b2.width - curW) > 2 || Math.abs(b2.height - curH) > 2) {
    win.setSize(curW, curH)
  }
  // 暂停采样循环：渲染端会在补偿后的下一个绘制帧（rAF）发 dragResume 恢复；
  // 80ms 安全上限只防 dragResume 丢失，正常情况下到不了这么久
  dragHoldUntil = Date.now() + 80
  // 同步更新拖动锚点，让后续 drag-move 的位移计算基于这个新的基准坐标，
  // 否则下一次鼠标移动会把这次补偿的偏移量又叠加/抵消回去。
  dragAnchor.winX -= dx
  dragAnchor.winY -= dy
  // 换边后本地偏移量变了，限位计算也要跟着更新到新的贴靠方向，
  // 否则限位还是按换边前的偏移量算，同样的"墙"问题会在新方向上重现。
  if (typeof offsetX === 'number') dragAnchor.offsetX = offsetX
  if (typeof offsetY === 'number') dragAnchor.offsetY = offsetY
  // 渲染进程用 sendSync 调用这个接口，必须设置 returnValue 才会返回、
  // 解除渲染进程的阻塞——这也是保证"容器先挪好，本地坐标再更新"这个
  // 时序的关键一环。
  event.returnValue = true
})

ipcMain.on('drag-end', () => {
  dragAnchor = null
  stopDragLoop()
  // 进入宽限期：忽略随后排队回来的漂移读数事件
  dragQuietUntil = Date.now() + 500
})

// 渲染端在补偿平移后的"下一帧已呈现"时（双重 rAF）发这个——收到后再
// 宽限一帧（16ms）才彻底恢复采样，彻底排除"内容帧未呈现就挪窗口"的
// 一帧镜像残影。正常情况下总暂停 ≈ 2 帧 + 16ms，肉眼无感
ipcMain.on('drag-resume', () => {
  dragHoldUntil = Date.now() + 16
})

// ---------- 跟随任务栏浮动 ----------
// 任务栏"自动隐藏"滑出时系统工作区不变（自动隐藏态下 workArea 恒等于
// 全屏，且滑出/收回不会触发 workArea 变化事件），轮询 workArea 探测不到
// 滑出——改用光标触底检测：光标触及屏幕底缘 → 任务栏滑出 → 贴底的
// 鲸鱼上浮一个任务栏高度；光标离开任务栏带 → 降回。
// 是否"自动隐藏"用 bounds 与 workArea 的高度差判定：常驻任务栏会预留
// 高度（差值 > 0），此功能对其自然失效（设置里的开关亦然）。
// 拖动中任务栏滑出：仅更新 dragAnchor（winY 与工作区），由采样循环
// 在下一拍跟随——鲸鱼在拖动中同样骑上任务栏。
let tbLifted = false
let tbPollTimer = null
let tbAnimTimer = null
const TB_LIFT_H = 48
// 停止进行中的升降动画（窗口销毁/重新定向时调用）
function stopTaskbarAnim() {
  if (tbAnimTimer) { clearInterval(tbAnimTimer); tbAnimTimer = null }
}
// 升降动画：260ms ease-out 三次曲线，接近任务栏滑出的速度与节奏，
// 鲸鱼看起来是"骑着任务栏"升降而不是瞬间跳变。
// - 非拖动状态：直接步进窗口 Y；
// - 拖动状态：步进 dragAnchor.winY（采样的跟随基准），与光标跟随自然叠加；
// - 每步滚动刷新 dragQuietUntil：动画产生的高频 setPosition 会让读数说谎，
//   必须压住纠偏器，否则会在动画中途用过期坐标瞬移窗口（回弹）。
function animateTaskbarRide(targetWinY) {
  stopTaskbarAnim()
  const startY = dragAnchor ? dragAnchor.winY : win.getBounds().y
  const startT = Date.now()
  const DUR = 260
  dragQuietUntil = Math.max(dragQuietUntil, Date.now() + DUR + 300)
  tbAnimTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { stopTaskbarAnim(); return }
    const t = Math.min(1, (Date.now() - startT) / DUR)
    const eased = 1 - Math.pow(1 - t, 3)
    const y = Math.round(startY + (targetWinY - startY) * eased)
    if (dragAnchor) {
      dragAnchor.winY = y
    } else {
      const bx = win.getBounds().x
      win.setPosition(bx, y)
    }
    dragQuietUntil = Math.max(dragQuietUntil, Date.now() + 300)
    if (t >= 1) {
      stopTaskbarAnim()
      saveWindowPos()
    }
  }, 16)
}
function pollTaskbar() {
  if (!win || win.isDestroyed()) return
  try {
    const cfg = readSizeConfig()
    const enabled = cfg.taskbarFloat !== false
    const b = win.getBounds()
    const disp = displayForBounds(b)
    const bounds = disp.bounds
    const wa = disp.workArea
    const autoHide = (bounds.height - wa.height) < 4
    const cursor = screen.getCursorScreenPoint()
    const screenBottom = bounds.y + bounds.height
    // 窗口底缘的高度用约定值 curH——getBounds 的 height 在拖动后会"说谎"
    //（150% 缩放的读数漂移），会把贴底的鲸鱼算出几十像素的假偏差，
    // 导致跟随任务栏浮动在该触发时不触发。位置 y 读数可信。
    const winBottom = b.y + curH
    // 仅当鲸鱼"吸附在屏幕底缘"（底缘距屏幕底 ≤30px，与磁吸阈值一致）时
    // 才跟随任务栏浮动——右侧/其他位置吸附、悬在半空时不触发
    const nearBottom = Math.abs(winBottom - screenBottom) <= 30
    const atEdge = cursor.y >= screenBottom - 3
    const leftBand = cursor.y < screenBottom - TB_LIFT_H - 8
    if (tbLifted) {
      if (!enabled || leftBand) {
        tbLifted = false
        if (dragAnchor) {
          // 任务栏降下：恢复拖拽缓存的工作区（底缘下移 48），钳制边界随之
          // 放开，鲸鱼在拖动中跟着降回
          dragAnchor.workArea = { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
          animateTaskbarRide(dragAnchor.winY + TB_LIFT_H)
        } else {
          animateTaskbarRide(b.y + TB_LIFT_H)
        }
      }
    } else if (enabled && autoHide && nearBottom && atEdge) {
      tbLifted = true
      if (dragAnchor) {
        // 任务栏滑出：拖拽缓存的工作区底缘同步上抬 48px——否则采样循环的
        // 跟随目标会被旧钳制（maxY 仍按任务栏未滑出计算）拉回原位，
        // 骑升动画被完全抵消（表现为"不会跟着浮起"）
        dragAnchor.workArea = { x: wa.x, y: wa.y, width: wa.width, height: Math.max(0, wa.height - TB_LIFT_H) }
        animateTaskbarRide(dragAnchor.winY - TB_LIFT_H)
      } else {
        animateTaskbarRide(b.y - TB_LIFT_H)
      }
    }
  } catch (e) {}
}
function startTaskbarPoll() {
  if (tbPollTimer) return
  tbPollTimer = setInterval(pollTaskbar, 200)
}

ipcMain.on('snap-window', (_event, offsetX, offsetY, ww) => snapWindow(offsetX, offsetY, ww))

// 渲染端改了缩放比例后请求窗口跟着变尺寸（上游 scale 上限 2.5，鲸鱼和
// 气泡都变大，固定窗口会裁掉内容）。w/h 由渲染端按与主进程一致的公式
// 算出；scale 用于熔断重建时恢复初始尺寸；anchorH/anchorV 用来在改尺寸
// 的同时反向平移窗口，保持鲸鱼贴图的屏幕绝对位置不动：
//   贴右时窗口宽了 dW → 窗口左移 dW（右缘固定，鲸鱼不动）
//   贴左时右缘外扩，鲸鱼贴容器左侧本来就不动，无需平移；垂直方向同理。
// 拖动中一律拒绝（拖动节奏由 drag-move 主导，缩放请求会在松手后重新排队）。
ipcMain.on('resize-for-scale', (event, w, h, scale, anchorH, anchorV) => {
  if (!win || win.isDestroyed() || dragAnchor) { event.returnValue = false; return }
  const W = Math.round(Number(w))
  const H = Math.round(Number(h))
  const S = Number(scale)
  if (!isFinite(W) || !isFinite(H) || W < 200 || H < 200 || W > 1600 || H > 1600) {
    event.returnValue = false
    return
  }
  if (isFinite(S) && S > 0) winScale = S
  if (W === curW && H === curH) { event.returnValue = true; return }
  const dW = W - curW
  const dH = H - curH
  const b = win.getBounds()
  const nx = b.x - (anchorH === 'right' ? dW : 0)
  const ny = b.y - (anchorV === 'bottom' ? dH : 0)
  // 先更新约定值并同步 min/max 锁，再 setBounds——这样 setBounds 引发的
  // resize 事件会落在容差内，不会触发纠偏/熔断。
  curW = W
  curH = H
  try {
    win.setMinimumSize(W, H)
    win.setMaximumSize(W, H)
    win.setBounds({ x: Math.round(nx), y: Math.round(ny), width: W, height: H })
  } catch (e) {
    event.returnValue = false
    return
  }
  saveWindowPos()
  // 通知渲染端"窗口已经是新尺寸了"，渲染端这才把本地的 winW/winH
  // 常量切换过来并重排贴图——顺序反过来会有一帧贴图按新偏移画在
  // 旧窗口里、被窗口边界裁掉。
  if (!win.isDestroyed()) win.webContents.send('win-resized', { w: W, h: H, x: Math.round(nx), y: Math.round(ny) })
  event.returnValue = true
})

ipcMain.on('get-win-info', (event) => {
  if (!win) { event.returnValue = null; return }
  const b = win.getBounds()
  const { workArea } = displayForBounds(b)
  // w/h 用约定值 curW/curH 而不是 getBounds() 读数——150% 缩放下读数会漂移，
  // 渲染端拿它当"窗口逻辑尺寸"用，必须是干净的约定值
  event.returnValue = { x: b.x, y: b.y, w: curW, h: curH, workArea: workArea }
})

// 全局兜底：主进程如果出现未捕获异常，Electron 默认会弹出一个
// 系统级的"A JavaScript error occurred..."错误框，很打断使用。
// 这里接管一下，安静地记到 renderer.log 里，不再弹窗。
process.on('uncaughtException', (err) => {
  try {
    appendLog('[main] uncaughtException: ' + (err && err.stack || err) + '\n')
  } catch (e) {}
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) win.focus()
  })
  app.whenReady().then(async () => {
    // 建窗前先读一次配置里的缩放比例，让初始窗口尺寸直接到位
    // （渲染端稍后还会用同一公式校对一次，正常情况下不会触发 resize）
    try {
      const cfg = readSizeConfig()
      if (cfg && typeof cfg.scale === 'number') winScale = cfg.scale
    } catch (e) {}
    // 凭据加密编解码：Windows 上 safeStorage = DPAPI（按用户加密），
    // 手动保存的 Token 密文落盘。不可用时保持明文（credentials.js 兜底）。
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        credentials.setCodec({
          encrypt: (s) => safeStorage.encryptString(s),
          decrypt: (b) => safeStorage.decryptString(b),
        })
      }
    } catch (e) {}
    // 设置窗改配置（缩放/用量模式等）后通知挂件窗重读并同步
    await startServer(PORT, {
      onConfigChanged: () => {
        if (win && !win.isDestroyed()) win.webContents.send('config-changed')
      },
    })
    createWindow()
    createTray()
    startTaskbarPoll()
    // 诊断开关：DEV_OPEN_SETTINGS=1 启动时直接打开设置窗；=2 额外自动展开
    // 音效下拉（设置页读 autoselect 参数），供真机屏摄核验折射滤镜
    if (process.env.DEV_OPEN_SETTINGS === '1' || process.env.DEV_OPEN_SETTINGS === '2') {
      setTimeout(() => openSettingsWindow(PORT), 600)
    }
  })
}

app.on('window-all-closed', () => {
  app.quit()
})
