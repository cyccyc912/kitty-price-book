/* ============================================================
   验证 Service Worker 更新机制
   ------------------------------------------------------------
   复现并验证曾经的真实故障：
   改了 js/css 重新部署，但 CACHE_VERSION 没变，
   浏览器一直用旧缓存 → 手机上按钮点不了、界面看着是旧的。
   用法： node tools/e2e-sw.js [baseUrl]
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep, createReporter } = require('./cdp-harness');

const BASE = process.argv[2] || 'http://127.0.0.1:8899/index.html';

(async () => {
  const { check, report } = createReporter();
  const shotsDir = path.join(__dirname, '..', '.shots');
  let ctx = null;

  try {
    ctx = await launch({ port: 9420, shotsDir });
    const { cdp } = ctx;

    await cdp.send('Page.navigate', { url: BASE });
    await sleep(3200);

    // ---------- 1. SW 注册与缓存建立 ----------
    const sw = await cdp.eval(`(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const keys = await caches.keys();
      const shellKey = keys.find(k => k.includes('shell'));
      let files = [];
      if (shellKey) {
        const c = await caches.open(shellKey);
        files = (await c.keys()).map(r => r.url.split('/').pop()).filter(Boolean).sort();
      }
      return {
        registered: !!reg,
        scope: reg ? reg.scope : null,
        active: !!(reg && reg.active),
        cacheKeys: keys,
        shellKey: shellKey,
        files: files
      };
    })()`);
    // 从 sw.js 读取当前版本号，避免硬编码（每次升版都要改测试）
    let expectedVer = '';
    for (let i = 0; i < 20 && !expectedVer; i++) {
      try {
        const src = await cdp.eval(`fetch('./sw.js', { cache: 'no-store' }).then(r => r.text())`);
        const m = src.match(/CACHE_VERSION\s*=\s*'([^']+)'/);
        if (m) expectedVer = m[1];
      } catch (e) { /* 重试 */ }
      if (!expectedVer) await sleep(300);
    }
    check('Service Worker 已注册并激活', sw.registered && sw.active, JSON.stringify({ scope: sw.scope }));
    check('缓存版本号与 sw.js 一致',
      expectedVer && (sw.shellKey || '').indexOf(expectedVer) === 0,
      'sw.js=' + expectedVer + ' cache=' + sw.shellKey);
    check('App Shell 已完整预缓存', sw.files.length >= 8, sw.files.join(', '));

    // ---------- 2. 关键：缓存里没有旧版本残留 ----------
    const staleKeys = sw.cacheKeys.filter(k => k.includes('kitty-price-book') && (!expectedVer || k.indexOf(expectedVer) !== 0));
    check('没有旧版本缓存残留', staleKeys.length === 0, staleKeys.join(', ') || '干净');

    // ---------- 3. 关键：缓存被旧内容污染后，SW 能自动换成新内容 ----------
    // 模拟"服务器上文件已更新，但用户缓存里还是旧版"这一真实故障场景
    const before = await cdp.eval(`(async () => {
      const keys = await caches.keys();
      const shellKey = keys.find(k => k.includes('shell'));
      const cache = await caches.open(shellKey);
      await cache.put('./js/app.js', new Response('/* OLD BROKEN VERSION */', {
        headers: { 'Content-Type': 'application/javascript' }
      }));
      const cached = await cache.match('./js/app.js');
      return { text: await cached.text() };
    })()`);
    check('可以模拟缓存被旧文件占用', before.text.includes('OLD BROKEN VERSION'));

    // 触发一次页面导航，SW 的 stale-while-revalidate 应该把新版拉回缓存
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(3500);

    // 再等一会儿，让后台的 revalidate 完成
    await sleep(1500);

    const after = await cdp.eval(`(async () => {
      const keys = await caches.keys();
      const shellKey = keys.find(k => k.includes('shell'));
      const runtimeKey = keys.find(k => k.includes('runtime'));
      // 从缓存里读（不是 fetch 服务器）
      for (const k of [runtimeKey, shellKey].filter(Boolean)) {
        const cache = await caches.open(k);
        const hit = await cache.match('./js/app.js');
        if (hit) {
          const t = await hit.text();
          if (!t.includes('OLD BROKEN VERSION') && t.length > 5000) {
            return { recovered: true, from: k, size: t.length };
          }
        }
      }
      const c = await caches.open(shellKey);
      const hit = await c.match('./js/app.js');
      const t = hit ? await hit.text() : '';
      return { recovered: false, stillOld: t.includes('OLD BROKEN VERSION'), size: t.length };
    })()`);
    check('缓存被污染后能自动恢复成新版代码', after.recovered === true,
      JSON.stringify(after));

    // ---------- 4. 离线能力仍然正常 ----------
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    });
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(4500);

    const offline = await cdp.eval(`(() => ({
      title: document.title,
      hasFab: !!document.getElementById('fab'),
      statTotal: document.getElementById('stat-total') ? document.getElementById('stat-total').textContent : null
    }))()`);
    check('断网后仍能打开', offline.hasFab && offline.title.includes('喵喵价格本'), JSON.stringify(offline));

    // 断网状态下触摸交互仍要正常（不能因为离线就点不动）
    const fbox = await cdp.eval(`(() => {
      const r = document.getElementById('fab').getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [fbox] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(1000);
    const offlineTouch = await cdp.eval(`!document.getElementById('sheet-form').hidden`);
    check('断网状态下触摸点击仍然有效', offlineTouch === true);

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });

    // ---------- 5. 「检查更新」按钮存在且能用真实触摸点到 ----------
    // 注意：这个按钮会触发 location.reload()，所以必须放在最后测，
    // 且点击后不要再去访问旧页面的元素（会拿到 rect 0x0）。
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(4000);
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(900);

    const updateBtn = await cdp.eval(`(() => {
      const b = document.getElementById('set-update');
      if (!b) return { exists: false };
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return {
        exists: true,
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
        w: Math.round(r.width), h: Math.round(r.height)
      };
    })()`);
    check('设置页有「检查更新」按钮且可见',
      updateBtn.exists && updateBtn.inViewport && updateBtn.w > 0, JSON.stringify(updateBtn));

    // 先装一个探针统计点击次数，再用触摸点一下
    await sleep(500);
    await cdp.eval(`window.__updHits = 0;
      document.getElementById('set-update').addEventListener('click', function () { window.__updHits++; }, true);
      'ok'`);
    const ub = await cdp.eval(`(() => {
      const b = document.getElementById('set-update');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [ub] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // 点击后按钮会立刻禁用并显示「检查中…」，随后页面 reload。
    // 所以要在极短时间内读一次，拿不到就说明已经重载了（同样是成功）。
    let hit = 0;
    for (let i = 0; i < 8; i++) {
      await sleep(120);
      const r = await cdp.eval(`(() => {
        if (window.__updHits > 0) return { hits: window.__updHits };
        const b = document.getElementById('set-update');
        if (!b) return { hits: -1 };
        return { hits: 0, text: b.textContent.trim(), disabled: b.disabled };
      })()`).catch(() => ({ hits: -1 }));
      if (r.hits === 1) { hit = 1; break; }
      if (r.hits === -1) { hit = 1; break; }              // 页面已重载 = 点击生效
      if (r.disabled || r.text !== '检查更新') { hit = 1; break; }
    }
    check('触摸点击「检查更新」有反应', hit === 1, hit ? '点击已生效' : '点击无反应');

    // 等页面重载完成后确认应用仍然正常
    await sleep(4000);
    const afterReload = await cdp.eval(`(() => ({
      hasFab: !!document.getElementById('fab'),
      hasDb: !!window.DB,
      title: document.title
    }))()`).catch(() => ({ hasFab: false }));
    check('检查更新后应用恢复正常', afterReload.hasFab && afterReload.hasDb, JSON.stringify(afterReload));

    check('无未捕获页面错误', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 3).join(' | '));

  } catch (err) {
    check('测试执行', false, err.message);
  } finally {
    if (ctx) { try { await ctx.close(); } catch (e) { /* 忽略 */ } }
  }

  const failed = report();
  process.exit(failed ? 1 : 0);
})();
