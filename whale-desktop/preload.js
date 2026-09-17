const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whaleDesktop', {
  setMouseEnable: (enable) => ipcRenderer.send('setMouseEnable', !!enable),
  // 拖动开始/采样都不传任何坐标——具体的光标位置和窗口位置全部由主进程
  // 通过 Electron 的 screen 模块（screen.getCursorScreenPoint()/win.getBounds()）
  // 统一读取。这两者本来就是同一套坐标系，避免了渲染进程 MouseEvent.screenX/Y
  // 在系统缩放不是 100%（比如 150%）时可能与主进程坐标系换算不一致、
  // 导致拖动跑偏/越过阈值瞬间跳动的问题。
  // 拖动开始时把"鲸鱼贴图当前在容器内的本地偏移量+贴图尺寸"一并告诉主进程，
  // 用于计算限位范围——限位应该按"鲸鱼贴图本身不超出屏幕"来算，而不是
  // 按"容器矩形不超出屏幕"来算，否则鲸鱼贴图贴的那一侧和拖动方向不一致时
  // （比如贴左侧却往右拖），会在鲸鱼真正到达屏幕边缘之前，容器自己先撞
  // 上限位，形成一堵提前很多的"墙"。
  dragStart: (offsetX, offsetY, ww) => ipcRenderer.send('drag-start', offsetX, offsetY, ww),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  // 换边补偿平移后，渲染端在补偿后的下一个绘制帧（rAF）调这个，通知主进程
  // 恢复拖拽采样——按"画过一帧"的边界恢复，既保证补偿不产生一帧残影，
  // 又把暂停压到最小（拖动中不感知的停顿）
  dragResume: () => ipcRenderer.send('drag-resume'),
  snapWindow: (offsetX, offsetY, ww) => ipcRenderer.send('snap-window', offsetX, offsetY, ww),
  // 渲染端改变缩放比例后请求窗口尺寸跟着变。参数：
  //   w/h        与 main.js sizeForScale 同一套公式算出的目标容器尺寸
  //   scale      目标缩放（熔断重建窗口时主进程要按它恢复初始尺寸）
  //   anchorH/V  当前贴边朝向——主进程据此在改尺寸的同时反向平移窗口，
  //              保证鲸鱼贴图的屏幕绝对位置不动（贴右/下时窗口左/上移）。
  //              拖动中主进程会拒绝（返回 false），渲染端松手后再重试。
  // 主进程完成后会先推一条 'win-resized'，渲染端收到后才切换本地窗口
  // 尺寸常量并重排贴图，保证"窗口先到位、贴图再挪"，中间不会有一帧
  // 贴图被旧窗口边界裁掉。
  resizeForScale: (w, h, scale, anchorH, anchorV) =>
    ipcRenderer.sendSync('resize-for-scale', w, h, scale, anchorH, anchorV),
  onWinResized: (cb) => ipcRenderer.on('win-resized', (_event, data) => cb && cb(data)),
  onWinAnchor: (cb) => ipcRenderer.on('win-anchor', (_event, data) => cb && cb(data)),
  // 拖动过程中，主进程把容器当前的绝对坐标 + 所在屏幕工作区实时同步给渲染进程，
  // 由渲染进程自己算"鲸鱼真实贴图的绝对位置"是否接近某条边——因为只有渲染进程
  // 知道鲸鱼贴图在容器里的具体偏移量（依赖用户设置的缩放比例 CFG.scale）。
  onWinPos: (cb) => ipcRenderer.on('win-pos', (_event, data) => cb && cb(data)),
  // 渲染进程决定"该换边了"之后，用这个告诉主进程：把容器反向平移
  // (dx, dy)，从而让鲸鱼贴图的绝对屏幕位置在换边前后保持连续，
  // 不再出现"明明离边缘还有一段距离，却突然唰地滑过去"的现象；
  // 同时把换边后新的本地偏移量 (offsetX, offsetY) 一并同步过去，
  // 让主进程后续的限位计算跟着更新到新的贴靠方向。
  // 换边补偿必须用同步 IPC：如果用异步 send，渲染进程会在主进程真正
  // 挪动完容器之前就已经继续往下执行、更新了本地 left/top，两者之间
  // 隔着一次 IPC 往返的时间差，哪怕只有一帧也会表现为瞬间闪烁/滑动。
  // sendSync 会阻塞到主进程处理完 setPosition 才返回，保证容器平移
  // 和本地坐标更新严格发生在同一帧内。主进程这个 handler 只是一次
  // setPosition 调用，极快，不会造成可感知的卡顿。
  compensateOffset: (dx, dy, offsetX, offsetY) => ipcRenderer.sendSync('compensate-offset', dx, dy, offsetX, offsetY),
  // 静止状态下（比如点击气泡时）实时查询一下真实的窗口坐标 + 所在屏幕
  // 工作区——不能用 anchor.v/whaleTop() 那套本地偏移量，因为那是贴边
  // 判定专用的，只在真正靠近某条边时才会更新，拖回屏幕中间之后也不会
  // 自动恢复，用来判断"当前上方空间够不够"会误判。
  getWinInfo: () => ipcRenderer.sendSync('get-win-info'),
  // 请求打开液态玻璃设置窗（独立可获焦窗口，Token 输入需要键盘焦点）
  openSettings: () => ipcRenderer.send('open-settings'),
  // 设置窗改了配置（缩放/音量/用量模式等）后，主进程推给挂件窗重读配置
  onConfigChanged: (cb) => ipcRenderer.on('config-changed', () => cb && cb()),
})
