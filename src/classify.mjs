import { TYPE_CN } from './util.mjs';

const DEF = {
  blackLuma: 18,
  whiteLuma: 232,
  greenDelta: 45,
  blueDelta: 55,
  greenMin: 60,
  blueMin: 60,
  minDur: 600,
  stallMs: 1500,
  graceMs: 900,
  novideoMin: 2000,
  blkMin: 2,
};

const MIN_DUR = { black: 600, white: 600, green: 600, blue: 600, loading: 600, error: 500, stall: 1400, novideo: 2000 };
const DEFAULT_LABEL = { 0: '(页面级)' };

export class Analyzer {
  constructor(opts = {}) {
    this.o = { ...DEF, ...opts };
    this.videos = new Map();
    this.open = new Map();
    this.episodes = [];
    this.pendingShots = [];
    this.samples = 0;
    this.t0 = 0;
    this.tLast = 0;
  }

  setVideos(list, frame) {
    for (const v of list || []) {
      const key = `${frame}:${v.id}`;
      const cur = this.videos.get(key) || { key, frame, id: v.id, n: 0, drop0: -1, drop1: 0, pr0: -1, pr1: 0, df0: -1, df1: 0, tf0: -1, tf1: 0, t0: 0, t1: 0, maxStall: 0, firstFrame: null };
      cur.label = v.label || `video#${v.id}`;
      cur.src = v.src || '';
      cur.visible = v.visible;
      this.videos.set(key, cur);
    }
  }

  colorOf(r, g, b, sd, sg, sb) {
    const o = this.o;
    const uniq = Math.max(sd || 0, sg || 0, sb || 0);
    if (r < o.blackLuma && g < o.blackLuma && b < o.blackLuma && uniq < 14) return 'black';
    if (r > o.whiteLuma && g > o.whiteLuma && b > o.whiteLuma && uniq < 14) return 'white';
    if (g - Math.max(r, b) > o.greenDelta && g > o.greenMin && (sg ?? 99) < 45) return 'green';
    if (b - Math.max(r, g) > o.blueDelta && b > o.blueMin) return 'blue';
    return null;
  }

  classify(s) {
    const t = this.colorOf(s.r, s.g, s.b, s.sd, s.sg, s.sb);
    return t ? [t] : [];
  }

  ingest(payload, frame) {
    const { samples = [], events = [], dom = {}, info = {}, qoe = [], rtc = null } = payload || {};
    this.info = info;
    // 通道自己的覆盖层已经报了错，就不要再从整页文案里重复报一条（同一故障两条记录）
    const chanErr = samples.some((x) => x.erv || x.err);

    for (const q of qoe) {
      const key = `${frame}:${q.v}`;
      let v = this.videos.get(key);
      if (!v) {
        v = { key, frame, id: q.v, n: 0, drop0: -1, drop1: 0, pr0: -1, pr1: 0, df0: -1, df1: 0, tf0: -1, tf1: 0, t0: 0, t1: 0, maxStall: 0, firstFrame: null };
        this.videos.set(key, v);
      }
      v.qoe = q;
      if (q.label && (!v.label || v.label.startsWith('video#'))) v.label = q.label;
    }
    if (rtc && rtc.snap && rtc.snap.length) this.ingestRTC(rtc, frame);

    for (const ev of events) this.onEvent(ev, frame);

    for (const s of samples) {
      this.samples++;
      const key = `${frame}:${s.v}`;
      let v = this.videos.get(key);
      if (!v) {
        v = { key, frame, id: s.v, label: `video#${s.v}`, n: 0, drop0: -1, drop1: 0, pr0: -1, pr1: 0, df0: -1, df1: 0, tf0: -1, tf1: 0, t0: 0, t1: 0, maxStall: 0, firstFrame: null };
        this.videos.set(key, v);
      }
      const t = s.t;
      this.tLast = Math.max(this.tLast, t);

      if (s.noFrame) {
        this.touch('novideo', t, v, s, { reason: `readyState=${s.rs}` });
        this.age(key, t, new Set(['novideo']));
        continue;
      }
      if (s.tainted) continue;

      v.n++;
      if (v.t0 === 0) v.t0 = t;
      v.t1 = t;
      if (v.pr0 < 0) {
        v.pr0 = s.pr;
        v.drop0 = s.dr;
        v.df0 = s.df ?? -1;
        v.tf0 = s.tf ?? -1;
      }
      v.pr1 = s.pr;
      if (s.dr >= 0) v.drop1 = s.dr;
      if (s.df != null) v.df1 = s.df;
      if (s.tf != null) v.tf1 = s.tf;
      if (s.st >= 0) v.maxStall = Math.max(v.maxStall, s.st);
      if (v.firstFrame == null && s.ct > 0) v.firstFrame = t;

      const types = new Set(this.classify(s));

      // 局部分区：只有一部分画面变绿/黑时，整帧平均看不出来，靠 agent 报上来的候选块
      const BLK_N = 18;
      const loc = new Map();
      for (const b of s.cb || []) {
        const t2 = this.colorOf(b[1], b[2], b[3], b[4], b[5], b[6]);
        if (!t2) continue;
        if (!loc.has(t2)) loc.set(t2, []);
        loc.get(t2).push(b[0]);
      }
      const areaMap = {};
      for (const [t2, idx] of loc) {
        if (idx.length < this.o.blkMin) continue;
        types.add(t2);
        areaMap[t2] = { frac: +(idx.length / BLK_N).toFixed(3), blocks: idx };
      }

      // 卡顿：只认一个现象——OSD 秒位心跳中断。画面停住就是卡顿，不做机制分类。
      // hb < 0 表示没有 OSD（自动标定失败），退回 rVFC 断档兜底。
      const hb = s.hb;
      if (!s.pl && (hb >= 0 ? hb >= this.o.stallMs : s.st >= this.o.stallMs)) types.add('stall');
      // 覆盖层：转圈 / 报错（按通道归属）
      if (s.ldv) types.add('loading');
      if (s.erv) types.add('error');
      if (s.err) types.add('error');

      const gtypes = new Set();
      if (dom.errors && dom.errors.length && !chanErr) gtypes.add('error');

      if (types.size) this.touch(types, t, v, s, { areaMap });
      if (gtypes.size && !(gtypes.has('error') && types.has('error'))) {
        const gv = { key: 'global', frame, id: 0, label: DEFAULT_LABEL[0] };
        this.touch(gtypes, t, gv, s, { dom });
        this.age('global', t, gtypes);
      }
      this.age(key, t, types);
      this.sawText = s.ovt ? { text: s.ovt, v: v.key } : this.sawText;
    }
    this.checkShots();
    this.tLastDom = dom;
  }

