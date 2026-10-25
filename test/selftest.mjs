/**
 * 自测：起一个静态服务 + 故障注入页面，跑一遍 monitor，断言各类异常都被抓到。
 *   node test/selftest.mjs            # 完整 50s
 *   node test/selftest.mjs 30         # 自定义时长
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const DUR = Number(process.argv[2] || 50);
const PORT = 8781;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const p = path.join(HERE, decodeURIComponent(req.url.split('?')[0]));
  try {
    const buf = await fs.readFile(p);
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`[selftest] fixture http://127.0.0.1:${PORT}/fixture.html`);

const out = path.join(ROOT, 'out', 'selftest');
await fs.rm(out, { recursive: true, force: true });

const args = ['src/monitor.mjs', '--url', `http://127.0.0.1:${PORT}/fixture.html`, '--duration', String(DUR), '--out', out, '--headless=true', '--settle', '1', '--stall', '1500', '--osd', '4,4,104,16', '--min-dur', '400'];
const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env } });

const code = await new Promise((r) => child.on('exit', r));
server.close();
if (code !== 0) {
  console.error('[selftest] monitor 退出码', code);
  process.exit(1);
}

const report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
const seen = new Set(report.episodes.map((e) => e.type));
const want = DUR >= 30 ? ['green', 'stall', 'black'] : ['green', 'stall'];
if (DUR >= 40) want.push('white', 'loading', 'error');

console.log('\n[selftest] 检出类型:', [...seen].join(', ') || '(无)');
console.log('[selftest] 明细:');
for (const e of report.episodes) {
  console.log(`  ${(e.start / 1000).toFixed(2).padStart(6)}s +${(e.dur / 1000).toFixed(2)}s  ${e.type.padEnd(8)} ${e.label} ${e.shot ? '📷' : ''}`);
}

const missing = want.filter((t) => !seen.has(t));
if (missing.length) {
  console.error(`\n❌ 漏检: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`\n✅ 全部命中 (${want.join(', ')}) — 报告 ${path.join(out, 'report.html')}`);
