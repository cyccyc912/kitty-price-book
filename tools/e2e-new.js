/* ============================================================
   新功能测试：多图 / 只读锁定 / 长按快捷菜单 / 报价模板
   用法： node tools/e2e-new.js [baseUrl]
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
    ctx = await launch({ port: 9460, shotsDir });
    const { cdp } = ctx;

    async function gotoApp() {
      await cdp.send('Page.navigate', { url: BASE });
      const start = Date.now();
      while (Date.now() - start < 30000) {
        await sleep(400);
        try {
          if (await cdp.eval(`!!(window.DB && document.getElementById('fab') && document.readyState === 'complete')`)) {
            await sleep(500);
            return true;
          }
        } catch (e) { /* 导航中 */ }
      }
      return false;
    }

    /** 造一张测试图并塞进 file input */
    async function makeImage(w, h, color) {
      return cdp.eval(`(async () => {
        const c = document.createElement('canvas');
        c.width = ${w}; c.height = ${h};
        const x = c.getContext('2d');
        x.fillStyle = ${JSON.stringify(color)}; x.fillRect(0,0,${w},${h});
        x.fillStyle = '#fff'; x.font = 'bold 90px sans-serif';
        x.fillText('IMG', 40, ${Math.round(h / 2)});
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
        const file = new File([blob], 't.jpg', { type: 'image/jpeg' });
        const dt = new DataTransfer(); dt.items.add(file);
        const input = document.getElementById('f-photo-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { size: blob.size };
      })()`);
    }

    await gotoApp();
    await cdp.eval(`(async () => { await window.DB.clearAll(); await window.DB.setMeta('draft', null); return 'ok'; })()`);
    await gotoApp();

    /* ============================================================
       1. 多图
       ============================================================ */
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(800);
    await cdp.eval(`(() => {
      const n=document.getElementById('f-name'); n.value='多图测试连衣裙'; n.dispatchEvent(new Event('input',{bubbles:true}));
      const p=document.getElementById('f-price'); p.value='299'; p.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#f-mode .seg__item[data-mode="no"]').click();
      return 'ok';
    })()`);
    await sleep(300);

    await makeImage(1000, 800, '#ff9ec8');
    await sleep(1800);
    let grid = await cdp.eval(`document.querySelectorAll('#f-photo-grid .photo-slot--filled').length`);
    check('可以添加第 1 张图', grid === 1, '当前 ' + grid + ' 张');

    await makeImage(900, 900, '#9cc7f0');
    await sleep(1800);
    await makeImage(1200, 900, '#9fdcc8');
    await sleep(1800);
    await makeImage(800, 1000, '#ffc861');
    await sleep(1800);

    const gridState = await cdp.eval(`(() => ({
      filled: document.querySelectorAll('#f-photo-grid .photo-slot--filled').length,
      hasAddBtn: !!document.querySelector('#f-photo-grid .photo-slot--add'),
      coverBadge: !!document.querySelector('#f-photo-grid .photo-slot__cover'),
      delBtns: document.querySelectorAll('#f-photo-grid [data-photo-del]').length
    }))()`);
    check('可以加到 4 张图', gridState.filled === 4, JSON.stringify(gridState));
    check('4 张后不再显示「添加」按钮', gridState.hasAddBtn === false);
    check('第 1 张标记为封面', gridState.coverBadge === true);
    check('每张图都有删除按钮', gridState.delBtns === 4);

    // 尝试加第 5 张
    await makeImage(600, 600, '#ff5c8a');
    await sleep(1200);
    const five = await cdp.eval(`document.querySelectorAll('#f-photo-grid .photo-slot--filled').length`);
    check('最多 4 张，第 5 张被拒绝', five === 4, '仍为 ' + five + ' 张');

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(shotsDir, 'new-form-multi.png'), Buffer.from(r.data, 'base64'));
    });

    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(2200);

    const saved = await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      const p = rows.find(r => r.name === '多图测试连衣裙');
      const imgs = await window.DB.allImages();
      const keys = imgs.map(i => i.id).filter(k => k.indexOf(p.id) === 0).sort();
      return { imageCount: p.imageCount, hasImage: p.hasImage, storedKeys: keys.length };
    })()`);
    check('保存后 imageCount = 4', saved.imageCount === 4, JSON.stringify(saved));
    check('4 张图都写入了数据库', saved.storedKeys === 4, '库中 ' + saved.storedKeys + ' 条');

    const cardBadge = await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('#p-list .card')].find(c => c.textContent.includes('多图测试'));
      const badge = card ? card.querySelector('.card__imgcount') : null;
      return { has: !!badge, text: badge ? badge.textContent : null };
    })()`);
    check('列表卡片显示多图角标', cardBadge.has && cardBadge.text.includes('4'), JSON.stringify(cardBadge));

    /* ============================================================
       2. 详情页轮播
       ============================================================ */
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('多图测试')); c.click(); return 'ok'; })()`);
    await sleep(1800);
    const carousel = await cdp.eval(`(() => ({
      slides: document.querySelectorAll('#d-track .carousel__slide').length,
      imgs: document.querySelectorAll('#d-track .carousel__slide img').length,
      dots: document.querySelectorAll('#d-dots i').length,
      count: (document.getElementById('d-count') || {}).textContent || null,
      allLoaded: [...document.querySelectorAll('#d-track img')].every(i => i.naturalWidth > 0)
    }))()`);
    check('详情页轮播有 4 张', carousel.slides === 4 && carousel.imgs === 4, JSON.stringify(carousel));
    check('轮播有 4 个指示点', carousel.dots === 4);
    check('显示 1/4 计数', carousel.count === '1/4', carousel.count);
    check('所有图片都成功加载', carousel.allLoaded === true);

    // 滑动到第 2 张（等 scroll-snap 吸附完成）
    await cdp.eval(`(() => {
      const car = document.getElementById('d-carousel');
      car.scrollTo({ left: car.clientWidth, behavior: 'instant' });
      return 'ok';
    })()`);
    await sleep(1200);
    const slide2 = await cdp.eval(`(() => ({
      count: (document.getElementById('d-count')||{}).textContent,
      activeDot: [...document.querySelectorAll('#d-dots i')].findIndex(d => d.classList.contains('is-active'))
    }))()`);
    check('滑动后计数和指示点同步', slide2.count === '2/4' && slide2.activeDot === 1, JSON.stringify(slide2));

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(shotsDir, 'new-detail-carousel.png'), Buffer.from(r.data, 'base64'));
    });

    /* ============================================================
       3. 只读锁定
       ============================================================ */
    const lockState = await cdp.eval(`(() => {
      const s = document.getElementById('sheet-detail');
      return {
        locked: s.classList.contains('is-locked'),
        edit: getComputedStyle(document.getElementById('d-edit')).display,
        del: getComputedStyle(document.getElementById('d-delete')).display
      };
    })()`);
    check('详情默认锁定，编辑与删除不可见',
      lockState.locked && lockState.edit === 'none' && lockState.del === 'none', JSON.stringify(lockState));

    await cdp.eval(`document.getElementById('d-lock').click(); 'ok'`);
    await sleep(400);
    const unlocked = await cdp.eval(`(() => ({
      locked: document.getElementById('sheet-detail').classList.contains('is-locked'),
      edit: getComputedStyle(document.getElementById('d-edit')).display
    }))()`);
    check('点锁图标后解锁', unlocked.locked === false && unlocked.edit !== 'none', JSON.stringify(unlocked));

    // 关闭再打开应恢复锁定
    await cdp.eval(`document.querySelector('#sheet-detail .text-btn[data-close]').click(); 'ok'`);
    await sleep(600);
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('多图测试')); c.click(); return 'ok'; })()`);
    await sleep(1200);
    const relocked = await cdp.eval(`document.getElementById('sheet-detail').classList.contains('is-locked')`);
    check('重新打开详情会自动重新锁定', relocked === true);

    /* ============================================================
       4. 报价模板
       ============================================================ */
    await cdp.eval(`document.querySelector('#sheet-detail .text-btn[data-close]').click(); 'ok'`);
    await sleep(600);

    // 先建一个三项单卖的商品
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(800);
    await cdp.eval(`(() => {
      const set=(id,v)=>{const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('f-name','三件套报价测试'); set('f-code','T999'); set('f-price','268');
      document.querySelector('#f-mode .seg__item[data-mode="single"]').click();
      return 'ok';
    })()`);
    await sleep(300);
    const trios = [['上衣','99'], ['裤子','89'], ['内搭','49']];
    for (let i = 0; i < 3; i++) {
      await cdp.eval(`(() => {
        if (document.querySelectorAll('#f-single-list .single-row').length < ${i + 1}) {
          document.getElementById('f-single-add').click();
        }
        return 'ok';
      })()`);
      await sleep(350);
      await cdp.eval(`(() => {
        const r = document.querySelectorAll('#f-single-list .single-row')[${i}];
        const n = r.querySelector('[data-single="name"]');
        const p = r.querySelector('[data-single="price"]');
        n.value = ${JSON.stringify(trios[i][0])}; n.dispatchEvent(new Event('input',{bubbles:true}));
        p.value = ${JSON.stringify(trios[i][1])}; p.dispatchEvent(new Event('input',{bubbles:true}));
        return 'ok';
      })()`);
      await sleep(300);
    }
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(2000);

    async function getQuote() {
      return cdp.eval(`(async () => {
        let captured = null;
        const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = (t) => { captured = t; return orig(t); };
        document.getElementById('d-copy-quote').click();
        await new Promise(r => setTimeout(r, 500));
        navigator.clipboard.writeText = orig;
        return captured;
      })()`);
    }

    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('三件套报价')); c.click(); return 'ok'; })()`);
    await sleep(1200);

    // 默认模板：简洁清单
    const q1 = await getQuote();
    check('默认模板生成报价',
      q1 && q1.includes('三件套报价测试') && q1.includes('整套 ¥268') && q1.includes('上衣¥99'),
      (q1 || '').replace(/\n/g, ' | '));

    await cdp.eval(`document.querySelector('#sheet-detail .text-btn[data-close]').click(); 'ok'`);
    await sleep(600);

    // 切换到口语模板
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(900);
    const tplCards = await cdp.eval(`(() => ({
      count: document.querySelectorAll('#set-tpl-list [data-tpl]').length,
      names: [...document.querySelectorAll('#set-tpl-list .tpl-card__name')].map(x => x.textContent),
      hasPreview: document.querySelectorAll('#set-tpl-list .tpl-card__preview').length
    }))()`);
    check('设置页显示 4 个模板（3 内置 + 自定义）', tplCards.count === 4, JSON.stringify(tplCards.names));
    check('每个模板都有预览', tplCards.hasPreview === 4);

    await cdp.eval(`document.querySelector('#set-tpl-list [data-tpl="friendly"]').click(); 'ok'`);
    await sleep(600);
    await cdp.eval(`document.querySelector('.tab[data-view="products"]').click(); 'ok'`);
    await sleep(600);
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('三件套报价')); c.click(); return 'ok'; })()`);
    await sleep(1200);
    const q2 = await getQuote();
    check('切换到口语模板生效', q2 && q2.includes('亲，') && q2.includes('268'),
      (q2 || '').replace(/\n/g, ' | '));

    await cdp.eval(`document.querySelector('#sheet-detail .text-btn[data-close]').click(); 'ok'`);
    await sleep(600);

    // 切到极简模板
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(700);
    await cdp.eval(`document.querySelector('#set-tpl-list [data-tpl="compact"]').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`document.querySelector('.tab[data-view="products"]').click(); 'ok'`);
    await sleep(600);
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('三件套报价')); c.click(); return 'ok'; })()`);
    await sleep(1200);
    const q3 = await getQuote();
    check('极简模板使用「单卖短」格式', q3 && q3.includes('整套268') && q3.includes('99/89/49'),
      (q3 || '').replace(/\n/g, ' | '));

    await cdp.eval(`document.querySelector('#sheet-detail .text-btn[data-close]').click(); 'ok'`);
    await sleep(600);

    // 自定义模板
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(700);
    await cdp.eval(`document.querySelector('#set-tpl-list [data-tpl="custom"]').click(); 'ok'`);
    await sleep(600);
    const customWrapShown = await cdp.eval(`!document.getElementById('set-tpl-custom-wrap').hidden`);
    check('选中自定义后显示编辑框', customWrapShown === true);

    await cdp.eval(`(() => {
      const ta = document.getElementById('set-tpl-custom');
      ta.value = '【MY】{名称} | {售价} | {单卖明细}';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(800);
    await cdp.eval(`document.querySelector('.tab[data-view="products"]').click(); 'ok'`);
    await sleep(600);
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('三件套报价')); c.click(); return 'ok'; })()`);
    await sleep(1200);
    const q4 = await getQuote();
    check('自定义模板生效',
      q4 && q4.includes('【MY】') && q4.includes('三件套报价测试') && q4.includes('上衣 ¥99'),
      (q4 || '').replace(/\n/g, ' | '));

    await cdp.eval(`document.querySelector('#sheet-detail .text-btn[data-close]').click(); 'ok'`);
    await sleep(600);

    /* ============================================================
       5. 长按快捷菜单
       ============================================================ */
    const cardPos = await cdp.eval(`(() => {
      const c = [...document.querySelectorAll('#p-list .card')].find(x => x.textContent.includes('三件套报价'));
      c.scrollIntoView({ block: 'center' });
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) };
    })()`);
    await sleep(400);

    // 模拟长按：touchStart 按住 700ms 再 touchEnd
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [cardPos] });
    await sleep(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(800);

    const quick = await cdp.eval(`(() => {
      const s = document.getElementById('sheet-quick');
      return {
        open: !s.hidden,
        items: document.querySelectorAll('#quick-body [data-quick]').length,
        hasQuote: !!document.querySelector('#quick-body [data-quick="quote"]'),
        title: document.getElementById('quick-title').textContent,
        detailOpened: !document.getElementById('sheet-detail').hidden
      };
    })()`);
    check('长按卡片打开快捷菜单', quick.open === true, JSON.stringify(quick));
    check('快捷菜单包含 7 个操作', quick.items === 7, '共 ' + quick.items + ' 个');
    check('快捷菜单有「复制报价」', quick.hasQuote === true);
    check('长按不会同时打开详情页', quick.detailOpened === false);
    check('快捷菜单标题显示商品名', quick.title.includes('三件套'), quick.title);

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(shotsDir, 'new-quick-menu.png'), Buffer.from(r.data, 'base64'));
    });

    // 从快捷菜单复制报价
    const quickQuote = await cdp.eval(`(async () => {
      let captured = null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t) => { captured = t; return orig(t); };
      document.querySelector('#quick-body [data-quick="quote"]').click();
      await new Promise(r => setTimeout(r, 600));
      navigator.clipboard.writeText = orig;
      return captured;
    })()`);
    check('快捷菜单可直接复制报价', quickQuote && quickQuote.includes('【MY】'),
      (quickQuote || '').replace(/\n/g, ' | '));

    await sleep(400);
    const closedAfter = await cdp.eval(`document.getElementById('sheet-quick').hidden`);
    check('复制后快捷菜单自动关闭', closedAfter === true);

    // 长按 + 轻微移动不应触发
    await cdp.eval(`document.querySelector('#p-list .card').scrollIntoView({block:'center'}); 'ok'`);
    await sleep(300);
    const pos2 = await cdp.eval(`(() => {
      const c = [...document.querySelectorAll('#p-list .card')].find(x => x.textContent.includes('多图测试'));
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) };
    })()`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pos2] });
    await sleep(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pos2.x, y: pos2.y + 60 }] });
    await sleep(600);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
    const notOpened = await cdp.eval(`document.getElementById('sheet-quick').hidden`);
    check('滑动时不会误触发长按菜单', notOpened === true);

    /* ============================================================
       6. 锁定设置的持久化
       ============================================================ */
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(700);
    await cdp.eval(`(() => {
      const sw = document.getElementById('set-lock');
      sw.checked = false;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(500);
    await gotoApp();
    const lockSetting = await cdp.eval(`(async () => ({
      saved: await window.DB.getMeta('lockByDefault', true),
      checked: document.getElementById('set-lock').checked
    }))()`);
    check('关闭默认锁定后设置被保存', lockSetting.saved === false && lockSetting.checked === false,
      JSON.stringify(lockSetting));

    await cdp.eval(`(() => { const c=document.querySelector('#p-list .card'); c.click(); return 'ok'; })()`);
    await sleep(1000);
    const nowUnlocked = await cdp.eval(`!document.getElementById('sheet-detail').classList.contains('is-locked')`);
    check('关闭默认锁定后详情页直接可编辑', nowUnlocked === true);

    check('无未捕获页面错误', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 3).join(' | '));

  } catch (err) {
    check('测试执行', false, err.message);
  } finally {
    if (ctx) { try { await ctx.close(); } catch (e) { /* 忽略 */ } }
  }

  const failed = report();
  process.exit(failed ? 1 : 0);
})();
