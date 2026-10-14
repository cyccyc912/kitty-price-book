/* ============================================================
   app.js · 喵喵价格本 主逻辑
   ------------------------------------------------------------
   功能：商品增删改查、图片压缩、搜索筛选排序、详情、备份恢复
   依赖：js/db.js（window.DB）
   ============================================================ */
(function () {
  'use strict';

  var APP_VERSION = '1.0.0';

  /* ============================================================
     常量
     ============================================================ */
  var MODES = {
    single: { key: 'single', label: '可单卖', short: '可单卖', desc: '可以拆开卖', cls: 'badge--single' },
    no:     { key: 'no',     label: '不可单卖', short: '不可单卖', desc: '只能整套', cls: 'badge--no' },
    set:    { key: 'set',    label: '仅整套', short: '仅整套', desc: '成套出售', cls: 'badge--set' },
    ask:    { key: 'ask',    label: '需询问', short: '需询问', desc: '先问上家', cls: 'badge--ask' }
  };
  var MODE_ORDER = ['single', 'no', 'set', 'ask'];

  var PRESET_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '均码', '90', '100', '110', '120', '130', '140', '150', '160'];
  var PRESET_TAGS = ['夏款', '冬款', '春秋款', '连衣裙', '上衣', '裤子', '外套', '套装', '童装', '亲子装', '爆款', '特价', '新品', '清仓'];

  var IMG_MAX = 800;       // 原图最长边
  var THUMB_MAX = 240;     // 缩略图最长边
  var IMG_QUALITY = 0.82;

  /* ============================================================
     小工具
     ============================================================ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 把用户输入转成价格数字；空/非法返回 null */
  function parsePrice(raw) {
    if (raw == null) return null;
    var s = String(raw).replace(/[^\d.]/g, '');
    if (!s) return null;
    var n = parseFloat(s);
    if (!isFinite(n) || n < 0) return null;
    return Math.round(n * 100) / 100;
  }

  /** 价格显示：整数不带小数，小数保留两位 */
  function fmtMoney(n) {
    if (n == null || !isFinite(n)) return '';
    if (Math.abs(n - Math.round(n)) < 0.005) return String(Math.round(n));
    return n.toFixed(2).replace(/0$/, '');
  }

  function fmtBytes(bytes) {
    if (bytes == null || !isFinite(bytes) || bytes <= 0) return '0 KB';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (v) { return v < 10 ? '0' + v : String(v); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function daysBetween(a, b) {
    if (!a) return Infinity;
    return Math.floor((b - a) / 86400000);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) {
      var k = String(v).trim();
      if (!k) return;
      var key = k.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push(k);
    });
    return out;
  }

  /* ============================================================
     全局状态
     ============================================================ */
  var state = {
    products: [],
    ready: false,
    fatal: null,
    view: 'products',
    editingId: null,
    detailId: null,
    draft: null,            // 表单草稿（含图片 blob）
    formImage: null,        // { blob, thumb, w, h, bytes, previewUrl } 或 null
    formImageCleared: false,
    formSizes: [],
    formTags: [],
    customSizes: [],
    customTags: [],
    lastBackupAt: 0,
    remindBackup: true,
    filters: {
      p: { mode: 'all', tag: null, size: null, sort: 'new' },
      s: { query: '', mode: 'all', tag: null, size: null, sort: 'new' }
    },
    query: '',
    searchMode: 'all'
  };

  var imgUrlCache = Object.create(null);   // id -> { full, thumb }

  /* ============================================================
     UI 基元：Toast / Dialog / Sheet
     ============================================================ */
  var toastTimer = null;
  function toast(msg, type) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' toast--' + type : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add('is-hiding');
      setTimeout(function () {
        el.hidden = true;
        el.classList.remove('is-hiding');
      }, 200);
    }, 2000);
  }

  /**
   * 通用弹窗
   * opts: { title, message, buttons: [{text, value, style:'primary'|'ghost'|'danger'}] }
   * 返回 Promise<value>，点遮罩/取消返回 null
   */
  function showDialog(opts) {
    return new Promise(function (resolve) {
      var el = $('#dialog');
      var actions = $('#dialog .dialog__actions');
      $('#dialog-title').textContent = opts.title || '提示';
      $('#dialog-msg').innerHTML = opts.message || '';
      actions.innerHTML = '';

      var buttons = opts.buttons || [
        { text: '取消', value: null, style: 'ghost' },
        { text: '确定', value: 'ok', style: 'primary' }
      ];

      var done = false;
      function finish(val) {
        if (done) return;
        done = true;
        el.hidden = true;
        document.removeEventListener('keydown', onKey);
        resolve(val);
      }
      function onKey(e) { if (e.key === 'Escape') finish(null); }

      buttons.forEach(function (b) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--' + (b.style || 'ghost');
        btn.textContent = b.text;
        btn.addEventListener('click', function () { finish(b.value); });
        actions.appendChild(btn);
      });

      var mask = $('#dialog .dialog__mask');
      mask.onclick = function () { finish(null); };
      document.addEventListener('keydown', onKey);
      el.hidden = false;
      // 自动聚焦主按钮，方便键盘操作
      var primary = actions.querySelector('.btn--primary, .btn--danger');
      if (primary) { try { primary.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ } }
    });
  }

  function confirmDialog(title, message, okText, danger) {
    return showDialog({
      title: title,
      message: message,
      buttons: [
        { text: '取消', value: false, style: 'ghost' },
        { text: okText || '确定', value: true, style: danger ? 'danger' : 'primary' }
      ]
    }).then(function (v) { return v === true; });
  }

  /* ---- 底部弹层 ---- */
  var sheetHistoryPushed = false;
  var suppressPop = false;

  function pushSheetHistory() {
    if (sheetHistoryPushed) return;
    try {
      history.pushState({ kittySheet: true }, '');
      sheetHistoryPushed = true;
    } catch (e) { /* 某些环境不支持，忽略 */ }
  }

  function popSheetHistory() {
    if (!sheetHistoryPushed) return;
    sheetHistoryPushed = false;
    suppressPop = true;
    try { history.back(); } catch (e) { /* 忽略 */ }
    setTimeout(function () { suppressPop = false; }, 80);
  }

  function openSheet(id) {
    var el = document.getElementById('sheet-' + id);
    if (!el) return;
    el.hidden = false;
    el.classList.remove('is-closing');
    document.body.style.overflow = 'hidden';
    pushSheetHistory();
  }

  function closeSheet(id, fromPop) {
    var el = document.getElementById('sheet-' + id);
    if (!el || el.hidden) return;
    el.classList.add('is-closing');
    var panel = el.querySelector('.sheet__body');
    if (panel) panel.scrollTop = 0;
    setTimeout(function () {
      el.hidden = true;
      el.classList.remove('is-closing');
      if ($('#sheet-form').hidden && $('#sheet-detail').hidden) {
        document.body.style.overflow = '';
      }
    }, 210);
    if (!fromPop) popSheetHistory();
  }

  window.addEventListener('popstate', function () {
    if (suppressPop) return;
    if (sheetHistoryPushed) {
      sheetHistoryPushed = false;
      if (!$('#sheet-form').hidden) closeSheet('form', true);
      if (!$('#sheet-detail').hidden) closeSheet('detail', true);
    }
  });

  /* ============================================================
     图片处理：读取 → 压缩 → 生成缩略图
     ============================================================ */
  function loadImageSource(file) {
    // 优先 createImageBitmap（能自动按 EXIF 方向摆正）
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(file); })
        .then(function (bmp) {
          return { source: bmp, width: bmp.width, height: bmp.height, cleanup: function () { if (bmp.close) bmp.close(); } };
        })
        .catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({
          source: img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          cleanup: function () { URL.revokeObjectURL(url); }
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这张图片无法识别，请换一张试试（HEIC 格式可先在相册里截图再选）'));
      };
      img.src = url;
    });
  }

  function drawToBlob(source, sw, sh, maxSide, quality) {
    var scale = Math.min(1, maxSide / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * scale));
    var h = Math.max(1, Math.round(sh * scale));
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (blob) resolve({ blob: blob, w: w, h: h });
          else reject(new Error('图片压缩失败'));
        }, 'image/jpeg', quality);
      } else {
        try {
          var dataUrl = canvas.toDataURL('image/jpeg', quality);
          var bin = atob(dataUrl.split(',')[1]);
          var u8 = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          resolve({ blob: new Blob([u8], { type: 'image/jpeg' }), w: w, h: h });
        } catch (e) { reject(e); }
      }
    });
  }

  function compressImage(file) {
    if (!file || !/^image\//.test(file.type || '')) {
      return Promise.reject(new Error('请选择图片文件'));
    }
    return loadImageSource(file).then(function (src) {
      return drawToBlob(src.source, src.width, src.height, IMG_MAX, IMG_QUALITY)
        .then(function (full) {
          return drawToBlob(src.source, src.width, src.height, THUMB_MAX, 0.75)
            .then(function (thumb) {
              src.cleanup();
              return {
                blob: full.blob,
                thumb: thumb.blob,
                w: full.w,
                h: full.h,
                bytes: full.blob.size + thumb.blob.size
              };
            });
        })
        .catch(function (err) { src.cleanup(); throw err; });
    });
  }

  /** 取图片的可显示 URL（带缓存） */
  function getImageUrl(id, useThumb) {
    if (!id) return Promise.resolve(null);
    var cache = imgUrlCache[id];
    var key = useThumb ? 'thumb' : 'full';
    if (cache && cache[key] !== undefined) return Promise.resolve(cache[key]);
    return DB.getImage(id).then(function (rec) {
      if (!rec) return null;
      var c = imgUrlCache[id] || (imgUrlCache[id] = {});
      var fullBlob = rec.blob || null;
      var thumbBlob = rec.thumb || null;
      if (fullBlob && c.full === undefined) c.full = URL.createObjectURL(fullBlob);
      if (thumbBlob && c.thumb === undefined) c.thumb = URL.createObjectURL(thumbBlob);
      if (c.thumb === undefined) c.thumb = c.full === undefined ? null : c.full;
      if (c.full === undefined) c.full = c.thumb === undefined ? null : c.thumb;
      return c[key] || c.full || c.thumb || null;
    }).catch(function () { return null; });
  }

  function dropImageCache(id) {
    var c = imgUrlCache[id];
    if (!c) return;
    if (c.full) { try { URL.revokeObjectURL(c.full); } catch (e) { /* 忽略 */ } }
    if (c.thumb && c.thumb !== c.full) { try { URL.revokeObjectURL(c.thumb); } catch (e) { /* 忽略 */ } }
    delete imgUrlCache[id];
  }

  /* ============================================================
     商品 CRUD
     ============================================================ */
  function normalizeProduct(raw) {
    var mode = MODES[raw.singleMode] ? raw.singleMode : 'ask';
    var p = {
      id: raw.id || DB.uuid(),
      name: String(raw.name || '').trim(),
      code: String(raw.code || '').trim(),
      price: parsePrice(raw.price),
      singlePrice: parsePrice(raw.singlePrice),
      singleMode: mode,
      sizes: Array.isArray(raw.sizes) ? uniq(raw.sizes) : [],
      tags: Array.isArray(raw.tags) ? uniq(raw.tags) : [],
      note: String(raw.note || '').trim(),
      hasImage: !!raw.hasImage,
      createdAt: raw.createdAt || Date.now(),
      updatedAt: raw.updatedAt || Date.now()
    };
    // 只有"可单卖"才保留单卖价；其余状态若填了也保留（用户可能先填后改）
    return p;
  }

  function getProduct(id) {
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === id) return state.products[i];
    }
    return null;
  }

  function upsertLocal(product) {
    var idx = -1;
    for (var i = 0; i < state.products.length; i++) {
      if (state.products[i].id === product.id) { idx = i; break; }
    }
    if (idx >= 0) state.products[idx] = product;
    else state.products.push(product);
  }

  function saveProduct(product, imagePayload) {
    product.updatedAt = Date.now();
    var hadImage = !!product.hasImage;
    // 有新图片 → 有图；没新图且用户点过"删除图片" → 无图；否则保持原状
    product.hasImage = imagePayload ? true : (hadImage && !state.formImageCleared);

    var chain = Promise.resolve();

    if (imagePayload) {
      chain = chain.then(function () {
        return DB.putImage(product.id, imagePayload.blob, {
          w: imagePayload.w, h: imagePayload.h, bytes: imagePayload.bytes, thumb: imagePayload.thumb
        });
      });
    } else if (hadImage && !product.hasImage) {
      chain = chain.then(function () { return DB.deleteImage(product.id); });
    }

    return chain
      .then(function () { return DB.putProduct(product); })
      .then(function () {
        dropImageCache(product.id);
        upsertLocal(product);
        return product;
      });
  }

  function deleteProductById(id) {
    return DB.deleteImage(id)
      .catch(function () { /* 图片可能本来就没有 */ })
      .then(function () { return DB.deleteProduct(id); })
      .then(function () {
        dropImageCache(id);
        state.products = state.products.filter(function (p) { return p.id !== id; });
      });
  }

  /* ============================================================
     筛选 / 搜索 / 排序
     ============================================================ */
  function matchQuery(p, q) {
    if (!q) return true;
    var needle = q.toLowerCase();
    var hay = [
      p.name, p.code, p.note,
      (p.tags || []).join(' '),
      (p.sizes || []).join(' ')
    ].join(' ').toLowerCase();
    // 空格分词，全部命中才算匹配
    var parts = needle.split(/\s+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      if (hay.indexOf(parts[i]) === -1) return false;
    }
    return true;
  }

  function sortProducts(list, sort) {
    var arr = list.slice();
    if (sort === 'price-desc') {
      arr.sort(function (a, b) {
        var av = a.price == null ? -Infinity : a.price;
        var bv = b.price == null ? -Infinity : b.price;
        if (bv !== av) return bv - av;
        return b.createdAt - a.createdAt;
      });
    } else if (sort === 'price-asc') {
      arr.sort(function (a, b) {
        var av = a.price == null ? Infinity : a.price;
        var bv = b.price == null ? Infinity : b.price;
        if (av !== bv) return av - bv;
        return b.createdAt - a.createdAt;
      });
    } else {
      arr.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    }
    return arr;
  }

  function filterProducts(f) {
    var list = state.products.filter(function (p) {
      if (f.mode && f.mode !== 'all' && p.singleMode !== f.mode) return false;
      if (f.tag && (p.tags || []).indexOf(f.tag) === -1) return false;
      if (f.size && (p.sizes || []).indexOf(f.size) === -1) return false;
      if (f.query && !matchQuery(p, f.query)) return false;
      return true;
    });
    return sortProducts(list, f.sort);
  }

  function allTags() {
    var out = [];
    state.products.forEach(function (p) { out = out.concat(p.tags || []); });
    return uniq(out).sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
  }

  function allSizes() {
    var out = [];
    state.products.forEach(function (p) { out = out.concat(p.sizes || []); });
    var list = uniq(out);
    list.sort(function (a, b) {
      var ai = PRESET_SIZES.indexOf(a), bi = PRESET_SIZES.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b, 'zh-Hans-CN');
    });
    return list;
  }

  /* ============================================================
     渲染：卡片与列表
     ============================================================ */
  var EMPTY_KITTY_SVG =
    '<svg viewBox="0 0 120 104" width="128" height="111" aria-hidden="true">' +
    '<path d="M22 42 L18 12 L46 28 Z" fill="#fff" stroke="#f5b8d3" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M98 42 L102 12 L74 28 Z" fill="#fff" stroke="#f5b8d3" stroke-width="3" stroke-linejoin="round"/>' +
    '<ellipse cx="60" cy="58" rx="44" ry="37" fill="#fff" stroke="#f5b8d3" stroke-width="3"/>' +
    '<ellipse cx="44" cy="55" rx="5" ry="6.4" fill="#5d4e56"/>' +
    '<ellipse cx="76" cy="55" rx="5" ry="6.4" fill="#5d4e56"/>' +
    '<ellipse cx="42.6" cy="52.6" rx="1.7" ry="1.7" fill="#fff"/>' +
    '<ellipse cx="74.6" cy="52.6" rx="1.7" ry="1.7" fill="#fff"/>' +
    '<ellipse cx="60" cy="68" rx="5" ry="3.8" fill="#ffc861"/>' +
    '<ellipse cx="32" cy="68" rx="8" ry="5" fill="#ffd0e2" opacity=".85"/>' +
    '<ellipse cx="88" cy="68" rx="8" ry="5" fill="#ffd0e2" opacity=".85"/>' +
    '<path d="M88 26 l8-8.5 8 8.5-8 8.5z" fill="#ff8fbe"/>' +
    '<circle cx="88" cy="26" r="3.6" fill="#e23e6e"/>' +
    '<path d="M60 96 v6" stroke="#f5b8d3" stroke-width="3" stroke-linecap="round"/>' +
    '</svg>';

  /* 卡片缩略图占位：小猫脸 */
  var THUMB_PH_SVG =
    '<svg viewBox="0 0 48 40" width="30" height="25" aria-hidden="true">' +
    '<path d="M9 17 L7 5 L19 12 Z" fill="#fff" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M39 17 L41 5 L29 12 Z" fill="#fff" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
    '<ellipse cx="24" cy="23" rx="17" ry="14" fill="#fff" stroke="currentColor" stroke-width="2"/>' +
    '<ellipse cx="18" cy="22" rx="2" ry="2.6" fill="currentColor"/>' +
    '<ellipse cx="30" cy="22" rx="2" ry="2.6" fill="currentColor"/>' +
    '<ellipse cx="24" cy="27" rx="2.1" ry="1.6" fill="currentColor" opacity=".55"/>' +
    '</svg>';

  function modeBadge(p) {
    var m = MODES[p.singleMode] || MODES.ask;
    return '<span class="badge ' + m.cls + '">' + m.label + '</span>';
  }

  function cardHtml(p) {
    var m = MODES[p.singleMode] || MODES.ask;
    var priceHtml;
    if (p.price != null) {
      priceHtml = '<span class="price-main"><small>售价</small><span class="yen">¥</span>' + fmtMoney(p.price) + '</span>';
    } else {
      priceHtml = '<span class="price-empty">未填售价</span>';
    }

    var singleHtml = '';
    if (p.singlePrice != null) {
      singleHtml = '<span class="price-single">单卖 ¥' + fmtMoney(p.singlePrice) + '</span>';
    } else if (p.singleMode === 'single') {
      singleHtml = '<span class="price-single price-single--none">单卖价待补</span>';
    } else if (p.singleMode === 'ask') {
      singleHtml = '<span class="price-single price-single--none">单卖需询问</span>';
    } else {
      singleHtml = '<span class="price-single price-single--none">' + (p.singleMode === 'set' ? '仅整套出售' : '不支持单卖') + '</span>';
    }

    var metaHtml = '';
    (p.sizes || []).slice(0, 4).forEach(function (s) {
      metaHtml += '<span class="size-mini">' + escapeHtml(s) + '</span>';
    });
    (p.tags || []).slice(0, 3).forEach(function (t) {
      metaHtml += '<span class="tag-mini">#' + escapeHtml(t) + '</span>';
    });

    var thumbInner = '<span class="card__thumb-ph">' + THUMB_PH_SVG + '</span>';

    return '' +
      '<article class="card" data-id="' + escapeHtml(p.id) + '" role="button" tabindex="0" aria-label="查看 ' + escapeHtml(p.name) + ' 详情">' +
        '<div class="card__thumb" data-thumb="' + escapeHtml(p.id) + '">' + (p.hasImage ? '' : thumbInner) + '</div>' +
        '<div class="card__main">' +
          '<div class="card__top">' +
            '<h3 class="card__name">' + escapeHtml(p.name || '未命名商品') + '</h3>' +
            (p.code ? '<span class="card__code">' + escapeHtml(p.code) + '</span>' : '') +
          '</div>' +
          '<div>' + modeBadge(p) + '</div>' +
          '<div class="card__prices">' + priceHtml + singleHtml + '</div>' +
          (metaHtml ? '<div class="card__meta">' + metaHtml + '</div>' : '') +
          (p.note ? '<div class="card__note">' + escapeHtml(p.note) + '</div>' : '') +
        '</div>' +
      '</article>';
  }

  function renderListInto(listEl, stateEl, items, emptyOpts) {
    listEl.innerHTML = '';
    if (!items.length) {
      stateEl.hidden = false;
      stateEl.className = 'state' + (emptyOpts.error ? ' state--error' : '');
      stateEl.innerHTML = emptyOpts.html;
      return;
    }
    stateEl.hidden = true;
    var frag = document.createDocumentFragment();
    var wrap = document.createElement('div');
    wrap.innerHTML = items.map(cardHtml).join('');
    while (wrap.firstChild) frag.appendChild(wrap.firstChild);
    listEl.appendChild(frag);
    hydrateThumbs(listEl, items);
  }

  function hydrateThumbs(root, items) {
    items.forEach(function (p) {
      if (!p.hasImage) return;
      var box = root.querySelector('[data-thumb="' + cssEscape(p.id) + '"]');
      if (!box) return;
      getImageUrl(p.id, true).then(function (url) {
        if (!url) {
          box.innerHTML = '<span class="card__thumb-ph">无图</span>';
          return;
        }
        var img = document.createElement('img');
        img.src = url;
        img.alt = p.name;
        img.loading = 'lazy';
        img.decoding = 'async';
        box.innerHTML = '';
        box.appendChild(img);
      });
    });
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  var EMPTY_PRODUCTS_HTML =
    '<div class="state__art">' + EMPTY_KITTY_SVG + '</div>' +
    '<p class="state__title">还没有商品哦</p>' +
    '<p class="state__desc">点右下角的 + 添加第一件衣服<br>记好售价和单卖价，以后随手就能查</p>' +
    '<div class="state__actions">' +
      '<button class="btn btn--primary btn--sm" data-action="add">添加商品</button>' +
      '<button class="btn btn--soft btn--sm" data-action="demo">载入示例</button>' +
    '</div>';

  var NO_RESULT_HTML =
    '<div class="state__art">' + EMPTY_KITTY_SVG + '</div>' +
    '<p class="state__title">没找到匹配的商品</p>' +
    '<p class="state__desc">换个关键词，或者把筛选条件放宽一点试试</p>' +
    '<div class="state__actions"><button class="btn btn--ghost btn--sm" data-action="reset">重置筛选</button></div>';

  function renderProductsView() {
    var f = state.filters.p;
    var items = filterProducts(f);
    var hasAny = state.products.length > 0;
    var noFilter = f.mode === 'all' && !f.tag && !f.size;
    var empty = (hasAny && !noFilter) ? { html: NO_RESULT_HTML } : { html: EMPTY_PRODUCTS_HTML };
    renderListInto($('#p-list'), $('#p-state'), items, empty);
    $('#p-count').textContent = items.length + ' / ' + state.products.length + ' 件';

    // 统计
    $('#stat-total').textContent = state.products.length;
    $('#stat-single').textContent = state.products.filter(function (p) { return p.singleMode === 'single'; }).length;
    $('#stat-ask').textContent = state.products.filter(function (p) { return p.singleMode === 'ask'; }).length;

    // 标签筛选
    var tags = allTags();
    var tagBlock = $('#p-tag-block');
    if (!tags.length) {
      tagBlock.hidden = true;
    } else {
      tagBlock.hidden = false;
      var tagHtml = '<button class="chip chip--tag' + (f.tag ? '' : ' is-active') + '" type="button" data-tag="">全部标签</button>';
      tags.forEach(function (t) {
        tagHtml += '<button class="chip chip--tag' + (f.tag === t ? ' is-active' : '') + '" type="button" data-tag="' + escapeHtml(t) + '">#' + escapeHtml(t) + '</button>';
      });
      var tagBox = $('#p-tags');
      if (tagBox.dataset.sig !== tagHtml) { tagBox.dataset.sig = tagHtml; tagBox.innerHTML = tagHtml; }
    }

    // 尺码筛选
    var sizes = allSizes();
    var sizeBlock = $('#p-size-block');
    if (!sizes.length) {
      sizeBlock.hidden = true;
    } else {
      sizeBlock.hidden = false;
      var sizeHtml = '<button class="chip chip--size' + (f.size ? '' : ' is-active') + '" type="button" data-size="">全部尺码</button>';
      sizes.forEach(function (s) {
        sizeHtml += '<button class="chip chip--size' + (f.size === s ? ' is-active' : '') + '" type="button" data-size="' + escapeHtml(s) + '">' + escapeHtml(s) + '</button>';
      });
      var sizeBox = $('#p-sizes');
      if (sizeBox.dataset.sig !== sizeHtml) { sizeBox.dataset.sig = sizeHtml; sizeBox.innerHTML = sizeHtml; }
    }
  }

  function renderSearchView() {
    var f = state.filters.s;
    var items = filterProducts(f);
    var noQuery = !f.query && f.mode === 'all' && !f.tag && !f.size;

    var empty;
    if (noQuery) {
      empty = {
        html: '<div class="state__art">' + EMPTY_KITTY_SVG + '</div>' +
              '<p class="state__title">想找哪件衣服？</p>' +
              '<p class="state__desc">输入商品名、货号或标签<br>也可以点下面的标签、尺码快速筛选</p>'
      };
    } else {
      empty = { html: NO_RESULT_HTML };
    }
    renderListInto($('#s-list'), $('#s-state'), items, empty);
    $('#s-count').textContent = items.length + ' 件结果';
    $('#s-clear').hidden = !f.query;

    // 标签筛选
    var tags = allTags();
    var tagBlock = $('#s-tag-block');
    var tagBox = $('#s-tags');
    if (!tags.length) {
      tagBlock.hidden = true;
    } else {
      tagBlock.hidden = false;
      var tagHtml = '<button class="chip chip--tag' + (f.tag ? '' : ' is-active') + '" type="button" data-tag="">全部标签</button>';
      tags.forEach(function (t) {
        tagHtml += '<button class="chip chip--tag' + (f.tag === t ? ' is-active' : '') + '" type="button" data-tag="' + escapeHtml(t) + '">#' + escapeHtml(t) + '</button>';
      });
      if (tagBox.dataset.sig !== tagHtml) {
        tagBox.dataset.sig = tagHtml;
        tagBox.innerHTML = tagHtml;
      }
    }

    // 尺码筛选
    var sizes = allSizes();
    var sizeBlock = $('#s-size-block');
    var sizeBox = $('#s-sizes');
    if (!sizes.length) {
      sizeBlock.hidden = true;
    } else {
      sizeBlock.hidden = false;
      var sizeHtml = '<button class="chip chip--size' + (f.size ? '' : ' is-active') + '" type="button" data-size="">全部尺码</button>';
      sizes.forEach(function (s) {
        sizeHtml += '<button class="chip chip--size' + (f.size === s ? ' is-active' : '') + '" type="button" data-size="' + escapeHtml(s) + '">' + escapeHtml(s) + '</button>';
      });
      if (sizeBox.dataset.sig !== sizeHtml) {
        sizeBox.dataset.sig = sizeHtml;
        sizeBox.innerHTML = sizeHtml;
      }
    }
  }

  function renderStatsAndSettings() {
    var count = state.products.length;
    $('#set-count').textContent = count + ' 件';
    $('#set-version').textContent = APP_VERSION;
    $('#set-mode').textContent = '存储方式：' + (DB.usingFallback ? 'localStorage（兼容模式）' : 'IndexedDB');

    DB.allImages().then(function (rows) {
      var bytes = 0;
      rows.forEach(function (r) { bytes += (r.bytes || (r.blob && r.blob.size) || 0); });
      $('#set-imgcount').textContent = rows.length + ' 张';
      var approxQuota = DB.usingFallback ? 5 * 1024 * 1024 : 500 * 1024 * 1024;
      $('#set-usage').textContent = fmtBytes(bytes);
      var pct = Math.min(100, Math.max(2, (bytes / approxQuota) * 100));
      $('#set-meter').style.width = pct.toFixed(1) + '%';
      $('#set-usage-hint').textContent = '数据全部保存在这台手机的浏览器里，不会上传到任何服务器。' +
        (DB.usingFallback ? '当前是兼容模式，空间有限，建议图片少放几张。' : '图片已自动压缩，正常存几百件没问题。');
    }).catch(function () {
      $('#set-imgcount').textContent = '—';
      $('#set-usage').textContent = '无法读取';
    });

    renderBackupTip();
  }

  function renderBackupTip() {
    var days = daysBetween(state.lastBackupAt, Date.now());
    var tip = $('#backup-tip');
    var text = $('#backup-tip-text');
    var dot = $('#tab-dot');
    tip.className = 'backup-tip';
    dot.hidden = true;

    if (!state.products.length) {
      text.textContent = '还没有商品，等录入后再来备份吧。';
      return;
    }
    if (!state.lastBackupAt) {
      tip.classList.add('backup-tip--warn');
      text.textContent = '还没有备份过。数据只存在这台手机上，建议现在导出一次。';
      dot.hidden = !state.remindBackup;
      return;
    }
    if (days >= 7) {
      tip.classList.add('backup-tip--warn');
      text.textContent = '已经 ' + days + ' 天没有备份了（上次 ' + fmtDate(state.lastBackupAt) + '），建议导出一次。';
      dot.hidden = !state.remindBackup;
      return;
    }
    tip.classList.add('backup-tip--ok');
    text.textContent = '上次备份：' + fmtDate(state.lastBackupAt) + '（' + (days <= 0 ? '今天' : days + ' 天前') + '）';
  }

  function renderAll() {
    if (!state.ready) return;
    renderProductsView();
    renderSearchView();
    renderStatsAndSettings();
  }

  /* ============================================================
     视图切换
     ============================================================ */
  function switchView(name) {
    state.view = name;
    $$('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.id === 'view-' + name);
    });
    $$('.tab').forEach(function (t) {
      var on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    var subs = {
      products: '价格随手查 · 离线可用',
      search: '搜商品名 / 货号 / 标签',
      settings: '备份与数据管理'
    };
    $('#appbar-sub').textContent = subs[name] || '';
    $('#fab').classList.toggle('is-hidden', name === 'settings');
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (name === 'search') {
      renderSearchView();
      setTimeout(function () {
        try { $('#s-input').focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
      }, 240);
    }
    if (name === 'settings') renderStatsAndSettings();
  }

  /* ============================================================
     表单：打开 / 填充 / 收集 / 保存
     ============================================================ */
  function openForm(id) {
    state.editingId = id || null;
    state.formImage = null;
    state.formImageCleared = false;
    var p = id ? getProduct(id) : null;

    $('#form-title').textContent = p ? '编辑商品' : '新增商品';
    $('#f-name').value = p ? p.name : '';
    $('#f-code').value = p ? p.code : '';
    $('#f-price').value = p && p.price != null ? fmtMoney(p.price) : '';
    $('#f-single').value = p && p.singlePrice != null ? fmtMoney(p.singlePrice) : '';
    $('#f-note').value = p ? p.note : '';
    state.formSizes = p ? (p.sizes || []).slice() : [];
    state.formTags = p ? (p.tags || []).slice() : [];

    setMode(p ? p.singleMode : 'single');
    $('#f-name-err').hidden = true;
    $('#f-name').parentNode.classList.remove('is-invalid');

    // 图片
    var img = $('#f-photo-img');
    var ph = $('#f-photo-ph');
    img.hidden = true;
    img.removeAttribute('src');
    ph.hidden = false;
    $('#f-photo-clear').hidden = true;

    if (p && p.hasImage) {
      getImageUrl(p.id, false).then(function (url) {
        if (!url || state.editingId !== id) return;
        img.src = url;
        img.hidden = false;
        ph.hidden = true;
        $('#f-photo-clear').hidden = false;
      });
    }

    renderSizeChips();
    renderTagChips();
    openSheet('form');
    setTimeout(function () {
      var body = $('#sheet-form .sheet__body');
      if (body) body.scrollTop = 0;
    }, 30);
    maybeRestoreDraft(id || null);
  }

  /* ---- 表单草稿：防止误触返回 / 切后台丢失已填内容 ---- */
  var saveDraftSoon = debounce(function () {
    if ($('#sheet-form').hidden) return;
    var d = {
      editingId: state.editingId || null,
      name: $('#f-name').value,
      code: $('#f-code').value,
      price: $('#f-price').value,
      single: $('#f-single').value,
      note: $('#f-note').value,
      mode: currentMode(),
      sizes: state.formSizes.slice(),
      tags: state.formTags.slice(),
      image: state.formImage
        ? { blob: state.formImage.blob, w: state.formImage.w, h: state.formImage.h, bytes: state.formImage.bytes }
        : null,
      savedAt: Date.now()
    };
    DB.setMeta('draft', d).catch(function () { /* 草稿存不下就算了 */ });
  }, 500);

  function clearFormDraft() {
    DB.setMeta('draft', null).catch(function () { /* 忽略 */ });
  }

  function maybeRestoreDraft(editingId) {
    DB.getMeta('draft', null).then(function (d) {
      if (!d || !d.savedAt) return;
      if ((d.editingId || null) !== editingId) return;
      if (Date.now() - d.savedAt > 12 * 3600 * 1000) return;
      var hasContent = (d.name && d.name.trim()) || (d.price && String(d.price).trim()) || (d.single && String(d.single).trim());
      if (!hasContent) return;
      return showDialog({
        title: '继续上次填写？',
        message: '上次填到一半的内容还在：<br><b>' + escapeHtml(String(d.name || '未命名')) + '</b><br><br>要接着填吗？',
        buttons: [
          { text: '不用了', value: false, style: 'ghost' },
          { text: '继续填写', value: true, style: 'primary' }
        ]
      }).then(function (ok) {
        if (!ok) { clearFormDraft(); return; }
        applyDraft(d);
      });
    }).catch(function () { /* 忽略 */ });
  }

  function applyDraft(d) {
    $('#f-name').value = d.name || '';
    $('#f-code').value = d.code || '';
    $('#f-price').value = d.price || '';
    $('#f-single').value = d.single || '';
    $('#f-note').value = d.note || '';
    state.formSizes = Array.isArray(d.sizes) ? d.sizes.slice() : [];
    state.formTags = Array.isArray(d.tags) ? d.tags.slice() : [];
    setMode(d.mode || 'single');
    renderSizeChips();
    renderTagChips();
    if (d.image && d.image.blob instanceof Blob) {
      state.formImage = { blob: d.image.blob, thumb: null, w: d.image.w || 0, h: d.image.h || 0, bytes: d.image.bytes || d.image.blob.size };
      var url = URL.createObjectURL(d.image.blob);
      var img = $('#f-photo-img');
      img.src = url;
      img.hidden = false;
      $('#f-photo-ph').hidden = true;
      $('#f-photo-clear').hidden = false;
      state.draft = state.draft || {};
      state.draft.previewUrl = url;
    }
    toast('已恢复上次填写的内容', 'ok');
  }

  function setMode(mode) {
    if (!MODES[mode]) mode = 'ask';
    state.draft = state.draft || {};
    state.draft.singleMode = mode;
    $$('#f-mode .seg__item').forEach(function (btn) {
      var on = btn.dataset.mode === mode;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    var isSingle = mode === 'single';
    $('#f-single-req').textContent = isSingle ? '建议填写' : '选填';
    $('#f-single-hint').textContent = isSingle
      ? '这件可以拆开卖，填上单卖价，报价的时候直接念给客人听～'
      : (mode === 'ask'
          ? '选择「需询问」时，可以先留空，问清楚上家再回来补。'
          : '这个状态一般不需要单卖价，留空就好。');
    var field = $('#f-single-field');
    field.classList.toggle('is-emphasized', isSingle);
    if (isSingle) {
      $('#f-single').setAttribute('placeholder', '建议填写');
    } else {
      $('#f-single').setAttribute('placeholder', '0');
    }
  }

  function currentMode() {
    var active = $('#f-mode .seg__item.is-active');
    return active ? active.dataset.mode : 'ask';
  }

  function renderSizeChips() {
    var pool = uniq(PRESET_SIZES.concat(state.customSizes));
    var html = pool.map(function (s) {
      var on = state.formSizes.indexOf(s) >= 0;
      return '<button class="chip' + (on ? ' is-active' : '') + '" type="button" data-size="' + escapeHtml(s) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + escapeHtml(s) + '</button>';
    }).join('');
    $('#f-size-chips').innerHTML = html;
  }

  function renderTagChips() {
    var pool = uniq(PRESET_TAGS.concat(state.customTags));
    var html = pool.map(function (t) {
      var on = state.formTags.indexOf(t) >= 0;
      return '<button class="chip chip--tag' + (on ? ' is-active' : '') + '" type="button" data-tag="' + escapeHtml(t) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + escapeHtml(t) + '</button>';
    }).join('');
    $('#f-tag-chips').innerHTML = html;
  }

  function toggleInArray(arr, val) {
    var i = arr.indexOf(val);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(val);
    return arr;
  }

  function collectForm() {
    var name = $('#f-name').value.trim();
    if (!name) {
      $('#f-name-err').hidden = false;
      $('#f-name').parentNode.classList.add('is-invalid');
      $('#f-name').focus();
      return null;
    }
    var mode = currentMode();
    var single = parsePrice($('#f-single').value);

    if (mode === 'single' && single == null) {
      // 强烈建议但不强制：给出一次确认
      state.draft = state.draft || {};
      state.draft.pendingSingleWarn = true;
    }

    var base = state.editingId ? getProduct(state.editingId) : null;
    return normalizeProduct({
      id: state.editingId || DB.uuid(),
      name: name,
      code: $('#f-code').value,
      price: $('#f-price').value,
      singlePrice: $('#f-single').value,
      singleMode: mode,
      sizes: state.formSizes,
      tags: state.formTags,
      note: $('#f-note').value,
      hasImage: base ? base.hasImage : false,
      createdAt: base ? base.createdAt : Date.now(),
      updatedAt: Date.now()
    });
  }

  var saving = false;

  function doSave() {
    // 防止连点两次保存出两条重复商品
    if (saving) return;

    var product = collectForm();
    if (!product) {
      toast('请先填写商品名');
      return;
    }

    saving = true;
    $('#f-save').disabled = true;

    var needsWarn = product.singleMode === 'single' && product.singlePrice == null;
    var proceed = needsWarn
      ? confirmDialog('还没填单卖价', '你选择了「可单卖」，但没有填单卖价。<br>以后客人问单卖多少钱，这里会显示「单卖价待补」。<br><br>确定就这样保存吗？', '就这样保存')
      : Promise.resolve(true);

    proceed.then(function (ok) {
      if (!ok) {
        $('#f-single').focus();
        return;
      }
      var payload = state.formImage;
      return saveProduct(product, payload).then(function () {
        state.formImage = null;
        state.formImageCleared = false;
        state.editingId = null;
        clearFormDraft();
        closeSheet('form');
        renderAll();
        toast('已保存「' + product.name + '」', 'ok');
      }).catch(function (err) {
        toast(err && err.message ? err.message : '保存失败，请重试', 'err');
      });
    }).then(function () {
      saving = false;
      $('#f-save').disabled = false;
    }, function () {
      saving = false;
      $('#f-save').disabled = false;
    });
  }

  /* ============================================================
     详情
     ============================================================ */
  function openDetail(id) {
    var p = getProduct(id);
    if (!p) { toast('商品不存在', 'err'); return; }
    state.detailId = id;
    var m = MODES[p.singleMode] || MODES.ask;

    var hero = '<div class="detail-hero' + (p.hasImage ? ' detail-hero--has-image' : '') + '" id="d-hero">' +
      (p.hasImage ? '<i class="spinner spinner--dark"></i>' : '<span>还没有图片，点「编辑」可以补一张</span>') +
      '</div>';

    var priceBox =
      '<div class="price-box price-box--main">' +
        '<div class="price-box__label">售价（整套 / 默认）</div>' +
        '<div class="price-box__value">' + (p.price != null ? '¥' + fmtMoney(p.price) : '未填写') + '</div>' +
        '<div class="price-box__note">整套带走按这个价</div>' +
      '</div>';

    var singleBox;
    if (p.singlePrice != null) {
      singleBox = '<div class="price-box price-box--single">' +
          '<div class="price-box__label">单卖价</div>' +
          '<div class="price-box__value">¥' + fmtMoney(p.singlePrice) + '</div>' +
          '<div class="price-box__note">' + (p.singleMode === 'single' ? '可以单卖' : '当前状态：' + m.label) + '</div>' +
        '</div>';
    } else {
      singleBox = '<div class="price-box price-box--empty">' +
          '<div class="price-box__label">单卖价</div>' +
          '<div class="price-box__value">' + (p.singleMode === 'ask' ? '需询问' : '无') + '</div>' +
          '<div class="price-box__note">' + m.label + ' · ' + m.desc + '</div>' +
        '</div>';
    }

    var rows = '';
    rows += '<div class="detail-row"><span class="detail-row__k">状态</span><span class="detail-row__v">' + modeBadge(p) + '</span></div>';
    rows += '<div class="detail-row"><span class="detail-row__k">货号</span><span class="detail-row__v' + (p.code ? '' : ' detail-row__v--muted') + '">' + (p.code ? escapeHtml(p.code) : '未填写') + '</span></div>';
    rows += '<div class="detail-row"><span class="detail-row__k">尺码</span><span class="detail-row__v' + (p.sizes.length ? '' : ' detail-row__v--muted') + '">' + (p.sizes.length ? p.sizes.map(escapeHtml).join(' / ') : '未填写') + '</span></div>';
    rows += '<div class="detail-row"><span class="detail-row__k">标签</span><span class="detail-row__v' + (p.tags.length ? '' : ' detail-row__v--muted') + '">' + (p.tags.length ? p.tags.map(function (t) { return '#' + escapeHtml(t); }).join(' ') : '未填写') + '</span></div>';
    rows += '<div class="detail-row"><span class="detail-row__k">添加时间</span><span class="detail-row__v detail-row__v--muted">' + fmtDate(p.createdAt) + '</span></div>';

    var noteBlock = p.note
      ? '<div class="detail-block"><div class="detail-block__title">备注</div><div class="detail-row__v">' + escapeHtml(p.note) + '</div></div>'
      : '';

    $('#d-body').innerHTML =
      hero +
      '<h3 class="detail-name">' + escapeHtml(p.name || '未命名商品') + '</h3>' +
      '<div class="detail-sub">' + modeBadge(p) + (p.code ? '<span class="card__code">' + escapeHtml(p.code) + '</span>' : '') + '</div>' +
      '<div class="detail-prices">' + priceBox + singleBox + '</div>' +
      '<div class="detail-block"><div class="detail-block__title">商品信息</div>' + rows + '</div>' +
      noteBlock;

    $('#d-copy-single').disabled = p.singlePrice == null;

    openSheet('detail');

    if (p.hasImage) {
      getImageUrl(p.id, false).then(function (url) {
        var hero2 = $('#d-hero');
        if (!hero2 || state.detailId !== id) return;
        if (!url) { hero2.innerHTML = '<span>图片读取失败</span>'; return; }
        var img = document.createElement('img');
        img.src = url;
        img.alt = p.name;
        img.id = 'd-hero-img';
        hero2.innerHTML = '';
        hero2.appendChild(img);
        hero2.style.cursor = 'zoom-in';
        hero2.addEventListener('click', function () { openLightbox(url, p.name); });
      });
    }
  }

  function openLightbox(url, alt) {
    $('#lightbox-img').src = url;
    $('#lightbox-img').alt = alt || '';
    $('#lightbox').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    $('#lightbox').hidden = true;
    $('#lightbox-img').removeAttribute('src');
    if ($('#sheet-form').hidden && $('#sheet-detail').hidden) document.body.style.overflow = '';
  }

  /* ============================================================
     复制
     ============================================================ */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('复制失败'));
      } catch (e) { reject(e); }
    });
  }

  function productToText(p) {
    var m = MODES[p.singleMode] || MODES.ask;
    var lines = ['【' + (p.name || '未命名商品') + '】'];
    if (p.code) lines.push('货号：' + p.code);
    lines.push('售价：' + (p.price != null ? '¥' + fmtMoney(p.price) : '未填写'));
    lines.push('单卖：' + m.label + (p.singlePrice != null ? ' · ¥' + fmtMoney(p.singlePrice) : ''));
    if (p.sizes.length) lines.push('尺码：' + p.sizes.join(' / '));
    if (p.tags.length) lines.push('标签：' + p.tags.join(' / '));
    if (p.note) lines.push('备注：' + p.note);
    return lines.join('\n');
  }

  function copyWithToast(text, label) {
    copyText(text).then(function () {
      toast(label + '已复制', 'ok');
    }).catch(function () {
      showDialog({
        title: '复制失败',
        message: '当前浏览器不允许自动复制，<br>可以长按下面内容手动复制：<br><br><textarea class="input textarea" rows="5" readonly>' + escapeHtml(text) + '</textarea>',
        buttons: [{ text: '知道了', value: 'ok', style: 'primary' }]
      });
    });
  }

  /* ============================================================
     导出 / 导入 / 清空
     ============================================================ */
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('图片读取失败')); };
      fr.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    try {
      var parts = String(dataUrl).split(',');
      var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
      var bin = atob(parts[1] || '');
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: mime });
    } catch (e) {
      return null;
    }
  }

  function buildBackup(includeImages) {
    var payload = {
      app: 'kitty-price-book',
      version: APP_VERSION,
      schema: 1,
      exportedAt: new Date().toISOString(),
      withImages: !!includeImages,
      products: state.products.map(function (p) { return JSON.parse(JSON.stringify(p)); }),
      images: {}
    };
    if (!includeImages) return Promise.resolve(payload);
    return DB.allImages().then(function (rows) {
      var jobs = rows.map(function (r) {
        if (!r.blob) return Promise.resolve();
        return blobToDataUrl(r.blob).then(function (d) { payload.images[r.id] = d; });
      });
      return Promise.all(jobs).then(function () { return payload; });
    });
  }

  function downloadJson(payload, filename) {
    var text = JSON.stringify(payload);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function stamp() {
    var d = new Date();
    var p = function (v) { return v < 10 ? '0' + v : String(v); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function doExport() {
    if (!state.products.length) {
      toast('还没有商品可以备份');
      return;
    }
    var btn = $('#set-export');
    btn.disabled = true;
    btn.textContent = '正在打包…';

    showDialog({
      title: '导出备份',
      message: '要连图片一起导出吗？<br><br><b>含图片</b>：文件较大（每张约 100KB），换手机能完整恢复。<br><b>仅文字</b>：文件很小，图片需要重新拍。',
      buttons: [
        { text: '取消', value: null, style: 'ghost' },
        { text: '仅文字', value: 'text', style: 'soft' },
        { text: '含图片', value: 'full', style: 'primary' }
      ]
    }).then(function (choice) {
      if (!choice) {
        btn.disabled = false;
        btn.textContent = '导出 JSON 备份';
        return;
      }
      var withImages = choice === 'full';
      buildBackup(withImages).then(function (payload) {
        downloadJson(payload, 'kitty-price-backup-' + stamp() + (withImages ? '-full' : '-text') + '.json');
        state.lastBackupAt = Date.now();
        return DB.setMeta('lastBackupAt', state.lastBackupAt).then(function () {
          renderBackupTip();
          toast('备份已导出，请保存到「文件」App', 'ok');
        });
      }).catch(function (err) {
        toast(err && err.message ? err.message : '导出失败', 'err');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '导出 JSON 备份';
      });
    });
  }

  function doImportFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(reader.result);
      } catch (e) {
        toast('文件不是有效的 JSON', 'err');
        return;
      }
      var list = data && Array.isArray(data.products) ? data.products
                : (Array.isArray(data) ? data : null);
      if (!list) {
        toast('这个备份文件里没有商品数据', 'err');
        return;
      }
      var images = (data && data.images) || {};
      var imgCount = Object.keys(images).length;

      showDialog({
        title: '导入备份',
        message: '备份里有 <b>' + list.length + '</b> 件商品' +
                 (imgCount ? '、<b>' + imgCount + '</b> 张图片' : '') + '。<br>导出时间：' +
                 (data && data.exportedAt ? fmtDate(new Date(data.exportedAt).getTime()) : '未知') +
                 '<br><br><b>合并</b>：保留现有商品，同 ID 覆盖。<br><b>覆盖</b>：先清空当前全部数据再导入。',
        buttons: [
          { text: '取消', value: null, style: 'ghost' },
          { text: '合并追加', value: 'merge', style: 'soft' },
          { text: '覆盖全部', value: 'replace', style: 'primary' }
        ]
      }).then(function (choice) {
        if (!choice) return;
        var normalized = list.map(normalizeProduct).filter(function (p) { return p.name; });
        if (!normalized.length) {
          toast('备份里没有可用的商品', 'err');
          return;
        }
        var run = choice === 'replace'
          ? DB.clearAll().then(function () {
              state.products = [];
              Object.keys(imgUrlCache).forEach(dropImageCache);
            })
          : Promise.resolve();

        run.then(function () {
          return DB.bulkPutProducts(normalized);
        }).then(function () {
          var jobs = Object.keys(images).map(function (id) {
            var blob = dataUrlToBlob(images[id]);
            if (!blob) return Promise.resolve();
            return DB.putImage(id, blob, { bytes: blob.size }).catch(function () { /* 单张失败不影响整体 */ });
          });
          return Promise.all(jobs);
        }).then(function () {
          return DB.allProducts();
        }).then(function (rows) {
          state.products = rows.map(normalizeProduct);
          Object.keys(imgUrlCache).forEach(dropImageCache);
          renderAll();
          toast('导入完成，共 ' + state.products.length + ' 件商品', 'ok');
        }).catch(function (err) {
          toast(err && err.message ? err.message : '导入失败', 'err');
        });
      });
    };
    reader.onerror = function () { toast('文件读取失败', 'err'); };
    reader.readAsText(file);
  }

  function doClear() {
    if (!state.products.length) {
      toast('现在就是空的呀');
      return;
    }
    showDialog({
      title: '清空全部数据',
      message: '将删除 <b>' + state.products.length + '</b> 件商品和全部图片，<br>这个操作<b>无法撤销</b>。<br><br>建议先导出一份备份。',
      buttons: [
        { text: '取消', value: null, style: 'ghost' },
        { text: '先备份', value: 'backup', style: 'soft' },
        { text: '确认清空', value: 'clear', style: 'danger' }
      ]
    }).then(function (v) {
      if (v === 'backup') { doExport(); return; }
      if (v !== 'clear') return;
      return confirmDialog('真的确定吗？', '这是最后一次确认。<br>清空后所有商品和图片都会消失。', '确定清空', true)
        .then(function (ok) {
          if (!ok) return;
          return DB.clearAll().then(function () {
            state.products = [];
            state.lastBackupAt = 0;
            Object.keys(imgUrlCache).forEach(dropImageCache);
            renderAll();
            toast('已清空', 'ok');
          }).catch(function (err) {
            toast(err && err.message ? err.message : '清空失败', 'err');
          });
        });
    });
  }

  /* ============================================================
     示例数据
     ============================================================ */
  function sampleProducts() {
    var now = Date.now();
    var raw = [
      { name: '粉色碎花连衣裙', code: 'A1023', price: 199, singlePrice: 89, singleMode: 'single', sizes: ['S', 'M', 'L'], tags: ['夏款', '连衣裙', '爆款'], note: '只有 M 码了，面料偏薄' },
      { name: '奶白针织开衫', code: 'B2088', price: 159, singlePrice: null, singleMode: 'no', sizes: ['均码'], tags: ['春秋款', '上衣'], note: '整套两件套，不拆卖' },
      { name: '牛仔背带裤套装', code: 'C3311', price: 268, singlePrice: null, singleMode: 'set', sizes: ['M', 'L', 'XL'], tags: ['套装', '春秋款'], note: '' },
      { name: '小熊卫衣亲子装', code: 'D4512', price: 128, singlePrice: 68, singleMode: 'single', sizes: ['100', '120', '140'], tags: ['童装', '亲子装', '新品'], note: '大人小孩同款' },
      { name: '格纹半身裙', code: 'E5107', price: 118, singlePrice: null, singleMode: 'ask', sizes: ['S', 'M'], tags: ['春秋款'], note: '单卖要问一下上家' }
    ];
    return raw.map(function (r, i) {
      return normalizeProduct({
        id: DB.uuid(),
        name: r.name, code: r.code, price: r.price, singlePrice: r.singlePrice,
        singleMode: r.singleMode, sizes: r.sizes, tags: r.tags, note: r.note,
        hasImage: false,
        createdAt: now - i * 60000,
        updatedAt: now - i * 60000
      });
    });
  }

  function doLoadDemo() {
    var list = sampleProducts();
    DB.bulkPutProducts(list).then(function () {
      return DB.allProducts();
    }).then(function (rows) {
      state.products = rows.map(normalizeProduct);
      renderAll();
      toast('已载入 ' + list.length + ' 件示例商品', 'ok');
    }).catch(function (err) {
      toast(err && err.message ? err.message : '载入失败', 'err');
    });
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindEvents() {
    /* ---- 底部导航 ---- */
    $('#tabbar').addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (!tab) return;
      switchView(tab.dataset.view);
    });

    /* ---- 新增按钮 ---- */
    $('#fab').addEventListener('click', function () { openForm(null); });
    $('#btn-quick-add').addEventListener('click', function () { openForm(null); });

    /* ---- 商品列表交互 ---- */
    $('#view-products').addEventListener('click', function (e) {
      var actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        var a = actionBtn.dataset.action;
        if (a === 'add') openForm(null);
        if (a === 'demo') doLoadDemo();
        if (a === 'reset') { resetProductFilters(); }
        return;
      }
      var chip = e.target.closest('#p-chips .chip');
      if (chip) {
        $$('#p-chips .chip').forEach(function (c) { c.classList.remove('is-active'); });
        chip.classList.add('is-active');
        state.filters.p.mode = chip.dataset.filter;
        renderProductsView();
        return;
      }
      var card = e.target.closest('.card');
      if (card) openDetail(card.dataset.id);
    });

    $('#view-products').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest('.card');
      if (card) { e.preventDefault(); openDetail(card.dataset.id); }
    });

    $('#p-tags').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      state.filters.p.tag = chip.dataset.tag || null;
      renderProductsView();
    });

    $('#p-sizes').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      state.filters.p.size = chip.dataset.size || null;
      renderProductsView();
    });

    $('#p-sort').addEventListener('change', function () {
      state.filters.p.sort = this.value;
      renderProductsView();
    });

    /* ---- 搜索页 ---- */
    var onSearch = debounce(function (v) {
      state.filters.s.query = v;
      renderSearchView();
    }, 130);

    $('#s-input').addEventListener('input', function () { onSearch(this.value.trim()); });
    $('#s-input').addEventListener('search', function () { onSearch(this.value.trim()); });

    $('#s-clear').addEventListener('click', function () {
      $('#s-input').value = '';
      state.filters.s.query = '';
      renderSearchView();
      $('#s-input').focus();
    });

    $('#view-search').addEventListener('click', function (e) {
      var actionBtn = e.target.closest('[data-action]');
      if (actionBtn && actionBtn.dataset.action === 'reset') { resetSearchFilters(); return; }
      var card = e.target.closest('.card');
      if (card) openDetail(card.dataset.id);
    });

    $('#s-tags').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      state.filters.s.tag = chip.dataset.tag || null;
      renderSearchView();
    });

    $('#s-sizes').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      state.filters.s.size = chip.dataset.size || null;
      renderSearchView();
    });

    $('#s-reset').addEventListener('click', resetSearchFilters);

    /* ---- 设置页 ---- */
    $('#set-export').addEventListener('click', doExport);
    $('#set-import').addEventListener('click', function () { $('#set-import-file').click(); });
    $('#set-import-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      doImportFile(f);
    });
    $('#set-clear').addEventListener('click', doClear);
    $('#set-demo').addEventListener('click', function () {
      if (state.products.length) {
        confirmDialog('载入示例商品？', '会在现有 ' + state.products.length + ' 件商品的基础上，再追加 5 件示例。', '载入').then(function (ok) {
          if (ok) doLoadDemo();
        });
      } else {
        doLoadDemo();
      }
    });
    $('#set-remind').addEventListener('change', function () {
      state.remindBackup = this.checked;
      DB.setMeta('remindBackup', state.remindBackup);
      renderBackupTip();
    });

    /* ---- 表单 ---- */
    $$('#sheet-form [data-close]').forEach(function (el) {
      el.addEventListener('click', function () { closeSheet('form'); });
    });
    $('#f-save').addEventListener('click', doSave);

    $('#f-mode').addEventListener('click', function (e) {
      var item = e.target.closest('.seg__item');
      if (item) setMode(item.dataset.mode);
    });

    $$('#f-price-quick button').forEach(function (b) {
      b.addEventListener('click', function () {
        var cur = parsePrice($('#f-price').value) || 0;
        $('#f-price').value = fmtMoney(cur + parseFloat(b.dataset.add));
      });
    });

    $('#f-size-chips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      toggleInArray(state.formSizes, chip.dataset.size);
      renderSizeChips();
    });

    $('#f-tag-chips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      toggleInArray(state.formTags, chip.dataset.tag);
      renderTagChips();
    });

    $('#f-size-add').addEventListener('click', function () {
      var v = $('#f-size-custom').value.trim();
      if (!v) return;
      // 已经是预设尺码就不重复塞进自定义列表，只做选中
      var isPreset = PRESET_SIZES.some(function (s) { return s.toLowerCase() === v.toLowerCase(); });
      if (!isPreset) {
        state.customSizes = uniq(state.customSizes.concat([v]));
        DB.setMeta('customSizes', state.customSizes);
      }
      if (state.formSizes.indexOf(v) === -1) state.formSizes.push(v);
      $('#f-size-custom').value = '';
      renderSizeChips();
      saveDraftSoon();
    });

    $('#f-tag-add').addEventListener('click', function () {
      var v = $('#f-tag-custom').value.trim();
      if (!v) return;
      var isPreset = PRESET_TAGS.some(function (t) { return t.toLowerCase() === v.toLowerCase(); });
      if (!isPreset) {
        state.customTags = uniq(state.customTags.concat([v]));
        DB.setMeta('customTags', state.customTags);
      }
      if (state.formTags.indexOf(v) === -1) state.formTags.push(v);
      $('#f-tag-custom').value = '';
      renderTagChips();
      saveDraftSoon();
    });

    ['f-size-custom', 'f-tag-custom'].forEach(function (id) {
      $('#' + id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          $(id === 'f-size-custom' ? '#f-size-add' : '#f-tag-add').click();
        }
      });
    });

    $('#f-name').addEventListener('input', function () {
      if (this.value.trim()) {
        $('#f-name-err').hidden = true;
        this.parentNode.classList.remove('is-invalid');
      }
    });

    /* ---- 草稿自动保存 ---- */
    ['f-name', 'f-code', 'f-price', 'f-single', 'f-note'].forEach(function (id) {
      $('#' + id).addEventListener('input', saveDraftSoon);
    });
    $('#f-mode').addEventListener('click', saveDraftSoon);

    /* ---- 图片选择 ---- */
    $('#f-photo-btn').addEventListener('click', function () {
      if ($('#f-photo-loading').hidden === false) return;
      $('#f-photo-input').click();
    });

    $('#f-photo-input').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;

      $('#f-photo-loading').hidden = false;
      compressImage(file).then(function (res) {
        state.formImage = res;
        state.formImageCleared = false;
        var img = $('#f-photo-img');
        if (state.draft && state.draft.previewUrl) URL.revokeObjectURL(state.draft.previewUrl);
        var url = URL.createObjectURL(res.blob);
        state.draft = state.draft || {};
        state.draft.previewUrl = url;
        img.src = url;
        img.hidden = false;
        $('#f-photo-ph').hidden = true;
        $('#f-photo-clear').hidden = false;
        toast('图片已压缩至 ' + res.w + '×' + res.h + '（' + fmtBytes(res.blob.size) + '）', 'ok');
      }).catch(function (err) {
        toast(err && err.message ? err.message : '图片处理失败', 'err');
      }).then(function () {
        $('#f-photo-loading').hidden = true;
      });
    });

    $('#f-photo-clear').addEventListener('click', function () {
      state.formImage = null;
      state.formImageCleared = true;
      var img = $('#f-photo-img');
      img.hidden = true;
      img.removeAttribute('src');
      $('#f-photo-ph').hidden = false;
      this.hidden = true;
      if (state.draft && state.draft.previewUrl) {
        URL.revokeObjectURL(state.draft.previewUrl);
        state.draft.previewUrl = null;
      }
    });

    /* ---- 详情 ---- */
    $$('#sheet-detail [data-close]').forEach(function (el) {
      el.addEventListener('click', function () { closeSheet('detail'); });
    });

    $('#d-edit').addEventListener('click', function () {
      var id = state.detailId;
      closeSheet('detail');
      setTimeout(function () { openForm(id); }, 240);
    });

    $('#d-delete').addEventListener('click', function () {
      var p = getProduct(state.detailId);
      if (!p) return;
      confirmDialog('删除「' + p.name + '」？', '删除后无法恢复，图片也会一起删掉。', '删除', true).then(function (ok) {
        if (!ok) return;
        deleteProductById(p.id).then(function () {
          closeSheet('detail');
          renderAll();
          toast('已删除', 'ok');
        }).catch(function (err) {
          toast(err && err.message ? err.message : '删除失败', 'err');
        });
      });
    });

    $('#d-copy-price').addEventListener('click', function () {
      var p = getProduct(state.detailId);
      if (!p) return;
      if (p.price == null) { toast('这件还没填售价'); return; }
      copyWithToast('售价 ¥' + fmtMoney(p.price), '售价');
    });

    $('#d-copy-single').addEventListener('click', function () {
      var p = getProduct(state.detailId);
      if (!p) return;
      if (p.singlePrice == null) { toast('这件没有单卖价'); return; }
      copyWithToast('单卖价 ¥' + fmtMoney(p.singlePrice), '单卖价');
    });

    $('#d-copy-all').addEventListener('click', function () {
      var p = getProduct(state.detailId);
      if (!p) return;
      copyWithToast(productToText(p), '商品信息');
    });

    /* ---- 大图 ---- */
    $('#lightbox-close').addEventListener('click', closeLightbox);
    $('#lightbox').addEventListener('click', function (e) {
      if (e.target === this) closeLightbox();
    });

    /* ---- 键盘 ---- */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('#lightbox').hidden) { closeLightbox(); return; }
      if (!$('#sheet-form').hidden) closeSheet('form');
      else if (!$('#sheet-detail').hidden) closeSheet('detail');
    });

    /* ---- 网络状态 ---- */
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);

    /* ---- 从后台切回前台时刷新统计 ---- */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.ready) {
        renderBackupTip();
      }
    });

    /* ---- 防止 iOS 双击缩放 ---- */
    var lastTouch = 0;
    document.addEventListener('touchend', function (e) {
      var now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });
  }

  function resetProductFilters() {
    state.filters.p.mode = 'all';
    state.filters.p.tag = null;
    state.filters.p.size = null;
    $$('#p-chips .chip').forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.filter === 'all');
    });
    renderProductsView();
  }

  function resetSearchFilters() {
    state.filters.s.query = '';
    state.filters.s.mode = 'all';
    state.filters.s.tag = null;
    state.filters.s.size = null;
    $('#s-input').value = '';
    renderSearchView();
  }

  function updateOnline() {
    $('#offline-banner').hidden = navigator.onLine !== false;
  }

  /* ============================================================
     启动
     ============================================================ */
  function showFatalError(err) {
    state.fatal = err;
    var msg = (err && err.message) || '未知错误';
    var html =
      '<div class="state__art">' + EMPTY_KITTY_SVG + '</div>' +
      '<p class="state__title">数据打不开了</p>' +
      '<p class="state__desc">' + escapeHtml(msg) + '<br><br>可能是浏览器禁用了本地存储。<br>试试用 Safari 打开，或者关掉「无痕浏览」再进。</p>' +
      '<div class="state__actions"><button class="btn btn--primary btn--sm" data-action="reload">重新加载</button></div>';
    var pState = $('#p-state');
    $('#p-list').innerHTML = '';
    pState.hidden = false;
    pState.className = 'state state--error';
    pState.innerHTML = html;
    pState.addEventListener('click', function (e) {
      if (e.target.closest('[data-action="reload"]')) location.reload();
    });
    $('#p-count').textContent = '';
    $('#appbar-sub').textContent = '出错了';
  }

  function boot() {
    bindEvents();
    updateOnline();
    switchView('products');

    // 从 manifest shortcuts 进来时直接定位
    var params = new URLSearchParams(location.search);
    if (params.get('view') === 'search') setTimeout(function () { switchView('search'); }, 60);
    if (params.get('action') === 'add') setTimeout(function () { openForm(null); }, 120);

    // 加载中骨架屏
    var skeleton = '<div class="skeleton-list">' +
      '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    $('#p-list').innerHTML = skeleton;
    $('#p-state').hidden = true;

    DB.ready().then(function () {
      return Promise.all([
        DB.allProducts(),
        DB.getMeta('lastBackupAt', 0),
        DB.getMeta('remindBackup', true),
        DB.getMeta('customSizes', []),
        DB.getMeta('customTags', [])
      ]);
    }).then(function (res) {
      state.products = (res[0] || []).map(normalizeProduct);
      state.lastBackupAt = res[1] || 0;
      state.remindBackup = res[2] !== false;
      state.customSizes = res[3] || [];
      state.customTags = res[4] || [];
      $('#set-remind').checked = state.remindBackup;
      state.ready = true;
      renderAll();

      if (DB.usingFallback) {
        toast('当前为兼容模式（localStorage），图片多时建议减少数量');
      } else if (state.remindBackup && state.products.length && daysBetween(state.lastBackupAt, Date.now()) >= 7) {
        setTimeout(function () { toast('好久没备份啦，去设置页导出一次吧'); }, 900);
      }
    }).catch(function (err) {
      state.ready = true;
      showFatalError(err);
    });

    // 注册 Service Worker（仅 http/https 下有效）
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          void reg;
        }).catch(function () {
          /* 离线缓存注册失败不影响主功能 */
        });
      });
    }

    // 阻止 iOS 上把整个页面拖拽回弹（弹层内滚动除外）
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
