# VideoTest — 浏览器视频播放异常检测

针对 **浏览器里正在播放的视频**（HLS / WebRTC / MSE / MediaStream / mp4）做黑盒巡检：
白屏、黑屏、绿屏、蓝屏、画面停住（卡顿）、报错文案、转圈 loading、无画面。
输出带截图证据的 HTML 报告 + JSON，可直接接到 CI 或巡检系统。

被测对象就是页面本身，不需要拿到流地址、不需要改播放器代码。

```
npm install
node test/selftest.mjs 50        # 自测：故障注入页，验证 6 类异常都能抓到
node src/monitor.mjs --url https://your-host/page --duration 120
node src/monitor.mjs --url https://unifi.local/protect/live --profile ./.chrome-profile --duration 300
```

---

## 1. 现成的方案调研（2026-10）

**结论：没有"浏览器播放端 + 像素级异常判定 + loading/报错"的开源成品。**
现成的东西分成三层，都只覆盖一层，需要自己组装。

### 开源

| 项目 | 层次 | 能做什么 | 缺什么 |
|---|---|---|---|
| **ffmpeg** `blackdetect` / `freezedetect` / `signalstats` / `blockdetect` / `blurdetect` | 解码后像素 | 黑屏区间、冻结区间、亮度/色度统计、块效应、模糊 | 离线文件或录制流；没有 DOM，看不到 loading/报错；不是实时浏览器渲染 |
| **Eyevinn/hls-monitor** (47★, TS) | 清单/分片 | 监测 HLS 清单错误、分片缺失、码率异常 | 不渲染，看不到画面 |
| **Jorji49/streamtop** (120★, Rust) | 传输层 | HLS/DASH/IPTV 探针、TR 101 290、Prometheus 指标 | 同上，纯传输层 |
| **koryglenn/MV** | 服务端 | ffmpeg 拉流拼墙预览 + 黑屏/冻结检测 | 需要自己拉流，不是浏览器播放链路 |
| **alexchungio/Video-Quality-Diagnosis** (23★, Py) | 文件/流 | YOLO 分类黑屏、花屏、噪点 | 2021 停更，要自备训练数据，判的是"片源"不是"播放" |
| **Chrome 原生 API**`getVideoPlaybackQuality()` / `requestVideoFrameCallback` / WebRTC `getStats()` | 播放器内部 | 丢帧数、逐帧呈现时间、`freezeCount`/`totalFreezesDuration`、解码耗时 | 只是原始指标，不判黑白绿屏，也不管 DOM 提示 |

安防行业的"视频质量诊断（VQD）"是另一条线：**EasyVQD**（TSINGSEE EasyCVR/EasyGBS 插件，11 类画质异常）、德科仕 ESAS、海康/大华/宇视运维平台的内置诊断。它们都是**服务端拉流→解码拆帧→AI 判图**，回答"这台摄像机/这路流坏没坏"。
不回答"网页播放器这一端白屏了、转圈了、报 -33 了"。

### 商业

- **Witbe** VQ-ID / Video Robots：真机/虚拟机器人跑 App 和网页，检测黑屏、冻结、马赛克、错误屏、静音，出 MOS。最接近的成品，但是商业授权。
- **Conviva / NPAW Youbora / Mux Data / Bitmovin Analytics**：播放器 SDK 上报 QoE 指标（启动时长、卡顿率、码率切换），**不做像素判定**，看不到"绿屏/白屏"。
- 云真机（BrowserStack / HeadSpin）能跑环境，异常判定仍要自己写。

### 国产三大厂（海康 / 大华 / 华为）的做法

三家都有成熟 VQD，但全部是**拉流→解码→判图**，部署在摄像机/NVR/诊断服务器/平台上，判的是"摄像头和码流"，不是"浏览器播放器"。

