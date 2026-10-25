/**
 * 注入到页面里的采集探针（page.addInitScript 注入，每个 frame 都会执行）。
 * 只做“取数”，不做判定：判定逻辑在 Node 侧，便于调阈值和复现。
 */
(() => {
  if (window.__VT) return;

  const CFG = Object.assign(
    {
      fps: 4,
      videoSel: 'video',
      maxVideos: 32,
      sampleW: 48,
      sampleH: 27,
      // 卡顿判定只看一个现象：OSD 秒位心跳中断。阈值在 Node 侧（stallMs）。
      osd: '', // 手动指定 OSD 区域 "x,y,w,h"（视频原生像素坐标）；留空自动标定
      osdCalMs: 6000, // 自动标定窗口
      osdAreaMax: 0.25, // 标定结果面积上限（占整帧比例），超过认为标定失败
      loadSel:
        '[role="progressbar"],[aria-busy="true"],[class*="spinner" i],[class*="loading" i],[class*="loader" i],[class*="buffering" i],[class*="progress" i]',
      loadText: 'loading|buffering|connecting|please wait|加载中|正在加载|缓冲中|正在缓冲|连接中|正在连接|请稍候|初始化',
      errText:
        'connection timeout|connection failed|failed to load|network error|playback error|media error|error code|cannot connect|no signal|连接失败|连接超时|加载失败|无法连接|播放失败|无信号|错误码|设备离线|\\(-?\\d{1,5}\\)',
    },
    window.__VT_CFG || {}
  );

  const T0 = performance.now();
  const now = () => performance.now() - T0;
  const samples = [];
  const events = [];
  const vids = new Map(); // element -> rec
  let nextId = 1;

  /* ---------- WebRTC 统计（直播/监控最常见） ---------- */

  const rtc = { pcs: [], snap: [], error: null };
  try {
    const O = window.RTCPeerConnection;
    if (O) {
      const W = function (...a) {
        const pc = new O(...a);
        try {
          rtc.pcs.push(pc);
        } catch (_) {}
        return pc;
      };
      W.prototype = O.prototype;
      Object.setPrototypeOf(W, O);
      window.RTCPeerConnection = W;
    }
  } catch (e) {
    rtc.error = String(e);
  }

  async function pollRTC() {
    const out = [];
    for (const pc of rtc.pcs) {
      if (!pc || pc.connectionState === 'closed') continue;
      let rep;
      try {
        rep = await pc.getStats();
      } catch (_) {
        continue;
      }
      rep.forEach((s) => {
        if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
          out.push({
            kind: 'in',
            id: s.id,
            fr: s.framesReceived ?? null,
            fd: s.framesDecoded ?? null,
            fdrop: s.framesDropped ?? null,
            fz: s.freezeCount ?? null,
            fzd: s.totalFreezesDuration ?? null,
            jb: s.jitterBufferDelay ?? null,
            jbc: s.jitterBufferEmittedCount ?? null,
            bytes: s.bytesReceived ?? null,
            lost: s.packetsLost ?? null,
            nack: s.nackCount ?? null,
            w: s.frameWidth ?? null,
            h: s.frameHeight ?? null,
            fps: s.framesPerSecond ?? null,
          });
        } else if (s.type === 'candidate-pair' && (s.nominated || s.selected)) {
          out.push({ kind: 'pair', rtt: s.currentRoundTripTime ?? null, avail: s.availableOutgoingBitrate ?? null });
        }
      });
    }
    rtc.snap = out;
  }
  try {
    setInterval(pollRTC, 1000);
  } catch (_) {}

  const info = {
    href: location.href,
    hidden: false,
    tainted: false,
    videos: 0,
  };

  /* ---------- 视频登记 ---------- */

  function labelFor(v) {
    // 优先祖先容器上的 aria-label / title（监控分屏里通常就是通道名）
    let el = v;
    for (let i = 0; i < 8 && el; i++) {
      el = el.parentElement;
      if (!el || el === document.body || el === document.documentElement) break;
      const a = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      if (a && a.length < 80) return a;
      const txt = (el.innerText || '').trim();
      if (txt && txt.length < 100) {
        const first = txt.split('\n').map((s) => s.trim()).filter(Boolean)[0];
        if (first && first.length < 80) return first;
      }
    }
    const self = [v.getAttribute('aria-label'), v.getAttribute('title'), v.id]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (self && self.length < 80) return self;
    return `video#${vids.get(v)?.id ?? '?'}`;
  }

  function register(v) {
    if (vids.has(v)) return vids.get(v);
    if (vids.size >= CFG.maxVideos) return null;
    const rec = {
      el: v,
      id: nextId++,
      label: null,
      canvas: null,
      ctx: null,
      prev: null,
      lastPresented: 0,
      lastPresentedAt: 0,
      presented: 0,
      delivered: 0,
      lastMediaTime: -1,
      gaps: 0,
      maxGap: 0,
      stallStart: 0,
      listening: false,
      taint: false,
      osdRect: null,
      osdFail: false,
      hbLast: 0,
      hbTicks: 0,
      calT0: 0,
      calPrev: null,
      calCells: new Map(),
      work: null,
      workCtx: null,
      workW: 0,
      workH: 0,
      q: { ttff: null, playMs: 0, stallCount: 0, stallMs: 0, openStall: 0, res: [], buf: 0, lastCt: 0, lastT: 0 },
    };
    vids.set(v, rec);
    rec.label = labelFor(v);
    attach(v, rec);
    return rec;
  }

  function attach(v, rec) {
    if (rec.listening) return;
    rec.listening = true;
    const on = (name, extra) => v.addEventListener(name, () => {
      events.push({ t: Math.round(now()), v: rec.id, name, ...extra });
    });
    ['waiting', 'stalled', 'error', 'playing', 'pause', 'emptied', 'ended', 'suspend', 'abort'].forEach((n) => on(n));

    // 卡顿（rebuffer）记账：waiting 开始，playing/canplay 结束
    v.addEventListener('waiting', () => {
      if (!rec.q.openStall) rec.q.openStall = now();
      rec.q.stallCount++;
    });
    const closeStall = () => {
      if (rec.q.openStall) {
        rec.q.stallMs += now() - rec.q.openStall;
        rec.q.openStall = 0;
      }
    };
    ['playing', 'canplay', 'canplaythrough'].forEach((n) => v.addEventListener(n, closeStall));

    if (typeof v.requestVideoFrameCallback === 'function') {
      const loop = (ts, meta) => {
        const t = now();
        if (meta && meta.mediaTime !== undefined && meta.mediaTime !== rec.lastMediaTime) {
          rec.lastMediaTime = meta.mediaTime;
          rec.delivered++;
        }
        if (rec.lastPresentedAt) {
          const gap = t - rec.lastPresentedAt;
          if (gap > rec.maxGap) rec.maxGap = gap;
          if (gap > CFG.stallMs) rec.gaps++;
        }
        rec.lastPresentedAt = t;
        rec.presented = meta.presentedFrames || rec.presented + 1;
        v.requestVideoFrameCallback(loop);
      };
      try {
        v.requestVideoFrameCallback(loop);
      } catch (_) {}
    }
  }

  let deepTick = 0;
  function scan() {
    const found = Array.from(document.querySelectorAll(CFG.videoSel));
    for (const v of found) register(v);
    // shadow DOM 里的播放器：兜底深扫（每 ~2.5s 一次）
    if (!found.length && ++deepTick % 10 === 0) {
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            for (const v of el.shadowRoot.querySelectorAll(CFG.videoSel)) register(v);
            walk(el.shadowRoot);
          }
        }
      };
      try {
        walk(document);
      } catch (_) {}
    }
    info.videos = vids.size;
  }

  /* ---------- 以画面为锚点探测覆盖层（loading / 报错文案） ---------- */

  const RE_LOAD = new RegExp(CFG.loadText, 'i');
  const RE_ERR = new RegExp(CFG.errText, 'i');
  // 页面级文案（导航、统计数字）里到处都有 "(0)"、"(1)" 这种，必须同时含明确的错误词才算报错；
  // 画面上的覆盖层不受这条限制（它天然属于某个通道）。
  const RE_ERR_WORD = /timeout|timed out|failed|failure|error|denied|offline|no signal|unavailable|connection|连接|超时|失败|无信号|离线|错误|异常/i;

  function probeOverlay(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
    let els;
    try {
      els = document.elementsFromPoint(x, y);
    } catch (_) {
      return null;
    }
    let txt = '';
    let cls = '';
    let hit = false;
    for (const el of els.slice(0, 5)) {
      if (el === v || el.contains(v) || v.contains(el)) continue;
      txt += ' ' + (el.innerText || '').trim();
      cls += ' ' + (el.className || '').toString();
      hit = true;
      if (txt.length > 240) break;
    }
    if (!hit) return null;
    return { text: txt.trim().slice(0, 200), cls: cls.trim().slice(0, 120) };
  }

  /* ---------- 画面采样 ---------- */

  // OSD 心跳：带秒级时间戳的安防画面里，OSD 就是“画面时钟”。
  // 画面停住时 OSD 也停（实测：暂停后 OSD 区域逐字节不变），所以只要它按 ~1Hz 跳动，
  // 就说明解码/渲染链路是活的；连续不动超过阈值就是卡顿（不再区分冻结/缓冲）。

  const CAL = { minEvents: 4, gap: 500, periodLo: 650, periodHi: 1600, cvMax: 0.35, maxActiveFrac: 0.55 };

  function parseOsd(s, W, H) {
    const m = String(s || '')
      .split(/[,x]/)
      .map((x) => +x.trim());
    if (m.length !== 4 || m.some((x) => !isFinite(x))) return null;
    const [x, y, w, h] = m;
    if (w < 8 || h < 8 || x < 0 || y < 0 || x + w > W || y + h > H) return null;
    return { x, y, w, h };
  }

  function ensureCanvases(rec, W, H) {
    if (!rec.small) {
      rec.small = document.createElement('canvas');
      rec.small.width = CFG.sampleW;
      rec.small.height = CFG.sampleH;
      rec.smallCtx = rec.small.getContext('2d');
    }
    if (rec.work && rec.workW === W && rec.workH === H) return;
    rec.work = document.createElement('canvas');
    rec.work.width = W;
    rec.work.height = H;
    rec.workCtx = rec.work.getContext('2d');
    rec.workW = W;
    rec.workH = H;
    rec.cal = document.createElement('canvas');
    rec.cal.width = Math.min(960, W);
    rec.cal.height = Math.max(1, Math.round((rec.cal.width * H) / W));
    rec.calCtx = rec.cal.getContext('2d', { willReadFrequently: true });
    rec.calPrev = null;
    rec.calCells = new Map();
    rec.calT0 = 0;
    rec.osdPrev = null;
    rec.osdCv = null;
    rec.hbLast = 0;
    if (CFG.osd) {
      const r = parseOsd(CFG.osd, W, H);
      if (r) rec.osdRect = r;
    }
  }

  // 标定：逐像素统计“隔了 ≥500ms 又变一次”的次数，取这些像素的包围盒当 OSD 区域。
  // 秒级 OSD 的秒位像素每秒跳一次，5–6s 里会累积 4 次以上；
  // 走廊里走动的人虽然也在变，但同一像素连续变化间隔远小于 500ms，累积不起来（PTZ 会失败，用 --osd 手填）。
  function calTick(rec, t) {
    const W = rec.cal.width,
      H = rec.cal.height;
    let d;
    try {
      rec.calCtx.drawImage(rec.work, 0, 0, W, H);
      d = rec.calCtx.getImageData(0, 0, W, H).data;
    } catch (_) {
      return;
    }
    const n = W * H;
    if (!rec.evCount || rec.evCount.length !== n) {
      rec.evCount = new Uint16Array(n);
      rec.evActive = new Uint16Array(n);
      rec.evPrevT = new Float64Array(n).fill(-1);
      rec.evSum = new Float32Array(n);
      rec.evSum2 = new Float32Array(n);
      rec.calPrev = null;
    }
    const prev = rec.calPrev;
    if (prev) {
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        if (Math.abs(d[p] - prev[p]) + Math.abs(d[p + 1] - prev[p + 1]) + Math.abs(d[p + 2] - prev[p + 2]) > 10) {
          rec.evActive[i]++;
          const last = rec.evPrevT[i];
          if (last < 0 || t - last >= CAL.gap) {
            if (last >= 0) {
              const iv = t - last;
              rec.evSum[i] += iv;
              rec.evSum2[i] += iv * iv;
            }
            rec.evCount[i]++;
            rec.evPrevT[i] = t;
          }
        }
      }
    }
    rec.calPrev = new Uint8ClampedArray(d);
    rec.calN = (rec.calN || 0) + 1;
  }

  function calFinish(rec) {
    if (!rec.evCount) return null;
    const W = rec.cal.width,
      H = rec.cal.height;
    let x0 = 1e9,
      y0 = 1e9,
      x1 = -1,
      y1 = -1,
      cnt = 0;
    const isClock = (i) => {
      const evn = rec.evCount[i];
      if (evn < CAL.minEvents) return false;
      const k = evn - 1;
      if (k <= 0) return false;
      const mean = rec.evSum[i] / k;
      if (mean < CAL.periodLo || mean > CAL.periodHi) return false;
      const v = Math.max(0, rec.evSum2[i] / k - mean * mean);
      if (Math.sqrt(v) / mean > CAL.cvMax) return false; // 间隔必须规整
      return rec.evActive[i] <= (rec.calN || 1) * CAL.maxActiveFrac; // 大部分时间静止
    };
    // 密度聚类：整帧里零散的噪声像素会把 bbox 撑到满屏，必须从最密的格子里长出来
    const G = 16;
    const gw = Math.ceil(W / G),
      gh = Math.ceil(H / G);
    const dens = new Int32Array(gw * gh);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isClock(y * W + x)) dens[((y / G) | 0) * gw + ((x / G) | 0)]++;
      }
    }
    let best = 0,
      bestI = -1;
    for (let i = 0; i < dens.length; i++) {
      if (dens[i] > best) {
        best = dens[i];
        bestI = i;
      }
    }
    if (best < 3) {
      rec.calWhy = `noSeed:${best}`;
      return null;
    }
    const thr = Math.max(3, Math.floor(best * 0.2));
    const seen = new Uint8Array(gw * gh);
    const stack = [bestI];
    seen[bestI] = 1;
    while (stack.length) {
      const c = stack.pop();
      const cx = c % gw,
        cy = (c / gw) | 0;
      const yEnd = Math.min(H, cy * G + G),
        xEnd = Math.min(W, cx * G + G);
      for (let y = cy * G; y < yEnd; y++) {
        for (let x = cx * G; x < xEnd; x++) {
          if (!isClock(y * W + x)) continue;
          cnt++;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (seen[ni] || dens[ni] < thr) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    if (cnt < 10 || x1 < 0) {
      rec.calWhy = `tooFewPixels:${cnt}`;
      return null;
    }
    const bw = x1 - x0 + 1,
      bh = y1 - y0 + 1;
    // bbox 里真正在跳的像素占比不能太低，否则说明是满屏随机噪声（PTZ/雨雪）
    if (cnt / (bw * bh) < 0.008) {
      rec.calWhy = `sparse:${cnt}/${bw}x${bh}`;
      return null;
    }
    const kx = rec.workW / W,
      ky = rec.workH / H;
    let X = Math.max(0, Math.floor((x0 - 3) * kx));
    let Y = Math.max(0, Math.floor((y0 - 3) * ky));
    let Wd = Math.ceil((bw + 6) * kx);
    let Hd = Math.ceil((bh + 6) * ky);
    if (X + Wd > rec.workW) Wd = rec.workW - X;
    if (Y + Hd > rec.workH) Hd = rec.workH - Y;
    if (Wd < 12 || Hd < 8) return null;
    if ((Wd * Hd) / (rec.workW * rec.workH) > CFG.osdAreaMax) return null;
    return { x: X, y: Y, w: Wd, h: Hd };
  }

  // 心跳：ROI 里任意像素变化就刷新 lastTick；阈值按面积取，避免压缩噪声误判。
  function heartbeat(rec, t) {
    const r = rec.osdRect;
    if (!r) return -1;
    if (!rec.hbLast) rec.hbLast = t;
    if (!rec.osdCv || rec.osdCv.width !== r.w || rec.osdCv.height !== r.h) {
      rec.osdCv = document.createElement('canvas');
      rec.osdCv.width = r.w;
      rec.osdCv.height = r.h;
      rec.osdCtx = rec.osdCv.getContext('2d');
      rec.osdPrev = null;
      if (!rec.hbLast) rec.hbLast = t;
    }
    let d;
    try {
      rec.osdCtx.drawImage(rec.work, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      d = rec.osdCtx.getImageData(0, 0, r.w, r.h).data;
    } catch (_) {
      return -1;
    }
    const prev = rec.osdPrev;
    let n = 0;
    if (prev && prev.length === d.length) {
      for (let p = 0; p < d.length; p += 4) {
        if (
          Math.abs(d[p] - prev[p]) > 18 ||
          Math.abs(d[p + 1] - prev[p + 1]) > 18 ||
          Math.abs(d[p + 2] - prev[p + 2]) > 18
        )
          n++;
      }
    }
    rec.osdPrev = new Uint8ClampedArray(d);
    const need = Math.max(8, Math.round(r.w * r.h * 0.002));
    if (n >= need) {
      rec.hbLast = t;
      rec.hbTicks++;
    }
    return Math.round(t - rec.hbLast);
  }

  function sample(rec) {
    const v = rec.el;
    if (!v || v.readyState < 2 || !v.videoWidth || !v.isConnected) {
      return { t: Math.round(now()), v: rec.id, noFrame: 1, rs: v?.readyState ?? 0 };
    }
    const VW = v.videoWidth,
      VH = v.videoHeight;
    ensureCanvases(rec, VW, VH);
    let data;
    try {
      // 整帧只回读一次；后面的裁剪/降采样都在 canvas 之间做。
      // （drawImage(video) 的价格由源分辨率决定，跟目标尺寸无关：2880×1620 实测 ~13ms）
      rec.workCtx.drawImage(v, 0, 0, VW, VH);
      rec.smallCtx.drawImage(rec.work, 0, 0, CFG.sampleW, CFG.sampleH);
      data = rec.smallCtx.getImageData(0, 0, CFG.sampleW, CFG.sampleH).data;
    } catch (e) {
      rec.taint = true;
      info.tainted = true;
      return { t: Math.round(now()), v: rec.id, tainted: 1 };
    }

    // OSD 标定（只在前 osdCalMs 内跑）
    const tNow0 = now();
    if (!rec.osdRect && !rec.osdFail && !v.paused) {
      if (!rec.calT0) rec.calT0 = tNow0;
      calTick(rec, tNow0);
      if (tNow0 - rec.calT0 >= CFG.osdCalMs) {
        rec.osdRect = calFinish(rec);
        // 标定数组很大（960×540 时每个 ~1–4MB），标定完就释放
        rec.evCount = rec.evActive = rec.evPrevT = rec.evSum = rec.evSum2 = rec.calPrev = null;
        if (!rec.osdRect) rec.osdFail = true;
        else {
          rec.hbLast = tNow0;
          info.osd = rec.osdRect;
        }
      }
    }

    // 颜色统计：按 6×3 区块算（18 块）。
    // 好处一：OSD/UI 角标最多污染 1–2 块，中位数剔除掉，黑/白屏不会被文字抬高方差而漏判；
    // 好处二：能发现“只有一部分画面是绿的/黑的”，整帧平均是做不出来的；
    // 好处三：不用排序 1296 个像素（那要 0.8ms/帧），一遍求和就够（~8µs）。
    const BX = 6,
      BY = 3,
      bn = BX * BY;
    const npx = CFG.sampleW * CFG.sampleH;
    const bw = CFG.sampleW / BX,
      bh = CFG.sampleH / BY;
    const bsum = new Float32Array(bn * 6),
      bcnt = new Float32Array(bn);
    let detail = 0;
    for (let y = 0, p = 0; y < CFG.sampleH; y++) {
      const by = Math.min(BY - 1, (y / bh) | 0);
      for (let x = 0; x < CFG.sampleW; x++, p += 4) {
        const bi = by * BX + Math.min(BX - 1, (x / bw) | 0);
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const o = bi * 6;
        bsum[o] += r;
        bsum[o + 1] += g;
        bsum[o + 2] += b;
        bsum[o + 3] += r * r;
        bsum[o + 4] += g * g;
        bsum[o + 5] += b * b;
        bcnt[bi]++;
        if (x) detail += Math.abs(r - data[p - 4]) + Math.abs(g - data[p - 3]) + Math.abs(b - data[p - 2]);
      }
    }
    const bmean = [],
      bsd = [];
    for (let i = 0; i < bn; i++) {
      const c = bcnt[i] || 1,
        o = i * 6;
      const mr = bsum[o] / c,
        mg = bsum[o + 1] / c,
        mb = bsum[o + 2] / c;
      bmean.push([mr, mg, mb]);
      bsd.push([
        Math.sqrt(Math.max(0, bsum[o + 3] / c - mr * mr)),
        Math.sqrt(Math.max(0, bsum[o + 4] / c - mg * mg)),
        Math.sqrt(Math.max(0, bsum[o + 5] / c - mb * mb)),
      ]);
    }
    // 全局：在区块层面对中位数做剔除（被 OSD 污染的块整块丢掉）
    const medOf = (k) => {
      const s = bmean.map((v) => v[k]).sort((a, b) => a - b);
      return s[s.length >> 1];
    };
    const gMed = [medOf(0), medOf(1), medOf(2)];
    const keepIdx = [];
    for (let i = 0; i < bn; i++) {
      if (Math.abs(bmean[i][0] - gMed[0]) <= 45 && Math.abs(bmean[i][1] - gMed[1]) <= 45 && Math.abs(bmean[i][2] - gMed[2]) <= 45) keepIdx.push(i);
    }
    const K = keepIdx.length || 1;
    const m3 = [0, 0, 0],
      v3 = [0, 0, 0];
    for (const i of keepIdx) for (let k = 0; k < 3; k++) m3[k] += bmean[i][k];
    for (let k = 0; k < 3; k++) m3[k] /= K;
    for (const i of keepIdx) for (let k = 0; k < 3; k++) v3[k] += (bmean[i][k] - m3[k]) ** 2;
    const sd3 = v3.map((v) => Math.sqrt(v / K));
    const R = m3[0],
      G = m3[1],
      B = m3[2];
    // 局部候选块：均值明显偏离全局的块交给 Node 判色（一次最多十几块，日志不会爆）
    // 已知 OSD 覆盖到的块直接排除，免得时间戳在白/黑屏上被当成“局部色块”。
    const osd = rec.osdRect;
    const cb = [];
    for (let i = 0; i < bn; i++) {
      const dev = Math.max(Math.abs(bmean[i][0] - R), Math.abs(bmean[i][1] - G), Math.abs(bmean[i][2] - B));
      if (dev <= 50) continue;
      if (osd) {
        const bx0 = ((i % BX) * VW) / BX,
          by0 = (((i / BX) | 0) * VH) / BY;
        const bx1 = bx0 + VW / BX,
          by1 = by0 + VH / BY;
        if (bx1 >= osd.x && bx0 <= osd.x + osd.w && by1 >= osd.y && by0 <= osd.y + osd.h) continue;
      }
      cb.push([i, Math.round(bmean[i][0]), Math.round(bmean[i][1]), Math.round(bmean[i][2]), Math.round(bsd[i][0]), Math.round(bsd[i][1]), Math.round(bsd[i][2])]);
    }

    // 与上一帧逐像素比较：eq=完全相同像素占比, mad=平均绝对差
    let diffPx = 0, mad = 0;
    if (rec.prev) {
      for (let p = 0; p < data.length; p += 4) {
        const d = Math.abs(data[p] - rec.prev[p]) + Math.abs(data[p + 1] - rec.prev[p + 1]) + Math.abs(data[p + 2] - rec.prev[p + 2]);
        if (d > 0) diffPx++;
        mad += d;
      }
      mad = mad / (npx * 3);
    }
    rec.prev = new Uint8ClampedArray(data);

    const pq = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    const stalledFor = rec.lastPresentedAt ? Math.max(0, now() - rec.lastPresentedAt) : -1;

    // QoE：首帧 / 有效播放时长 / 缓冲余量 / 分辨率变化
    const st = rec.q;
    const tNow = now();
    if (st.ttff == null && v.currentTime > 0) st.ttff = Math.round(tNow);
    const dct = v.currentTime - st.lastCt;
    const dt = tNow - st.lastT;
    if (!v.paused && dct > 0 && dt > 0) st.playMs += Math.min(dct * 1000, dt);
    st.lastCt = v.currentTime;
    st.lastT = tNow;
    const buf = v.buffered && v.buffered.length ? Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime) : 0;
    st.buf = buf;
    if (!st.res.length || st.res[st.res.length - 1].w !== v.videoWidth || st.res[st.res.length - 1].h !== v.videoHeight) {
      st.res.push({ t: Math.round(tNow), w: v.videoWidth, h: v.videoHeight });
    }

    // 覆盖层：转圈 / 报错文案（以画面中心为锚点，天然按通道归属）
    const ov = probeOverlay(v);
    const otext = ov ? ov.text : '';
    const ldv = ov ? RE_LOAD.test(otext) || /spin|spinner|loading|loader|buffer|progress/i.test(ov.cls) : 0;
    const erv = ov ? RE_ERR.test(otext) : 0;

    const hbAge = heartbeat(rec, now());

    return {
      t: Math.round(now()),
      v: rec.id,
      hb: hbAge,
      ldv: ldv ? 1 : 0,
      erv: erv ? 1 : 0,
      ovt: otext ? otext.slice(0, 120) : undefined,
      ovc: ov ? ov.cls : undefined,
      w: v.videoWidth,
      h: v.videoHeight,
      r: +R.toFixed(1),
      g: +G.toFixed(1),
      b: +B.toFixed(1),
      sd: +sd3[0].toFixed(1),
      sg: +sd3[1].toFixed(1),
      sb: +sd3[2].toFixed(1),
      cb: cb.length ? cb : undefined,
      eq: rec.prev && diffPx === 0 ? 100 : +(100 * (1 - diffPx / npx)).toFixed(1),
      mad: +mad.toFixed(3),
      det: +(detail / (npx * 3)).toFixed(2),
      ct: +v.currentTime.toFixed(3),
      pl: v.paused ? 1 : 0,
      rs: v.readyState,
      ns: v.networkState,
      dr: pq ? pq.droppedVideoFrames : -1,
      tf: pq ? pq.totalVideoFrames : -1,
      cq: pq ? pq.corruptedVideoFrames ?? -1 : -1,
      df: rec.delivered,
      buf: +buf.toFixed(2),
      pr: rec.presented,
      st: Math.round(stalledFor),
      err: v.error ? `${v.error.code}:${v.error.message || ''}` : null,
    };
  }

  /* ---------- DOM：loading / 报错文案 ---------- */

  const dom = { loading: [], errors: [], ts: 0 };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    if (r.width > window.innerWidth * 0.98 && r.height > window.innerHeight * 0.98) return false; // 整个页面容器不算
    return true;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }

  function scanDom() {
    const found = { loading: [], errors: [] };

    // 页面级报错文案（弹窗/横幅这类不一定压在画面上的提示）
    const txt = (document.body && document.body.innerText) || '';
    if (txt) {
      const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 400);
      for (const line of lines) {
        if (line.length > 160) continue;
        if (!RE_ERR_WORD.test(line)) continue;
        const hit = line.match(RE_ERR);
        if (hit) found.errors.push({ kind: 'text', text: line.slice(0, 160), match: hit[1] });
      }
    }

    // 3) video.error
    for (const [v, rec] of vids) {
      if (v.error) found.errors.push({ kind: 'video-error', text: `${v.error.code} ${v.error.message || ''}`.trim(), v: rec.id });
    }

    dom.loading = found.loading.slice(0, 6);
    dom.errors = found.errors.slice(0, 6);
    dom.ts = Math.round(now());
    info.hidden = document.hidden;
  }

  /* ---------- 对外接口 ---------- */

  function tick() {
    scan();
    for (const [, rec] of vids) {
      const s = sample(rec);
      if (s) samples.push(s);
    }
  }

  let sampleTimer = setInterval(tick, Math.max(100, Math.round(1000 / CFG.fps)));
  let domTimer = setInterval(scanDom, 700);
  scanDom();

  window.__VT = {
    version: 1,
    info: () => ({ ...info }),
    drain: () => {
      const out = {
        samples: samples.splice(0, samples.length),
        events: events.splice(0, events.length),
        dom: { ...dom, loading: dom.loading.slice(), errors: dom.errors.slice() },
        info: { ...info },
        qoe: Array.from(vids.values()).map((r) => ({
          v: r.id,
          label: r.label,
          ttff: r.q.ttff,
          playMs: Math.round(r.q.playMs),
          stallCount: r.q.stallCount,
          stallMs: Math.round(r.q.stallMs + (r.q.openStall ? now() - r.q.openStall : 0)),
          res: r.q.res.slice(0, 16),
          buf: +r.q.buf.toFixed(2),
          ct: +r.el.currentTime.toFixed(2),
          paused: r.el.paused ? 1 : 0,
          w: r.el.videoWidth,
          h: r.el.videoHeight,
        })),
        rtc: { snap: rtc.snap, error: rtc.error, pcs: rtc.pcs.length },
      };
      return out;
    },
    videos: () =>
      Array.from(vids.values()).map((r) => {
        const b = r.el.getBoundingClientRect();
        return { id: r.id, label: r.label, rect: { x: b.x, y: b.y, w: b.width, h: b.height }, visible: b.width > 0 && b.height > 0, paused: r.el.paused, src: (r.el.currentSrc || '').slice(0, 200), osd: r.osdRect, hb: r.osdRect ? Math.round(now() - r.hbLast) : -1, vw: r.el.videoWidth, vh: r.el.videoHeight };
      }),
    rect: (id) => {
      for (const [, r] of vids) if (r.id === id) {
        const b = r.el.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      }
      return null;
    },
    stop: () => {
      clearInterval(sampleTimer);
      clearInterval(domTimer);
    },
    // 标定诊断：给 --osd 手填坐标时用
    diag: () =>
      Array.from(vids.values()).map((r) => ({
        id: r.id,
        calN: r.calN || 0,
        osd: r.osdRect,
        fail: r.osdFail,
        evPixels: r.evCount ? r.evCount.reduce((a, v) => a + (v >= CAL.minEvents ? 1 : 0), 0) : -1,
        why: r.calWhy || null,
      })),
  };
})();
