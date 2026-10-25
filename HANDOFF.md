# 浏览器端视频播放质量检测 —— 方案与交接说明

> 给接手的模型/工程师看。读完这份就能接着干，不需要原始对话。
> 最后更新：2026-10-23

---

## 0. 背景与目标

**场景**：安防行业。被测对象是 **浏览器里正在播放的视频**（VMS/监控网页，例如 UniFi Protect 的 Live View、海康/大华/宇视 Web 客户端、GB28181 网页播放器）。

**要检测的现象**：白屏、黑屏、绿屏、蓝屏、画面停住（卡顿）、报错文案（如 `Connection Timeout (-33)`）、转圈 loading、无画面。

**同时要能量化播放质量（QoE）**：首帧时间、卡顿次数/时长/卡顿率、平均 fps、丢帧率、分辨率切换、缓冲余量；WebRTC 场景还要码率、RTT、抖动缓冲、freezeCount。

**已确认的前提**：市面上没有"浏览器播放端 + 像素级判定 + loading/报错"的开源成品（详见第 5 节）。安防厂商的 VQD 全是服务端拉流解码判图，看不到播放器这一端。所以自己组装。

**未完成的前置**：**还没有在真实 UniFi Protect / 海康 / 大华页面上跑过**。目前验证覆盖 MediaStream、HLS+MSE、WebRTC 环回三种链路（第 4 节）。真实页面需要 URL 和一次登录。

---

## 1. 代码位置与结构

代码在 `D:\CODE\VideoTest`（Windows，Node 24，用系统 Chrome，不下载 Chromium）。

```
package.json          依赖：playwright-core（用 executablePath 指向系统 Chrome）、hls.js（仅测试页用）
src/
  agent.js      (456) 注入页面的探针：只取数，不判定
  monitor.mjs   (216) CLI：起/接管浏览器、注入、定时 drain、截图、落盘
  classify.mjs  (333) Node 侧判定：逐样本分类 → 合并 episode → QoE/RTC 汇总
  report.mjs    (147) HTML + 控制台报告
  util.mjs      ( 29) 参数解析、格式化
test/
  fixture.html        故障注入页（MediaStream + canvas captureStream，双通道）
  selftest.mjs        自测：起静态服务 + 跑 monitor + 断言 6 类异常
  attach-test.mjs     CDP 接管模式自测
  hls.html            真实 HLS 页（hls.js + MSE）
  hls-test.mjs        本地切片 HLS 自测（确定性）+ --remote 公网流
  webrtc.html         WebRTC 本地环回（canvas → RTCPeerConnection → video）
  rtc-test.mjs        验证 getStats 采集
  media/hls/          ffmpeg 生成的 30s 本地 HLS 切片（640×360/30fps，约 1.5MB）
tools/
  preview.mjs         把 report.html 渲染成 PNG，便于检查排版
  bench.mjs           采样成本基准（帧采样 vs 截图）
out/<run>/            report.html / report.json / samples.jsonl / shots/
```

约 1400 行，无构建步骤。

---

## 2. 架构：四路信号 + Node 侧判定

### 2.1 注入方式

`context.addInitScript()` 在 `goto` **之前**注入 `agent.js`（覆盖后续导航与 SPA 重载，且对每个 frame 生效）。
attach 模式（CDP 接管已有 Chrome）下页面已加载，需再 `page.evaluate(agentSource)` 补注入一次。
探针暴露 `window.__VT`：`drain()`（取走并清空缓冲）、`videos()`（通道清单）、`rect(id)`（截图用）、`stop()`。

浏览器启动参数必须带：
`--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required --disable-features=CalculateNativeWinOcclusion`

### 2.2 四路信号

| 层 | 采什么 | 用什么 | 判什么 |
|---|---|---|---|
| 像素 | 48×27 降采样：RGB 均值/方差、空间梯度；OSD 秒位 ROI 逐像素差分 | `ctx.drawImage(video,…)` + `getImageData` | 黑白绿蓝屏、卡顿（OSD 心跳中断） |
| 播放器指标 | `currentTime`、`readyState`、`buffered`、`paused`、`video.error`、`getVideoPlaybackQuality()`、rVFC 呈现间隔 | `requestVideoFrameCallback` | 卡顿、丢帧、fps、首帧、分辨率切换 |
| DOM 覆盖层 | 以画面中心 `document.elementsFromPoint` 取上层元素的 innerText + className | DOM | 转圈 loading、报错文案（按通道归属） |
| WebRTC | `getStats()` inbound-rtp / candidate-pair | 包装 `RTCPeerConnection` 构造器后保留实例 | freezeCount、freezesDuration、framesDropped、jitterBuffer、packetsLost、RTT、码率 |