| 厂商 | 端侧 | 平台侧 | 诊断项 | 实测口径/限制 |
|---|---|---|---|---|
| **海康** | 摄像机"基础事件 → 视频质量诊断"15 项：亮度异常、偏色、雪花、条纹、画面冻结、信号丢失、清晰度、画面抖动、视频遮挡、花屏、噪声、光斑、紫边、ICR 异常、保护膜未撕 | iSecure Center 运维模块"视频诊断"14 项：偏色、噪声、过暗、过亮、冻结、抖动、对比度、条纹、遮挡、信号丢失、黑白、模糊、场景变化、剧变；输出图像正常率、录像完整率、巡检计划。另有 iOMS 一体化运维 | 设备 SDK `NET_DVR_VQD_LOOP_DIAGNOSE_CFG`：8 类（模糊/亮度/偏色/雪花/条纹/冻结/信号丢失/云台失控），阈值 0–100，**设备默认 3 分钟自动诊断一次、不可配** | 官方文档明确：**夜间（红外黑白）模式不支持 VQD，不产生告警**，避免夜间误报 |
| **大华** | NVR/IVSS 智能视频设备"Video Diagnosis"13 项：模糊、低对比度、遮挡、抖动、剧变、冻结、过曝、丢失、噪声、场景变化、静态噪声、条纹干扰、偏色；**1 路轮巡** | DH-IVS-VQ8000 系列（视频质量诊断智能服务器/服务软件）：17 类——清晰度、过亮、过暗、低对比度、偏色、抖动、噪声、条纹、丢失、冻结、遮挡、场景变化、剧变、黑白、**丢帧**、雪花屏、频闪；支持自定义轮巡计划/任务/方案 | 量化清晰度/亮度/对比度/颜色/运动/噪声/相似度 | 平台侧靠轮巡，NVR 侧只 1 路，大规模要堆诊断服务器 |
| **华为** | IVS1800"智能配置 → 视频质量检测"，另有**虚焦检测**、遮挡告警、声音诊断 | eSight 视频监控管理：**"视频质量诊断：诊断视频出现花屏、卡顿的原因"**；诊断类型含离线/实况异常/录像丢失/视频质量；指标有"视频质量完好率"、摄像机质量地图、巡检（OWS）；iClient S100 出运维告警 | 偏"故障定界"：链路还原、告警/KPI 联判，指出是网络、供电还是摄像机 | 强在运维闭环和定界，不强调逐项图像算法清单 |

**对你有用的四条结论：**

1. 三家的"黑屏/冻结/信号丢失"判定都在**流侧**，浏览器播放器白屏、转圈、`Connection Timeout`、WebRTC 解码绿屏，它们一个都看不到。
2. 绿屏在它们的话术里被拆进"偏色/花屏/场景剧变"，没有独立"绿屏"检测项——你的需求比它们更细。
3. 端侧自诊断有硬盲区：海康夜间不支持、3 分钟一轮；大华 NVR 侧 1 路轮巡。要 7×24 秒级，必须平台侧拉流或端侧专用诊断服务器。
4. 它们的诊断项清单可以直接当**验收口径**：把海康 15 项 / 平台 14 项、大华 17 项映射到你的工具里（颜色、冻结、丢帧、遮挡），和甲方/运维说话时术语能对上。

### 所以本工具补的是这块

浏览器内取三路信号互相印证，判据全部可调：

| 异常 | 判据 |
|---|---|
| 黑屏 | 48×27 降采样后 R/G/B 均值 < 18 且方差 < 14 |
| 白屏 | 三通道均值 > 232 且方差 < 14 |
| 绿屏 | G − max(R,B) > 45、G > 60、G 通道方差 < 45（解码器绿底/仅 Y 平面典型值 0,160,0） |
| 蓝屏 | B − max(R,G) > 55（无信号蓝底） |
| 卡顿（画面中断） | **OSD 秒位心跳中断 ≥1.5s**。画面里烧的秒级时间戳就是“画面时钟”，它不跳 = 画面停住。不区分冻结/缓冲卡顿——两者在画面上完全一致，区分要靠 buffer/网络信号，而按用户能不能看出来的口径没有意义。`paused` 时排除 |
| 转圈 loading | 以画面中心为锚点 `elementsFromPoint`，覆盖层文本/class 命中 `loading/connecting/缓冲/请稍候/spin…` |
| 报错 | 覆盖层或页面文案命中 `connection timeout / (-33) / 连接失败 / 无信号…`，或 `video.error`（页面级文案必须同时含错误词，否则 `View (0)` 这类统计数字会被误判） |
| 无画面 | `readyState < 2` 或 `videoWidth == 0` 持续 ≥2s |

