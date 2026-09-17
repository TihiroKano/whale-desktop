// 设置窗 preload：只暴露窗口控制（最小化/最大化切换/关闭）。
// 设置页是本地 React 渲染层，不经此桥接触任何业务数据。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settingsWin', {
  minimize: () => ipcRenderer.send('settings-win-minimize'),
  toggleMaximize: () => ipcRenderer.send('settings-win-toggle-max'),
  close: () => ipcRenderer.send('settings-win-close'),
  // 桌面背景位图（.env 环境层）：拉取缓存快照 + 订阅更新推送
  getBackdrop: () => ipcRenderer.invoke('settings-backdrop-get'),
  onBackdrop: (cb) => ipcRenderer.on('settings-backdrop', (_e, p) => cb(p)),
  // 拖动中的纯坐标更新（不含位图数据）
  onBackdropPos: (cb) => ipcRenderer.on('settings-backdrop-pos', (_e, p) => cb(p)),
})
