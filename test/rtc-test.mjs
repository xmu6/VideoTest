/**
 * WebRTC 播放自测：本地环回（canvas → RTCPeerConnection → video），验证 getStats 采集。
 *   node test/rtc-test.mjs [秒数]
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const PORT = 8784;
const DUR = Number(process.argv[2] || 20);

const server = http.createServer(async (req, res) => {
  try {
    const p = path.join(HERE, req.url.split('?')[0] === '/' ? 'webrtc.html' : decodeURIComponent(req.url.split('?')[0]));
    const buf = await fs.readFile(p);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const out = path.join(ROOT, 'out', 'rtc');
await fs.rm(out, { recursive: true, force: true });
const url = `http://127.0.0.1:${PORT}/webrtc.html`;
console.log(`[rtc-test] ${url}`);

const child = spawn(
  process.execPath,
  ['src/monitor.mjs', '--url', url, '--duration', String(DUR), '--out', out, '--headless=true', '--settle', '1', '--fps', '4'],
  { cwd: ROOT, stdio: 'inherit' }
);
const code = await new Promise((r) => child.on('exit', r));
server.close();
if (code !== 0) process.exit(1);

const rep = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
const v = rep.videos[0];
console.log('\n[rtc-test] QoE:', JSON.stringify(v?.qoe));
console.log('[rtc-test] RTC:', JSON.stringify(rep.rtc));

const ok = rep.rtc && rep.rtc.framesDecoded > 50 && v && v.qoe && v.qoe.playMs > DUR * 500;
if (!ok) {
  console.error('❌ WebRTC 指标缺失或播放不足');
  process.exit(1);
}
console.log('✅ WebRTC：解码 %d 帧 / 丢帧 %d / %s kbps / RTT %s ms', rep.rtc.framesDecoded, rep.rtc.framesDropped, rep.rtc.bitrateKbps, rep.rtc.rttMs);
