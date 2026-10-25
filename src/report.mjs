import { esc, ms, TYPE_CN } from './util.mjs';

const COLOR = {
  black: '#111827',
  white: '#e5e7eb',
  green: '#22c55e',
  blue: '#3b82f6',
  stall: '#f59e0b',
  loading: '#06b6d4',
  error: '#ef4444',
  novideo: '#6b7280',
};

// 6×3 区块 → 方位（用于“区域 33%（右下）”这种描述）
function blockPos(blocks) {
  if (!blocks || !blocks.length) return '';
  const cx = blocks.reduce((a, i) => a + (i % 6), 0) / blocks.length;
  const cy = blocks.reduce((a, i) => a + ((i / 6) | 0), 0) / blocks.length;
  const v = cy < 0.7 ? '上' : cy > 1.3 ? '下' : '中';
  const h = cx < 1.7 ? '左' : cx > 3.3 ? '右' : '中';
  return h === '中' && v === '中' ? '中央' : h + v;
}

export function buildReport(d) {
  const span = Math.max(1, d.durationMs || 1);
  const videos = d.videos.length ? d.videos : [{ key: 'global', label: '(页面级)' }];
  const byV = new Map();
  for (const e of d.episodes) {
    if (!byV.has(e.v)) byV.set(e.v, []);
    byV.get(e.v).push(e);
  }

  const counts = Object.entries(d.counts || {}).sort((a, b) => b[1].dur - a[1].dur);
  const cards = counts
    .map(
      ([t, c]) => `<div class="card"><div class="k" style="color:${COLOR[t] || '#888'}">${esc(TYPE_CN[t] || t)}</div>
      <div class="v">${c.count}<span> 次</span></div><div class="s">累计 ${ms(c.dur)}</div></div>`
    )
    .join('');

  const bars = videos
    .map((v) => {
      const eps = byV.get(v.key) || [];
      const segs = eps
        .map((e) => {
          const left = (e.start / span) * 100;
          const w = Math.max(0.35, (e.dur / span) * 100);
          return `<i title="${esc(e.typeCn)} ${ms(e.dur)} @ ${ms(e.start)}" style="left:${left.toFixed(2)}%;width:${Math.min(100 - left, w).toFixed(2)}%;background:${COLOR[e.type] || '#888'}"></i>`;
        })
        .join('');
      return `<div class="row"><div class="lab" title="${esc(v.label)}">${esc(v.label)}</div>
        <div class="bar">${segs || '<em class="none">无异常</em>'}</div>
        <div class="meta">${v.samples || 0} 样本${v.fps ? ` · ${v.fps}fps` : ''}${v.dropped != null ? ` · 丢帧 ${v.dropped}` : ''}${v.maxStallMs ? ` · 最大断流 ${ms(v.maxStallMs)}` : ''}</div></div>`;
    })
    .join('');

  const qoeRows = videos
    .map((v) => {
      const q = v.qoe;
      const res = q && q.width ? `${q.width}×${q.height}` : '—';
      const pct = (x) => (x == null ? '—' : (x * 100).toFixed(2) + '%');
      return `<tr><td class="lb">${esc(v.label)}</td>
        <td>${q && q.ttffMs != null ? ms(q.ttffMs) : '—'}</td>
        <td>${q ? ms(q.playMs) : '—'}</td>
        <td>${q ? q.stallCount : '—'}</td>
        <td>${q ? ms(q.stallMs) : '—'}</td>
        <td>${q ? pct(q.stallRatio) : '—'}</td>
        <td>${v.fps ?? '—'}</td>
        <td>${v.dropped != null ? v.dropped : '—'}${v.dropRatio != null ? ` · ${pct(v.dropRatio)}` : ''}</td>
        <td>${res}${q && q.resChanges ? ` · ${q.resChanges} 次切换` : ''}</td>
        <td>${q && q.bufferedSec != null ? q.bufferedSec.toFixed(1) + 's' : '—'}</td></tr>`;
    })
    .join('');

  const rtcBox = d.rtc
    ? `<div class="rtc">WebRTC：${d.rtc.streams} 路 · 码率 ${d.rtc.bitrateKbps ?? '—'} kbps · RTT ${d.rtc.rttMs ?? '—'} ms ·
       抖动缓冲 ${d.rtc.jitterBufferMs ?? '—'} ms · 冻结 ${d.rtc.freezeCount} 次 / ${d.rtc.freezesSec}s ·
       丢帧 ${d.rtc.framesDropped} / ${d.rtc.framesDecoded} · 丢包 ${d.rtc.packetsLost}</div>`
    : '';

  const rows = d.episodes
    .map((e) => {
      const shot = e.shot ? `<a href="${esc(e.shot)}" target="_blank"><img src="${esc(e.shot)}" alt=""></a>` : '<span class="dim">—</span>';
      const areaTxt = e.area ? ` · 区域 ${(e.area.frac * 100).toFixed(0)}%（${blockPos(e.area.blocks)}）` : '';
      const detail = (e.color ? `RGB(${e.color.r},${e.color.g},${e.color.b}) sd=${e.color.sd}` : e.peak ? `断流 ${ms(e.peak)}` : e.text ? esc(String(e.text).slice(0, 60)) : '') + areaTxt;
      return `<tr><td>${(e.start / 1000).toFixed(2)}s</td><td><span class="tag" style="background:${COLOR[e.type] || '#888'}">${esc(e.typeCn)}</span></td>
        <td class="lb">${esc(e.label)}</td><td>${ms(e.dur)}</td><td class="dim">${detail}</td><td>${shot}</td></tr>`;
    })
    .join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>视频播放异常检测报告</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0f17;color:#e6edf3;font:14px/1.6 "Segoe UI",system-ui,"Microsoft YaHei",sans-serif;padding:28px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 10px;color:#9aa7b8;font-weight:600}
.sub{color:#8b97a8;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:14px}
.card{background:#141b26;border:1px solid #1f2a3a;border-radius:10px;padding:12px}
.card .k{font-size:12px}.card .v{font-size:24px;font-weight:700;margin-top:2px}.card .v span{font-size:12px;color:#8b97a8;font-weight:400}
.card .s{font-size:11px;color:#8b97a8}
.row{display:grid;grid-template-columns:190px 1fr 220px;gap:10px;align-items:center;margin-bottom:6px}
.lab{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{position:relative;height:20px;background:#141b26;border:1px solid #1f2a3a;border-radius:5px;overflow:hidden}
.bar i{position:absolute;top:0;bottom:0;opacity:.92;box-shadow:inset 0 0 0 1px #ffffff2e}
.bar em{position:absolute;left:8px;top:0;font-size:11px;color:#4b5563;font-style:normal;line-height:20px}
.meta{font-size:11px;color:#8b97a8;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #1b2432;vertical-align:middle}
th{color:#8b97a8;font-weight:500}
.tag{display:inline-block;padding:1px 8px;border-radius:20px;color:#08110c;font-size:11px;font-weight:600}
td img{height:54px;border-radius:4px;display:block;border:1px solid #2b3a4d;background:#000}
.lb{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dim{color:#6b7686}
.banner{margin-top:16px;padding:10px 14px;border-radius:8px;font-size:13px}
.rtc{margin:0 0 8px;padding:8px 12px;background:#0d1f2b;border:1px solid #1c3a4a;border-radius:8px;font-size:12px;color:#7dd3fc}
.ok{background:#0d2a1a;border:1px solid #1c5b39;color:#6ee7a8}
.bad{background:#2a1010;border:1px solid #5b1c1c;color:#fca5a5}
</style></head><body>
<h1>视频播放异常检测报告</h1>
<div class="sub">${esc(d.url || '')} · ${esc(d.startedAt || '')} → ${esc(d.endedAt || '')} · ${ms(d.durationMs || 0)} · ${d.samples} 个采样点</div>
<div class="banner ${d.ok ? 'ok' : 'bad'}">${d.ok ? '✅ 未发现异常' : `⚠️ 发现 ${d.episodes.length} 段异常，涉及 ${new Set(d.episodes.map((e) => e.v)).size} 个画面`}</div>
<div class="grid">${cards || '<div class="card"><div class="k">结果</div><div class="v">0<span> 项</span></div></div>'}</div>
<h2>时间轴</h2>${bars}
<h2>播放质量（QoE）</h2>${rtcBox}
<table><thead><tr><th>画面</th><th>首帧</th><th>有效播放</th><th>缓冲等待</th><th>等待总时长</th><th>缓冲占比</th><th>平均fps</th><th>丢帧</th><th>分辨率</th><th>缓冲余量</th></tr></thead>
<tbody>${qoeRows || '<tr><td colspan="10" class="dim">无视频画面</td></tr>'}</tbody></table>
<div class="sub">首帧＝监测开始到 currentTime&gt;0；缓冲等待＝waiting→playing 事件（区别于“卡顿（画面中断）”，后者由 OSD 心跳判定）；fps 由 rVFC 里 mediaTime 变化次数计算；丢帧取 getVideoPlaybackQuality。</div>
<h2>异常明细（按时间排序）</h2>
<table><thead><tr><th>开始</th><th>类型</th><th>画面</th><th>持续</th><th>细节</th><th>截图</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="dim">无</td></tr>'}</tbody></table>
<div class="sub" style="margin-top:22px">阈值：黑屏 luma&lt;${d.thr?.blackLuma} · 白屏 luma&gt;${d.thr?.whiteLuma} · 绿/蓝偏色&gt;${d.thr?.greenDelta}/${d.thr?.blueDelta} · 卡顿(OSD 心跳中断)&gt;${ms(d.thr?.stallMs || 0)} · 最短计入 ${ms(d.thr?.minDur || 0)}</div>
</body></html>`;
}

export function consoleSummary(d) {
  const lines = [];
  lines.push('');
  lines.push(`采样 ${d.samples} 点 / ${(d.durationMs / 1000).toFixed(1)}s，画面 ${d.videos.length} 个`);
  for (const v of d.videos) {
    const q = v.qoe || {};
    lines.push(
      `  ${v.label.padEnd(28).slice(0, 28)} 首帧=${q.ttffMs != null ? ms(q.ttffMs) : '-'} 播放=${q.playMs != null ? ms(q.playMs) : '-'} 缓冲等待=${q.stallCount ?? '-'}次/${q.stallMs != null ? ms(q.stallMs) : '-'}(${q.stallRatio != null ? (q.stallRatio * 100).toFixed(2) + '%' : '-'}) fps=${v.fps ?? '-'} 丢帧=${v.dropped ?? '-'}`
    );
  }
  if (d.rtc) lines.push(`  WebRTC: ${d.rtc.bitrateKbps ?? '-'}kbps RTT ${d.rtc.rttMs ?? '-'}ms 冻结 ${d.rtc.freezeCount}次/${d.rtc.freezesSec}s 丢帧 ${d.rtc.framesDropped}/${d.rtc.framesDecoded}`);
  if (!d.episodes.length) {
    lines.push('✅ 未发现白屏/黑屏/绿屏/卡顿（画面中断）/报错/loading');
    return lines.join('\n');
  }
  lines.push('异常明细：');
  for (const e of d.episodes) {
    lines.push(`  [${(e.start / 1000).toFixed(2)}s +${ms(e.dur)}] ${e.typeCn.padEnd(8)} ${e.label}${e.text ? ' · ' + String(e.text).slice(0, 50) : ''}`);
  }
  return lines.join('\n');
}

export const TYPE_COLOR = COLOR;
