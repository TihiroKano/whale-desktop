// 判定鼠标是否落在鲸鱼相关元素上，供主进程切换鼠标穿透。
// 独立成文件是为了配合 index.html 的 CSP（script-src 'self' 不允许内联脚本）。
//
// 注意：气泡盒和设置菜单常驻 DOM（开/关由类切换 + CSS 过渡驱动），关闭态
// 只是透明——必须只在"打开"时才把它们算进命中区，否则看不见的气泡/菜单
// 会挡住桌面点击。
//
// 气泡盒占满构图盒宽，但其 SVG 大部分是透明区域——打开时按"实际绘制
// 内容"（椭圆主体 + 两颗圆点 + 文字）判定，透明角落穿透到桌面。
(function () {
  function rectsHit(els, x, y, pad) {
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) continue
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return true
    }
    return false
  }
  function isOverWhale(x, y) {
    const pad = 16
    const whale = document.querySelectorAll('.dshwv-whale')
    if (rectsHit(whale, x, y, pad)) return true
    // 菜单：仅在打开（渐显中/完全显示）时才算命中
    if (document.querySelector('.dshwv-menu.dshwv-menu-open')) {
      if (rectsHit(document.querySelectorAll('.dshwv-menu'), x, y, pad)) return true
    }
    // 气泡：仅在打开时按绘制形状（椭圆/圆点/文字）判定
    if (document.querySelector('.dshwv-bubble.dshwv-bubble-open')) {
      const bubblePainted = document.querySelectorAll('.dshwv-bshape, .dshwv-b1, .dshwv-b2, .dshwv-text')
      if (rectsHit(bubblePainted, x, y, pad)) return true
    }
    return false
  }
  // 拖动期间（由 widget.js 设置 window.__DSHWV_DRAGGING__）始终保持鼠标可交互，
  // 不再按实时命中检测切换穿透——否则窗口跟手存在的 IPC 延迟会导致鼠标
  // 短暂"跑出"命中区或触发 mouseleave，穿透被重新打开后拖拽事件全部丢失，
  // 表现为拖到一半突然被"空气墙"挡住、卡死不动。
  // 状态去重：mousemove 高频触发（高轮询率鼠标可达 1000Hz），状态没变的
  // 时候不再重复发 IPC——拖动期间少一串无谓的渲染→主进程调用。
  let lastEnable = null
  window.addEventListener('mousemove', (e) => {
    if (!window.whaleDesktop) return
    let enable
    if (window.__DSHWV_DRAGGING__) {
      enable = true
    } else {
      enable = isOverWhale(e.clientX, e.clientY)
    }
    if (enable !== lastEnable) {
      lastEnable = enable
      window.whaleDesktop.setMouseEnable(enable)
    }
  }, { passive: true })
  window.addEventListener('mouseleave', () => {
    if (!window.whaleDesktop) return
    if (window.__DSHWV_DRAGGING__) return
    if (lastEnable !== false) {
      lastEnable = false
      window.whaleDesktop.setMouseEnable(false)
    }
  })
})()
