/* 通过 Chrome DevTools Protocol 在真实浏览器里跑端到端测试。
   用法： node tools/e2e.js [baseUrl]
   依赖：无（使用 Node 内置 fetch + WebSocket，Node >= 22） */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8899/index.html';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const SHOT_DIR = path.join(__dirname, '..', '.shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('DevTools 端口没起来');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面内报错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null && detail !== '' ? '  -> ' + detail : ''}`);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const profile = path.join(os.tmpdir(), 'kitty-e2e-' + Date.now());

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=390,844',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    await waitForDevtools(20000);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('没有找到页面目标');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new CDP(ws);

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Console.enable');

    // 收集页面错误
    const pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        pageErrors.push('[log] ' + m.params.entry.text);
      }
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    // ---------- 打开页面 ----------
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2500);

    const booted = await cdp.eval(`(() => {
      return {
        ready: !!(window.DB),
        mode: window.DB ? window.DB.mode : null,
        title: document.title,
        hasFab: !!document.getElementById('fab'),
        emptyShown: !document.getElementById('p-state').hidden,
        emptyText: document.getElementById('p-state').textContent.trim().slice(0, 40)
      };
    })()`);
    check('页面加载且 DB 可用', booted.ready, 'storage=' + booted.mode);
    check('空状态正确显示', booted.emptyShown && booted.emptyText.includes('还没有商品'), booted.emptyText);

    // ---------- 新增商品（可单卖）----------
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(500);
    const formOpen = await cdp.eval(`!document.getElementById('sheet-form').hidden`);
    check('新增表单可以打开', formOpen);

    await cdp.eval(`(() => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('f-name', '粉色碎花连衣裙');
      set('f-code', 'A1023');
      set('f-price', '199');
      set('f-note', '只有 M 码了');
      document.querySelector('#f-mode .seg__item[data-mode="single"]').click();
      // 单卖项：填第一条
      const rows = document.querySelectorAll('#f-single-list .single-row');
      const r0 = rows[0];
      const n0 = r0.querySelector('[data-single="name"]');
      const p0 = r0.querySelector('[data-single="price"]');
      n0.value = '上衣'; n0.dispatchEvent(new Event('input', { bubbles: true }));
      p0.value = '89'; p0.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#f-tag-chips .chip[data-tag="夏款"]').click();
      return 'ok';
    })()`);
    await sleep(200);
    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'form.png'), Buffer.from(r.data, 'base64'));
    });
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1200);

    let s = await cdp.eval(`(() => {
      const c = document.querySelector('#p-list .card');
      return {
        count: document.querySelectorAll('#p-list .card').length,
        total: document.getElementById('stat-total').textContent,
        single: document.getElementById('stat-single').textContent,
        text: c ? c.textContent.replace(/\\s+/g, ' ').trim() : '',
        sheetHidden: document.getElementById('sheet-form').hidden
      };
    })()`);
    check('新增商品成功', s.count === 1 && s.total === '1', JSON.stringify({ count: s.count, total: s.total }));
    check('表单保存后自动关闭', s.sheetHidden);
    check('卡片显示售价 ¥199', s.text.includes('¥199'), s.text);
    check('卡片显示单卖 ¥89', s.text.includes('单卖 ¥89'));
    check('卡片显示可单卖徽章', s.text.includes('可单卖'));

    // ---------- 新增第二件：不可单卖 ----------
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(450);
    await cdp.eval(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('f-name', '奶白针织开衫');
      set('f-code', 'B2088');
      set('f-price', '159');
      document.querySelector('#f-mode .seg__item[data-mode="no"]').click();
      return 'ok';
    })()`);
    await sleep(200);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1000);
    s = await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('#p-list .card')];
      const c = cards.find(x => x.textContent.includes('奶白'));
      return { count: cards.length, text: c ? c.textContent.replace(/\\s+/g,' ').trim() : '' };
    })()`);
    check('新增第二件商品', s.count === 2, 'count=' + s.count);
    check('不可单卖卡片不显示单卖价', !s.text.includes('单卖 ¥') && s.text.includes('不可单卖'), s.text);

    // ---------- 可单卖但没填单卖项 -> 二次确认 ----------
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(450);
    await cdp.eval(`(() => {
      const el = document.getElementById('f-name'); el.value = '待定单卖价测试'; el.dispatchEvent(new Event('input', {bubbles:true}));
      const p = document.getElementById('f-price'); p.value = '99'; p.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#f-mode .seg__item[data-mode="single"]').click();
      // 故意把默认那条单卖项的价格留空
      return 'ok';
    })()`);
    await sleep(150);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(500);
    const warnShown = await cdp.eval(`!document.getElementById('dialog').hidden && document.getElementById('dialog-title').textContent`);
    check('可单卖未填单卖项会提示', warnShown && warnShown.includes('单卖项'), warnShown);
    await cdp.eval(`document.querySelector('#dialog .dialog__actions .btn--primary').click(); 'ok'`);
    await sleep(900);
    s = await cdp.eval(`(() => {
      const cards=[...document.querySelectorAll('#p-list .card')];
      const c=cards.find(x=>x.textContent.includes('待定单卖价'));
      return { count: cards.length, text: c ? c.textContent.replace(/\\s+/g,' ').trim() : '' };
    })()`);
    check('确认后仍可保存', s.count === 3, 'count=' + s.count);
    check('无单卖价时显示「单卖价待补」', s.text.includes('单卖价待补'), s.text);

    // ---------- 详情页 ----------
    await cdp.eval(`(() => {
      const c = [...document.querySelectorAll('#p-list .card')].find(x => x.textContent.includes('粉色碎花'));
      c.click(); return 'ok';
    })()`);
    await sleep(600);
    const detail = await cdp.eval(`(() => {
      const b = document.getElementById('d-body');
      return {
        open: !document.getElementById('sheet-detail').hidden,
        text: b.textContent.replace(/\\s+/g,' ').trim(),
        hasHero: !!document.getElementById('d-hero')
      };
    })()`);
    check('详情页可打开', detail.open);
    check('详情区分售价与单卖', detail.text.includes('售价（整套 / 默认）') && detail.text.includes('单卖'), detail.text.slice(0, 80));
    check('详情显示 ¥199 与 ¥89', detail.text.includes('¥199') && detail.text.includes('¥89'));
    check('详情显示单卖项名称', detail.text.includes('上衣'), detail.text.slice(0, 120));
    check('详情显示标签与备注', detail.text.includes('#夏款') && detail.text.includes('只有 M 码了'));

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'detail.png'), Buffer.from(r.data, 'base64'));
    });

    // ---------- 编辑 ----------
    await cdp.eval(`document.getElementById('d-edit').click(); 'ok'`);
    await sleep(700);
    const editState = await cdp.eval(`(() => ({
      open: !document.getElementById('sheet-form').hidden,
      title: document.getElementById('form-title').textContent,
      name: document.getElementById('f-name').value,
      price: document.getElementById('f-price').value,
      singleNames: [...document.querySelectorAll('#f-single-list [data-single="name"]')].map(x=>x.value),
      singlePrices: [...document.querySelectorAll('#f-single-list [data-single="price"]')].map(x=>x.value),
      mode: (document.querySelector('#f-mode .seg__item.is-active')||{}).dataset ? document.querySelector('#f-mode .seg__item.is-active').dataset.mode : null,
      tags: [...document.querySelectorAll('#f-tag-chips .chip.is-active')].map(x=>x.dataset.tag)
    }))()`);
    check('编辑会回填表单', editState.open && editState.title === '编辑商品' && editState.name === '粉色碎花连衣裙',
      JSON.stringify(editState));
    check('编辑回填价格与状态', editState.price === '199' && editState.mode === 'single');
    check('编辑回填单卖项名称与价格',
      editState.singleNames.join(',') === '上衣' && editState.singlePrices.join(',') === '89',
      JSON.stringify({ n: editState.singleNames, p: editState.singlePrices }));
    check('编辑回填标签', editState.tags.join(',') === '夏款');

    // ---------- 多单卖项：新增两条，验证列表显示最低价 ----------
    await cdp.eval(`(() => {
      document.getElementById('f-single-add').click();
      return 'ok';
    })()`);
    await sleep(400);
    const afterAdd = await cdp.eval(`document.querySelectorAll('#f-single-list .single-row').length`);
    check('可以添加第二条单卖项', afterAdd === 2, '共 ' + afterAdd + ' 行');

    await cdp.eval(`(() => {
      const rows = document.querySelectorAll('#f-single-list .single-row');
      const r = rows[1];
      const n = r.querySelector('[data-single="name"]');
      const p = r.querySelector('[data-single="price"]');
      n.value = '裤子'; n.dispatchEvent(new Event('input', {bubbles:true}));
      p.value = '59'; p.dispatchEvent(new Event('input', {bubbles:true}));
      return 'ok';
    })()`);
    await sleep(300);
    // 同一次保存里顺手改售价，避免重复提交
    await cdp.eval(`(() => {
      const el = document.getElementById('f-price'); el.value = '188'; el.dispatchEvent(new Event('input',{bubbles:true}));
      return 'ok';
    })()`);
    await sleep(200);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1300);
    s = await cdp.eval(`(() => {
      const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('粉色碎花'));
      return c.textContent.replace(/\\s+/g,' ').trim();
    })()`);
    check('多条单卖时列表显示最低价', s.includes('单卖 ¥59 起') && s.includes('2 项可单卖'), s);
    check('编辑后价格已更新', s.includes('¥188') && !s.includes('¥199'), s);

    // ---------- 搜索 ----------
    await cdp.eval(`document.querySelector('.tab[data-view="search"]').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`(() => { const el=document.getElementById('s-input'); el.value='A1023'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
    await sleep(500);
    let q = await cdp.eval(`document.querySelectorAll('#s-list .card').length`);
    check('按货号搜索', q === 1, '命中 ' + q);

    await cdp.eval(`(() => { const el=document.getElementById('s-input'); el.value='夏款'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
    await sleep(500);
    q = await cdp.eval(`document.querySelectorAll('#s-list .card').length`);
    check('按标签搜索', q === 1, '命中 ' + q);

    await cdp.eval(`(() => { const el=document.getElementById('s-input'); el.value='开衫'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
    await sleep(500);
    q = await cdp.eval(`document.querySelectorAll('#s-list .card').length`);
    check('按商品名搜索', q === 1, '命中 ' + q);

    await cdp.eval(`(() => { const el=document.getElementById('s-input'); el.value='不存在的货号XYZ'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
    await sleep(500);
    q = await cdp.eval(`(() => ({ n: document.querySelectorAll('#s-list .card').length, empty: !document.getElementById('s-state').hidden }))()`);
    check('无结果时显示空状态', q.n === 0 && q.empty, JSON.stringify(q));

    // 标签筛选 chip
    await cdp.eval(`document.getElementById('s-clear').click(); 'ok'`);
    await sleep(400);
    await cdp.eval(`(() => { const c=document.querySelector('#s-tags .chip[data-tag="夏款"]'); if(c) c.click(); return 'ok'; })()`);
    await sleep(450);
    q = await cdp.eval(`document.querySelectorAll('#s-list .card').length`);
    check('按标签 chip 筛选', q === 1, '命中 ' + q);

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'search.png'), Buffer.from(r.data, 'base64'));
    });
    await cdp.eval(`document.getElementById('s-reset').click(); 'ok'`);
    await sleep(300);

    // ---------- 列表筛选 + 排序 ----------
    await cdp.eval(`document.querySelector('.tab[data-view="products"]').click(); 'ok'`);
    await sleep(400);
    await cdp.eval(`document.querySelector('#p-chips .chip[data-filter="single"]').click(); 'ok'`);
    await sleep(400);
    let f = await cdp.eval(`document.querySelectorAll('#p-list .card').length`);
    check('筛选「可单卖」', f === 2, '命中 ' + f);

    await cdp.eval(`document.querySelector('#p-chips .chip[data-filter="no"]').click(); 'ok'`);
    await sleep(400);
    f = await cdp.eval(`document.querySelectorAll('#p-list .card').length`);
    check('筛选「不可单卖」', f === 1, '命中 ' + f);

    await cdp.eval(`document.querySelector('#p-chips .chip[data-filter="all"]').click(); 'ok'`);
    await sleep(300);

    await cdp.eval(`(() => { const el=document.getElementById('p-sort'); el.value='price-desc'; el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
    await sleep(400);
    let order = await cdp.eval(`[...document.querySelectorAll('#p-list .card')].map(c => (c.textContent.match(/¥(\\d+)/)||[])[1])`);
    check('价格从高到低排序', order.join(',') === '188,159,99', order.join(','));

    await cdp.eval(`(() => { const el=document.getElementById('p-sort'); el.value='price-asc'; el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
    await sleep(400);
    order = await cdp.eval(`[...document.querySelectorAll('#p-list .card')].map(c => (c.textContent.match(/¥(\\d+)/)||[])[1])`);
    check('价格从低到高排序', order.join(',') === '99,159,188', order.join(','));

    await cdp.eval(`(() => { const el=document.getElementById('p-sort'); el.value='new'; el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
    await sleep(300);

    // ---------- 商品页 标签筛选 ----------
    const pFilterChips = await cdp.eval(`(() => ({
      tags: [...document.querySelectorAll('#p-tags .chip')].map(c=>c.dataset.tag),
      tagBlockShown: !document.getElementById('p-tag-block').hidden,
      sizeBlockShown: true
    }))()`);
    check('商品页显示标签筛选项', pFilterChips.tagBlockShown && pFilterChips.tags.includes('夏款'), JSON.stringify(pFilterChips.tags));

    await cdp.eval(`(() => { const c=document.querySelector('#p-tags .chip[data-tag="夏款"]'); c.click(); return 'ok'; })()`);
    await sleep(400);
    f = await cdp.eval(`document.querySelectorAll('#p-list .card').length`);
    check('商品页按标签筛选', f === 1, '命中 ' + f);

    await cdp.eval(`(() => { const c=document.querySelector('#p-tags .chip[data-tag=""]'); c.click(); return 'ok'; })()`);
    await sleep(300);
    f = await cdp.eval(`document.querySelectorAll('#p-list .card').length`);
    check('清除筛选后恢复全部', f === 3, 'count=' + f);

    // ---------- 图片上传（合成一张图）----------
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(500);
    const imgOk = await cdp.eval(`(async () => {
      // 造一张 1200x900 的测试图，模拟大图上传
      const c = document.createElement('canvas');
      c.width = 1200; c.height = 900;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0,0,1200,900);
      g.addColorStop(0,'#ffd9ec'); g.addColorStop(1,'#ff7fb5');
      ctx.fillStyle = g; ctx.fillRect(0,0,1200,900);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 120px sans-serif'; ctx.fillText('TEST', 380, 500);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const file = new File([blob], 'test.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('f-photo-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { srcSize: blob.size };
    })()`);
    await sleep(2000);
    const imgState = await cdp.eval(`(() => {
      const img = document.getElementById('f-photo-img');
      return { shown: !img.hidden, src: (img.getAttribute('src')||'').slice(0,5), natural: img.naturalWidth + 'x' + img.naturalHeight };
    })()`);
    check('选择图片后显示预览', imgState.shown && imgState.src === 'blob:', JSON.stringify(imgState));
    check('图片被压缩到 800px 以内', parseInt(imgState.natural, 10) <= 800, '压缩后 ' + imgState.natural + '（原始 1200x900）');

    await cdp.eval(`(() => {
      const el=document.getElementById('f-name'); el.value='带图片的测试商品'; el.dispatchEvent(new Event('input',{bubbles:true}));
      const p=document.getElementById('f-price'); p.value='258'; p.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#f-mode .seg__item[data-mode="ask"]').click();
      return 'ok';
    })()`);
    await sleep(200);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1600);

    const thumbState = await cdp.eval(`(async () => {
      const cards=[...document.querySelectorAll('#p-list .card')];
      const card=cards.find(c=>c.textContent.includes('带图片的测试商品'));
      if(!card) return { found:false };
      await new Promise(r=>setTimeout(r,900));
      const img = card.querySelector('.card__thumb img');
      return { found:true, hasImg: !!img, src: img ? img.src.slice(0,5) : null, w: img ? img.naturalWidth : 0 };
    })()`);
    check('列表卡片显示缩略图', thumbState.found && thumbState.hasImg, JSON.stringify(thumbState));
    check('缩略图已生成（≤240px）', thumbState.w > 0 && thumbState.w <= 240, 'w=' + thumbState.w);

    // ---------- 详情页大图 ----------
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('带图片')); c.click(); return 'ok'; })()`);
    await sleep(1200);
    const heroImg = await cdp.eval(`(() => { const i=document.getElementById('d-hero-img'); return { has: !!i, w: i ? i.naturalWidth : 0 }; })()`);
    check('详情页显示大图', heroImg.has && heroImg.w > 0, 'w=' + heroImg.w);

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'detail-image.png'), Buffer.from(r.data, 'base64'));
    });

    // ---------- 导出备份 ----------
    await cdp.eval(`document.querySelector('#sheet-detail [data-close]').click(); 'ok'`);
    await sleep(400);
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(600);
    const settingsInfo = await cdp.eval(`(() => ({
      count: document.getElementById('set-count').textContent,
      imgcount: document.getElementById('set-imgcount').textContent,
      usage: document.getElementById('set-usage').textContent,
      mode: document.getElementById('set-mode').textContent,
      meter: document.getElementById('set-meter').style.width
    }))()`);
    check('设置页显示数量', settingsInfo.count === '4 件', settingsInfo.count);
    check('设置页显示图片数与占用空间', /张/.test(settingsInfo.imgcount) && /KB|MB|B/.test(settingsInfo.usage),
      settingsInfo.imgcount + ' / ' + settingsInfo.usage);

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'settings.png'), Buffer.from(r.data, 'base64'));
    });

    // ---------- 真实导出下载 ----------
    // 每次跑测试用一个全新的子目录，避免删除任何已有文件
    const dlDir = path.join(__dirname, '..', '.downloads', 'run-' + Date.now());
    fs.mkdirSync(dlDir, { recursive: true });
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
    } catch (e) {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    }

    await cdp.eval(`document.getElementById('set-export').click(); 'ok'`);
    await sleep(600);
    const exportDialog = await cdp.eval(`(() => ({
      open: !document.getElementById('dialog').hidden,
      title: document.getElementById('dialog-title').textContent,
      buttons: [...document.querySelectorAll('#dialog .dialog__actions .btn')].map(b=>b.textContent)
    }))()`);
    check('导出前可选择是否含图片', exportDialog.open && exportDialog.buttons.includes('含图片'), JSON.stringify(exportDialog.buttons));

    await cdp.eval(`(() => {
      const btns=[...document.querySelectorAll('#dialog .dialog__actions .btn')];
      btns.find(b=>b.textContent==='含图片').click(); return 'ok';
    })()`);

    let dlFile = null;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const files = fs.readdirSync(dlDir).filter((f) => f.endsWith('.json'));
      if (files.length) { dlFile = path.join(dlDir, files[0]); break; }
    }
    check('点击导出后真的下载了 JSON 文件', !!dlFile, dlFile ? path.basename(dlFile) : '没有下载到文件');

    let backup = null;
    if (dlFile) {
      backup = JSON.parse(fs.readFileSync(dlFile, 'utf8'));
      check('备份文件包含全部商品', backup.products && backup.products.length === 4, '商品 ' + (backup.products || []).length + ' 件');
      check('备份文件包含图片数据', backup.images && Object.keys(backup.images).length === 1,
        '图片 ' + Object.keys(backup.images || {}).length + ' 张');
      const sample = backup.images[Object.keys(backup.images)[0]] || '';
      check('图片以 dataURL 形式保存', sample.startsWith('data:image/'), sample.slice(0, 22));
      const names = backup.products.map((p) => p.name);
      check('备份含中文商品名', names.includes('粉色碎花连衣裙'), names.join(' / '));
      check('备份记录了导出时间与版本', !!backup.exportedAt && !!backup.schema, backup.exportedAt);
    }

    const backupTip = await cdp.eval(`document.getElementById('backup-tip-text').textContent`);
    check('导出后备份提醒更新', backupTip.includes('上次备份'), backupTip);

    // ---------- 清空后从备份恢复 ----------
    await cdp.eval(`(async () => { await window.DB.clearAll(); return 'ok'; })()`);
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2500);
    let cur = await cdp.eval(`document.getElementById('stat-total').textContent`);
    check('清空后确实没有数据了', cur === '0', '剩余 ' + cur + ' 件');

    // 用 CDP 把备份文件塞进 file input，模拟用户选文件
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(500);
    await cdp.send('DOM.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const inputNode = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#set-import-file' });
    await cdp.send('DOM.setFileInputFiles', { files: [dlFile], nodeId: inputNode.nodeId });
    await sleep(900);

    const importDialog = await cdp.eval(`(() => ({
      open: !document.getElementById('dialog').hidden,
      title: document.getElementById('dialog-title').textContent,
      msg: document.getElementById('dialog-msg').textContent,
      buttons: [...document.querySelectorAll('#dialog .dialog__actions .btn')].map(b=>b.textContent)
    }))()`);
    check('导入前显示备份内容概览', importDialog.open && importDialog.msg.includes('4'), importDialog.msg.slice(0, 60));
    check('导入提供合并/覆盖两种方式', importDialog.buttons.includes('合并追加') && importDialog.buttons.includes('覆盖全部'),
      JSON.stringify(importDialog.buttons));

    await cdp.eval(`(() => {
      const btns=[...document.querySelectorAll('#dialog .dialog__actions .btn')];
      btns.find(b=>b.textContent==='覆盖全部').click(); return 'ok';
    })()`);
    await sleep(2000);

    const restored = await cdp.eval(`(() => ({
      total: document.getElementById('stat-total').textContent,
      names: [...document.querySelectorAll('#p-list .card__name')].map(x=>x.textContent)
    }))()`);
    check('导入备份后商品恢复', restored.total === '4', JSON.stringify(restored.names));

    const restoredImg = await cdp.eval(`(async () => {
      const imgs = await window.DB.allImages();
      const card=[...document.querySelectorAll('#p-list .card')].find(c=>c.textContent.includes('带图片'));
      await new Promise(r=>setTimeout(r,1000));
      const el = card ? card.querySelector('.card__thumb img') : null;
      return { dbImages: imgs.length, thumbShown: !!el, w: el ? el.naturalWidth : 0 };
    })()`);
    check('导入后图片也恢复了', restoredImg.dbImages === 1 && restoredImg.thumbShown,
      JSON.stringify(restoredImg));

    // 合并导入不应清空现有数据
    const beforeMerge = await cdp.eval(`document.getElementById('stat-total').textContent`);
    await cdp.send('DOM.setFileInputFiles', { files: [dlFile], nodeId: inputNode.nodeId });
    await sleep(900);
    await cdp.eval(`(() => {
      const btns=[...document.querySelectorAll('#dialog .dialog__actions .btn')];
      btns.find(b=>b.textContent==='合并追加').click(); return 'ok';
    })()`);
    await sleep(2000);
    const afterMerge = await cdp.eval(`document.getElementById('stat-total').textContent`);
    check('合并导入不会重复计数（按 ID 覆盖）', afterMerge === beforeMerge, beforeMerge + ' -> ' + afterMerge);


    // ---------- 持久化：重新加载 ----------
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2600);
    const after = await cdp.eval(`(() => ({
      count: document.querySelectorAll('#p-list .card').length,
      total: document.getElementById('stat-total').textContent,
      names: [...document.querySelectorAll('#p-list .card__name')].map(x=>x.textContent)
    }))()`);
    check('重新加载后数据仍在（IndexedDB 持久化）', after.count === 4 && after.total === '4',
      JSON.stringify(after.names));

    const thumbAfter = await cdp.eval(`(async () => {
      await new Promise(r=>setTimeout(r,1200));
      const cards=[...document.querySelectorAll('#p-list .card')];
      const card=cards.find(c=>c.textContent.includes('带图片'));
      const img = card ? card.querySelector('.card__thumb img') : null;
      return { has: !!img, w: img ? img.naturalWidth : 0 };
    })()`);
    check('重新加载后图片仍在', thumbAfter.has && thumbAfter.w > 0, JSON.stringify(thumbAfter));

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'list.png'), Buffer.from(r.data, 'base64'));
    });

    // ---------- 删除 ----------
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('带图片')); c.click(); return 'ok'; })()`);
    await sleep(700);
    await cdp.eval(`document.getElementById('d-delete').click(); 'ok'`);
    await sleep(500);
    const delDialog = await cdp.eval(`!document.getElementById('dialog').hidden`);
    check('删除有二次确认', delDialog);
    await cdp.eval(`document.querySelector('#dialog .dialog__actions .btn--danger').click(); 'ok'`);
    await sleep(900);
    const delState = await cdp.eval(`(() => ({
      count: document.querySelectorAll('#p-list .card').length,
      total: document.getElementById('stat-total').textContent,
      images: 0
    }))()`);
    check('删除商品成功', delState.count === 3 && delState.total === '3', JSON.stringify(delState));

    const imgGone = await cdp.eval(`(async () => { const rows = await window.DB.allImages(); return rows.length; })()`);
    check('删除商品同时清理图片', imgGone === 0, '剩余图片 ' + imgGone);

    // ---------- 清空 ----------
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`document.getElementById('set-clear').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`document.querySelector('#dialog .dialog__actions .btn--danger').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`document.querySelector('#dialog .dialog__actions .btn--danger').click(); 'ok'`);
    await sleep(1000);
    const cleared = await cdp.eval(`(() => ({
      total: document.getElementById('stat-total').textContent,
      count: document.querySelectorAll('#p-list .card').length
    }))()`);
    check('清空数据（二次确认）', cleared.total === '0' && cleared.count === 0, JSON.stringify(cleared));

    // ---------- 示例数据 + 离线能力 ----------
    await cdp.eval(`document.getElementById('set-demo').click(); 'ok'`);
    await sleep(1200);
    const demo = await cdp.eval(`document.getElementById('stat-total').textContent`);
    check('可载入示例商品', demo === '5', '共 ' + demo + ' 件');

    // Service Worker
    const swState = await cdp.eval(`(async () => {
      if (!('serviceWorker' in navigator)) return { supported:false };
      const reg = await navigator.serviceWorker.getRegistration();
      return { supported:true, registered: !!reg, scope: reg ? reg.scope : null, active: !!(reg && reg.active) };
    })()`);
    check('Service Worker 已注册', swState.registered, JSON.stringify(swState));

    const cached = await cdp.eval(`(async () => {
      const keys = await caches.keys();
      const cache = await caches.open(keys.find(k=>k.includes('shell')) || keys[0]);
      const reqs = await cache.keys();
      return { keys, files: reqs.map(r=>r.url.split('/').pop()).sort() };
    })()`);
    check('离线资源已缓存', cached.files && cached.files.length >= 8, cached.files.join(', '));

    // 模拟离线后重新加载
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(3000);
    const offline = await cdp.eval(`(() => ({
      title: document.title,
      total: document.getElementById('stat-total').textContent,
      cards: document.querySelectorAll('#p-list .card').length,
      banner: !document.getElementById('offline-banner').hidden
    }))()`);
    check('断网后仍能打开（Service Worker 离线缓存）', offline.cards === 5, JSON.stringify(offline));
    check('断网时显示离线提示条', offline.banner === true);

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(SHOT_DIR, 'offline.png'), Buffer.from(r.data, 'base64'));
    });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    // ---------- 页面错误汇总 ----------
    check('无未捕获的页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    // ---------- 移动端布局检查 ----------
    const layout = await cdp.eval(`(() => {
      const tabbar = document.querySelector('.tabbar').getBoundingClientRect();
      const fab = document.getElementById('fab').getBoundingClientRect();
      const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1;
      const taps = [...document.querySelectorAll('.tab, .fab')].map(el => {
        const r = el.getBoundingClientRect();
        return Math.min(r.width, r.height);
      });
      return { tabbarBottom: Math.round(tabbar.bottom), vh: window.innerHeight, fabBottom: Math.round(fab.bottom),
               overflowX, minTap: Math.min(...taps) };
    })()`);
    check('底部导航贴底显示', Math.abs(layout.tabbarBottom - layout.vh) <= 1, JSON.stringify(layout));
    check('无横向溢出', layout.overflowX === false);
    check('点击区域足够大（>=44px）', layout.minTap >= 44, 'min=' + layout.minTap);

    // ---------- 真实触摸事件（回归防护）----------
    // 曾经的 bug：用 touchend + preventDefault 防双击缩放，把随后的 click 一起取消，
    // 导致"连点两个按钮时第二个没反应"。这里用真实触摸序列验证所有关键按钮可用。
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.eval(`(async () => { await window.DB.clearAll(); await window.DB.setMeta('draft', null); return 'ok'; })()`);
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2500);

    // 先把元素滚进视野，再用真实触摸序列点击
    async function tapByTouch(selector) {
      const box = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })()`);
      if (!box) return false;
      await sleep(220);
      // scrollIntoView 之后重新取一次坐标，避免用到旧位置
      const pos = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pos] });
      await sleep(50);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(340);
      return true;
    }

    let touchOk = await tapByTouch('#fab');
    await sleep(500);
    const t1 = await cdp.eval(`!document.getElementById('sheet-form').hidden`);
    check('触摸点击「+」能打开表单', touchOk && t1, 'formOpen=' + t1);

    await tapByTouch('#f-mode .seg__item[data-mode="single"]');
    const t2 = await cdp.eval(`(document.querySelector('#f-mode .seg__item.is-active')||{dataset:{}}).dataset.mode`);
    check('触摸点击「可单卖」能选中', t2 === 'single', t2);

    // 连续快速触摸两个不同的按钮 —— 这正是旧 bug 会失败的场景
    await tapByTouch('#f-tag-chips .chip');
    await tapByTouch('#f-tag-chips .chip:nth-child(2)');
    const t3 = await cdp.eval(`document.querySelectorAll('#f-tag-chips .chip.is-active').length`);
    check('连续触摸两个标签都能生效（防连点吞事件回归）', t3 === 2, '选中 ' + t3 + ' 个');

    await tapByTouch('#f-single-add');
    const t4 = await cdp.eval(`document.querySelectorAll('#f-single-list .single-row').length`);
    check('触摸点击「添加单卖项」能增加一行', t4 === 2, '共 ' + t4 + ' 行');

    await tapByTouch('#f-photo-btn');
    const t5 = await cdp.eval(`!document.getElementById('sheet-form').hidden`);
    check('触摸点击图片选择不报错', t5 === true);

    // 用「取消」按钮本体（.text-btn），不要用 [data-close]（那个也会选中遮罩层）
    await tapByTouch('#sheet-form .text-btn');
    await sleep(500);
    const t6 = await cdp.eval(`document.getElementById('sheet-form').hidden`);
    check('触摸点击「取消」能关闭表单', t6 === true);

    await tapByTouch('.tab[data-view="settings"]');
    const t7 = await cdp.eval(`document.getElementById('view-settings').classList.contains('is-active')`);
    check('触摸点击「设置」能切换页面', t7 === true);

    await tapByTouch('.tab[data-view="products"]');
    const t8 = await cdp.eval(`document.getElementById('view-products').classList.contains('is-active')`);
    check('触摸点击「商品」能切回列表', t8 === true);

    check('触摸操作后仍无未捕获页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  } catch (err) {
    check('测试执行', false, err.message);
  } finally {
    try { cdp && cdp.ws.close(); } catch (e) { /* 忽略 */ }
    chrome.kill('SIGKILL');
    await sleep(600);
    // 默认不删除任何东西；只有显式设置 KITTY_E2E_CLEAN=1 时才清理本次测试自建的临时配置目录
    if (process.env.KITTY_E2E_CLEAN === '1') {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    } else {
      console.log('（临时浏览器配置保留在：' + profile + '，未删除）');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n============================================');
  console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  (' + f.detail + ')' : '')));
  }
  console.log('截图输出：' + SHOT_DIR);
  process.exit(failed.length ? 1 : 0);
})();