冻结/卡顿合并成一条，是因为“画面停住”在像素上完全一样，用户也只会说“卡住了”。判定只认画面表现：OSD 秒位不跳超过阈值就是卡顿，时长取“最后一次跳秒 → 恢复跳秒”。
OSD 区域自动标定（`--osd` 可手填）：整帧缩到 960 宽，逐像素统计“隔 ≥500ms 又变一次”的次数与间隔，取间隔规整（~1s）、大部分时间静止的像素做密度聚类；PTZ/雨雪场景标定会失败，用手填坐标兜底。

**颜色判定按 6×3 = 18 个区块算**（每块约占画面 5.6%）。整帧平均只能发现“整屏变色”；分区能发现“只有一部分画面是绿的/黑的”——同色区块 ≥2 块（约 11%）即报，报告里带区域占比与方位（如“区域 33%（右下）”）。已知 OSD 覆盖的区块直接排除，避免时间戳在黑/白屏上被当成局部色块。顺带把逐像素中位数/MAD 换掉了：**0.8ms → 8µs 每帧**。

---

## 2. 用法

```bash
# 1) 托管模式：自己拉起 Chrome（推荐，可复用已登录的 profile）
node src/monitor.mjs --url https://unifi.local/protect/live --profile ./.chrome-profile --duration 300

# 2) CDP 接管：Chrome 已带 --remote-debugging-port=9222 启动，直接挂上去
node src/monitor.mjs --attach http://127.0.0.1:9222 --match protect --duration 300

# 3) 无头巡检（CI）
node src/monitor.mjs --url https://host/page --headless --duration 600 --fail-on-anomaly

# 4) 自测（故障注入页）
node test/selftest.mjs 50
```

首次跑 UniFi Protect / 海康 / 大华这类要登录的页面：去掉 `--headless`，在弹出的浏览器里登录一次，
profile 存在 `./.chrome-profile`，之后巡检直接复用登录态。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--url` | — | 被测页面 |
| `--duration` | 60 | 观测秒数 |
| `--out` | `out/run-<时间>` | 输出目录 |
| `--attach` | — | CDP 地址，接管已有 Chrome |
| `--profile` | `./.chrome-profile` | 持久化用户目录（登录态） |
| `--headless` | false | 无头模式 |
| `--fps` | 4 | 采样频率（每路画面） |
| `--stall` | 1500 | OSD 心跳中断多少毫秒算卡顿 |
| `--osd` | 自动标定 | OSD 区域，`x,y,w,h`（视频原生像素）；自动失败时手填 |
| `--osd-cal` | 6000 | 自动标定窗口毫秒 |
| `--min-dur` | 600 | 异常最短持续，过滤闪烁误报 |
| `--black` / `--white` / `--green` / `--blue` | 18 / 232 / 45 / 55 | 颜色阈值 |
| `--sel` | `video` | 视频元素选择器（canvas 播放器可试 `canvas`） |
| `--snap-every` | 0 | 每 N 秒存一张全页截图（留证） |
| `--fail-on-anomaly` | false | 有异常时退出码 1（CI 用） |
| `--open` | false | 结束后自动打开报告 |

### 输出

```
out/run-xxx/
  report.html      # 时间轴 + 异常明细 + 截图，双击即看
  report.json      # 机器可读（episodes / counts / videos / thr）
  samples.jsonl    # 原始采样，可复算阈值
  shots/           # 每段异常的画面截图（按通道裁剪）+ 定时全页截图
