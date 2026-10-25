#!/usr/bin/env node
/**
 * 视频播放异常检测 CLI
 *
 *   node src/monitor.mjs --url http://host/page --duration 120 --out out/run1
 *   node src/monitor.mjs --attach http://127.0.0.1:9222 --duration 120
 *   node src/monitor.mjs --url https://unifi.local/protect/timelapse --profile ./.chrome-profile --headless
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, num, sleep, ms } from './util.mjs';
import { Analyzer } from './classify.mjs';
import { buildReport, consoleSummary } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (!args.url && !args.attach) {
  console.log(`用法: node src/monitor.mjs --url <页面地址> [--duration 120] [--out out/run1]
       node src/monitor.mjs --attach http://127.0.0.1:9222 [--duration 120]
       node src/monitor.mjs --url <地址> --profile ./.chrome-profile   # 复用登录态
参数: --headless --fps 4 --stall 1500 --osd "x,y,w,h" --min-dur 600 --black 18 --white 232 --green 45 --open
      卡顿判据 = OSD 秒位心跳中断 ≥ --stall 毫秒（只看画面表现）`);
  process.exit(2);
}

const cfg = {
  fps: num(args.fps, 4),
  osd: args.osd || '',
  osdCalMs: num(args['osd-cal'], 4000),
  videoSel: args.sel || 'video',
};
const thr = {
  blackLuma: num(args.black, 18),
  whiteLuma: num(args.white, 232),
  greenDelta: num(args.green, 45),
  blueDelta: num(args.blue, 55),
  stallMs: num(args.stall, 1500),
  minDur: num(args['min-dur'], 600),
  graceMs: num(args.grace, 900),
};
const duration = num(args.duration, 60) * 1000;
const outDir = path.resolve(args.out || `out/run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const shotsDir = path.join(outDir, 'shots');
fsSync.mkdirSync(shotsDir, { recursive: true });
const logFile = fsSync.createWriteStream(path.join(outDir, 'samples.jsonl'), { flags: 'a' });

const CHROME =
  args.chrome ||
  process.env.CHROME_PATH ||
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fsSync.existsSync(p));

const HEADERS = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', '--disable-features=CalculateNativeWinOcclusion'];

const analyzer = new Analyzer(thr);
analyzer.startedAt = new Date().toISOString();
const frameIds = new Map();
const frameList = [];
const fid = (f) => {
  if (!frameIds.has(f)) {
    frameIds.set(f, frameIds.size);
    frameList[frameIds.get(f)] = f;
  }
  return frameIds.get(f);
};
let browser = null;
let context = null;
let page = null;
let stopped = false;

async function open() {
  if (args.attach) {
    browser = await chromium.connectOverCDP(args.attach);
    context = browser.contexts()[0] || (await browser.newContext());
    page = context.pages().find((p) => p.url().includes(args.match || '\u0000')) || context.pages()[0] || (await context.newPage());
    console.error(`[vt] 已接管 CDP ${args.attach}，当前页 ${page.url()}`);
  } else {
    const profile = path.resolve(args.profile || path.join('.chrome-profile'));
    context = await chromium.launchPersistentContext(profile, {
      headless: !!args.headless && args.headless !== 'false',
      executablePath: CHROME,
      viewport: { width: num(args.width, 1600), height: num(args.height, 900) },
      args: [...HEADERS, ...(args.proxy ? [`--proxy-server=${args.proxy}`] : [])],
      ignoreHTTPSErrors: true,
    });
    page = context.pages()[0] || (await context.newPage());
  }

  page.setDefaultTimeout(30000);
  const agent = `window.__VT_CFG=${JSON.stringify(cfg)};\n` + (await fs.readFile(path.join(HERE, 'agent.js'), 'utf8'));
  await context.addInitScript({ content: agent });
  // attach 模式下页面已加载，补注入一次
  try {
    await page.evaluate(agent);
  } catch (_) {}

  if (args.url) {
    await page.goto(args.url, { waitUntil: 'domcontentloaded' }).catch((e) => console.error('[vt] goto 失败:', e.message));
  }
  await sleep(num(args.settle, 2) * 1000);
}

async function drain() {
  const frames = page.frames();
  for (const f of frames) {
    let data = null;
    try {
      data = await f.evaluate(() => (window.__VT ? window.__VT.drain() : null));
    } catch (_) {
      continue;
    }
    if (!data) continue;
    const id = fid(f);
    analyzer.ingest(data, id);
    for (const s of data.samples || []) logFile.write(JSON.stringify({ f: id, ...s }) + '\n');
  }
  // 画面清单（通道名/尺寸/可见性）
  for (const f of page.frames()) {
    try {
      const list = await f.evaluate(() => (window.__VT ? window.__VT.videos() : null));
      if (list) analyzer.setVideos(list, fid(f));
    } catch (_) {}
  }
}

const TYPE_SLUG = { black: 'black', white: 'white', green: 'green', blue: 'blue', stall: 'stall', loading: 'loading', error: 'error', novideo: 'novideo' };

async function shootPending() {
  for (const ep of analyzer.pendingShots.slice(0, 4)) {
    let file = null;
    try {
      const f = frameList[ep.frame] || page.mainFrame();
      let rect = null;
      if (ep.vid) rect = await f.evaluate((id) => window.__VT && window.__VT.rect(id), ep.vid).catch(() => null);
      const name = `${String(ep.id).padStart(3, '0')}-${TYPE_SLUG[ep.type] || ep.type}.png`;
      const abs = path.join(shotsDir, name);
      if (rect && rect.w > 40 && rect.h > 40) {
        const vp = page.viewportSize() || { width: 1600, height: 900 };
        const x = Math.max(0, Math.min(rect.x, vp.width - 10));
        const y = Math.max(0, Math.min(rect.y, vp.height - 10));
        const w = Math.max(10, Math.min(rect.w, vp.width - x));
        const h = Math.max(10, Math.min(rect.h, vp.height - y));
        await page.screenshot({ path: abs, clip: { x, y, width: w, height: h } });
      } else {
        await page.screenshot({ path: abs });
      }
      file = `shots/${name}`;
    } catch (e) {
      console.error('[vt] 截图失败:', e.message);
    }
    analyzer.attachedShot(ep.id, file);
  }
}

async function main() {
  await open();
  const t0 = Date.now();
  let lastTick = 0;
  let lastSnap = 0;
  const snapEvery = num(args['snap-every'], 0) * 1000;
  const tick = setInterval(async () => {
    if (stopped) return;
    try {
      await drain();
      await shootPending();
      if (snapEvery && Date.now() - lastSnap >= snapEvery) {
        lastSnap = Date.now();
        const sec = Math.round((Date.now() - t0) / 1000);
        await page.screenshot({ path: path.join(shotsDir, `t${String(sec).padStart(4, '0')}.png`) }).catch(() => {});
      }
    } catch (e) {
      console.error('[vt] 采样异常:', e.message);
    }
    const el = Date.now() - t0;
    if (el - lastTick > 10000) {
      lastTick = el;
      process.stderr.write(`\r[vt] ${(el / 1000).toFixed(0)}s/${(duration / 1000).toFixed(0)}s  已捕获 ${analyzer.episodes.filter((e) => e.valid).length} 段异常   `);
    }
  }, 750);

  await sleep(duration);
  stopped = true;
  clearInterval(tick);
  await sleep(800);

  const summary = analyzer.summary();
  summary.url = page.url();
  summary.durationMs = Date.now() - t0;
  summary.thr = thr;
  summary.config = { cfg, mode: args.attach ? 'cdp' : 'launch', profile: args.profile || '.chrome-profile' };
  fsSync.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(summary, null, 2));
  fsSync.writeFileSync(path.join(outDir, 'report.html'), buildReport(summary));
  logFile.end();
  console.log(consoleSummary(summary));
  console.log(`\n报告: ${path.join(outDir, 'report.html')}`);

  if (args.open === 'true') {
    const { spawn } = await import('node:child_process');
    spawn('cmd', ['/c', 'start', '', path.join(outDir, 'report.html')], { detached: true, stdio: 'ignore' }).unref();
  }
  // attach 模式只断开、不关闭用户的 Chrome
  if ((!args['keep-open'] || args['keep-open'] === 'false') && !args.attach) await context.close().catch(() => {});
  process.exit(args['fail-on-anomaly'] === 'true' && summary.episodes.length ? 1 : 0);
}

process.on('SIGINT', async () => {
  stopped = true;
  console.error('\n[vt] 中断，输出部分结果…');
  process.exit(130);
});

main().catch((e) => {
  console.error('[vt] 失败:', e);
  process.exit(1);
});
