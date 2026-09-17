# DSH小鲸鱼余额桌宠（Whale Desktop WdgPet）

![Whale Desktop WdgPet](assets/wdgpet-banner.png)

DeepSeek Harness（DSH）小鲸鱼的**桌面桌宠版**：一只常驻桌面的透明悬浮小鲸鱼，实时显示 DeepSeek API **余额**与**今日已用**，带点击互动、拖动吸附与液态玻璃设置窗。基于原 DSH 网页插件 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（作者 MeteorNOX）开发；**不装 DSH 也能用**。

## 特性

### 记账与显示

- 🐋 **余额**：每 60 秒自动刷新；瞬时网络抖动自动沿用最近余额，不报错、不闪 `--`
- 📊 **今日已用（小鲸鱼记账）**：按余额**下降**自动累计为消费；余额**上升**（充值 / 赠金）单独记录、不会冲掉已有消费；金额按 8 位小数记账、显示保留两位
- 💰 **余额变动提醒**：检测到余额变化自动弹出气泡，金额数字**滚动动画**过渡到新值
- ⛰️ **峰谷提示**：气泡内显示 DeepSeek 峰谷时段文案（设置里可调）
- ⚠️ **失败可见**：余额获取失败时在气泡里显示原因（如「未配置 DEEPSEEK_API_KEY」），点击鲸鱼重试

### 互动

- 🖱️ **拖动 + 吸附**：拖动移动窗口，可停在任意位置（重启后记住）；靠近屏幕边缘（30px）自动**磁吸贴边**
- 🔄 贴左吸附时整体**水平镜像翻转**，气泡与文字始终正向可读
- 🧸 **按压 Q 弹**：按压时底部坐标不变、压扁回弹，配合按压 / 松手音效
- 📏 **大小缩放 0.6–2.5×**：滑条 + 数字档，窗口尺寸随缩放自动变化，气泡不会被裁掉
- 💬 **点击气泡**：点鲸鱼弹出浏览器同款**椭圆思考气泡**（圆点拖尾动画）——余额页 → 再点看**加权随机台词**（峰谷提示 / 吐槽台词 / **摸鲸鱼 gif** 等）→ 再点关闭；5 秒自动收起
- 📌 **永远浮于最上层**：screen-saver 级置顶 + 定时重新夺顶（托盘可取消「总在最前」）

### 设置窗与托盘

- 🎚️ **液态玻璃设置窗**：右键鲸鱼或悬停点汉堡按钮打开（16:9 桌面应用式；Win11 上带系统级亚克力背景模糊）
  - **通用设置**：大小滑条、音效下拉、**DeepSeek 密钥**（输入 + 保存 / 清除 / 测试，**本机 DPAPI 加密存储**）、平台令牌、用量统计（今日 / 本月）、声音大小、峰谷文案、思考气泡、跟随任务栏浮动
  - **关于**：版本与项目说明
- 🖥️ **托盘菜单**：显示鲸鱼 / 总在最前 / 开机自启（默认关）/ 退出

### 音效与形象

- 🔊 按压 / 松手音效：内置「小黄鸭」「音效1」两套预置
- 🐳 小鲸鱼形象：贴图角色（气泡由代码绘制），含备用整图与多样表情素材

## 目录结构

```text
whale-desktop/                     # 程序运行文件（本仓库根下的程序目录）
├── main.js                        # 主进程入口
├── server.js                      # 本地服务（余额查询 / 设置读写 / 资源路由）
├── credentials.js                 # 凭据解析（设置窗 > 环境变量 > DSH 凭据文件）
├── desktop-backdrop.js            # 设置窗液态玻璃的桌面环境层
├── settings-window.js             # 设置窗主进程（960×540，Win11 acrylic）
├── preload.js
├── settings-preload.js
├── index.html                     # 挂件页
├── settings.html                  # 设置页
├── package.json
└── assets/
    ├── widget.js                  # 前端挂件本体
    ├── hit-test.js                # 透明窗口命中测试
    ├── DSniang1.png / DSniang02.png / DSH2.png   # 小鲸鱼形象与素材
    ├── rua.gif                    # 摸鲸鱼动图
    ├── Ya1.mp3 / Ya2.mp3          # 音效「小黄鸭」按压 / 松开
    ├── D1.mp3 / D2.mp3            # 音效「音效1」按压 / 松开
    └── dist/                      # 设置窗界面（构建产物）
```

## 安装与运行

- **方式 1：安装包**——运行 `whale-desktopV1.0.0-setup.exe` 安装后，双击桌面「小鲸鱼余额挂件」快捷方式。
- **方式 2：从本仓库本地运行（开发）**——

  ```bash
  cd whale-desktop
  npm install
  npm start
  ```

  需要 Node.js 环境；首次安装依赖会下载 Electron。

**退出**：系统托盘 → 右键鲸鱼图标 → 「退出鲸鱼」。

## 数据文件（均在应用目录）

| 文件 | 用途 |
| :--- | :--- |
| `.dshw-usage.json` | 今日已用记账 + 30 天历史 |
| `.dshw-size.json` | 外观与开关（缩放 / 音量 / 用量模式 / 峰谷文案等） |
| `.dshw-credentials.json` | 设置窗保存的 Token（DPAPI 加密，不可加密时明文兜底） |
| `.dshw-window.json` | 窗口位置记忆 |
| `renderer.log` | 运行日志（超 1MB 自动轮转为 `.old`） |

## 常见问题

- **鲸鱼被动画壁纸盖住**：若与 Wallpaper Engine 等动画壁纸互相遮挡，请在 Wallpaper Engine 里关闭「窗口置顶（always on top）」。
- **余额不显示 / 显示 `--`**：右键鲸鱼 → 设置 → 连接，填入 DeepSeek API Key 并点「测试」。
- **找不到退出入口**：在系统托盘的鲸鱼图标上右键 → 「退出鲸鱼」。

## 致谢

- 本项目基于 **[MeteorNOX](https://github.com/MeteorNOX)** 的 DSH 网页插件 **[DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)** 开发（桌面桌宠版）——插件思路、视觉与交互均源自原项目，感谢原作者与原项目的所有贡献者。

## 许可证

本项目沿用原项目的 **MIT License**（版权行保留原作者 MeteorNOX），详见 [LICENSE](LICENSE)。
