(function () {
  if (window.__dshWhaleWidget) return
  window.__dshWhaleWidget = true

  var IMG_URL = '/dsh-whale/image.png?v=5'
  var BALANCE_URL = '/dsh-whale/balance.json'
  var SIZE_URL = '/dsh-whale/size.json'
  var GIF_URL = '/dsh-whale/rua.gif'
  var PRESS_URL = '/dsh-whale/sound/press.mp3?set='
  var RELEASE_URL = '/dsh-whale/sound/release.mp3?set='

  // 与上游 DSH 插件 v0.2.10 对齐的常量
  var WHALE_SIZE = 132
  var MIN_SCALE = 0.6
  var MAX_SCALE = 2.5
  var BUBBLE_MS = 5000
  var REFRESH_MS = 60000
  var CHANGE_MS = 900
  var ANIM_MS = 700
  var FETCH_TIMEOUT_MS = 25000
  // winW/winH 是"窗口此刻应有的逻辑尺寸"约定值，与 main.js 的 curW/curH
  // 一一对应。它们只在收到主进程 'win-resized'（缩放变化，窗口已真正
  // 改完尺寸）后才更新——绝不读取 window.innerWidth/innerHeight 实时值。
  // 原因：Windows 在 150% 缩放的机器上会偶尔让窗口的真实像素尺寸短暂漂移
  // 几个像素，如果贴图位置跟着实时尺寸算，尺寸一漂移一纠正，贴图位置也
  // 会跟着抖一下再抖回来——这正是偶发"残影闪烁"的来源。用约定值彻底屏蔽。
  //
  // 上游根盒子模型（严格按效果图）：构图盒是正方形，气泡 SVG 占满构图盒
  // 宽（1026:700，贴斜对角），鲸鱼贴图占构图盒的 59.45%、贴另一侧的底部
  // 角。left/right 停靠的镜像通过整个构图盒 scaleX(-1) 实现（文字/gif 再
  // 镜像保持可读），顶部停靠通过 dshwv-vtop 上下组成翻转实现。
  //
  // 窗口比构图盒大一圈（历史上常年内嵌设置菜单；菜单已迁移到独立的
  // 液态玻璃设置窗 settings.html，窗口公式原样保留——多余区域不可见
  // 且鼠标穿透，改动公式反而会扰动已验证的缩放/磁吸行为链）。
  var MENU_MIN_W = 372
  var MENU_EXTRA_H = 300
  var winW = 372
  var winH = 432
  function calcWinSize(scale) {
    var ww = Math.round(WHALE_SIZE * scale)
    var S = Math.round(ww / 0.5945)
    return { w: Math.max(S, MENU_MIN_W), h: Math.max(S, ww + MENU_EXTRA_H) }
  }
  function compS() { return Math.round(whaleW() / 0.5945) }
  // 镜像/垂直朝向翻转的中线死区（px）：越过中线 60px 才翻转，防止中线
  // 附近反复翻转造成的重影/闪烁（水平朝向与垂直朝向共用）
  var FLIP_DEADBAND = 60

  // 默认值与上游一致（scale 1.5 / vol 0.9）；实际值从 size.json 读取，
  // 服务端只补缺失字段，不会覆盖用户已保存的设置。
  var CFG = { scale: 1.5, sound: true, vol: 0.9, soundSet: 'duck', usageMode: 'ledger', peakMode: 'default', bubbleOn: true, taskbarFloat: true }

  var ROOT, BOX, WHALE, IMG, BUBBLE, GIF, LABEL, AMOUNT, HINT, HAM
  // facing：水平朝向（鲸鱼在屏幕左半→'left'，构图盒整体镜像）；
  // vFacing：垂直朝向（鲸鱼在屏幕上半→'top'，构图盒上下翻转、气泡垂在
  // 鲸鱼下方）。两者都由"鲸鱼实际所在的一半屏幕"决定（带 60px 死区），
  // 而不是贴边锚点——贴边锚点只在边缘 30px 内更新，拖到另一侧后不会
  // 跟着变，曾导致"鲸鱼在底部、气泡却从下方顶上来"的朝向错乱。
  var facing = 'right'
  var vFacing = 'bottom'
  var pressed = false
  var dragging = false
  var moved = false
  window.__DSHWV_DRAGGING__ = false
  var downScreenX = 0, downScreenY = 0
  var bubbleTimer = null
  var bubblePage = 0            // 0 关闭 / 1 余额页 / 2 随机台词页
  var bal = { amount: null, currency: 'CNY', today: null, isPeak: false }
  // 余额状态机（与上游一致）：loading 拉取中 / ok 正常 / error 失败（保留
  // 上次余额 + 提示）/ changing 检测到余额变动、滚动动画进行中
  var stateStatus = 'ok'
  var stateMsg = ''
  var shown = null              // 滚动动画当前显示的数值（动画起点/终点）
  var busy = false
  var animId = null
  var animDelayTimer = null
  var settleTimer = null
  // 随机台词状态（与上游一致）：点击气泡进入随机台词段，再点关闭
  var bubbleRandomActive = false
  var bubbleRandomLines = null
  var gifFailed = false
  var lastHintText = null
  var hintFadeTimer = null
  var gifFadeTimer = null

  function whaleW() { return Math.round(WHALE_SIZE * CFG.scale) }

  // 防御性调用 window.whaleDesktop 上的方法：
  // 如果 preload.js 版本和这份 widget.js 版本对不上（比如只更新了一部分文件、
  // 或者旧进程没退干净还在跑旧的 preload），某个方法可能不存在。
  // 直接调用一个 undefined 的方法会抛异常，导致整个 pointerdown/pointerup
  // 处理函数在还没走到"注册后续监听器"之前就被打断——表现成拖动和点击
  // 全部失效。这里统一做存在性检查 + try/catch，保证就算接口对不上，
  // 也只是那一小块功能失效，不会连累整个鼠标交互瘫痪。
  function bridgeCall(name) {
    var args = Array.prototype.slice.call(arguments, 1)
    var api = window.whaleDesktop
    if (!api || typeof api[name] !== 'function') {
      if (window.console) console.warn('[whale] whaleDesktop.' + name + ' 不存在，请确认 preload.js 是否已更新为最新版本')
      return
    }
    try { api[name].apply(api, args) } catch (err) {
      if (window.console) console.warn('[whale] 调用 whaleDesktop.' + name + ' 失败：', err)
    }
  }

  // 和 bridgeCall 一样的防御性判断，但用于需要拿到返回值的调用
  // （比如 getWinInfo 这种同步查询），失败时返回 null。
  function bridgeCallReturn(name) {
    var args = Array.prototype.slice.call(arguments, 1)
    var api = window.whaleDesktop
    if (!api || typeof api[name] !== 'function') {
      if (window.console) console.warn('[whale] whaleDesktop.' + name + ' 不存在，请确认 preload.js 是否已更新为最新版本')
      return null
    }
    try { return api[name].apply(api, args) } catch (err) {
      if (window.console) console.warn('[whale] 调用 whaleDesktop.' + name + ' 失败：', err)
      return null
    }
  }

  var BUBBLE_SVG =
    '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="dshwv-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse class="dshwv-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '<ellipse class="dshwv-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '</svg>'

  var CSS =
    '.dshwv-root{position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;user-select:none;-webkit-user-select:none;z-index:99998;font-family:"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;}' +
    // 构图盒（上游根盒子）：正方形，贴窗口的停靠角；镜像/垂直停靠都翻转
    // 这个盒子，鲸鱼/气泡/汉堡全部跟着走。
    // transform 过渡 .3s（与上游 root 一致）：跨中线换向时 scaleX(-1) 不再
    // 是瞬间切换，而是"压扁→翻面→展开"的渐变动画。注意只过渡 transform
    // ——left/top 必须保持瞬时，才能和主进程的换边补偿平移严格同帧。
    '.dshwv-box{position:absolute;width:var(--dshws);height:var(--dshws);pointer-events:none;transition:transform .3s ease;}' +
    // 整体水平镜像（左半屏停靠）：鲸鱼/气泡/汉堡全部跟着翻，文字和 gif
    // 由下面的规则再翻回来保持可读
    '.dshwv-box.dshwv-left{transform:scaleX(-1);}' +
    // 鲸鱼贴构图盒右下角（上游 59.45%）；顶部停靠时贴右上角
    '.dshwv-whale{position:absolute;right:0;bottom:0;width:var(--dshww);height:var(--dshww);pointer-events:auto;cursor:grab;' +
      'transform-origin:50% 100%;transition:transform .22s cubic-bezier(.34,1.56,.64,1);}' +
    '.dshwv-box.dshwv-vtop .dshwv-whale{top:0;bottom:auto;}' +
    '.dshwv-whale img{width:100%;height:100%;display:block;pointer-events:none;-webkit-user-drag:none;}' +
    // 汉堡菜单按钮：锚定在鲸鱼贴图自身的右上角（不随垂直构图翻转而改变
    // 相对鲸鱼的位置）；悬停鲸鱼显示，镜像时跟随整体翻到视觉左侧
    '.dshwv-ham{position:absolute;top:4px;right:4px;width:26px;height:26px;border:none;border-radius:6px;' +
      'background:rgba(32,49,112,.85);cursor:pointer;pointer-events:auto;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:4px;padding:0;z-index:3;opacity:0;transition:opacity .15s ease;}' +
    '.dshwv-box:hover .dshwv-ham,.dshwv-whale:hover .dshwv-ham{opacity:1;}' +
    '.dshwv-ham span{display:block;width:14px;height:2px;background:#fff;border-radius:1px;}' +
    '.dshwv-ham:hover{background:#203170;}' +
    // 气泡盒占满构图盒宽、贴顶部（上游布局）；顶部停靠时贴底部、
    // svg 上下翻转使圆点尾巴朝上指向鲸鱼。
    // 开/关动画（与上游一致）：默认关闭态——形状缩小(.7)且透明，文字透明；
    // 打开态 .dshwv-bubble-open——圆点b2(0s)→圆点b1(.13s)→主体(.26s)错峰
    // 由小到大渐显，文字延迟 .36s 淡入；关闭时按 bshape(.1s)→b1(.2s)→
    // b2(.3s) 的顺序错峰缩小淡出。盒子始终 display:block，靠类切换驱动。
    '.dshwv-bubble{position:absolute;left:0;top:0;width:100%;aspect-ratio:1026/700;pointer-events:none;z-index:99999;}' +
    '.dshwv-box.dshwv-vtop .dshwv-bubble{top:auto;bottom:0;}' +
    '.dshwv-box.dshwv-vtop .dshwv-bubble svg{transform:scaleY(-1);}' +
    '.dshwv-bubble svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}' +
    '.dshwv-bubble svg path,.dshwv-bubble svg ellipse{transform-box:fill-box;transform-origin:50% 50%;pointer-events:none;cursor:pointer;' +
      'opacity:0;transform:scale(.7);transition:opacity .2s ease,transform .2s ease,pointer-events 0s;}' +
    '.dshwv-bubble .dshwv-bshape{transition-delay:.1s;}' +
    '.dshwv-bubble .dshwv-b1{transition-delay:.2s;}' +
    '.dshwv-bubble .dshwv-b2{transition-delay:.3s;}' +
    '.dshwv-bubble.dshwv-bubble-open svg path,.dshwv-bubble.dshwv-bubble-open svg ellipse{opacity:1;transform:none;pointer-events:auto;}' +
    '.dshwv-bubble.dshwv-bubble-open .dshwv-b2{transition-delay:0s;}' +
    '.dshwv-bubble.dshwv-bubble-open .dshwv-b1{transition-delay:.13s;}' +
    '.dshwv-bubble.dshwv-bubble-open .dshwv-bshape{transition-delay:.26s;}' +
    '.dshwv-gif{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);display:none;opacity:0;transition:opacity .2s ease;' +
      'max-width:calc(var(--dshw-u) * 560);max-height:calc(var(--dshw-u) * 400);object-fit:contain;pointer-events:none;-webkit-user-drag:none;user-select:none;}' +
    '.dshwv-bubble.dshwv-bubble-open .dshwv-gif{opacity:1;}' +
    '.dshwv-box.dshwv-vtop .dshwv-gif{top:62%;}' +
    '.dshwv-box.dshwv-left .dshwv-gif{transform:translate(-50%,-50%) scaleX(-1);}' +
    '.dshwv-text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);text-align:center;color:#536ba9;line-height:1.15;white-space:nowrap;pointer-events:none;' +
      'opacity:0;transition:opacity .16s ease,transform .3s ease;}' +
    '.dshwv-bubble.dshwv-bubble-open .dshwv-text{opacity:1;transition:opacity .16s ease .36s,transform .3s ease;}' +
    '.dshwv-box.dshwv-vtop .dshwv-text{top:62%;}' +
    // 整体镜像后把文字再翻回来（保持可读）
    '.dshwv-box.dshwv-left .dshwv-text{transform:translate(-50%,-50%) scaleX(-1);}' +
    '.dshwv-text div{display:block;}' +
    '.dshwv-label{font-size:calc(var(--dshw-u) * 66);font-weight:600;letter-spacing:.06em;}' +
    '.dshwv-amount{font-size:calc(var(--dshw-u) * 128);font-weight:800;line-height:1.05;}' +
    '.dshwv-period{font-size:calc(var(--dshw-u) * 104);font-weight:800;line-height:1.05;}' +
    '.dshwv-wrap{white-space:normal;max-width:calc(var(--dshw-u) * 560);line-height:1.2;}' +
    '.dshwv-hint{font-size:calc(var(--dshw-u) * 56);color:#9fb0d9;letter-spacing:.02em;margin-top:calc(var(--dshw-u) * 9);min-height:calc(var(--dshw-u) * 64);line-height:1.15;white-space:normal;max-width:calc(var(--dshw-u) * 640);margin-left:auto;margin-right:auto;}'

  function injectCss() {
    var s = document.createElement('style')
    s.textContent = CSS
    document.head.appendChild(s)
  }

  function buildDom() {
    ROOT = document.createElement('div')
    ROOT.className = 'dshwv-root'

    BOX = document.createElement('div')
    BOX.className = 'dshwv-box'

    WHALE = document.createElement('div')
    WHALE.className = 'dshwv-whale'
    IMG = document.createElement('img')
    IMG.src = IMG_URL
    IMG.alt = '小鲸鱼'
    IMG.draggable = false
    WHALE.appendChild(IMG)
    BOX.appendChild(WHALE)

    BUBBLE = document.createElement('div')
    BUBBLE.className = 'dshwv-bubble'
    BUBBLE.innerHTML = BUBBLE_SVG +
      '<img class="dshwv-gif" src="' + GIF_URL + '" alt="">' +
      '<div class="dshwv-text"><div></div><div></div><div></div></div>'
    GIF = BUBBLE.querySelector('.dshwv-gif')
    LABEL = BUBBLE.querySelector('.dshwv-text div:nth-child(1)')
    AMOUNT = BUBBLE.querySelector('.dshwv-text div:nth-child(2)')
    HINT = BUBBLE.querySelector('.dshwv-text div:nth-child(3)')
    // gif 资源缺失（404/解码失败）时永久降级为文字台词，避免空白气泡
    GIF.addEventListener('error', function () { gifFailed = true })
    BOX.appendChild(BUBBLE)

    // 汉堡按钮挂在鲸鱼贴图内：右上角固定，垂直构图翻转时相对鲸鱼
    // 的位置不变；点它打开液态玻璃设置窗（独立可获焦窗口）；右键鲸鱼同样
    HAM = document.createElement('button')
    HAM.type = 'button'
    HAM.className = 'dshwv-ham'
    HAM.title = '设置'
    HAM.innerHTML = '<span></span><span></span><span></span>'
    HAM.addEventListener('pointerdown', function (e) { e.stopPropagation() })
    HAM.addEventListener('click', function (e) { e.stopPropagation(); openSettings() })
    WHALE.appendChild(HAM)

    ROOT.appendChild(BOX)

    document.body.appendChild(ROOT)

    WHALE.addEventListener('pointerdown', onDown)
    WHALE.addEventListener('contextmenu', function (e) { e.preventDefault(); openSettings() })
    BUBBLE.addEventListener('click', function (e) { e.stopPropagation(); cycleBubble() })
  }

  // 设置在独立的液态玻璃窗口里（settings.html / settings-window.js）：
  // 挂件窗口 focusable:false 无法承载键盘输入，且历史上原生控件（下拉等）
  // 在透明不可激活窗口里问题不断，故整体迁出
  function openSettings() {
    bridgeCall('openSettings')
  }

  // ---------- 缩放/音量等设置已迁移至独立设置窗（settings.html）。
  // 设置窗改动配置后，主进程推 'config-changed'（文件末尾监听），挂件窗
  // 重读配置并走同一套缩放/音效应用链路。 ----------

  function applyVars() {
    var ww = whaleW()
    var S = compS()
    BOX.style.setProperty('--dshww', ww + 'px')
    BOX.style.setProperty('--dshws', S + 'px')
    WHALE.style.width = ww + 'px'
    WHALE.style.height = ww + 'px'
    BUBBLE.style.setProperty('--dshw-u', (S / 1026) + 'px')
  }

  function applySize() {
    applyVars()
    positionWhale()
    // 缩放变了，容器窗口也要跟着变（拖动中暂缓，松手后重新排队）
    queueWinResize(false)
  }

  // ---------- 窗口尺寸随缩放 ----------
  // 尺寸请求做 120ms 防抖：拖缩放滑条时 applySize 会高频触发，没必要
  // 每一格都改一次窗口。immediate=true 跳过防抖（启动对齐用）。
  // resizeForScale 是 sendSync：主进程改完窗口才返回。返回后立刻把本地
  // 约定值切到目标尺寸并重排贴图——不能等 'win-resized' 事件，否则中间
  // 会有一帧"窗口已挪、贴图还在旧位置"的错位（正是设置面板闪烁的来源）。
  var winResizeTimer = null
  function queueWinResize(immediate) {
    var need = calcWinSize(CFG.scale)
    if (need.w === winW && need.h === winH) return
    if (winResizeTimer) { clearTimeout(winResizeTimer); winResizeTimer = null }
    if (dragging) return
    if (!immediate) {
      winResizeTimer = setTimeout(function () {
        winResizeTimer = null
        if (!dragging) applyWinResize(need.w, need.h)
      }, 120)
      return
    }
    applyWinResize(need.w, need.h)
  }
  function applyWinResize(w, h) {
    if (w === winW && h === winH) return
    bridgeCall('resizeForScale', w, h, CFG.scale, facing, vFacing)
    // sendSync 返回时窗口已经就位——同步切换本地约定值，避免错位帧
    winW = w
    winH = h
    applyVars()
    positionWhale()
  }

  // 构图盒在窗口内的位置：贴停靠角（镜像→左，否则右；上半屏→上，否则下）
  function boxLeft() { return facing === 'left' ? 0 : (winW - compS()) }
  function boxTop() { return vFacing === 'top' ? 0 : (winH - compS()) }
  // 鲸鱼贴图的本地坐标 = 构图盒位置 + 盒内偏移。必须与 CSS 定位规则
  // （.dshwv-whale right:0 bottom:0 / .dshwv-vtop top:0）完全一致：
  // 拖拽限位、磁吸、换边补偿全部依赖这套本地坐标。
  function whaleLeft() {
    return boxLeft() + (facing === 'left' ? 0 : (compS() - whaleW()))
  }
  function whaleTop() {
    return boxTop() + (vFacing === 'top' ? 0 : (compS() - whaleW()))
  }

  function positionWhale() {
    BOX.style.left = boxLeft() + 'px'
    BOX.style.top = boxTop() + 'px'
    // 镜像与垂直朝向都由构图盒的类驱动（整体翻转），贴图本身不再单独摆位
    BOX.classList.toggle('dshwv-left', facing === 'left')
    BOX.classList.toggle('dshwv-vtop', vFacing === 'top')
    applyTransform()
  }

  function applyTransform() {
    WHALE.style.transform = pressed ? 'scaleY(.88) scaleX(1.05)' : ''
  }

  function loadConfig(cb) {
    var done = false
    function finish() { if (!done) { done = true; if (typeof cb === 'function') cb() } }
    fetch(SIZE_URL, { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (d) {
      if (d && typeof d === 'object') {
        if (typeof d.scale === 'number' && isFinite(d.scale) && d.scale >= MIN_SCALE && d.scale <= MAX_SCALE) CFG.scale = d.scale
        if (typeof d.vol === 'number' && isFinite(d.vol)) CFG.vol = d.vol
        if (typeof d.sound === 'boolean') CFG.sound = d.sound
        if (d.soundSet === 'duck' || d.soundSet === 'fx1') CFG.soundSet = d.soundSet
        if (d.usageMode === 'ledger' || d.usageMode === 'token') CFG.usageMode = d.usageMode
        if (d.peakMode === 'default' || d.peakMode === 'liangwen' || d.peakMode === 'qiangqiang') CFG.peakMode = d.peakMode
        if (typeof d.bubbleOn === 'boolean') CFG.bubbleOn = d.bubbleOn
        if (typeof d.taskbarFloat === 'boolean') CFG.taskbarFloat = d.taskbarFloat
      }
      finish()
    }).catch(function () { finish() })
  }

  function saveConfig() {
    fetch(SIZE_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: CFG.scale, vol: CFG.vol, sound: CFG.sound, soundSet: CFG.soundSet, usageMode: CFG.usageMode, peakMode: CFG.peakMode, bubbleOn: CFG.bubbleOn, taskbarFloat: CFG.taskbarFloat }),
    }).catch(function () {})
  }

  // ---------- 余额拉取与渲染（状态机与上游一致） ----------
  function fetchBalance(manual) {
    if (busy) return
    busy = true
    if (animDelayTimer) { clearTimeout(animDelayTimer); animDelayTimer = null }
    if (manual || bal.amount === null) { stateStatus = 'loading'; render() }
    var ctrl = null
    var timer = null
    try {
      ctrl = new AbortController()
      timer = setTimeout(function () { try { ctrl.abort() } catch (err) {} }, FETCH_TIMEOUT_MS)
    } catch (err) {}
    fetch(BALANCE_URL, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (data && data.ok) {
          var nb = Number(data.totalBalance)
          var nc = String(data.currency || 'CNY')
          var changed = bal.amount !== null && (nb !== bal.amount || nc !== bal.currency)
          var currencyChanged = bal.currency !== null && nc !== bal.currency
          bal.amount = nb
          bal.currency = nc
          stateMsg = ''
          bal.today = data.todayUsage !== undefined ? data.todayUsage : null
          bal.isPeak = !!data.isPeak
          if (changed && !currencyChanged) {
            if (!manual) {
              // 后台检测到余额变动：先让气泡弹出来，0.3s 后数字开始滚动
              showBubble()
              stateStatus = 'changing'
              if (animDelayTimer) clearTimeout(animDelayTimer)
              animDelayTimer = setTimeout(function () {
                animDelayTimer = null
                animateAmount(shown, nb, nc, ANIM_MS)
              }, 300)
              if (settleTimer) clearTimeout(settleTimer)
              settleTimer = setTimeout(function () {
                settleTimer = null
                if (stateStatus === 'changing') { stateStatus = 'ok'; render() }
              }, CHANGE_MS + 300)
            } else {
              animateAmount(shown, nb, nc, ANIM_MS)
              stateStatus = 'ok'
              render()
            }
          } else {
            if (animId === null) shown = nb
            stateStatus = 'ok'
            render()
          }
        } else {
          // 失败（含未配置 Token）：保留上次余额，把原因放进提示行
          //（.dshwv-hint 已允许换行，不再粗暴截断到 14 字）
          stateStatus = 'error'
          stateMsg = (data && data.error) ? String(data.error) : '获取失败'
          render()
        }
      })
      .catch(function () {
        stateStatus = 'error'
        stateMsg = '获取失败'
        render()
      })
      .finally(function () {
        busy = false
        if (timer) clearTimeout(timer)
      })
  }

  // fmt 与上游一致：CNY 显示 "¥ 9.99"，其他币种数字在前 "9.99 USD"
  function fmt(v, currency) {
    var num = Number(v)
    var fixed = isFinite(num) ? num.toFixed(2) : '--'
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
  }

  function animateAmount(from, to, currency, duration) {
    if (animId) cancelAnimationFrame(animId)
    if (from === null || !isFinite(from)) from = to
    if (from === to) {
      shown = to
      AMOUNT.textContent = fmt(to, currency)
      return
    }
    var startTime = null
    function step(ts) {
      if (startTime === null) startTime = ts
      var t = Math.min(1, (ts - startTime) / duration)
      var eased = 1 - Math.pow(1 - t, 3)
      var val = from + (to - from) * eased
      AMOUNT.textContent = fmt(val, currency)
      if (t < 1) {
        animId = requestAnimationFrame(step)
      } else {
        animId = null
        shown = to
        AMOUNT.textContent = fmt(to, currency)
      }
    }
    animId = requestAnimationFrame(step)
  }

  function render() {
    var amount, hint
    if (stateStatus === 'error') {
      amount = shown !== null ? fmt(shown, bal.currency) : '--'
      hint = stateMsg ? stateMsg.slice(0, 42) : '获取失败 · 点击重试'
    } else if (bal.amount === null) {
      amount = shown !== null ? fmt(shown, bal.currency) : '…'
      hint = '加载中…'
    } else {
      amount = shown !== null ? fmt(shown, bal.currency) : fmt(bal.amount, bal.currency)
      hint = '今日已用 ' + (bal.today !== null && bal.today !== undefined ? fmt(bal.today, bal.currency) : '--')
    }
    AMOUNT.textContent = amount
    if (bubbleRandomActive && bubbleRandomLines) {
      applyBubbleLines(bubbleRandomLines)
    } else {
      setHint(hint)
    }
  }

  function setHint(text) {
    // 首次/恢复（lastHintText===null）时直接写文本，不做淡出淡入——否则
    // 气泡打开或按压重开时会先淡出再淡入，造成「消失一下又出现」。
    // 只有气泡打开期间的内容变化（加载中→今日已用）才走动画。
    if (text === lastHintText) return
    var first = lastHintText === null
    lastHintText = text
    if (first || bubblePage === 0) {
      HINT.textContent = text
      return
    }
    HINT.style.transition = 'opacity .18s ease'
    HINT.style.opacity = '0'
    hintFadeTimer = setTimeout(function () {
      hintFadeTimer = null
      HINT.textContent = text
      HINT.style.opacity = '1'
      setTimeout(function () {
        HINT.style.transition = ''
        HINT.style.opacity = ''
      }, 220)
    }, 190)
  }

  // ---------- 随机台词（与上游 v0.2.10 逐字一致） ----------
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }
  function singleCenter(style, text, color, wrap) { return [null, { t: text, s: style, c: color || '', w: !!wrap }, null] }
  function buildGroup1() {
    var peak = !!bal.isPeak
    var offText = '空闲时段'
    var peakText = '高峰时段'
    if (CFG.peakMode === 'liangwen') {
      offText = '梁文谷'
      peakText = '梁文峰'
    } else if (CFG.peakMode === 'qiangqiang') {
      offText = '!?谷谷?!'
      peakText = '!?峰峰?!'
    }
    return [
      { t: '当前时间段为:', s: 'A', c: '' },
      { t: peak ? peakText : offText, s: 'P', c: peak ? '#e0433f' : '#2fa24c' },
      { t: '今日已用 ' + fmt(bal.today, bal.currency), s: 'C', c: '' },
    ]
  }
  var RANDOM_GROUPS = [
    { w: 45, lines: buildGroup1 },
    { w: 7, lines: function () { return singleCenter('B', pickOne(['好模型... ↓', '好女孩...↓'])) } },
    { w: 7, lines: function () { return singleCenter('A', pickOne(['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！']), '', true) } },
    { w: 10, lines: function () { return { gif: true } } },
    { w: 3, lines: function () { return singleCenter('A', pickOne(['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...']), '', true) } },
    { w: 1, lines: function () { return singleCenter('B', '哦鲸鲸... ') } },
  ]
  function pickRandomLines() {
    var total = 0
    for (var i = 0; i < RANDOM_GROUPS.length; i++) total += RANDOM_GROUPS[i].w
    var r = Math.random() * total
    for (var i = 0; i < RANDOM_GROUPS.length; i++) {
      r -= RANDOM_GROUPS[i].w
      if (r < 0) return RANDOM_GROUPS[i].lines()
    }
    return RANDOM_GROUPS[RANDOM_GROUPS.length - 1].lines()
  }

  var BUBBLE_STYLE_CLASS = { A: 'dshwv-label', B: 'dshwv-amount', P: 'dshwv-period', C: 'dshwv-hint' }
  function applyBubbleLines(lines) {
    if (lines && lines.gif) {
      // gif 台词组：只显示 gif，隐藏三行文字。
      // inline opacity 必须清空——渐显由 .dshwv-bubble-open 的类规则驱动
      if (gifFailed) {
        // gif 加载失败/路由缺失：降级为文字台词，避免空白白色气泡
        lines = singleCenter('A', pickOne(['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...']), '', true)
      } else {
        if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
        GIF.style.display = 'block'
        GIF.style.opacity = ''
        LABEL.style.display = 'none'
        AMOUNT.style.display = 'none'
        HINT.style.display = 'none'
        return
      }
    }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    GIF.style.display = 'none'
    GIF.style.opacity = ''
    var els = [LABEL, AMOUNT, HINT]
    for (var i = 0; i < 3; i++) {
      var el = els[i]
      var ln = lines && lines[i]
      if (ln) {
        el.style.display = ''
        el.className = (BUBBLE_STYLE_CLASS[ln.s] || 'dshwv-label') + (ln.w ? ' dshwv-wrap' : '')
        el.textContent = ln.t
        el.style.color = ln.c || ''
      } else {
        el.style.display = 'none'
        el.textContent = ''
        el.style.color = ''
      }
    }
  }

  function restoreBubbleLines() {
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    lastHintText = null
    GIF.style.display = 'none'
    GIF.style.opacity = ''
    LABEL.style.display = ''
    LABEL.className = 'dshwv-label'
    LABEL.textContent = 'DeepSeek 余额'
    LABEL.style.color = ''
    AMOUNT.style.display = ''
    AMOUNT.className = 'dshwv-amount'
    AMOUNT.style.color = ''
    HINT.style.display = ''
    HINT.className = 'dshwv-hint'
    HINT.style.color = ''
    render()
  }

  function showBubble() {
    if (!CFG.bubbleOn) return
    bubblePage = 1
    bubbleRandomActive = false
    bubbleRandomLines = null
    restoreBubbleLines()
    openBubble()
  }

  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null }
    bubbleRandomActive = false
    bubbleRandomLines = null
    bubblePage = 0
    // 摘掉打开类 → 形状按 bshape(.1s)→b1(.2s)→b2(.3s) 错峰缩小淡出，
    // 文字同步淡出（动画全部由 CSS 过渡播放，这里不直接隐藏盒子）
    BUBBLE.classList.remove('dshwv-bubble-open')
    // gif 靠 opacity 过渡淡出，display:none 会跳过过渡——等淡出完再隐藏
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    gifFadeTimer = setTimeout(function () {
      gifFadeTimer = null
      GIF.style.display = 'none'
    }, 240)
  }

  function cycleBubble() {
    // 上游点击循环：①余额页 → ②加权随机台词（含 gif 组）→ ③关闭
    if (bubblePage === 1) {
      bubbleRandomActive = true
      bubbleRandomLines = pickRandomLines()
      applyBubbleLines(bubbleRandomLines)
      bubblePage = 2
      if (bubbleTimer) clearTimeout(bubbleTimer)
      bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
    } else if (bubblePage === 2) {
      hideBubble()
    } else {
      fetchBalance(true)
      showBubble()
    }
  }

  // 气泡盒固定占满构图盒（上游布局）：开关只切换 .dshwv-bubble-open 类，
  // 渐显/渐退动画全部由 CSS 过渡播放。盒子始终在 DOM 里（关闭态透明且
  // 不拦截鼠标），不存在"候选位置"——镜像/停靠由构图盒的类驱动。
  function openBubble() {
    if (!CFG.bubbleOn || bubblePage === 0) return
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    // 强制 reflow：连续快速开关时保证"关闭态→打开态"的过渡能重播
    BUBBLE.classList.remove('dshwv-bubble-open')
    void BUBBLE.offsetWidth
    BUBBLE.classList.add('dshwv-bubble-open')
    if (bubbleTimer) clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }

  // ---------- 设置在独立窗口（见 openSettings），挂件窗只负责响应变更 ----------

  // ---------- 音效（与上游一致的预加载 + 重叠切割规则） ----------
  var pressAudio = null
  var releaseAudio = null
  var pressing = false
  var pressEnded = false
  var releasePlayed = false
  var releaseTimer = null
  function audioVol() { return Math.min(1, Math.max(0, CFG.vol)) }
  function applySoundSet() {
    try {
      pressAudio = new Audio(PRESS_URL + CFG.soundSet)
      pressAudio.preload = 'auto'
      pressAudio.volume = audioVol()
      releaseAudio = new Audio(RELEASE_URL + CFG.soundSet)
      releaseAudio.preload = 'auto'
      releaseAudio.volume = audioVol()
    } catch (err) {}
  }
  function playPress() {
    if (!CFG.sound || CFG.vol <= 0 || !pressAudio) return
    try {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
      if (releaseAudio) {
        releaseAudio.pause()
        try { releaseAudio.currentTime = 0 } catch (e) {}
      }
      pressEnded = false
      releasePlayed = false
      pressAudio.onended = function () {
        pressEnded = true
        // 兜底（拿不到时长时）：短按 → Ya1 播完紧接着放 Ya2；
        // 长按（还按着）→ 等 pressUp() 再放
        if (!pressing && !releasePlayed) playRelease()
      }
      try { pressAudio.currentTime = 0 } catch (e) {}
      pressAudio.volume = audioVol()
      var p = pressAudio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {}
  }
  function playRelease() {
    if (releasePlayed || !CFG.sound || CFG.vol <= 0 || !releaseAudio) return
    releasePlayed = true
    try {
      try { releaseAudio.currentTime = 0 } catch (e) {}
      releaseAudio.volume = audioVol()
      var p = releaseAudio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {}
  }
  // 松手：短按时把 Ya2 安排在 Ya1 播放的最后 100ms 内，衔接连贯不叠音；
  // 长按（Ya1 已播完）立刻放 Ya2；拿不到时长时靠 onended 兜底。
  function pressUpSound() {
    if (pressEnded) {
      playRelease()
      return
    }
    var durKnown = false
    var remainMs = 0
    try {
      var dur = pressAudio ? pressAudio.duration : 0
      if (isFinite(dur) && dur > 0) {
        durKnown = true
        remainMs = (dur - pressAudio.currentTime) * 1000
      }
    } catch (err) {}
    if (durKnown) {
      releaseTimer = setTimeout(function () {
        releaseTimer = null
        playRelease()
      }, Math.max(0, remainMs - 100))
    }
  }

  function onDown(e) {
    if (e.button !== 0) return
    // 防御性清理：万一上一次拖动因为某种原因没有正常触发 onUp
    // （例如曾经被穿透打断导致 pointerup 丢失），这里先移除残留监听器，
    // 避免新旧监听器叠加、用陈旧的起始坐标算出错误位移导致鲸鱼乱跳。
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    document.removeEventListener('pointercancel', onUp, true)
    dragging = true
    moved = false
    pressed = true
    pressing = true
    // downScreenX/Y 只用于判断"是否移动超过阈值"从而区分点击/拖动，
    // 不用于计算窗口应该移动到哪——真正的位移量由主进程通过
    // screen.getCursorScreenPoint() 自己采样，避免渲染进程 MouseEvent
    // 坐标在系统缩放（如150%）下与主进程坐标系不一致导致跑偏。
    downScreenX = e.screenX
    downScreenY = e.screenY
    // 立刻显式标记为拖动中，并强制开启鼠标交互——不依赖下一次 mousemove
    // 才生效，避免起手瞬间就被穿透逻辑抢先关闭。
    // 拖动过程中镜像切换会同时改动鲸鱼本地位置和让主进程瞬间平移容器
    // 做补偿——容器那边是瞬间到位的，本地坐标的更新必须与容器平移严格
    // 同帧（compensateOffset 走 sendSync 保证时序），贴图本身没有
    // left/top 过渡，不会出现滑动错位。
    window.__DSHWV_DRAGGING__ = true
    if (window.whaleDesktop) {
      bridgeCall('setMouseEnable', true)
      bridgeCall('dragStart', whaleLeft(), whaleTop(), whaleW())
    }
    applyTransform()
    WHALE.style.cursor = 'grabbing'
    if (WHALE.setPointerCapture) { try { WHALE.setPointerCapture(e.pointerId) } catch (err) {} }
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onUp, true)
    playPress()
    e.preventDefault()
  }

  var dragMoveRafPending = false
  function onMove(e) {
    if (!dragging) return
    var dx = e.screenX - downScreenX
    var dy = e.screenY - downScreenY
    // 拖拽不收起气泡：气泡固定在构图盒内跟随整体移动，无需任何处理
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true
    // 不再自己算目标坐标——只是通知主进程"再采样一次当前光标位置"，
    // 具体挪到哪由主进程用它自己的坐标系统一计算。挪动后主进程会
    // 通过 'win-pos' 把容器最新坐标推回来（见 handleWinPos），
    // 朝向（facing）和贴边换边判断都在那里统一处理。
    // 用 requestAnimationFrame 把通知频率限制到最多每帧一次——
    // 原始 pointermove 事件在高轮询率鼠标上可能每秒触发几百次，
    // 每一次 setPosition 都有概率撞上 Windows 在 150% 缩放下那个
    // 不稳定的内部尺寸重算，降低触发频率能减少撞上的概率。
    if (dragMoveRafPending) return
    dragMoveRafPending = true
    requestAnimationFrame(function () {
      dragMoveRafPending = false
      if (!dragging) return
      if (window.whaleDesktop) bridgeCall('dragMove')
    })
  }

  // 主进程每次挪动容器后，会把容器的绝对坐标 + 所在屏幕工作区推过来。
  // 朝向（facing/vFacing）按"鲸鱼贴图当前在哪一半屏幕"实时决定，各自带
  // 60px 死区；翻转会改变鲸鱼/构图盒的本地坐标，因此和水平换边一样用
  // compensateOffset 让容器反向平移，保证鲸鱼的屏幕绝对位置连续不跳。
  function handleWinPos(pos) {
    if (!dragging || !pos || !pos.workArea) return
    var wa = pos.workArea
    var ww = whaleW()
    var oldLocalX = whaleLeft()
    var oldLocalY = whaleTop()

    // ---- 水平朝向：屏幕竖直中线 + 死区 ----
    var whaleCenterX = pos.x + oldLocalX + ww / 2
    var distToMid = whaleCenterX - (wa.x + wa.width / 2)
    var newFacing = facing
    if (facing === 'right' && distToMid < -FLIP_DEADBAND) newFacing = 'left'
    else if (facing === 'left' && distToMid > FLIP_DEADBAND) newFacing = 'right'

    // ---- 垂直朝向：默认气泡朝上；只有鲸鱼头顶离屏幕顶部太近、上方
    // 放不下气泡（约 0.62 个构图盒高）时才翻到 vtop（气泡垂到下方）。
    // ±60px 死区防抖。以前的"屏幕竖直中线翻转"会在上方明明有空间时把
    // 气泡甩到下面（视觉突兀），而且中线附近拖动频繁触发上下互换
    //（用户描述的"水面镜像"残影）。
    var whaleScreenTop = pos.y + oldLocalY
    var roomNeeded = Math.round(compS() * 0.62)
    var boundary = wa.y + roomNeeded
    var newVFacing = vFacing
    if (vFacing === 'bottom' && whaleScreenTop < boundary - FLIP_DEADBAND) newVFacing = 'top'
    else if (vFacing === 'top' && whaleScreenTop > boundary + FLIP_DEADBAND) newVFacing = 'bottom'

    var changed = (newFacing !== facing) || (newVFacing !== vFacing)
    if (changed) {
      facing = newFacing
      vFacing = newVFacing
      var newLocalX = whaleLeft()
      var newLocalY = whaleTop()
      var deltaX = newLocalX - oldLocalX
      var deltaY = newLocalY - oldLocalY
      // 先用同步 IPC 让主进程把容器挪到位（阻塞等待其真正完成），
      // 再更新本地坐标——避免"容器还没挪好、本地坐标已经变了"这一帧
      // 的错位，那正是之前滑动/闪烁的来源。
      if ((deltaX || deltaY) && window.whaleDesktop) {
        bridgeCall('compensateOffset', deltaX, deltaY, newLocalX, newLocalY)
        // 恢复信号必须等"翻转后的内容帧"真正呈现后再发。单个 rAF 在绘制
        // 前触发——用它发恢复，主进程可能在内容帧提交合成器之前就挪窗口，
        // 造成一帧"窗口已按补偿位移、内容还在翻转前位置"的镜像残影
        //（垂直翻转补偿高达 ~300px，尤为明显）。双重 rAF = 第一帧已呈现
        // 后才发信号；主进程侧另有 80ms 安全上限 + 收到后再宽限一帧。
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            if (window.whaleDesktop) bridgeCall('dragResume')
          })
        })
      }
      positionWhale()
    }
  }

  function onUp(e) {
    if (!dragging) return
    dragging = false
    window.__DSHWV_DRAGGING__ = false
    pressed = false
    pressing = false
    if (window.whaleDesktop) bridgeCall('dragEnd')
    // facing 不在这里改动——保持拖动过程中由 handleWinPos 按"当前在
    // 屏幕左/右半区"算出的朝向即可（只有磁吸贴边的小幅调整）。
    positionWhale()
    WHALE.style.cursor = 'grab'
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    document.removeEventListener('pointercancel', onUp, true)
    pressUpSound()
    if (moved) {
      if (window.whaleDesktop) bridgeCall('snapWindow', whaleLeft(), whaleTop(), whaleW())
    }
    else cycleBubble()
    // 拖动开始瞬间若有待处理的窗口尺寸请求会被丢弃（拖动中拒绝改尺寸），
    // 这里补一次队列，保证松手后窗口尺寸最终和缩放值对齐
    queueWinResize(false)
  }

  // facing/vFacing 的硬编码默认值 'right'/'bottom' 只在"正常首次启动、
  // 窗口就在默认的右下角出生位置"这一种场景下是对的。但页面重新加载
  // 不止这一种触发方式——主进程那边尺寸漂移超过熔断阈值时会整个销毁
  // 重建窗口（保留窗口当前的物理坐标，只是页面重新 loadURL），这种情况下
  // JS 状态被重置成默认值，可是窗口很可能其实已经在屏幕左侧/上侧了。
  // 如果什么都不做，贴图和气泡就会一直用默认朝向渲染——表现为"明明在
  // 屏幕左侧，嘴却朝左（该朝右）"——直到用户下一次真正拖动它，才会被
  // handleWinPos 纠正回来。这里在页面刚加载、还没渲染出第一帧时，就按
  // 屏幕中线（与 handleWinPos 同一套半屏规则）根据窗口真实坐标算一次
  // 正确的 facing/vFacing，不必等下一次拖动。
  // 注意：这里用容器自身的绝对坐标（info.x/info.y + winW/winH）而不是
  // "鲸鱼贴图"的绝对坐标——鲸鱼在容器里的本地偏移量本来就依赖朝向，
  // 而朝向正是这里要算的东西，用它反过来算自己会成环；容器和贴图的
  // 尺寸差远小于屏幕尺寸，拿容器坐标做"在屏幕哪一半"的判断已经足够准，
  // 等真正开始拖动后 handleWinPos 还会持续用更精确的贴图坐标纠正。
  // 垂直朝向按窗口在屏幕中的位置估算：底部构图时鲸鱼头顶 = 窗口顶 +
  // (窗高 − 贴图边)；头顶离屏幕顶部不足 0.62 个构图盒高才用 vtop
  //（气泡垂到下方）。缩放会改变这个距离，所以 loadConfig 拿到真实
  // 缩放后会再校一次。
  function evalVFacingFromWindow() {
    var info = bridgeCallReturn('getWinInfo')
    if (!info || !info.workArea) return
    var wa = info.workArea
    var boundary = wa.y + Math.round(compS() * 0.62)
    var whaleTopEstimate = info.y + winH - whaleW()
    vFacing = whaleTopEstimate < boundary ? 'top' : 'bottom'
  }

  function initOrientationFromRealPosition() {
    var info = bridgeCallReturn('getWinInfo')
    if (!info || !info.workArea) return
    // 主进程把约定尺寸（curW/curH）一并带过来，winW/winH 从第一帧起
    // 就和真实窗口一致，不会出现"按默认尺寸摆、随后又被纠正"的闪烁
    if (typeof info.w === 'number' && typeof info.h === 'number') { winW = info.w; winH = info.h }
    var wa = info.workArea
    facing = (info.x + winW / 2) < (wa.x + wa.width / 2) ? 'left' : 'right'
    evalVFacingFromWindow()
  }

  // 主进程改完窗口尺寸后通知到这里（缩放变化路径）——同步兜底：本地
  // 约定值在 applyWinResize 里已经先行切换过，这里再做一次幂等重排。
  if (window.whaleDesktop && window.whaleDesktop.onWinResized) {
    window.whaleDesktop.onWinResized(function (d) {
      if (!d || typeof d.w !== 'number' || typeof d.h !== 'number') return
      winW = d.w
      winH = d.h
      applyVars()
      positionWhale()
    })
  }
  if (window.whaleDesktop && window.whaleDesktop.onWinPos) {
    window.whaleDesktop.onWinPos(function (pos) { handleWinPos(pos) })
  }

  // 设置窗改了配置（主进程经 server 的写入钩子推 'config-changed'）：
  // 重读配置，按差异套用——缩放走既有 applySize（含窗口尺寸同步），
  // 音效集/音量变化重挂音频，用量模式变化立即刷新余额
  if (window.whaleDesktop && window.whaleDesktop.onConfigChanged) {
    window.whaleDesktop.onConfigChanged(function () {
      var prev = JSON.parse(JSON.stringify(CFG))
      loadConfig(function () {
        if (CFG.soundSet !== prev.soundSet || CFG.vol !== prev.vol || CFG.sound !== prev.sound) applySoundSet()
        if (CFG.scale !== prev.scale) applySize()
        if (CFG.usageMode !== prev.usageMode) fetchBalance(true)
      })
    })
  }

  // 先按真实窗口坐标校正一次 facing/vFacing 和窗口尺寸约定值，再建 DOM——
  // 不管这次加载是正常启动还是熔断重建后的重新加载，第一帧画面就该是对的。
  // 配置（缩放等）加载完成后再建 DOM 并首渲染：避免按默认 scale 画一帧
  // 又被纠正的闪烁，首帧就能用上正确的窗口尺寸约定值。
  initOrientationFromRealPosition()
  injectCss()
  loadConfig(function () {
    buildDom()
    applySoundSet()
    // 真实缩放到位后重校一次垂直朝向（估算用的边界随缩放变化）
    evalVFacingFromWindow()
    applyVars()
    positionWhale()
    fetchBalance()
    setInterval(fetchBalance, REFRESH_MS)
  })
})()
