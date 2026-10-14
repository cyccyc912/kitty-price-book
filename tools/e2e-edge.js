/* ============================================================
   边界与容错测试
   ------------------------------------------------------------
   用法： node tools/e2e-edge.js [baseUrl]
   覆盖：兼容模式降级、草稿恢复、连点防重、价格解析、复制、
         单卖项（迁移 / 上限 / 默认名 / 逐项复制）、
         自定义标签、转义安全、大数据量、软键盘适配等
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
    /* ============================================================
       场景 1：正常模式下的边界行为
       ============================================================ */
    ctx = await launch({ port: 9334, shotsDir });
    const { cdp } = ctx;

    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2500);

    // ---------- 空表单校验 ----------
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(450);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(500);
    const emptySave = await cdp.eval(`(() => ({
      errShown: !document.getElementById('f-name-err').hidden,
      invalid: document.getElementById('f-name').parentNode.classList.contains('is-invalid'),
      sheetStillOpen: !document.getElementById('sheet-form').hidden,
      cards: document.querySelectorAll('#p-list .card').length
    }))()`);
    check('商品名为空时阻止保存并提示', emptySave.errShown && emptySave.sheetStillOpen && emptySave.cards === 0,
      JSON.stringify(emptySave));
    check('空表单保存时输入框标红', emptySave.invalid);

    // ---------- 连点保存不会产生重复 ----------
    await cdp.eval(`(() => {
      const set=(id,v)=>{const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('f-name','连点测试商品');
      set('f-price','100');
      document.querySelector('#f-mode .seg__item[data-mode="no"]').click();
      return 'ok';
    })()`);
    await sleep(200);
    await cdp.eval(`(() => {
      const b = document.getElementById('f-save');
      b.click(); b.click(); b.click(); b.click();
      return 'ok';
    })()`);
    await sleep(1500);
    const dup = await cdp.eval(`(() => {
      const names=[...document.querySelectorAll('#p-list .card__name')].map(x=>x.textContent);
      return { total: names.length, same: names.filter(n=>n==='连点测试商品').length };
    })()`);
    check('快速连点保存不会产生重复商品', dup.same === 1, JSON.stringify(dup));

    // ---------- 价格解析容错 ----------
    const priceCases = [
      { input: '199', expect: 199 },
      { input: '￥299', expect: 299 },
      { input: '¥ 88.5', expect: 88.5 },
      { input: '1,280', expect: 1280 },
      { input: '99元', expect: 99 },
      { input: '0', expect: 0 },
      { input: 'abc', expect: null },
      { input: '', expect: null }
    ];
    let priceAllOk = true;
    const priceDetail = [];
    for (const c of priceCases) {
      await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
      await sleep(400);
      const got = await cdp.eval(`(async () => {
        const el=document.getElementById('f-name'); el.value='价格测试'; el.dispatchEvent(new Event('input',{bubbles:true}));
        const p=document.getElementById('f-price'); p.value=${JSON.stringify(c.input)}; p.dispatchEvent(new Event('input',{bubbles:true}));
        document.querySelector('#f-mode .seg__item[data-mode="no"]').click();
        document.getElementById('f-save').click();
        await new Promise(r=>setTimeout(r,700));
        const card=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('价格测试'));
        const m = card ? card.textContent.match(/售价¥([\\d.]+)/) : null;
        return m ? Number(m[1]) : null;
      })()`);
      if (got !== c.expect) { priceAllOk = false; priceDetail.push(`${c.input} => ${got} (期望 ${c.expect})`); }
    }
    check('各种价格写法都能正确解析', priceAllOk, priceDetail.join('; ') || '全部通过');

    // 清掉价格测试数据
    await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      for (const r of rows) { await window.DB.deleteProduct(r.id); }
      return 'ok';
    })()`);
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2200);

    // ---------- 特殊字符转义（防止 HTML 注入 / 显示错乱）----------
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(450);
    await cdp.eval(`(() => {
      const set=(id,v)=>{const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('f-name','<img src=x onerror=alert(1)>连衣裙 & "特价"');
      set('f-code','A<1>');
      set('f-price','150');
      set('f-note','备注里有 <script>alert(2)<\\/script> 和 & 符号');
      document.querySelector('#f-mode .seg__item[data-mode="no"]').click();
      return 'ok';
    })()`);
    await sleep(200);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1200);
    const esc = await cdp.eval(`(() => {
      const card=document.querySelector('#p-list .card');
      return {
        nameText: card.querySelector('.card__name').textContent,
        injectedImg: !!card.querySelector('.card__name img'),
        injectedScript: document.querySelectorAll('#p-list script').length,
        noteText: (card.querySelector('.card__note')||{}).textContent || ''
      };
    })()`);
    check('特殊字符按纯文本显示（无 HTML 注入）',
      esc.injectedImg === false && esc.injectedScript === 0 && esc.nameText.includes('<img src=x'),
      esc.nameText);
    check('备注里的尖括号也安全显示', esc.noteText.includes('<script>'), esc.noteText);

    // 详情页同样检查
    await cdp.eval(`document.querySelector('#p-list .card').click(); 'ok'`);
    await sleep(700);
    const detailEsc = await cdp.eval(`(() => ({
      imgs: document.querySelectorAll('#d-body img').length,
      scripts: document.querySelectorAll('#d-body script').length,
      name: (document.querySelector('#d-body .detail-name')||{}).textContent || ''
    }))()`);
    check('详情页也不会被特殊字符破坏', detailEsc.imgs === 0 && detailEsc.scripts === 0,
      JSON.stringify(detailEsc));

    // ---------- 复制功能 ----------
    const copied = await cdp.eval(`(async () => {
      // 监听剪贴板写入
      let captured = null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t) => { captured = t; return orig(t); };
      document.getElementById('d-copy-all').click();
      await new Promise(r=>setTimeout(r,400));
      return captured;
    })()`);
    check('复制全部信息包含商品名与价格',
      copied && copied.includes('售价：¥150') && copied.includes('单卖：不可单卖'),
      (copied || '').replace(/\n/g, ' | '));

    const copyPrice = await cdp.eval(`(async () => {
      let captured=null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t)=>{captured=t; return orig(t);};
      document.getElementById('d-copy-price').click();
      await new Promise(r=>setTimeout(r,400));
      return captured;
    })()`);
    check('复制售价格式正确', copyPrice === '售价 ¥150', copyPrice);

    const copySingleDisabled = await cdp.eval(`(() => {
      // 不可单卖且没有任何单卖项 → 按钮应为禁用
      return document.getElementById('d-copy-single').disabled;
    })()`);
    check('无单卖项时「复制单卖价」按钮禁用', copySingleDisabled === true);

    await cdp.eval(`document.querySelector('#sheet-detail [data-close]').click(); 'ok'`);
    await sleep(400);

    // ---------- 草稿恢复 ----------
    await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      for (const r of rows) { await window.DB.deleteProduct(r.id); }
      await window.DB.setMeta('draft', null);
      return 'ok';
    })()`);
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2200);

    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(450);
    await cdp.eval(`(() => {
      const set=(id,v)=>{const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('f-name','草稿测试连衣裙');
      set('f-price','268');
      set('f-note','填到一半被打断');
      document.querySelector('#f-tag-chips .chip[data-tag="夏款"]').click();
      return 'ok';
    })()`);
    await sleep(1200);   // 等草稿自动保存（debounce 500ms）
    // 模拟误触返回：关闭表单但不保存
    await cdp.eval(`document.querySelector('#sheet-form [data-close]').click(); 'ok'`);
    await sleep(600);
    // 重新打开新增表单
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(900);
    const draftDlg = await cdp.eval(`(() => ({
      open: !document.getElementById('dialog').hidden,
      title: document.getElementById('dialog-title').textContent,
      buttons: [...document.querySelectorAll('#dialog .dialog__actions .btn')].map(b=>b.textContent)
    }))()`);
    check('再次打开表单会询问是否恢复草稿', draftDlg.open && draftDlg.title.includes('继续'), JSON.stringify(draftDlg));

    await cdp.eval(`(() => {
      const b=[...document.querySelectorAll('#dialog .dialog__actions .btn')].find(x=>x.textContent==='继续填写');
      b.click(); return 'ok';
    })()`);
    await sleep(700);
    const draftRestored = await cdp.eval(`(() => ({
      name: document.getElementById('f-name').value,
      price: document.getElementById('f-price').value,
      note: document.getElementById('f-note').value,
      tag: !!document.querySelector('#f-tag-chips .chip[data-tag="夏款"].is-active')
    }))()`);
    check('草稿内容完整恢复',
      draftRestored.name === '草稿测试连衣裙' && draftRestored.price === '268' &&
      draftRestored.note === '填到一半被打断' && draftRestored.tag === true,
      JSON.stringify(draftRestored));

    await cdp.send('Page.captureScreenshot', {}).then(() => {});
    await cdp.screenshot(path.join(shotsDir, 'edge-draft.png'));

    // 放弃草稿
    await cdp.eval(`document.querySelector('#sheet-form [data-close]').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(900);
    await cdp.eval(`(() => {
      const b=[...document.querySelectorAll('#dialog .dialog__actions .btn')].find(x=>x.textContent==='不用了');
      b.click(); return 'ok';
    })()`);
    await sleep(600);
    const draftCleared = await cdp.eval(`document.getElementById('f-name').value`);
    check('选择「不用了」后草稿被清空', draftCleared === '', 'name="' + draftCleared + '"');

    // ---------- 自定义标签 ----------
    await cdp.eval(`(() => {
      const t=document.getElementById('f-tag-custom'); t.value='闺蜜同款';
      document.getElementById('f-tag-add').click();
      return 'ok';
    })()`);
    await sleep(400);
    const customChips = await cdp.eval(`(() => ({
      tagChip: !!document.querySelector('#f-tag-chips .chip[data-tag="闺蜜同款"]'),
      tagActive: !!document.querySelector('#f-tag-chips .chip[data-tag="闺蜜同款"].is-active')
    }))()`);
    check('可以添加自定义标签并自动选中', customChips.tagChip && customChips.tagActive, JSON.stringify(customChips));

    // 自定义项要持久化
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2200);
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(600);
    const customPersist = await cdp.eval(`(() => ({
      tag: !!document.querySelector('#f-tag-chips .chip[data-tag="闺蜜同款"]')
    }))()`);
    check('自定义标签重新打开后仍在', customPersist.tag, JSON.stringify(customPersist));

    await cdp.eval(`document.querySelector('#sheet-form [data-close]').click(); 'ok'`);
    await sleep(500);

    // ---------- 图片：非图片文件 / 超大图 ----------
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(500);
    const badFile = await cdp.eval(`(async () => {
      const file = new File([new Uint8Array([1,2,3,4])], 'not-an-image.txt', { type: 'text/plain' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('f-photo-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r=>setTimeout(r,800));
      return { toast: document.getElementById('toast').textContent, hidden: document.getElementById('toast').hidden };
    })()`);
    check('选择非图片文件会给出提示', badFile.hidden === false && badFile.toast.includes('图片'), badFile.toast);

    // 超大图（3000x3000）也要压到 800
    const bigImg = await cdp.eval(`(async () => {
      const c=document.createElement('canvas'); c.width=3000; c.height=3000;
      const x=c.getContext('2d'); x.fillStyle='#8fd'; x.fillRect(0,0,3000,3000);
      x.fillStyle='#f5a'; x.beginPath(); x.arc(1500,1500,900,0,7); x.fill();
      const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.95));
      const file=new File([blob],'big.jpg',{type:'image/jpeg'});
      const dt=new DataTransfer(); dt.items.add(file);
      const input=document.getElementById('f-photo-input');
      input.files=dt.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,2500));
      const img=document.getElementById('f-photo-img');
      return { srcBytes: blob.size, w: img.naturalWidth, h: img.naturalHeight };
    })()`);
    check('3000×3000 大图压到 800px 以内',
      bigImg.w <= 800 && bigImg.h <= 800 && bigImg.w > 0,
      `${bigImg.w}×${bigImg.h}（原始 3000×3000，${(bigImg.srcBytes / 1024).toFixed(0)}KB）`);

    await cdp.eval(`(() => {
      const n=document.getElementById('f-name'); n.value='大图商品'; n.dispatchEvent(new Event('input',{bubbles:true}));
      const p=document.getElementById('f-price'); p.value='399'; p.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#f-mode .seg__item[data-mode="single"]').click();
      const row = document.querySelector('#f-single-list .single-row');
      const rn = row.querySelector('[data-single="name"]');
      const rp = row.querySelector('[data-single="price"]');
      rn.value='外套'; rn.dispatchEvent(new Event('input',{bubbles:true}));
      rp.value='159'; rp.dispatchEvent(new Event('input',{bubbles:true}));
      return 'ok';
    })()`);
    await sleep(200);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(2000);
    const bigSaved = await cdp.eval(`(async () => {
      const rows = await window.DB.allImages();
      return rows.map(r => ({ bytes: r.bytes, hasThumb: !!r.thumb }));
    })()`);
    check('大图存储体积合理（<400KB）',
      bigSaved.length === 1 && bigSaved[0].bytes > 0 && bigSaved[0].bytes < 400 * 1024,
      JSON.stringify(bigSaved));
    check('大图同时生成了缩略图', bigSaved.length === 1 && bigSaved[0].hasThumb === true);

    // ---------- 图片删除 ----------
    await cdp.eval(`(() => { const c=document.querySelector('#p-list .card'); c.click(); return 'ok'; })()`);
    await sleep(700);
    await cdp.eval(`document.getElementById('d-edit').click(); 'ok'`);
    await sleep(800);
    await cdp.eval(`document.getElementById('f-photo-clear').click(); 'ok'`);
    await sleep(300);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1500);
    const imgCleared = await cdp.eval(`(async () => ({
      images: (await window.DB.allImages()).length,
      cardHasImg: !!document.querySelector('#p-list .card .card__thumb img')
    }))()`);
    check('编辑时删除图片会真正清理数据',
      imgCleared.images === 0 && imgCleared.cardHasImg === false, JSON.stringify(imgCleared));

    // ---------- 单卖项：旧数据迁移 / 上限 / 默认名 / 逐项复制 ----------
    await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      for (const r of rows) { await window.DB.deleteProduct(r.id); }
      await window.DB.setMeta('draft', null);
      return 'ok';
    })()`);

    // 1) 旧格式（只有 singlePrice）导入后应自动变成一条「单卖」项
    const legacy = await cdp.eval(`(async () => {
      // 直接写一条旧格式记录，绕过 normalize，模拟历史备份
      await window.DB.putProduct({
        id: 'legacy-1', name: '旧格式商品', code: 'OLD1', price: 200,
        singlePrice: 88, singleMode: 'single', tags: ['旧数据'], note: '',
        hasImage: false, createdAt: Date.now(), updatedAt: Date.now()
      });
      return 'ok';
    })()`);
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2200);
    const migrated = await cdp.eval(`(() => {
      const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('旧格式'));
      return c ? c.textContent.replace(/\\s+/g,' ').trim() : null;
    })()`);
    check('旧格式 singlePrice 自动迁移为一条单卖项',
      migrated && migrated.includes('单卖 ¥88'), migrated);

    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('旧格式')); c.click(); return 'ok'; })()`);
    await sleep(700);
    const migratedDetail = await cdp.eval(`document.querySelector('#d-body').textContent.replace(/\\s+/g,' ')`);
    check('迁移后的单卖项显示为「单卖」', migratedDetail.includes('单卖明细') && migratedDetail.includes('单卖¥88'),
      migratedDetail.slice(0, 140));
    await cdp.eval(`document.querySelector('#sheet-detail [data-close]').click(); 'ok'`);
    await sleep(400);

    // 2) 最多 6 条
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`(() => {
      const n=document.getElementById('f-name'); n.value='上限测试'; n.dispatchEvent(new Event('input',{bubbles:true}));
      const p=document.getElementById('f-price'); p.value='500'; p.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#f-mode .seg__item[data-mode="single"]').click();
      for (let i = 0; i < 10; i++) document.getElementById('f-single-add').click();
      return 'ok';
    })()`);
    await sleep(600);
    const limitState = await cdp.eval(`(() => ({
      rows: document.querySelectorAll('#f-single-list .single-row').length,
      addDisabled: document.getElementById('f-single-add').disabled,
      label: document.querySelector('#f-single-add .single-add__label').textContent.trim()
    }))()`);
    check('单卖项最多 6 条', limitState.rows === 6, JSON.stringify(limitState));
    check('达到上限后按钮禁用并提示', limitState.addDisabled === true && limitState.label.includes('6'), limitState.label);

    // 3) 名称为空时默认显示「单卖」
    await cdp.eval(`(() => {
      const rows = document.querySelectorAll('#f-single-list .single-row');
      const r = rows[0];
      r.querySelector('[data-single="price"]').value = '77';
      r.querySelector('[data-single="price"]').dispatchEvent(new Event('input',{bubbles:true}));
      // 名称故意不填
      return 'ok';
    })()`);
    await sleep(300);
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1400);
    const named = await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      const p = rows.find(r => r.name === '上限测试');
      return p ? p.singleItems : null;
    })()`);
    check('名称留空时单卖项按「单卖」存储', named && named.length === 1 && named[0].name === '' && named[0].price === 77,
      JSON.stringify(named));

    const cardNamed = await cdp.eval(`(() => {
      const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('上限测试'));
      return c.textContent.replace(/\\s+/g,' ').trim();
    })()`);
    check('只有一条单卖项时列表不显示「起」', cardNamed.includes('单卖 ¥77') && !cardNamed.includes('起'), cardNamed);

    // 4) 名为空的项在详情页显示为「单卖」，且可逐项复制
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('上限测试')); c.click(); return 'ok'; })()`);
    await sleep(700);
    const defaultName = await cdp.eval(`(() => {
      const el = document.querySelector('#d-body .single-detail__name');
      return el ? el.textContent : null;
    })()`);
    check('详情页空名称显示为「单卖」', defaultName === '单卖', defaultName);

    const itemCopy = await cdp.eval(`(async () => {
      let captured=null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t)=>{captured=t; return orig(t);};
      document.querySelector('#d-body [data-copy-item]').click();
      await new Promise(r=>setTimeout(r,400));
      return captured;
    })()`);
    check('可以逐项复制单卖价格', itemCopy === '单卖 ¥77', itemCopy);

    // 5) 多条时「复制单卖价」按钮一次复制全部明细
    await cdp.eval(`document.querySelector('#sheet-detail [data-close]').click(); 'ok'`);
    await sleep(400);
    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('旧格式')); c.click(); return 'ok'; })()`);
    await sleep(600);
    await cdp.eval(`document.querySelector('#sheet-detail [data-close]').click(); 'ok'`);
    await sleep(400);

    // 构造一个三项单卖的商品
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`(() => {
      const n=document.getElementById('f-name'); n.value='三件套测试'; n.dispatchEvent(new Event('input',{bubbles:true}));
      const p=document.getElementById('f-price'); p.value='268'; p.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#f-mode .seg__item[data-mode="single"]').click();
      return 'ok';
    })()`);
    await sleep(300);
    const trioNames = ['上衣', '裤子', '内搭'];
    const trioPrices = ['99', '89', '49'];
    for (let i = 0; i < 3; i++) {
      await cdp.eval(`(() => {
        if (document.querySelectorAll('#f-single-list .single-row').length < ${i + 1}) {
          document.getElementById('f-single-add').click();
        }
        return 'ok';
      })()`);
      await sleep(300);
      await cdp.eval(`(() => {
        const r = document.querySelectorAll('#f-single-list .single-row')[${i}];
        const n = r.querySelector('[data-single="name"]');
        const p = r.querySelector('[data-single="price"]');
        n.value = ${JSON.stringify(trioNames[i])}; n.dispatchEvent(new Event('input',{bubbles:true}));
        p.value = ${JSON.stringify(trioPrices[i])}; p.dispatchEvent(new Event('input',{bubbles:true}));
        return 'ok';
      })()`);
      await sleep(250);
    }
    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1500);

    const trioCard = await cdp.eval(`(() => {
      const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('三件套'));
      return c ? c.textContent.replace(/\\s+/g,' ').trim() : null;
    })()`);
    check('三件套卡片显示「¥49 起 · 3 项可单卖」',
      trioCard && trioCard.includes('单卖 ¥49 起') && trioCard.includes('3 项可单卖'), trioCard);

    await cdp.eval(`(() => { const c=[...document.querySelectorAll('#p-list .card')].find(x=>x.textContent.includes('三件套')); c.click(); return 'ok'; })()`);
    await sleep(800);
    const trioDetail = await cdp.eval(`(() => {
      const rows=[...document.querySelectorAll('#d-body .single-detail__row')].map(r=>({
        name: r.querySelector('.single-detail__name').textContent,
        price: r.querySelector('.single-detail__price').textContent
      }));
      const sum = document.querySelector('#d-body .single-detail__sum');
      return { rows, sum: sum ? sum.textContent : null, body: document.getElementById('d-body').textContent.replace(/\\s+/g,' ') };
    })()`);
    check('详情页逐项列出三个单卖项',
      trioDetail.rows.length === 3 &&
      trioDetail.rows[0].name === '上衣' && trioDetail.rows[0].price === '¥99' &&
      trioDetail.rows[1].name === '裤子' && trioDetail.rows[1].price === '¥89' &&
      trioDetail.rows[2].name === '内搭' && trioDetail.rows[2].price === '¥49',
      JSON.stringify(trioDetail.rows));
    check('详情页显示单卖合计', trioDetail.sum && trioDetail.sum.includes('合计 ¥237'), trioDetail.sum);
    check('详情页单卖汇总显示最低价起', trioDetail.body.includes('¥49 起'), trioDetail.body.slice(0, 100));

    const multiCopy = await cdp.eval(`(async () => {
      let captured=null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t)=>{captured=t; return orig(t);};
      document.getElementById('d-copy-single').click();
      await new Promise(r=>setTimeout(r,400));
      return captured;
    })()`);
    check('多条时一次复制全部单卖明细',
      multiCopy && multiCopy.includes('上衣 ¥99') && multiCopy.includes('裤子 ¥89') && multiCopy.includes('内搭 ¥49'),
      (multiCopy || '').replace(/\n/g, ' | '));

    const allCopy = await cdp.eval(`(async () => {
      let captured=null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t)=>{captured=t; return orig(t);};
      document.getElementById('d-copy-all').click();
      await new Promise(r=>setTimeout(r,400));
      return captured;
    })()`);
    check('复制全部信息包含单卖明细', allCopy && allCopy.includes('· 上衣 ¥99') && allCopy.includes('· 内搭 ¥49'),
      (allCopy || '').replace(/\n/g, ' | '));

    await cdp.send('Page.captureScreenshot', {}).then(async (r) => {
      fs.writeFileSync(path.join(shotsDir, 'edge-single-items.png'), Buffer.from(r.data, 'base64'));
    });

    // 6) 删除单卖项
    await cdp.eval(`document.getElementById('d-edit').click(); 'ok'`);
    await sleep(800);
    const beforeDel = await cdp.eval(`document.querySelectorAll('#f-single-list .single-row').length`);
    await cdp.eval(`(() => {
      const btns = document.querySelectorAll('#f-single-list [data-single-del]');
      btns[btns.length - 1].click();
      return 'ok';
    })()`);
    await sleep(400);
    const afterDel = await cdp.eval(`document.querySelectorAll('#f-single-list .single-row').length`);
    check('可以删除单卖项', beforeDel === 3 && afterDel === 2, beforeDel + ' -> ' + afterDel);

    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1300);
    const afterDelSave = await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      const p = rows.find(r => r.name === '三件套测试');
      return p ? p.singleItems.map(x=>x.name) : null;
    })()`);
    check('删除后保存生效', afterDelSave && afterDelSave.join(',') === '上衣,裤子', JSON.stringify(afterDelSave));

    await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      for (const r of rows) { await window.DB.deleteProduct(r.id); }
      await window.DB.setMeta('draft', null);
      return 'ok';
    })()`);
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2000);

    // ---------- 重复标签去重 ----------
    // 注意：每次点击后 chip 会重新渲染，必须重新查询节点
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(500);
    await cdp.eval(`(() => {
      const n=document.getElementById('f-name'); n.value='去重测试'; n.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#f-mode .seg__item[data-mode="no"]').click();
      return 'ok';
    })()`);
    await sleep(150);
    // 选中 → 取消 → 再选中，最终应为选中 1 个
    for (const step of [1, 2, 3]) {
      await cdp.eval(`(() => { const c=document.querySelector('#f-tag-chips .chip[data-tag="夏款"]'); c.click(); return ${step}; })()`);
      await sleep(180);
    }
    const chipToggles = await cdp.eval(`(() => ({
      tags: [...document.querySelectorAll('#f-tag-chips .chip.is-active')].map(x=>x.dataset.tag),
    }))()`);
    check('标签点击可以反复切换',
      chipToggles.tags.join(',') === '夏款',
      JSON.stringify(chipToggles));

    // 再用自定义输入重复添加已存在的项：应只选中、不产生重复选项
    await cdp.eval(`(() => {
      const t=document.getElementById('f-tag-custom'); t.value='夏款';
      document.getElementById('f-tag-add').click();
      return 'ok';
    })()`);
    await sleep(400);
    const dupChips = await cdp.eval(`(() => ({
      tagChips: [...document.querySelectorAll('#f-tag-chips .chip')].filter(c=>c.dataset.tag==='夏款').length,
    }))()`);
    check('重复添加已有标签不会产生重复选项',
      dupChips.tagChips === 1, JSON.stringify(dupChips));

    await cdp.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1300);
    const dedup = await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      const p = rows.find(r => r.name === '去重测试');
      return p ? { tags: p.tags } : null;
    })()`);
    check('保存后的标签无重复项',
      dedup && dedup.tags.length === 1 && dedup.tags[0] === '夏款',
      JSON.stringify(dedup));

    const customStored = await cdp.eval(`(async () => {
      const t = await window.DB.getMeta('customTags', []);
      return { tags: t };
    })()`);
    check('输入预设标签不会污染自定义列表',
      customStored.tags.indexOf('夏款') === -1,
      JSON.stringify(customStored));

    // ---------- 大数据量性能 ----------
    // 先清空，保证批量测试的基数确定
    await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      for (const r of rows) { await window.DB.deleteProduct(r.id); }
      return 'ok';
    })()`);
    const bulk = await cdp.eval(`(async () => {
      const now = Date.now();
      const list = [];
      for (let i = 0; i < 300; i++) {
        list.push({
          id: 'bulk-' + i, name: '批量商品' + i, code: 'B' + (1000 + i),
          price: 50 + (i % 200),
          singleItems: i % 3 === 0 ? [{ name: '上衣', price: 30 + (i % 50) }] : [],
          singleMode: ['single','no','set','ask'][i % 4],
          tags: [['夏款'],['冬款'],['爆款'],['清仓']][i % 4],
          note: '', hasImage: false, createdAt: now - i * 1000, updatedAt: now - i * 1000
        });
      }
      const t0 = performance.now();
      await window.DB.bulkPutProducts(list);
      return { writeMs: Math.round(performance.now() - t0) };
    })()`);
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(3500);
    const perf = await cdp.eval(`(() => {
      const t0 = performance.now();
      const cards = document.querySelectorAll('#p-list .card').length;
      return {
        cards,
        total: document.getElementById('stat-total').textContent,
        renderMs: Math.round(performance.now() - t0)
      };
    })()`);
    check('300 件商品能正常加载', perf.cards === 300 && perf.total === '300',
      JSON.stringify({ cards: perf.cards, total: perf.total, writeMs: bulk.writeMs }));

    const searchPerf = await cdp.eval(`(async () => {
      document.querySelector('.tab[data-view="search"]').click();
      await new Promise(r=>setTimeout(r,400));
      const el=document.getElementById('s-input');
      const t0=performance.now();
      el.value='批量商品1'; el.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,600));
      return { ms: Math.round(performance.now()-t0), hits: document.querySelectorAll('#s-list .card').length };
    })()`);
    check('大数据量下搜索响应迅速', searchPerf.ms < 1500 && searchPerf.hits > 0,
      searchPerf.hits + ' 条命中，耗时 ' + searchPerf.ms + 'ms');

    await cdp.screenshot(path.join(shotsDir, 'edge-bulk.png'));

    // 清理批量数据（保留用户自己建的）
    await cdp.eval(`(async () => {
      const rows = await window.DB.allProducts();
      for (const r of rows) { if (String(r.id).startsWith('bulk-')) await window.DB.deleteProduct(r.id); }
      return 'ok';
    })()`);

    // ---------- 软键盘弹出时输入框不被遮挡 ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 400, deviceScaleFactor: 2, mobile: true
    });
    await cdp.eval(`document.querySelector('.tab[data-view="products"]').click(); 'ok'`);
    await sleep(400);
    await cdp.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(600);
    const kb = await cdp.eval(`(() => {
      const body=document.querySelector('#sheet-form .sheet__body');
      const name=document.getElementById('f-name');
      name.scrollIntoView({block:'center'});
      const r=name.getBoundingClientRect();
      const panel=document.querySelector('#sheet-form .sheet__panel').getBoundingClientRect();
      return { inputTop: Math.round(r.top), inputBottom: Math.round(r.bottom),
               panelTop: Math.round(panel.top), vh: window.innerHeight,
               scrollable: body.scrollHeight > body.clientHeight };
    })()`);
    check('屏幕变矮（模拟键盘）时表单仍可滚动且输入框可见',
      kb.scrollable && kb.inputBottom <= kb.vh + 1 && kb.inputTop >= kb.panelTop - 1,
      JSON.stringify(kb));

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await cdp.eval(`document.querySelector('#sheet-form [data-close]').click(); 'ok'`);
    await sleep(500);

    check('本场景无未捕获页面错误', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 3).join(' | '));

    await ctx.close();
    ctx = null;

    /* ============================================================
       场景 2：IndexedDB 完全不可用 → 自动降级 localStorage
       （在页面脚本执行前就把 window.indexedDB 抹掉，模拟隐私模式）
       ============================================================ */
    ctx = await launch({ port: 9335, shotsDir });
    const cdp2 = ctx.cdp;
    await cdp2.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        try { Object.defineProperty(window, 'indexedDB', { get: function(){ return undefined; }, configurable: true }); } catch (e) {}
        try { delete window.indexedDB; } catch (e) {}
      `
    });
    await cdp2.send('Page.navigate', { url: BASE });
    await sleep(3000);

    const fallback = await cdp2.eval(`(() => ({
      idbType: typeof window.indexedDB,
      mode: window.DB ? window.DB.mode : null,
      usingFallback: window.DB ? window.DB.usingFallback : null,
      booted: document.getElementById('stat-total') ? document.getElementById('stat-total').textContent : null,
      stateText: document.getElementById('p-state').textContent.trim().slice(0, 30)
    }))()`);
    check('IndexedDB 不可用时自动降级到 localStorage',
      fallback.mode === 'ls' && fallback.usingFallback === true, JSON.stringify(fallback));
    check('降级后界面仍能正常初始化', fallback.booted === '0', fallback.stateText);

    // 降级模式下走一遍完整增删改查
    await cdp2.eval(`document.getElementById('fab').click(); 'ok'`);
    await sleep(500);
    await cdp2.eval(`(() => {
      const set=(id,v)=>{const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('f-name','兼容模式商品');
      set('f-price','188');
      document.querySelector('#f-mode .seg__item[data-mode="single"]').click();
      const row = document.querySelector('#f-single-list .single-row');
      const rn = row.querySelector('[data-single="name"]');
      const rp = row.querySelector('[data-single="price"]');
      rn.value='上衣'; rn.dispatchEvent(new Event('input',{bubbles:true}));
      rp.value='78'; rp.dispatchEvent(new Event('input',{bubbles:true}));
      return 'ok';
    })()`);
    await sleep(200);
    await cdp2.eval(`document.getElementById('f-save').click(); 'ok'`);
    await sleep(1200);
    const lsSave = await cdp2.eval(`(() => {
      const c=document.querySelector('#p-list .card');
      return { count: document.querySelectorAll('#p-list .card').length,
               text: c ? c.textContent.replace(/\\s+/g,' ').trim() : '' };
    })()`);
    check('兼容模式下能新增商品', lsSave.count === 1 && lsSave.text.includes('¥188'), lsSave.text);

    await cdp2.send('Page.navigate', { url: BASE });
    await sleep(2500);
    const lsPersist = await cdp2.eval(`document.getElementById('stat-total').textContent`);
    check('兼容模式下重启后数据还在', lsPersist === '1', '共 ' + lsPersist + ' 件');

    const lsUsage = await cdp2.eval(`(() => {
      document.querySelector('.tab[data-view="settings"]').click();
      return new Promise(r => setTimeout(() => r({
        mode: document.getElementById('set-mode').textContent,
        usage: document.getElementById('set-usage').textContent,
        hint: document.getElementById('set-usage-hint').textContent
      }), 800));
    })()`);
    check('兼容模式设置页显示正确存储方式', lsUsage.mode.includes('localStorage'), lsUsage.mode);
    check('兼容模式显示占用空间', /KB|B|MB/.test(lsUsage.usage), lsUsage.usage);

    check('兼容模式无未捕获页面错误', cdp2.pageErrors.length === 0, cdp2.pageErrors.slice(0, 3).join(' | '));

    await ctx.close();
    ctx = null;

  } catch (err) {
    check('测试执行', false, err.message + '\n' + (err.stack || ''));
  } finally {
    if (ctx) { try { await ctx.close(); } catch (e) { /* 忽略 */ } }
  }

  const failed = report();
  process.exit(failed ? 1 : 0);
})();