```

多个 `<video>`（分屏/多通道）会自动按 DOM 归属命名（取最近的 `aria-label`/`title`/短文本），
分别统计 fps、丢帧、断流、异常段。

---

## 3. 播放质量（QoE）怎么量

异常检测回答"坏没坏"，QoE 回答"有多好"。同一份采样里直接算得出来：

| 指标 | 取法 | 说明 |
|---|---|---|
| 首帧 TTFF | 探针启动 → `currentTime > 0` 的第一个采样 | 起播性能；登录/空白页会拉长，按页面就绪后再计时更准 |
| 有效播放时长 | `currentTime` 增量累加 | 卡顿率的分母 |
| 卡顿次数/总时长 | `waiting` 开始、`playing/canplay` 结束 | rebuffer；播放器自己重连也会体现在这里 |
| 卡顿率 | 卡顿时长 /(播放 + 卡顿) | 行业常用 QoE 口径 |
| 平均 fps | rVFC 回调里 `mediaTime` 变化次数 / 时长 | **不要用 `presentedFrames`**：浏览器按刷新率重复呈现，实测 30fps 流会算成 44fps |
| 丢帧率 | `droppedVideoFrames / totalVideoFrames` | 解码/呈现丢帧 |
| 分辨率切换 | `videoWidth/Height` 变化序列 | ABR 降码率、清晰度切换 |
| 缓冲余量 | `buffered.end(last) − currentTime` | 直播延迟与抗抖动能力 |
| WebRTC 质量 | `getStats()` inbound-rtp：framesDecoded/Dropped、`freezeCount`、`totalFreezesDuration`、`jitterBufferDelay`、`packetsLost`、candidate-pair RTT | 监控/WebRTC 场景必看；要包装 `RTCPeerConnection` 构造器才能拿到实例 |

四路信号互相印证，单看任何一路都会误判：

1. **像素**（48×27 降采样 + OSD 秒位 ROI）→ 黑白绿蓝、卡顿
2. **播放器指标**（rVFC / `getVideoPlaybackQuality` / `error` / `buffered`）→ 丢帧、fps、首帧
3. **DOM 覆盖层**（画面中心 `elementsFromPoint`）→ 转圈、报错文案
4. **WebRTC `getStats`** → 网络侧质量、冻结次数

4Hz 采样够用：状态指标的判定误差 < 250ms，颜色类异常 1s 内出结果；要更细可 `--fps 10`，代价是 canvas 读回和 CPU。

### 三种播放链路都实测过

```bash
node test/selftest.mjs 50           # MediaStream（canvas 故障注入）
node test/hls-test.mjs 30           # 真实 HLS + MSE（本地切片，fps 精确 30）
node test/hls-test.mjs 30 --remote  # 公网多码率流（走代理，会看到真实卡顿/降码率）
node test/rtc-test.mjs 20           # WebRTC 本地环回，验证 getStats
```

跑公网流那次，工具抓到了一段真实故障：`ct` 卡在 9.912s、`buffered` 掉到 0.1s、断流 6.4s，随后 ABR 从 1280×720 降到 848×480——这类"网络抖动导致的降码率"只有浏览器端能看见，服务端 VQD 看不出来。

## 4. 已知限制

- **canvas 渲染的播放器**（jsmpeg、自绘 WebGL）拿不到 `getVideoPlaybackQuality`/rVFC；
  用 `--sel canvas` 可做颜色/卡顿判定，但拿不到丢帧指标。
- **跨域视频**画进 canvas 会 taint，读不到像素；同源页面（VMS 自身）没问题。
- **没有秒级 OSD 的流判不了卡顿**：只能退回 rVFC 断档兜底，静态场景会误报。PTZ/雨雪场景自动标定会失败，用 `--osd "x,y,w,h"` 手填。
- 花屏/马赛克没有做（需要模型）；ffmpeg 的 `blockdetect` 或一个小的 CNN 可以后续加。
- 页面文案匹配是中英关键字表，不同 VMS 的提示语需要在 `src/agent.js` 的 `errText`/`loadText` 里补。
- 长跑建议 `--headless` 且单标签页：浏览器会节流后台标签的定时器（已加 `--disable-background-timer-throttling`，但不是万能的）。
