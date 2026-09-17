# DeepSeek 余额小鲸鱼桌面挂件

一个脱离 DSH、常驻桌面的透明悬浮小鲸鱼，实时显示 DeepSeek 余额与今日已用。
功能与 DSH 网页插件 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) v0.2.10 对齐。

## 启动

- 方式 1：双击桌面上的「小鲸鱼余额挂件」快捷方式。
- 方式 2：双击本目录下的 `启动鲸鱼.cmd`。

## 功能

- 🐳 小鲸鱼 + 实时余额 + 今日已用（余额差值自动记账），位于**桌面右下角小置顶窗**内（不铺满全屏）；每 60 秒自动刷新，网络抖动时**静默保留上次余额**，不闪 `--`
- 💬 **左键点击**鲸鱼 → 弹出浏览器同款**椭圆思考气泡**（带圆点拖尾弹出动画）：余额页 → 再点气泡 → **加权随机台词**（峰谷时段提示 / 吐槽台词 / **摸鲸鱼 gif** / 「哦鲸鲸...」等 6 组）→ 再点关闭；5 秒自动收起
- 💰 后台检测到**余额变动**会自动弹出气泡，金额数字**滚动动画**过渡到新值
- ⚠️ 余额获取失败时在气泡里显示原因（如「未配置 DEEPSEEK_API_KEY」），**点击鲸鱼重试**
- 🧸 按压 Q 弹动画（底部不动、压扁回弹）+ 按压/松手**音效**（小黄鸭 / 音效1，衔接不叠音）
- 🖱️ **拖动**即移动窗口，可停在**任意位置**（重启后**记住位置**）；靠近屏幕边缘（**30px** 内）自动**磁吸贴边**，贴左时鲸鱼自动镜像，气泡/文字始终正向可读
- 📏 **大小缩放 0.6–2.5×**（滑条 + 1–20 数字档），窗口尺寸随缩放自动变化，气泡永远不会被裁掉
- 🎚️ **右键**或**悬停鲸鱼点汉堡按钮** → 打开**液态玻璃设置窗**（16:9 桌面应用式，React 渲染层；Win11 上带系统级亚克力背景模糊）：
  - 左侧边栏：通用设置 / 关于
  - 通用设置：大小滑条、音效下拉（海浪/风铃/雨声待素材）、**Deepseek 密钥**（输入 + 保存/清除/测试，**本机 DPAPI 加密存储**）、平台令牌（折叠）、用量统计（今日/本月 + 已用/余额进度条 + 用量模式）、跟随任务栏浮动、谷峰文案、声音大小、思考气泡
- 🔑 **不装 DSH 也能用**：在设置窗里填一次 API Key 即可显示余额。凭据解析优先级：**设置窗手动保存 > 环境变量 > DSH 凭据文件**；清除手动 Key 后自动回落
- 📌 **永远浮于最上层**：screen-saver 级置顶 + 定时重新夺顶（托盘可勾选取消「总在最前」）
- 🖥️ 托盘菜单：显示鲸鱼 / 总在最前 / **开机自启**（默认关）/ 调试工具 / 退出

## 与浏览器插件的差异（无法/无需实现）

| 插件功能 | 桌面版 | 说明 |
| --- | --- | --- |
| 每轮对话消耗统计 | ❌ | 依赖 DSH 宿主的会话事件（每轮真实 token 用量），桌面独立进程没有对话事件源，无法得知"每一轮"的边界与 token 数。基于平台 API 小时桶的近似值不精确，故不做 |
| 避让滚动条 | ❌ | 只对嵌入网页、随网页滚动的挂件有意义；桌面窗口自由悬浮，无滚动条可言 |
| 常驻于 DSH 网页 | ✅ 等效 | 等效为桌面常驻 + 可选开机自启 |
| 位置记忆（localStorage） | ✅ 等效 | 存在 `.dshw-window.json`，重启恢复 |
| DSH 凭据服务 | ✅ 等效 | 直接读取 `~/.dsh/.credentials.yaml`（未装 DSH 时可用环境变量） |

## 凭据

优先级（高 → 低）：

1. **设置窗手动保存的 Token**（`.dshw-credentials.json`，Windows DPAPI 加密；设置窗里可随时清除）
2. `DEEPSEEK_API_KEY` 环境变量
3. DSH 凭据文件 `C:\Users\<用户名>\.dsh\.credentials.yaml` 的 `refs:` 段

- `DEEPSEEK_API_KEY`（余额必需）：推荐直接在设置窗里填（右键鲸鱼 → 设置 → 连接），支持一键测试。
- `DEEPSEEK_PLATFORM_TOKEN`（可选，实时·令牌模式用）：同样可在设置窗里填。取值方法：在 platform.deepseek.com 打开 DevTools，从 `usage/by_api_key/amount` 请求的 `Authorization: Bearer eyJ...` 头里复制。

## 退出

右下角系统托盘里的鲸鱼图标 → 右键 → 「退出鲸鱼」。

## 数据文件（均在应用目录）

- `.dshw-usage.json` — 今日已用记账 + 30 天历史
- `.dshw-size.json` — 设置（缩放/音量/用量模式/峰谷文案等）
- `.dshw-credentials.json` — 设置窗保存的 Token（DPAPI 加密，不可加密时明文兜底）
- `.dshw-window.json` — 窗口位置记忆
- `renderer.log` — 运行日志（超 1MB 自动轮转为 `.old`）

## 开发

- `npm start` 启动应用
- `npm run build:settings` — 重新打包设置窗 React 渲染层（源码 `src/settings/`，产物 `assets/dist/`；改了设置窗 UI 后需要重跑）
- `node test\credentials.test.js` — 凭据模块单元测试（纯 node，19 例）
- `node test\server.endpoints.test.js` — 服务端接口端点测试（8 例）
- `npx electron dev-shot.js` — 跑 12 个截图场景（停靠镜像/顶部停靠/缩放/随机台词/gif/设置窗/关于页/错误态）输出到 `dev-shots/`，可用环境变量 `DEV_SHOT_ONLY=场景名` 只跑指定场景

### 设置窗 UI 架构

```
src/settings/            React 渲染层（esbuild 打包 → assets/dist/settings.js + settings.css）
├── components/glass/    玻璃组件体系（GlassCard/Button/Input/Select/Slider/Toggle + 细线 SVG 图标）
├── pages/               通用设置 / 关于
├── adapters/            现有 HTTP 接口的 fetch 封装（业务零重写）
src/styles/liquid-glass.css  液态玻璃设计令牌（三层材质，主界面可复用）
settings-window.js       主进程窗口（960×540 可缩放，Win11 acrylic）
settings-preload.js      仅暴露最小化/放大还原/关闭三个窗口控制
```

> 布局说明：窗口是"上游同款根容器"——正方形、气泡 SVG 占满容器宽（1026:700）、鲸鱼贴图占容器 59.45% 贴斜对角；左右停靠镜像通过容器整体翻转实现（文字自动翻回保持可读）。

> 提示：若与 Wallpaper Engine 等动画壁纸互相遮挡，请在 Wallpaper Engine 里关闭「窗口置顶 (always on top)」。
