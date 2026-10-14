/* 端到端测试公共脚手架：启动 Chrome + 连接 CDP + 断言输出
   无第三方依赖，使用 Node 内置 fetch / WebSocket（Node >= 22） */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) { lastErr = e; }
    await sleep(250);
  }
  throw new Error('DevTools 端口没起来：' + (lastErr ? lastErr.message : '超时'));
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.pageErrors.push(d.exception?.description || d.text);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.pageErrors.push('[log] ' + msg.params.entry.text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面内报错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', {});
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  /** 把本地文件塞进 <input type=file>，模拟用户选文件 */
  async setFileInput(selector, files) {
    await this.send('DOM.enable');
    const doc = await this.send('DOM.getDocument', { depth: -1 });
    const node = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    await this.send('DOM.setFileInputFiles', { files, nodeId: node.nodeId });
  }
}

/**
 * 启动一个 headless Chrome 并连上第一个页面。
 * opts: { port, width, height, shotsDir, extraArgs }
 */
async function launch(opts = {}) {
  const port = opts.port || 9333;
  const width = opts.width || 390;
  const height = opts.height || 844;
  const shotsDir = opts.shotsDir || path.join(__dirname, '..', '.shots');
  const profile = path.join(os.tmpdir(), 'kitty-e2e-' + Date.now() + '-' + Math.floor(Math.random() * 1000));

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    ...(opts.extraArgs || []),
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  await waitForDevtools(port, 25000);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到页面目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: true
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  return {
    cdp, chrome, profile, shotsDir,
    async close() {
      try { ws.close(); } catch (e) { /* 忽略 */ }
      chrome.kill('SIGKILL');
      await sleep(500);
      if (process.env.KITTY_E2E_CLEAN === '1') {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
      }
    }
  };
}

/** 简易断言收集器 */
function createReporter() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null && detail !== '' ? '  -> ' + detail : ''}`);
  };
  const report = () => {
    const failed = results.filter((r) => !r.ok);
    console.log('\n============================================');
    console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length) {
      console.log('失败项：');
      failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  (' + f.detail + ')' : '')));
    }
    return failed.length;
  };
  return { results, check, report };
}

module.exports = { launch, CDP, sleep, createReporter, CHROME };