**为什么必须四路**：只截图会把"夜间静态画面"判成冻结；只读 DOM 看不到绿屏；只读播放器指标看不到颜色；只有 WebRTC stats 才能看到网络侧冻结。

### 2.3 判定放 Node 侧

页面探针只产出样本（4Hz/通道）+ 事件，Node 负责：
逐样本分类 → 命中类型开 episode → 连续缺失超过 `grace(900ms)` 关闭 → 时长 ≥ `minDur` 才计入 → 输出报告。
好处：阈值可调、可用 `samples.jsonl` 复算、改判据不用重跑页面。

---

## 3. 检测规则与默认阈值

| 类型 | 判据 | 默认 |
|---|---|---|
| 黑屏 | R/G/B 均值 < `blackLuma` 且三通道最大方差 < 14 | 18 |
| 白屏 | 三通道均值 > `whiteLuma` 且最大方差 < 14 | 232 |
| 绿屏 | `G − max(R,B) > greenDelta` 且 `G > 60` 且 G 通道方差 < 45（解码器绿底典型 `0,160,0`） | 45 |
| 蓝屏 | `B − max(R,G) > blueDelta` 且 `B > 60` | 55 |
| 卡顿（画面中断） | **OSD 秒位心跳中断 ≥ `stallMs`**：画面里烧的秒级时间戳不跳 = 画面停住。冻结/缓冲卡顿不再区分（画面上完全一致，用户也只会说“卡住了”）；`paused` 时排除 | 1500ms |
| 转圈 loading | 覆盖层文本/class 命中 `loading|connecting|缓冲|请稍候|spin…` | 600ms 起 |
| 报错 | 覆盖层或页面文本命中 `connection timeout|连接失败|无信号|(-33)…`，或 `video.error` | 500ms 起 |
| 无画面 | `readyState < 2` 或 `videoWidth == 0` | 2000ms |
| episode 最短 | 过滤闪烁误报 | 600ms（各类略有差异） |

**为什么改看 OSD 心跳**：带秒级 OSD 的流上，bit-exact 双向失效——整帧永远不相等（OSD 每秒跳一次，永不报），降采样后的场景区在空走廊/静态机房又长期为 0（一直误报）。OSD 是画面里自带的时钟：它按 1Hz 跳就说明解码/渲染链路活着，连续不跳就是画面停住。实测：暂停后 OSD 区域逐字节不变；正常播放时两次跳秒之间差分精确为 0，跳秒时 600–1400 px。时长取“最后一次跳秒 → 恢复跳秒”，不再区分冻结与缓冲。

**颜色判定为什么不用参考图**：绝对阈值（均值+方差），不依赖基线；光照、昼夜红外、PTZ、OSD 时间戳变化都不影响。判定按 6×3=18 个区块做：整帧平均发现不了“只有一部分画面变绿/变黑”，区块能做到（同色 ≥2 块 ≈11% 即报，报告带区域占比与方位）；被 OSD 覆盖的区块直接排除。区块统计还比逐像素中位数/MAD 快两个数量级（0.8ms → 8µs/帧）。

### QoE 指标口径

- 首帧 TTFF：探针启动 → 第一个 `currentTime > 0` 的样本
- 有效播放：`currentTime` 增量累加（对暂停/跳转稳健）
- 卡顿：`waiting` 开始，`playing/canplay` 结束；卡顿率 = 卡顿 /(播放+卡顿)
- **平均 fps = rVFC 回调里 `mediaTime` 变化次数 / 时长**。不要用 `presentedFrames`：浏览器按刷新率重复呈现，实测 30fps 流会算成 44fps
- 丢帧率 = `droppedVideoFrames / totalVideoFrames`
- 分辨率：`videoWidth/Height` 变化序列（ABR 降码率）
- 缓冲余量：`buffered.end(last) − currentTime`
- WebRTC：inbound-rtp 各项取首末差，码率 = Δbytes×8/Δt；jitterBuffer = Δdelay/Δcount；RTT 取 candidate-pair

### 采样成本（`tools/bench.mjs` 实测）

| 方式 | 单次 | 说明 |
|---|---|---|
| 48×27 drawImage+getImageData | **0.013 ms** | 默认采样规格 |
| 160×90 | 0.038 ms | 判块效应/细节时用 |
| 320×180 | 0.11 ms | |
| `page.screenshot()` 整页 | **68.8 ms** | 含 UI，仅出异常时用 |
| `screenshot({clip})` | 21.8 ms | 按通道裁剪存证 |

