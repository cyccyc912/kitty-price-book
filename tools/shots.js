/* 生成一组界面截图，用于人工视觉检查
   用法： node tools/shots.js [baseUrl] */
'use strict';

const path = require('path');
const { launch, sleep } = require('./cdp-harness');

const BASE = process.argv[2] || 'http://127.0.0.1:8899/index.html';
const DIR = path.join(__dirname, '..', '.shots');

(async () => {
  const ctx = await launch({ port: 9336, shotsDir: DIR });
  const { cdp } = ctx;

  try {
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2500);

    // 1. 空状态
    await cdp.screenshot(path.join(DIR, '01-empty.png'));

    // 2. 新增表单（填一半，展示可单卖态）
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(600);
    await cdp.eval(`(() => {
      const set=(id,v)=>{const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('f-name','粉色碎花连衣裙'); set('f-code','A1023'); set('f-price','199'); set('f-single','89');
      document.querySelector('#f-mode .seg__item[data-mode="single"]').click();
      document.querySelector('#f-size-chips .chip[data-size="M"]').click();
      document.querySelector('#f-tag-chips .chip[data-tag="夏款"]').click();
      return 'ok';
    })()`);
    await sleep(700);
    await cdp.screenshot(path.join(DIR, '02-form.png'));
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1300);

    // 3. 详情（有单卖价）
    await cdp.eval(`document.querySelector('#p-list .card').click(); 'ok'`);
    await sleep(800);
    await cdp.screenshot(path.join(DIR, '03-detail-single.png'));
    await cdp.eval(`document.querySelector('#sheet-detail [data-close]').click(); 'ok'`);
    await sleep(500);

    // 4. 载入示例数据后的列表
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`document.getElementById('set-demo').click(); 'ok'`);
    await sleep(700);
    // 已有商品时会先弹确认框
    await cdp.eval(`(() => {
      const d=document.getElementById('dialog');
      if (!d.hidden) {
        const b=[...d.querySelectorAll('.dialog__actions .btn')].find(x=>x.textContent==='载入');
        if (b) b.click();
      }
      return 'ok';
    })()`);
    await sleep(1400);
    await cdp.eval(`document.querySelector('.tab[data-view="products"]').click(); 'ok'`);
    await sleep(700);
    await cdp.screenshot(path.join(DIR, '04-list.png'));

    // 5. 详情（无单卖价 / 需询问）
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('格纹')); c.click(); return 'ok'; })()`);
    await sleep(800);
    await cdp.screenshot(path.join(DIR, '05-detail-ask.png'));
    await cdp.eval(`document.querySelector('#sheet-detail [data-close]').click(); 'ok'`);
    await sleep(500);

    // 6. 搜索页
    await cdp.eval(`document.querySelector('.tab[data-view="search"]').click(); 'ok'`);
    await sleep(700);
    await cdp.eval(`(() => { const el=document.getElementById('s-input'); el.value='连衣裙'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
    await sleep(700);
    await cdp.screenshot(path.join(DIR, '06-search.png'));

    // 7. 设置页
    await cdp.eval(`document.querySelector('.tab[data-view="settings"]').click(); 'ok'`);
    await sleep(900);
    await cdp.screenshot(path.join(DIR, '07-settings.png'));

    // 8. 空结果状态
    await cdp.eval(`document.querySelector('.tab[data-view="search"]').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`(() => { const el=document.getElementById('s-input'); el.value='zzz不存在'; el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
    await sleep(700);
    await cdp.screenshot(path.join(DIR, '08-no-result.png'));

    // 9. 删除确认弹窗
    await cdp.eval(`document.querySelector('.tab[data-view="products"]').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`document.querySelector('#p-list .card').click(); 'ok'`);
    await sleep(700);
    await cdp.eval(`document.getElementById('d-delete').click(); 'ok'`);
    await sleep(600);
    await cdp.screenshot(path.join(DIR, '09-confirm.png'));

    console.log('截图已生成到 ' + DIR);
  } finally {
    await ctx.close();
  }
})();
