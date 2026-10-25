/**
 * CDP 接管模式自测：起 Chrome（--remote-debugging-port）→ monitor --attach。
 *   node test/attach-test.mjs
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const PORT = 8782;
const CDP = 9333;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = http.createServer(async (req, res) => {
  try {
    const p = path.join(HERE, decodeURIComponent(req.url.split('?')[0]));
    const buf = await fs.readFile(p);
    res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('404');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = path.join(ROOT, 'out', '.cdp-profile');
await fs.mkdir(profile, { recursive: true });
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore', detached: false }
);

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
    if (r.ok) {
      up = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
}
if (!up) {
  console.error('❌ Chrome 调试端口没起来');
  chrome.kill();
  server.close();
  process.exit(1);
}
console.log(`[attach-test] Chrome CDP 就绪 :${CDP}`);

const out = path.join(ROOT, 'out', 'attach');
await fs.rm(out, { recursive: true, force: true });
const child = spawn(
  process.execPath,
  ['src/monitor.mjs', '--attach', `http://127.0.0.1:${CDP}`, '--url', `http://127.0.0.1:${PORT}/fixture.html`, '--duration', '20', '--out', out, '--settle', '1', '--stall', '1500', '--osd', '4,4,104,16'],
  { cwd: ROOT, stdio: 'inherit' }
);
const code = await new Promise((r) => child.on('exit', r));
chrome.kill();
server.close();
if (code !== 0) process.exit(1);

const rep = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
const seen = new Set(rep.episodes.map((e) => e.type));
console.log('[attach-test] 检出:', [...seen].join(', '));
if (!seen.has('green') || !seen.has('stall')) {
  console.error('❌ CDP 模式漏检');
  process.exit(1);
}
console.log('✅ CDP 接管模式正常');