  onEvent(ev, frame) {
    // 注意：不再用 waiting/stalled 事件开卡顿 episode（按表现口径只认 OSD 心跳），
    // 事件仍然记录在 samples.jsonl 里作为归因线索。
    if (ev.name === 'error') {
      const key = `${frame}:${ev.v}`;
      const v = this.videos.get(key) || { key, label: `video#${ev.v}`, n: 0 };
      this.touch('error', ev.t, v, {}, { src: `event:${ev.name}` });
    }
  }

  touch(typeOrTypes, t, v, s, meta) {
    const list = Array.isArray(typeOrTypes) ? typeOrTypes : typeOrTypes instanceof Set ? [...typeOrTypes] : [typeOrTypes];
    for (const type of list) {
      const key = `${type}|${v.key}`;
      let ep = this.open.get(key);
      if (!ep) {
        ep = {
          id: this.episodes.length + 1,
          type,
          v: v.key,
          frame: v.frame,
          vid: v.id,
          label: v.label || `video#${v.id}`,
          start: type === 'stall' && s && s.hb > 0 ? Math.max(v.t0 || 0, t - s.hb) : t,
          end: t,
          count: 0,
          shot: null,
          valid: false,
          peak: null,
          meta: meta || {},
          color: s && s.r !== undefined ? { r: s.r, g: s.g, b: s.b, sd: s.sd } : null,
        };
        this.open.set(key, ep);
        this.episodes.push(ep);
      }
      ep.end = t;
      ep.count++;
      if (meta && meta.areaMap && meta.areaMap[type]) {
        const a = meta.areaMap[type];
        if (!ep.area || a.frac > ep.area.frac) ep.area = a;
      }
      if ((type === 'loading' || type === 'error') && s && s.ovt) ep.text = s.ovt;
      if (type === 'stall') ep.peak = Math.max(ep.peak || 0, s.st || 0);
    }
  }

  age(vkey, t, presentTypes) {
    for (const [key, ep] of this.open) {
      if (!key.endsWith('|' + vkey)) continue;
      if (presentTypes.has(ep.type)) continue;
      if (t - ep.end > this.o.graceMs) this.close(key, ep);
    }
  }

  close(key, ep) {
    this.open.delete(key);
    ep.dur = Math.max(0, ep.end - ep.start);
    const min = MIN_DUR[ep.type] ?? this.o.minDur;
    ep.valid = ep.dur >= min;
    if (ep.valid && !ep.shot) this.shotWanted(ep);
  }

  shotWanted(ep) {
    if (ep.shotRequested) return;
    ep.shotRequested = true;
    this.pendingShots.push(ep);
  }

  checkShots() {
    for (const ep of this.open.values()) {
      if (ep.shotRequested) continue;
      const min = MIN_DUR[ep.type] ?? this.o.minDur;
      if (this.tLast - ep.start >= Math.min(500, min)) this.shotWanted(ep);
    }
  }

  attachedShot(epId, file) {
    const ep = this.episodes.find((e) => e.id === epId);
    if (ep) ep.shot = file;
    this.pendingShots = this.pendingShots.filter((e) => e.id !== epId);
  }