4Hz × 16 通道的像素开销约 0.8ms/s。这不是"不停截图比对"。

---

## 4. 已验证的结果（可复现）

```bash
cd D:\CODE\VideoTest
npm run selftest     # 50s，MediaStream + 故障注入，断言 6 类全中
npm run attach-test  # CDP 接管
npm run hls-test     # 本地 HLS + MSE
npm run rtc-test     # WebRTC 环回
node test/hls-test.mjs 30 --remote   # 公网多码率流（需代理）
```

| 链路 | 实测 |
|---|---|
| 故障注入页（2 通道，50s） | 绿屏 4.25s / 卡顿 12.75s / 冻结 13.75s / 黑屏 22.25s / 白屏 31.25s / loading 35.01s / 报错 39.01s，全部命中且有截图 |
| 本地 HLS | 首帧 260ms，有效播放 28.5s，fps 精确 30，卡顿 0，缓冲 1.5s，无异常 |
| WebRTC 环回 | 解码 480 帧 / 丢帧 0，1141 kbps，jitter buffer 9ms，RTT 0ms |
| 公网 mux 多码率流 | 抓到真实故障：`currentTime` 卡在 9.912s、buffer 0.1s、断流 6.4s，随后 ABR 720p→480p |
| CDP 接管 | `--attach http://127.0.0.1:9333` 正常，含截图 |

报告示例：`out/selftest/report.html`、`out/hls/report.html`（含 QoE 表 + 时间轴 + 异常明细 + 缩略图）。

---

## 5. 选型调研结论（为什么自研）

**开源**：没有覆盖"浏览器播放端渲染结果 + 颜色异常 + DOM 提示"的成品。
- ffmpeg `blackdetect/freezedetect/signalstats/blockdetect`：解码后像素，离线/流，无 DOM
- Eyevinn/hls-monitor、Jorji49/streamtop：清单/传输层，不渲染
- koryglenn/MV：服务端拉流拼墙 + 黑白屏检测
- alexchungio/Video-Quality-Diagnosis：YOLO 分类片源，2021 停更
- Chrome 原生 `getVideoPlaybackQuality` / rVFC / WebRTC `getStats`：只是原始指标

**商业**：Witbe VQ-ID 最接近（黑屏/冻结/马赛克/错误屏/MOS），是商业授权；Conviva/NPAW/Mux/Bitmovin 只做 SDK 埋点，不做像素。

**国产三大厂**（均服务端拉流→解码→判图，判"摄像头/码流"，不判"播放器"）：

| | 端侧 | 平台侧 | 备注 |
|---|---|---|---|
| 海康 | 摄像机 VQD 15 项（亮度/偏色/雪花/条纹/冻结/信号丢失/清晰度/抖动/遮挡/花屏/噪声/光斑/紫边/ICR/保护膜） | iSecure Center 运维「视频诊断」14 项，输出图像正常率、录像完整率 | SDK `NET_DVR_VQD_LOOP_DIAGNOSE_CFG` 8 类、阈值 0–100；**设备默认 3 分钟一轮、不可配**；**夜间红外模式不支持 VQD** |
| 大华 | NVR/IVSS 13 项，1 路轮巡 | `DH-IVS-VQ8000` 系列 17 类（含**丢帧**、雪花屏、频闪），支持轮巡计划 | 大规模要堆诊断服务器 |
| 华为 | IVS1800 视频质量检测 + 虚焦 + 遮挡 + 声音诊断 | eSight「视频质量诊断：诊断视频出现花屏、卡顿的原因」，含离线/实况异常/录像丢失/视频质量；指标"视频质量完好率"、质量地图、OWS | 强在故障定界与运维闭环 |

结论：它们能判"摄像头坏没坏"，判不出"网页播放器白屏/转圈/报 -33/WebRTC 解码绿屏"。两层可互补：服务端判流，浏览器端判渲染。

---

## 6. 未知实现下怎么读"解码帧"（设计要点，尚未实现自动探测）

页面实现未知时，先枚举候选：`video` / `canvas` / `img`（含 shadow root、所有 iframe），每 500ms 取 1×1 或 8×8 哈希跑 3 秒，**哪个在变哪个就是活动画面**。

