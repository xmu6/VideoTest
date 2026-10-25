/**
 * 真实 HLS 播放自测（本地切片，确定性）。
 *   node test/hls-test.mjs [秒数] [--remote]   # --remote 用 mux 公网流（需代理，网络会抖）
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const PORT = 8783;
const DUR = Number(process.argv[2] || 30);
const REMOTE = process.argv.includes('--remote');
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7897';
const MUX = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.js': 'text/javascript',
  '.html': 'text/html; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  try {
    let file;
    if (url === '/hls.js') file = path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js');
    else if (url.startsWith('/hls/')) file = path.join(HERE, 'media', url.slice(1));
    else file = path.join(HERE, url === '/' ? 'hls.html' : url);
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const out = path.join(ROOT, 'out', 'hls');
await fs.rm(out, { recursive: true, force: true });
const src = REMOTE ? MUX : `http://127.0.0.1:${PORT}/hls/index.m3u8`;
const url = `http://127.0.0.1:${PORT}/hls.html?src=${encodeURIComponent(src)}`;
console.log(`[hls-test] ${url}`);

const args = ['src/monitor.mjs', '--url', url, '--duration', String(DUR), '--out', out, '--headless=true', '--settle', '1', '--fps', '4'];
if (REMOTE) args.push('--proxy', PROXY);
const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
const code = await new Promise((r) => child.on('exit', r));
server.close();
if (code !== 0) process.exit(1);

const rep = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
const v = rep.videos[0];
console.log('\n[hls-test] QoE:', JSON.stringify(v?.qoe));
console.log('[hls-test] fps/dropped:', v?.fps, v?.dropped);
console.log('[hls-test] 异常:', rep.episodes.map((e) => e.type).join(', ') || '(无)');

const min = REMOTE ? DUR * 300 : DUR * 700;
const ok = v && v.qoe && v.qoe.ttffMs != null && v.qoe.ttffMs < 8000 && v.qoe.playMs > min && v.fps > 20;
if (!ok) {
  console.error('❌ HLS 播放指标不合格', { ttff: v?.qoe?.ttffMs, playMs: v?.qoe?.playMs, fps: v?.fps, min });
  process.exit(1);
}
console.log('✅ HLS：首帧 %d ms，有效播放 %d ms，fps %s，卡顿 %d 次/%d ms', v.qoe.ttffMs, v.qoe.playMs, v.fps, v.qoe.stallCount, v.qoe.stallMs);