  ingestRTC(rtc, frame) {
    this.rtc = this.rtc || { streams: new Map(), pair: null, error: null, pcs: 0 };
    this.rtc.pcs = Math.max(this.rtc.pcs, rtc.pcs || 0);
    if (rtc.error) this.rtc.error = rtc.error;
    const at = Date.now();
    for (const s of rtc.snap) {
      if (s.kind === 'in') {
        const key = `${frame}:${s.id}`;
        const cur = this.rtc.streams.get(key) || { first: s, t0: at, last: s, t1: at };
        cur.last = s;
        cur.t1 = at;
        this.rtc.streams.set(key, cur);
      } else if (s.kind === 'pair' && s.rtt != null) {
        this.rtc.pair = s;
      }
    }
  }

  rtcSummary() {
    if (!this.rtc || !this.rtc.streams.size) return null;
    let freezeCount = 0,
      freezeDur = 0,
      dropped = 0,
      decoded = 0,
      bytes = 0,
      jb = 0,
      jbc = 0,
      lost = 0,
      span = 0;
    const res = [];
    for (const s of this.rtc.streams.values()) {
      const d = (k) => (s.last[k] ?? 0) - (s.first[k] ?? 0);
      freezeCount += Math.max(0, d('fz'));
      freezeDur += Math.max(0, d('fzd'));
      dropped += Math.max(0, d('fdrop'));
      decoded += Math.max(0, d('fd'));
      bytes += Math.max(0, d('bytes'));
      jb += Math.max(0, d('jb'));
      jbc += Math.max(0, d('jbc'));
      lost += Math.max(0, d('lost'));
      span = Math.max(span, s.t1 - s.t0);
      if (s.last.w && s.last.h) res.push(`${s.last.w}x${s.last.h}`);
    }
    span = Math.max(span, 1);
    return {
      streams: this.rtc.streams.size,
      pcs: this.rtc.pcs,
      freezeCount,
      freezesSec: +freezeDur.toFixed(2),
      framesDropped: dropped,
      framesDecoded: decoded,
      bitrateKbps: bytes ? +((bytes * 8) / span).toFixed(0) : null,
      jitterBufferMs: jbc ? +((jb / jbc) * 1000).toFixed(0) : null,
      packetsLost: lost,
      rttMs: this.rtc.pair ? +(this.rtc.pair.rtt * 1000).toFixed(0) : null,
      resolution: [...new Set(res)].join(', ') || null,
      error: this.rtc.error,
    };
  }

  finish() {
    for (const [key, ep] of Array.from(this.open.entries())) this.close(key, ep);
  }

  summary() {
    this.finish();
    const valid = this.episodes.filter((e) => e.valid);
    const byType = {};
    for (const e of valid) {
      byType[e.type] = byType[e.type] || { count: 0, dur: 0 };
      byType[e.type].count++;
      byType[e.type].dur += e.dur;
    }
    const videos = Array.from(this.videos.values()).map((v) => {
      const dur = Math.max(1, (v.t1 || 0) - (v.t0 || 0));
      return {
        key: v.key,
        label: v.label,
        src: v.src,
        samples: v.n,
        spanMs: dur,
        fps: v.df1 > v.df0 ? +(((v.df1 - v.df0) / dur) * 1000).toFixed(2) : null,
        dropped: v.drop1 >= 0 && v.drop0 >= 0 ? v.drop1 - v.drop0 : null,
        dropRatio: v.drop1 >= 0 && v.drop0 >= 0 && v.tf1 > v.tf0 ? +((v.drop1 - v.drop0) / (v.tf1 - v.tf0)).toFixed(4) : null,
        maxStallMs: v.maxStall,
        firstFrameMs: v.firstFrame,
        qoe: v.qoe
          ? {
              ttffMs: v.qoe.ttff,
              playMs: v.qoe.playMs,
              stallCount: v.qoe.stallCount,
              stallMs: v.qoe.stallMs,
              stallRatio: v.qoe.playMs + v.qoe.stallMs > 0 ? +(v.qoe.stallMs / (v.qoe.playMs + v.qoe.stallMs)).toFixed(4) : null,
              bufferedSec: v.qoe.buf,
              currentTime: v.qoe.ct,
              paused: !!v.qoe.paused,
              width: v.qoe.w,
              height: v.qoe.h,
              resChanges: Math.max(0, (v.qoe.res || []).length - 1),
              resolutions: v.qoe.res || [],
            }
          : null,
      };
    });
    return {
      ok: valid.length === 0,
      startedAt: this.startedAt || null,
      endedAt: new Date().toISOString(),
      samples: this.samples,
      videos,
      rtc: this.rtcSummary(),
      counts: byType,
      episodes: this.episodes.filter((e) => e.valid).sort((a, b) => a.start - b.start).map((e) => ({ ...e, typeCn: TYPE_CN[e.type] || e.type })),
      raw: this.episodes.length,
    };
  }
}