| 载体 | 读法 | 条件与坑 |
|---|---|---|
| `<video>` src/MSE/srcObject | `drawImage(video,0,0,w,h)` | 需 `readyState ≥ 2` 且 `videoWidth > 0`，否则得到透明黑帧；读源帧，不含 CSS 滤镜/页面浮层；`willReadFrequently:true` |
| `<canvas>` 2D | `getImageData` | 注意 1×1 画布 + CSS 拉伸的实现 |
| `<canvas>` WebGL | `readPixels` | `preserveDrawingBuffer:false` 时合成后缓冲被清空，必须在其 draw 调用之后同任务内读，否则全 0 |
| `<img>` 连续换 src（MJPEG） | `drawImage(img)` | 判 `complete`；帧率看 src 变化次数 |
| iframe / shadow DOM | 注入到对应 frame/root | 跨域 iframe 父页面 JS 完全读不到 |

**读不到像素的三条退路**：
1. CORS taint（`getImageData` 抛 SecurityError）→ `video.captureStream()` + `MediaStreamTrackProcessor` 拿 `VideoFrame.copyTo()`；或 CDP 裁剪截图（合成后画面，不受 CORS 限制，~22ms/张，降到 1Hz）
2. DRM（Widevine/PlayReady）→ drawImage 必然纯黑，这是规范行为；只能靠 DOM + 播放器指标
3. 播放器被 IntersectionObserver 停掉 → 先确认元素可见且 `!paused`

**YUV 范围**：解码输出 BT.709 有限范围（16–235），转 sRGB 后暗部被抬升，黑屏阈值取 0–18 都合理，不要卡死 0。

---

## 7. 已知限制

1. **未在真实 VMS 页面验证**（UniFi/海康/大华）。首次接入需要登录态 profile（`--profile ./.chrome-profile`，去掉 `--headless` 登录一次）。
2. canvas 自绘播放器（jsmpeg/WebGL）拿不到 `getVideoPlaybackQuality`/rVFC，只有像素与 DOM；WebGL 还有 `readPixels` 清空问题。
3. 跨域视频 canvas taint，读不到像素；同源 VMS 页面不受影响。
4. **没有秒级 OSD 的流判不了卡顿**（只能退回 rVFC 断档，静态场景会误报）。测试夹具必须画秒级 OSD，并且在"画面停住"阶段整帧不重绘。
5. 花屏/马赛克未做（需模型或块效应指标）。
6. 文案匹配是中英关键字表，不同 VMS 的提示语要补 `agent.js` 的 `errText` / `loadText`。
7. 后台标签页会节流定时器，长跑建议单标签 + 已加的三个 disable 参数。
8. 首帧从探针启动计时，登录/空白页会拉长；严格场景应在页面就绪后再计时。
9. attach 模式不要 `context.close()`，会关掉用户的 Chrome。

---

## 8. 关键踩坑记录（别重复踩）

- `x || default` 会吃掉合法的 0：判绿屏时 `(s.sg || 99) < 45` 让"G 方差=0"永不成立，要用 `??`
- `Array.isArray(new Set()) === false`：Set 传进按数组处理的函数会被当成单一"类型"，到汇总阶段才炸
- 结束时不 flush 未关闭的 episode = 静默丢结果；`summary()` 前必须 `finish()`
- 迷你统计哨兵值要初始化 `-1`：`undefined < 0` 为 false，导致 fps/丢帧恒为 null
- `readyState < 2` 时 drawImage 得到透明黑帧，会在加载瞬间误报黑屏
- 暂停时 rVFC 停止，"距上一帧时长"会无限增长，判卡顿必须排除 paused
- `elementsFromPoint` 最上层常只有 class 没有文字，要累加 3–5 层文本/class 再匹配
- `presentedFrames` 按刷新率重复计数，不能当 fps
- 公网流会抖，别做断言；用 ffmpeg 本地切 HLS 做确定性测试

---

## 9. 后续可选方向

1. **`--sel auto`**：把第 6 节的"候选探测 + reader 选择"做进工具（含 WebGL readPixels 钩子、captureStream/VideoFrame 退路）
2. **花屏/马赛克**：在 160×90 采样帧上算 8×8 块边界能量比，或跑小模型
3. **直播延迟**：`buffered.end − currentTime` 的稳定值与 P95；卡顿热力图
4. **CI/巡检**：`--fail-on-anomaly` 已有退出码；可接 Prometheus / 告警
5. **真实页面适配**：UniFi Protect 的 WebRTC、海康/大华的 Web 客户端，需要补各自的错误文案与通道命名规则
6. **两层联动**：从 iSecure Center / DSS / eSight 拉"视频质量"告警，与服务端 VQD 合并成端到端报告
