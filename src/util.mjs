export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    o[k] = v;
  }
  return o;
}

export const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(2) + 's' : Math.round(n) + 'ms');
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const TYPE_CN = {
  black: '黑屏',
  white: '白屏',
  green: '绿屏',
  blue: '蓝屏',
  stall: '卡顿（画面中断）',
  loading: '转圈 Loading',
  error: '报错',
  novideo: '无画面',
};
