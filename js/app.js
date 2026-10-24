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
    formImages: [],         // 多图：[{ type:'new', blob, thumb, url } | { type:'old', index, url }]
    formImagesLoading: false,
    formTags: [],
    formSingleItems: [],
    customTags: [],
    lastBackupAt: 0,
    remindBackup: true,
    // 只读模式 / 报价模板
    detailLocked: true,     // 详情页是否锁定（只读）
    lockByDefault: true,    // 设置项：默认锁定
    quoteTemplate: 'simple',// 报价模板：simple | friendly | compact | custom
    quoteTemplateCustom: '',// 自定义模板正文
    filters: {
      p: { mode: 'all', tag: null, sort: 'new' },
      s: { query: '', mode: 'all', tag: null, sort: 'new' }
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
      var anyOpen = ['form', 'detail', 'quick'].some(function (k) {
        var s = $('#sheet-' + k);
        return s && !s.hidden;
      });
      if (!anyOpen) document.body.style.overflow = '';
    }, 210);
    if (!fromPop) popSheetHistory();
  }

  window.addEventListener('popstate', function () {
    if (suppressPop) return;
    if (sheetHistoryPushed) {
      sheetHistoryPushed = false;
      if (!$('#sheet-form').hidden) closeSheet('form', true);
      if (!$('#sheet-detail').hidden) closeSheet('detail', true);
      if (!$('#sheet-quick').hidden) closeSheet('quick', true);
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

  /* ============================================================
     多图：一件商品最多 4 张，图片以 `${id}#${index}` 为 key 存在 IndexedDB
     ============================================================ */
  var MAX_IMAGES = 4;

  /** 图片存储 key */
  function imgKey(productId, index) { return productId + '#' + index; }

  /** 取商品当前图片张数（兼容旧数据：hasImage 为 true 但无 imageCount） */
  function imageCountOf(p) {
    if (!p) return 0;
    if (typeof p.imageCount === 'number') return Math.max(0, Math.min(MAX_IMAGES, p.imageCount));
    return p.hasImage ? 1 : 0;
  }

  /** 取图片的可显示 URL（带缓存）。index 从 0 开始 */
  function getImageUrl(productId, index, useThumb) {
    if (!productId) return Promise.resolve(null);
    var key = imgKey(productId, index || 0);
    var cache = imgUrlCache[key];
    var slot = useThumb ? 'thumb' : 'full';
    if (cache && cache[slot] !== undefined) return Promise.resolve(cache[slot]);
    return DB.getImage(key).then(function (rec) {
      // 旧数据兼容：早期图片以商品 id 本身为 key 存储
      if (!rec && (index || 0) === 0) return DB.getImage(productId);
      return rec;
    }).then(function (rec) {
      if (!rec) return null;
      var c = imgUrlCache[key] || (imgUrlCache[key] = {});
      var fullBlob = rec.blob || null;
      var thumbBlob = rec.thumb || null;
      if (fullBlob && c.full === undefined) c.full = URL.createObjectURL(fullBlob);
      if (thumbBlob && c.thumb === undefined) c.thumb = URL.createObjectURL(thumbBlob);
      if (c.thumb === undefined) c.thumb = c.full === undefined ? null : c.full;
      if (c.full === undefined) c.full = c.thumb === undefined ? null : c.thumb;
      return c[slot] || c.full || c.thumb || null;
    }).catch(function () { return null; });
  }

  function dropImageCache(productId) {
    for (var i = 0; i < MAX_IMAGES; i++) {
      var key = imgKey(productId, i);
      var c = imgUrlCache[key];
      if (c) {
        if (c.full) { try { URL.revokeObjectURL(c.full); } catch (e) { /* 忽略 */ } }
        if (c.thumb && c.thumb !== c.full) { try { URL.revokeObjectURL(c.thumb); } catch (e) { /* 忽略 */ } }
        delete imgUrlCache[key];
      }
    }
    // 旧 key
    var old = imgUrlCache[productId];
    if (old) {
      if (old.full) { try { URL.revokeObjectURL(old.full); } catch (e) { /* 忽略 */ } }
      if (old.thumb && old.thumb !== old.full) { try { URL.revokeObjectURL(old.thumb); } catch (e) { /* 忽略 */ } }
      delete imgUrlCache[productId];
    }
  }

  /** 删除某商品的所有图片（含可能存在的旧 key） */
  function deleteAllImages(productId, count) {
    var jobs = [];
    var n = Math.max(count || 0, MAX_IMAGES);
    for (var i = 0; i < n; i++) {
      jobs.push(DB.deleteImage(imgKey(productId, i)).catch(function () { /* 忽略 */ }));
    }
    jobs.push(DB.deleteImage(productId).catch(function () { /* 忽略 */ }));
    return Promise.all(jobs);
  }


  /* ============================================================
     商品 CRUD
     ============================================================ */

  var MAX_SINGLE_ITEMS = 6;   // 一件商品最多几条单卖项

  /**
   * 规整单卖项数组。
   * 每项形如 { name: '上衣', price: 89 }，名称为空时自动补「单卖」。
   * 价格无效的项会被丢弃；同一名称只保留第一条。
   */
  function normalizeSingleItems(list, fallbackPrice) {
    var out = [];
    if (Array.isArray(list)) {
      list.forEach(function (raw) {
        if (raw == null) return;
        var item = (typeof raw === 'object') ? raw : { price: raw };
        var price = parsePrice(item.price);
        if (price == null) return;                       // 没价格的不算一项
        var name = String(item.name == null ? '' : item.name).trim().slice(0, 12);
        out.push({ name: name, price: price });
      });
    }
    // 兼容旧格式：只有一个 singlePrice 的老数据，自动转成一条「单卖」项
    if (!out.length && fallbackPrice != null) {
      var legacy = parsePrice(fallbackPrice);
      if (legacy != null) out.push({ name: '', price: legacy });
    }
    // 同名去重（名称留空视为「单卖」，只留一条）
    var seen = {};
    out = out.filter(function (it) {
      var key = (it.name || '单卖').toLowerCase();
      if (seen[key]) return false;
      seen[key] = 1;
      return true;
    });
    return out.slice(0, MAX_SINGLE_ITEMS);
  }

  /** 单卖项显示名：空名称统一显示为「单卖」 */
  function singleItemLabel(item) {
    var n = String((item && item.name) || '').trim();
    return n || '单卖';
  }

  /** 取最低单卖价，没有单卖项时返回 null */
  function lowestSinglePrice(p) {
    var items = (p && p.singleItems) || [];
    if (!items.length) return null;
    var min = null;
    items.forEach(function (it) {
      if (it.price == null) return;
      if (min == null || it.price < min) min = it.price;
    });
    return min;
  }

  function normalizeProduct(raw) {
    var mode = MODES[raw.singleMode] ? raw.singleMode : 'ask';
    // 图片张数：优先用 imageCount，旧数据回落到 hasImage ? 1 : 0
    var count = typeof raw.imageCount === 'number'
      ? Math.max(0, Math.min(MAX_IMAGES, Math.floor(raw.imageCount)))
      : (raw.hasImage ? 1 : 0);
    var p = {
      id: raw.id || DB.uuid(),
      name: String(raw.name || '').trim(),
      code: String(raw.code || '').trim(),
      price: parsePrice(raw.price),
      singleItems: normalizeSingleItems(raw.singleItems, raw.singlePrice),
      singleMode: mode,
      tags: Array.isArray(raw.tags) ? uniq(raw.tags) : [],
      note: String(raw.note || '').trim(),
      imageCount: count,
      hasImage: count > 0,
      createdAt: raw.createdAt || Date.now(),
      updatedAt: raw.updatedAt || Date.now()
    };
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

  /**
   * 保存商品及其图片。
   * imagePlan 形如 { kept: [blob/url 描述...], removed: [index...], newFiles: [...] }
   * 这里简化处理：传入最终的图片列表（长度 ≤ MAX_IMAGES），
   * 每项要么是 { blob, thumb, w, h, bytes }（新图），要么是 { existingIndex: n }（保留原图）。
   */
  function saveProduct(product, imageList) {
    product.updatedAt = Date.now();
    var list = Array.isArray(imageList) ? imageList.slice(0, MAX_IMAGES) : [];

    var chain = Promise.all([]).then(function () {
      // 1) 先读出旧图片（以便重新编号）
      var olds = [];
      var readJobs = [];
      for (var i = 0; i < MAX_IMAGES; i++) {
        (function (idx) {
          readJobs.push(
            DB.getImage(imgKey(product.id, idx))
              .catch(function () { return null; })
              .then(function (rec) { olds[idx] = rec; })
          );
        })(i);
      }
      return Promise.all(readJobs).then(function () {
        // 兼容旧 key
        return DB.getImage(product.id).catch(function () { return null; }).then(function (legacy) {
          if (legacy && !olds[0]) olds[0] = legacy;
          return olds;
        });
      });
    });

    return chain.then(function (olds) {
      // 2) 清掉这个商品的所有旧图片记录
      return deleteAllImages(product.id, MAX_IMAGES).then(function () {
        // 3) 按最终顺序重新写入
        var writes = list.map(function (entry, idx) {
          var key = imgKey(product.id, idx);
          if (entry && entry.existingIndex != null) {
            var rec = olds[entry.existingIndex];
            if (rec) {
              return DB.putImage(key, rec.blob, {
                thumb: rec.thumb, w: rec.w, h: rec.h, bytes: rec.bytes
              }).catch(function () { /* 单张失败不影响其它 */ });
            }
            return null;
          }
          if (entry && entry.blob) {
            return DB.putImage(key, entry.blob, {
              w: entry.w, h: entry.h, bytes: entry.bytes, thumb: entry.thumb
            }).catch(function () { /* 忽略 */ });
          }
          return null;
        });
        return Promise.all(writes);
      });
    }).then(function () {
      product.imageCount = list.length;
      product.hasImage = list.length > 0;
      return DB.putProduct(product);
    }).then(function () {
      dropImageCache(product.id);
      upsertLocal(product);
      return product;
    });
  }

  function deleteProductById(id) {
    return deleteAllImages(id, MAX_IMAGES)
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
      (p.tags || []).join(' ')
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
    var items = p.singleItems || [];
    if (items.length) {
      var low = lowestSinglePrice(p);
      var suffix = items.length > 1 ? (' 起 · ' + items.length + ' 项可单卖') : '';
      singleHtml = '<span class="price-single">单卖 ¥' + fmtMoney(low) + suffix + '</span>';
    } else if (p.singleMode === 'single') {
      singleHtml = '<span class="price-single price-single--none">单卖价待补</span>';
    } else if (p.singleMode === 'ask') {
      singleHtml = '<span class="price-single price-single--none">单卖需询问</span>';
    } else {
      singleHtml = '<span class="price-single price-single--none">' + (p.singleMode === 'set' ? '仅整套出售' : '不支持单卖') + '</span>';
    }

    var metaHtml = '';
    (p.tags || []).slice(0, 4).forEach(function (t) {
      metaHtml += '<span class="tag-mini">#' + escapeHtml(t) + '</span>';
    });

    var thumbInner = '<span class="card__thumb-ph">' + THUMB_PH_SVG + '</span>';
    var count = imageCountOf(p);
    var badgeHtml = count > 1
      ? '<span class="card__imgcount">' + count + ' 张</span>'
      : '';

    return '' +
      '<article class="card" data-id="' + escapeHtml(p.id) + '" role="button" tabindex="0" aria-label="查看 ' + escapeHtml(p.name) + ' 详情">' +
        '<div class="card__thumb" data-thumb="' + escapeHtml(p.id) + '">' +
          (count > 0 ? '' : thumbInner) + badgeHtml +
        '</div>' +
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
      if (imageCountOf(p) === 0) return;
      var box = root.querySelector('[data-thumb="' + cssEscape(p.id) + '"]');
      if (!box) return;
      getImageUrl(p.id, 0, true).then(function (url) {
        if (!url) {
          // 显示占位，但保留右上角张数标记
          var badge = box.querySelector('.card__imgcount');
          box.innerHTML = '<span class="card__thumb-ph">无图</span>' + (badge ? badge.outerHTML : '');
          return;
        }
        var img = document.createElement('img');
        img.src = url;
        img.alt = p.name;
        img.loading = 'lazy';
        img.decoding = 'async';
        var keepBadge = box.querySelector('.card__imgcount');
        box.innerHTML = '';
        box.appendChild(img);
        if (keepBadge) box.appendChild(keepBadge);
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
    var noFilter = f.mode === 'all' && !f.tag;
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
  }

  function renderSearchView() {
    var f = state.filters.s;
    var items = filterProducts(f);
    var noQuery = !f.query && f.mode === 'all' && !f.tag;

    var empty;
    if (noQuery) {
      empty = {
        html: '<div class="state__art">' + EMPTY_KITTY_SVG + '</div>' +
              '<p class="state__title">想找哪件衣服？</p>' +
              '<p class="state__desc">输入商品名、货号或标签<br>也可以点下面的标签快速筛选</p>'
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
    renderTemplatePicker();
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
    state.formImages = [];        // [{ type:'new', blob, thumb, w, h, bytes, url } | { type:'old', index, url }]
    state.formImagesLoading = false;
    var p = id ? getProduct(id) : null;

    $('#form-title').textContent = p ? '编辑商品' : '新增商品';
    $('#f-name').value = p ? p.name : '';
    $('#f-code').value = p ? p.code : '';
    $('#f-price').value = p && p.price != null ? fmtMoney(p.price) : '';
    $('#f-note').value = p ? p.note : '';
    state.formTags = p ? (p.tags || []).slice() : [];
    // 单卖项：编辑时回填，新增时先给一条空行方便直接填
    state.formSingleItems = p ? (p.singleItems || []).map(function (it) { return { name: it.name || '', price: it.price }; })
                              : [{ name: '', price: null }];

    setMode(p ? p.singleMode : 'single');
    $('#f-name-err').hidden = true;
    $('#f-name').parentNode.classList.remove('is-invalid');

    // 图片：先渲染空槽位，再异步加载已有图片
    renderPhotoGrid();

    if (p && imageCountOf(p) > 0) {
      // 逐个读取已有图片的完整尺寸，做成"已存在"条目
      for (var i = 0; i < imageCountOf(p); i++) {
        (function (idx) {
          getImageUrl(p.id, idx, true).then(function (url) {
            if (state.editingId !== id) return;
            if (!url) return;
            // 保持顺序：如果这个槽还没被占用就填进去
            var existing = state.formImages.filter(function (x) {
              return x.type === 'old' && x.index === idx;
            })[0];
            if (!existing) {
              state.formImages.push({
                type: 'old',
                index: idx,
                url: url,
                w: 0, h: 0, bytes: 0
              });
            }
            renderPhotoGrid();
          });
        })(i);
      }
    }

    renderTagChips();
    openSheet('form');
    setTimeout(function () {
      var body = $('#sheet-form .sheet__body');
      if (body) body.scrollTop = 0;
    }, 30);
    maybeRestoreDraft(id || null);
  }

  /* ---- 多图：表单里的 4 个格子 ---- */
  function renderPhotoGrid() {
    var grid = $('#f-photo-grid');
    if (!grid) return;
    var imgs = state.formImages || [];
    var html = '';

    for (var i = 0; i < MAX_IMAGES; i++) {
      var item = imgs[i];
      if (item) {
        html += '<div class="photo-slot photo-slot--filled" data-slot="' + i + '">' +
            '<img src="' + (item.url || '') + '" alt="图片 ' + (i + 1) + '">' +
            (i === 0 ? '<span class="photo-slot__cover">封面</span>' : '') +
            '<button class="photo-slot__del" type="button" data-photo-del="' + i + '" aria-label="删除第 ' + (i + 1) + ' 张图">' +
              '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
              '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' +
            '</button>' +
          '</div>';
      } else {
        // 只有一个"添加"格子：空位中第一个
        var firstEmpty = imgs.length;
        if (i === firstEmpty) {
          html += '<button class="photo-slot photo-slot--add" type="button" data-photo-add="1" aria-label="添加图片">' +
              '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">' +
              '<rect x="3" y="6" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
              '<circle cx="12" cy="13" r="3.3" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
              '<path d="M9 6l1.2-2h3.6L15 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
              '</svg><span>拍照/相册</span></button>';
        } else {
          html += '<div class="photo-slot photo-slot--empty" aria-hidden="true"></div>';
        }
      }
    }
    grid.innerHTML = html;

    // 压缩中：给当前"添加"格子盖上遮罩
    if (state.formImagesLoading) {
      var addSlot = grid.querySelector('.photo-slot--add');
      if (addSlot) {
        addSlot.innerHTML = '<i class="spinner spinner--dark"></i><span>压缩中…</span>';
        addSlot.setAttribute('aria-busy', 'true');
      }
    }
  }

  /** 添加一张图（压缩后） */
  function addPhotoFromFile(file) {
    if (!file) return;
    var imgs = state.formImages || [];
    if (imgs.length >= MAX_IMAGES) {
      toast('最多只能放 ' + MAX_IMAGES + ' 张图');
      return;
    }
    state.formImagesLoading = true;
    renderPhotoGrid();

    compressImage(file).then(function (res) {
      var item = {
        type: 'new',
        blob: res.blob,
        thumb: res.thumb,
        w: res.w,
        h: res.h,
        bytes: res.bytes,
        url: URL.createObjectURL(res.blob)
      };
      state.formImages.push(item);
      toast('已添加第 ' + state.formImages.length + ' 张（' + res.w + '×' + res.h + '）', 'ok');
      saveDraftSoon();
    }).catch(function (err) {
      toast(err && err.message ? err.message : '图片处理失败', 'err');
    }).then(function () {
      state.formImagesLoading = false;
      renderPhotoGrid();
    });
  }

  function removePhotoAt(index) {
    var imgs = state.formImages || [];
    var item = imgs[index];
    if (!item) return;
    if (item.type === 'new' && item.url) {
      try { URL.revokeObjectURL(item.url); } catch (e) { /* 忽略 */ }
    }
    imgs.splice(index, 1);
    renderPhotoGrid();
    saveDraftSoon();
  }

  /* ---- 表单草稿：防止误触返回 / 切后台丢失已填内容 ---- */
  var saveDraftSoon = debounce(function () {
    if ($('#sheet-form').hidden) return;
    var items = collectSingleItems();
    // 草稿里连"名称填了但价格还没填"的行也一起存，避免恢复后白填
    var rawRows = $$('#f-single-list .single-row').map(function (row) {
      var nameEl = row.querySelector('[data-single="name"]');
      var priceEl = row.querySelector('[data-single="price"]');
      return {
        name: (nameEl ? nameEl.value : '').trim(),
        price: parsePrice(priceEl ? priceEl.value : '')
      };
    }).filter(function (it) { return it.name || it.price != null; });

    var d = {
      editingId: state.editingId || null,
      name: $('#f-name').value,
      code: $('#f-code').value,
      price: $('#f-price').value,
      singleItems: rawRows.length ? rawRows : items,
      note: $('#f-note').value,
      mode: currentMode(),
      tags: state.formTags.slice(),
      // 只缓存新加进来的图片（已有图片本来就在库里，不用重复存）
      images: (state.formImages || []).map(function (it) {
        if (it.type === 'old') return { old: it.index };
        return { blob: it.blob, thumb: it.thumb, w: it.w, h: it.h, bytes: it.bytes };
      }),
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
      var hasItems = Array.isArray(d.singleItems) && d.singleItems.length > 0;
      var hasContent = (d.name && d.name.trim()) || (d.price && String(d.price).trim()) || hasItems;
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
    $('#f-note').value = d.note || '';
    state.formTags = Array.isArray(d.tags) ? d.tags.slice() : [];
    // 兼容旧草稿（single 单值）与新草稿（singleItems 数组）
    if (Array.isArray(d.singleItems)) {
      state.formSingleItems = d.singleItems.map(function (it) {
        return { name: (it && it.name) || '', price: it ? parsePrice(it.price) : null };
      });
    } else if (d.single != null && String(d.single).trim()) {
      state.formSingleItems = [{ name: '', price: parsePrice(d.single) }];
    } else {
      state.formSingleItems = [{ name: '', price: null }];
    }
    setMode(d.mode || 'single');
    renderTagChips();

    // 恢复草稿里的图片：保留"已有图片"，再追加草稿里新加的
    if (Array.isArray(d.images)) {
      var oldOnes = (state.formImages || []).filter(function (x) { return x.type === 'old'; });
      var restored = oldOnes.slice();
      d.images.forEach(function (it) {
        if (it && it.blob instanceof Blob) {
          restored.push({
            type: 'new',
            blob: it.blob,
            thumb: it.thumb || null,
            w: it.w || 0,
            h: it.h || 0,
            bytes: it.bytes || it.blob.size,
            url: URL.createObjectURL(it.blob)
          });
        }
      });
      state.formImages = restored.slice(0, MAX_IMAGES);
      renderPhotoGrid();
    } else if (d.image && d.image.blob instanceof Blob) {
      // 兼容更早的单图草稿
      state.formImages = [{
        type: 'new',
        blob: d.image.blob,
        thumb: null,
        w: d.image.w || 0,
        h: d.image.h || 0,
        bytes: d.image.bytes || d.image.blob.size,
        url: URL.createObjectURL(d.image.blob)
      }];
      renderPhotoGrid();
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
      ? '这件可以拆开卖。给每件单独卖的部件起个名并定价，比如「上衣 ¥89、裤子 ¥79、内搭 ¥49」，报价时直接念给客人听～'
      : (mode === 'ask'
          ? '选择「需询问」时，可以先留空，问清楚上家再回来补。'
          : '这个状态一般不需要填单卖项，留着就好。');
    var field = $('#f-single-field');
    field.classList.toggle('is-emphasized', isSingle);
    renderSingleItems();
  }

  function currentMode() {
    var active = $('#f-mode .seg__item.is-active');
    return active ? active.dataset.mode : 'ask';
  }

  function renderTagChips() {
    var pool = uniq(PRESET_TAGS.concat(state.customTags));
    var html = pool.map(function (t) {
      var on = state.formTags.indexOf(t) >= 0;
      return '<button class="chip chip--tag' + (on ? ' is-active' : '') + '" type="button" data-tag="' + escapeHtml(t) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + escapeHtml(t) + '</button>';
    }).join('');
    $('#f-tag-chips').innerHTML = html;
  }

  /* ---- 单卖项：动态多行（自定义名称 + 价格）---- */
  var SINGLE_NAME_PLACEHOLDER = ['上衣', '裤子', '内搭', '外套', '裙子', '配件'];

  function renderSingleItems() {
    var box = $('#f-single-list');
    if (!box) return;
    var items = state.formSingleItems || (state.formSingleItems = []);
    var count = items.length;

    if (!count) {
      box.innerHTML = '<p class="single-empty">还没有单卖项，点下面的按钮添加</p>';
    } else {
      box.innerHTML = items.map(function (it, i) {
        return '' +
          '<div class="single-row" data-index="' + i + '">' +
            '<input class="input single-row__name" type="text" data-single="name" data-index="' + i + '" ' +
              'value="' + escapeHtml(it.name || '') + '" maxlength="12" autocomplete="off" ' +
              'placeholder="' + SINGLE_NAME_PLACEHOLDER[i % SINGLE_NAME_PLACEHOLDER.length] + '（名称）" ' +
              'aria-label="第 ' + (i + 1) + ' 个单卖项的名称">' +
            '<div class="single-row__price">' +
              '<span class="single-row__yen">¥</span>' +
              '<input class="input single-row__input" type="text" inputmode="decimal" data-single="price" data-index="' + i + '" ' +
                'value="' + (it.price == null ? '' : fmtMoney(it.price)) + '" placeholder="0" autocomplete="off" ' +
                'aria-label="第 ' + (i + 1) + ' 个单卖项的价格">' +
            '</div>' +
            '<button class="single-row__del" type="button" data-single-del="' + i + '" aria-label="删除第 ' + (i + 1) + ' 个单卖项">' +
              '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
              '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' +
            '</button>' +
          '</div>';
      }).join('');
    }

    var full = count >= MAX_SINGLE_ITEMS;
    var addBtn = $('#f-single-add');
    addBtn.disabled = full;
    var label = addBtn.querySelector('.single-add__label');
    if (label) {
      label.textContent = full
        ? (' 最多 ' + MAX_SINGLE_ITEMS + ' 项')
        : (count ? ' 再加一项' : ' 添加单卖项');
    }
  }

  /** 从表单读取单卖项（滤掉没价格的行） */
  function collectSingleItems() {
    var rows = $$('#f-single-list .single-row');
    var out = [];
    rows.forEach(function (row) {
      var nameEl = row.querySelector('[data-single="name"]');
      var priceEl = row.querySelector('[data-single="price"]');
      var price = parsePrice(priceEl ? priceEl.value : '');
      if (price == null) return;
      out.push({
        name: (nameEl ? nameEl.value : '').trim().slice(0, 12),
        price: price
      });
    });
    return out;
  }

  /** 把 DOM 里的输入同步回 state（避免重渲染丢内容） */
  function syncSingleItemsFromDom() {
    var rows = $$('#f-single-list .single-row');
    if (!rows.length) return;
    var next = [];
    rows.forEach(function (row) {
      var nameEl = row.querySelector('[data-single="name"]');
      var priceEl = row.querySelector('[data-single="price"]');
      next.push({
        name: (nameEl ? nameEl.value : '').trim().slice(0, 12),
        price: parsePrice(priceEl ? priceEl.value : '')
      });
    });
    state.formSingleItems = next;
  }

  function addSingleItem() {
    syncSingleItemsFromDom();
    if (state.formSingleItems.length >= MAX_SINGLE_ITEMS) {
      toast('最多只能加 ' + MAX_SINGLE_ITEMS + ' 项单卖');
      return;
    }
    state.formSingleItems.push({ name: '', price: null });
    renderSingleItems();
    // 聚焦到新加那一行的名称输入框
    var rows = $$('#f-single-list .single-row');
    var last = rows[rows.length - 1];
    if (last) {
      var input = last.querySelector('[data-single="name"]');
      if (input) { try { input.focus({ preventScroll: false }); } catch (e) { /* 忽略 */ } }
      last.scrollIntoView({ block: 'nearest' });
    }
    saveDraftSoon();
  }

  function removeSingleItem(index) {
    syncSingleItemsFromDom();
    state.formSingleItems.splice(index, 1);
    renderSingleItems();
    saveDraftSoon();
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
    var singleItems = collectSingleItems();

    var base = state.editingId ? getProduct(state.editingId) : null;
    return normalizeProduct({
      id: state.editingId || DB.uuid(),
      name: name,
      code: $('#f-code').value,
      price: $('#f-price').value,
      singleItems: singleItems,
      singleMode: mode,
      tags: state.formTags,
      note: $('#f-note').value,
      imageCount: (state.formImages || []).length,
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

    // 选了「可单卖」却一项都没填 → 提示一次，但不强制
    var needsWarn = product.singleMode === 'single' && product.singleItems.length === 0;
    var proceed = needsWarn
      ? confirmDialog('还没填单卖项', '你选择了「可单卖」，但一项单卖都没填。<br>以后客人问单卖多少钱，列表里会显示「单卖价待补」。<br><br>确定就这样保存吗？', '就这样保存')
      : Promise.resolve(true);

    proceed.then(function (ok) {
      if (!ok) {
        var first = $('#f-single-list [data-single="price"]');
        if (first) { try { first.focus(); } catch (e) { /* 忽略 */ } }
        return;
      }
      // 把表单里的图片整理成 saveProduct 需要的格式
      var imageList = (state.formImages || []).map(function (it) {
        if (it.type === 'old') return { existingIndex: it.index };
        return { blob: it.blob, thumb: it.thumb, w: it.w, h: it.h, bytes: it.bytes };
      });
      return saveProduct(product, imageList).then(function () {
        state.formImages = [];
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
    state.detailLocked = state.lockByDefault !== false;
    var m = MODES[p.singleMode] || MODES.ask;
    var imgCount = imageCountOf(p);

    // 多图轮播
    var hero = imgCount > 0
      ? '<div class="detail-hero detail-hero--has-image" id="d-hero">' +
          '<div class="carousel" id="d-carousel">' +
            '<div class="carousel__track" id="d-track"></div>' +
          '</div>' +
          (imgCount > 1
            ? '<div class="carousel__dots" id="d-dots">' +
                Array.apply(null, Array(imgCount)).map(function (_, i) {
                  return '<i class="' + (i === 0 ? 'is-active' : '') + '"></i>';
                }).join('') +
              '</div>' +
              '<span class="carousel__count" id="d-count">1/' + imgCount + '</span>'
            : '') +
        '</div>'
      : '<div class="detail-hero" id="d-hero"><span>还没有图片，点「编辑」可以补一张</span></div>';

    var items = p.singleItems || [];
    var multi = items.length > 1;

    // 套装价 + 单卖汇总（两个并排的小卡）
    var singleSummaryValue;
    if (items.length) {
      singleSummaryValue = multi ? ('¥' + fmtMoney(lowestSinglePrice(p)) + ' 起') : ('¥' + fmtMoney(items[0].price));
    } else {
      singleSummaryValue = (p.singleMode === 'ask' ? '需询问' : '无');
    }

    var priceBox =
      '<div class="price-box price-box--main">' +
        '<div class="price-box__label">售价（整套 / 默认）</div>' +
        '<div class="price-box__value">' + (p.price != null ? '¥' + fmtMoney(p.price) : '未填写') + '</div>' +
        '<div class="price-box__note">整套带走按这个价</div>' +
      '</div>' +
      '<div class="price-box ' + (items.length ? 'price-box--single' : 'price-box--empty') + '">' +
        '<div class="price-box__label">单卖' + (multi ? '（' + items.length + ' 项）' : '价') + '</div>' +
        '<div class="price-box__value">' + singleSummaryValue + '</div>' +
        '<div class="price-box__note">' + (items.length ? '可以单卖' : m.label + ' · ' + m.desc) + '</div>' +
      '</div>';

    // 单卖明细：逐项列出，每项可单独复制
    var singleDetail = '';
    if (items.length) {
      singleDetail = '<div class="detail-block">' +
        '<div class="detail-block__title">单卖明细' + (multi ? '（' + items.length + ' 项）' : '') + '</div>' +
        '<div class="single-detail">' +
        items.map(function (it, i) {
          return '<div class="single-detail__row">' +
              '<span class="single-detail__name">' + escapeHtml(singleItemLabel(it)) + '</span>' +
              '<span class="single-detail__price">¥' + fmtMoney(it.price) + '</span>' +
              '<button class="single-detail__copy" type="button" data-copy-item="' + i + '" ' +
                'aria-label="复制 ' + escapeHtml(singleItemLabel(it)) + ' 的价格">复制</button>' +
            '</div>';
        }).join('') +
        '</div>' +
        (multi ? '<p class="single-detail__sum">合计 ¥' + fmtMoney(items.reduce(function (s, it) { return s + (it.price || 0); }, 0)) + '（单卖全部部件）</p>' : '') +
      '</div>';
    }

    var rows = '';
    rows += '<div class="detail-row"><span class="detail-row__k">状态</span><span class="detail-row__v">' + modeBadge(p) + '</span></div>';
    rows += '<div class="detail-row"><span class="detail-row__k">货号</span><span class="detail-row__v' + (p.code ? '' : ' detail-row__v--muted') + '">' + (p.code ? escapeHtml(p.code) : '未填写') + '</span></div>';
    rows += '<div class="detail-row"><span class="detail-row__k">标签</span><span class="detail-row__v' + (p.tags.length ? '' : ' detail-row__v--muted') + '">' + (p.tags.length ? p.tags.map(function (t) { return '#' + escapeHtml(t); }).join(' ') : '未填写') + '</span></div>';
    rows += '<div class="detail-row"><span class="detail-row__k">添加时间</span><span class="detail-row__v detail-row__v--muted">' + fmtDate(p.createdAt) + '</span></div>';

    var noteBlock = p.note
      ? '<div class="detail-block"><div class="detail-block__title">备注</div><div class="detail-row__v">' + escapeHtml(p.note) + '</div></div>'
      : '';

    $('#d-body').innerHTML =
      hero +
      '<h3 class="detail-name">' + escapeHtml(p.name || '未命名商品') + '</h3>' +
      '<div class="detail-sub">' + modeBadge(p) + (p.code ? '<span class="card__code">' + escapeHtml(p.code) + '</span>' : '') + '</div>' +
      '<div class="detail-prices">' + priceBox + '</div>' +
      singleDetail +
      '<div class="detail-block"><div class="detail-block__title">商品信息</div>' + rows + '</div>' +
      noteBlock;

    // 锁定 / 解锁
    applyDetailLock();

    // 没有单卖项时禁用「复制单卖价」
    var copySingleBtn = $('#d-copy-single');
    if (copySingleBtn) copySingleBtn.disabled = items.length === 0;

    openSheet('detail');

    // 加载所有图片到轮播
    if (imgCount > 0) {
      var jobs = [];
      for (var i = 0; i < imgCount; i++) {
        jobs.push(getImageUrl(p.id, i, false).catch(function () { return null; }));
      }
      Promise.all(jobs).then(function (urls) {
        if (state.detailId !== id) return;
        var track = $('#d-track');
        if (!track) return;
        track.innerHTML = '';
        urls.forEach(function (url, idx) {
          var slide = document.createElement('div');
          slide.className = 'carousel__slide';
          if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.alt = p.name + (urls.length > 1 ? '（' + (idx + 1) + '）' : '');
            // 最多 4 张，直接预加载，避免滑到还没加载出来
            slide.appendChild(img);
            slide.addEventListener('click', function () { openLightbox(url, p.name); });
          } else {
            slide.innerHTML = '<span class="carousel__fail">图片读取失败</span>';
          }
          track.appendChild(slide);
        });
        setupCarousel();
      });
    }
  }

  /** 详情页锁定状态应用 */
  function applyDetailLock() {
    var sheet = $('#sheet-detail');
    if (!sheet) return;
    var locked = state.detailLocked !== false;
    sheet.classList.toggle('is-locked', locked);

    var btn = $('#d-lock');
    if (btn) {
      btn.setAttribute('aria-pressed', locked ? 'false' : 'true');
      btn.innerHTML = locked ? LOCK_ICON : UNLOCK_ICON;
      btn.title = locked ? '已锁定，点此解锁' : '已解锁，点此锁定';
    }
    // 锁定时隐藏危险操作
    var editBtn = $('#d-edit');
    var delBtn = $('#d-delete');
    if (editBtn) editBtn.hidden = locked;
    if (delBtn) delBtn.hidden = locked;
  }

  var LOCK_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/>' +
    '<path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
    '<circle cx="12" cy="15.2" r="1.3" fill="currentColor"/></svg>';

  var UNLOCK_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/>' +
    '<path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.4-1.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
    '<circle cx="12" cy="15.2" r="1.3" fill="currentColor"/></svg>';

  /** 轮播：横向滑动 + 圆点指示 */
  function setupCarousel() {
    var car = $('#d-carousel');
    var track = $('#d-track');
    if (!car || !track) return;

    var update = function () {
      var w = car.clientWidth || 1;
      var idx = Math.round(car.scrollLeft / w);
      var dots = $$('#d-dots i');
      dots.forEach(function (d, i) { d.classList.toggle('is-active', i === idx); });
      var count = $('#d-count');
      if (count) count.textContent = (idx + 1) + '/' + track.children.length;
    };
    car.addEventListener('scroll', debounce(update, 60));
    update();
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

    var items = p.singleItems || [];
    if (items.length === 1) {
      lines.push('单卖：' + singleItemLabel(items[0]) + ' ¥' + fmtMoney(items[0].price) + '（' + m.label + '）');
    } else if (items.length > 1) {
      lines.push('单卖（' + m.label + '）：');
      items.forEach(function (it) {
        lines.push('  · ' + singleItemLabel(it) + ' ¥' + fmtMoney(it.price));
      });
    } else {
      lines.push('单卖：' + m.label);
    }

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
     报价模板（发给客人的话术）
     ------------------------------------------------------------
     内置 3 种 + 自定义。占位符：
       {名称} {货号} {售价} {单卖} {单卖明细} {标签} {备注}
     ============================================================ */
  var QUOTE_TEMPLATES = {
    simple: {
      name: '简洁清单',
      desc: '一行一项，清楚明白',
      tpl: '【{名称}】{货号}\n整套 ¥{售价}\n{单卖}'
    },
    friendly: {
      name: '口语报价',
      desc: '像在聊天，亲切一点',
      tpl: '亲，这款{名称}整套{售价}哦～\n{单卖}\n有喜欢的随时问我ฅ^•ﻌ•^ฅ'
    },
    compact: {
      name: '极简数字',
      desc: '发群里/朋友圈用',
      tpl: '{名称} {货号}\n整套{售价}｜{单卖短}'
    }
  };

  /** 生成模板需要的变量表 */
  function quoteVars(p) {
    var m = MODES[p.singleMode] || MODES.ask;
    var items = p.singleItems || [];
    var priceStr = p.price != null ? fmtMoney(p.price) : '待定';

    // 单卖：整行描述
    var singleLine;
    var singleShort;
    if (items.length === 1) {
      singleLine = '单卖 ' + singleItemLabel(items[0]) + ' ¥' + fmtMoney(items[0].price);
      singleShort = '单卖' + singleItemLabel(items[0]) + fmtMoney(items[0].price);
    } else if (items.length > 1) {
      singleLine = '也可单买：' + items.map(function (it) {
        return singleItemLabel(it) + '¥' + fmtMoney(it.price);
      }).join('、');
      singleShort = '单卖' + items.map(function (it) {
        return fmtMoney(it.price);
      }).join('/');
    } else if (p.singleMode === 'single') {
      singleLine = '可以单卖，单价待补';
      singleShort = '可单卖';
    } else if (p.singleMode === 'ask') {
      singleLine = '单卖价格需询问';
      singleShort = '单卖需问';
    } else {
      singleLine = '仅整套出售';
      singleShort = '整套';
    }

    // 单卖明细：多行
    var detail = items.length > 1
      ? items.map(function (it) {
          return singleItemLabel(it) + ' ¥' + fmtMoney(it.price);
        }).join(' / ')
      : singleLine;

    return {
      '名称': p.name || '未命名商品',
      '货号': p.code || '',
      '售价': priceStr,
      '单卖': singleLine,
      '单卖短': singleShort,
      '单卖明细': detail,
      '标签': (p.tags || []).map(function (t) { return '#' + t; }).join(' '),
      '备注': p.note || ''
    };
  }

  /** 渲染模板文本 */
  function renderTemplate(tpl, p) {
    var vars = quoteVars(p);
    var out = String(tpl || '');
    Object.keys(vars).forEach(function (k) {
      out = out.split('{' + k + '}').join(vars[k]);
    });
    // 清掉空的可选行（比如没货号时留下空行）
    out = out.split('\n').map(function (line) {
      return line.replace(/\s+$/, '');
    }).filter(function (line, i, arr) {
      // 去掉连续空行和首尾空行
      if (line.trim()) return true;
      return false;
    }).join('\n');
    return out.trim();
  }

  /** 按当前设置生成报价文本 */
  function buildQuote(p) {
    var key = state.quoteTemplate || 'simple';
    var tpl;
    if (key === 'custom') {
      tpl = state.quoteTemplateCustom || QUOTE_TEMPLATES.simple.tpl;
    } else {
      tpl = (QUOTE_TEMPLATES[key] || QUOTE_TEMPLATES.simple).tpl;
    }
    return renderTemplate(tpl, p);
  }

  /* ---- 设置页：模板选择 UI ---- */
  function renderTemplatePicker() {
    var box = $('#set-tpl-list');
    if (!box) return;
    var cur = state.quoteTemplate || 'simple';
    var sample = state.products[0] || sampleProducts()[0];

    var html = '';
    Object.keys(QUOTE_TEMPLATES).forEach(function (k) {
      var t = QUOTE_TEMPLATES[k];
      var preview = renderTemplate(t.tpl, sample);
      html += '<button class="tpl-card' + (cur === k ? ' is-active' : '') + '" type="button" data-tpl="' + k + '">' +
          '<span class="tpl-card__name">' + t.name + '</span>' +
          '<span class="tpl-card__desc">' + t.desc + '</span>' +
          '<span class="tpl-card__preview">' + escapeHtml(preview).replace(/\n/g, '<br>') + '</span>' +
        '</button>';
    });
    // 自定义
    var customPreview = renderTemplate(state.quoteTemplateCustom || QUOTE_TEMPLATES.simple.tpl, sample);
    html += '<button class="tpl-card' + (cur === 'custom' ? ' is-active' : '') + '" type="button" data-tpl="custom">' +
        '<span class="tpl-card__name">自定义</span>' +
        '<span class="tpl-card__desc">自己写格式</span>' +
        '<span class="tpl-card__preview">' + escapeHtml(customPreview).replace(/\n/g, '<br>') + '</span>' +
      '</button>';

    box.innerHTML = html;
    $('#set-tpl-custom-wrap').hidden = cur !== 'custom';
    $('#set-tpl-custom').value = state.quoteTemplateCustom || '';
  }

  function setQuoteTemplate(key) {
    state.quoteTemplate = key;
    DB.setMeta('quoteTemplate', key).catch(function () { /* 忽略 */ });
    renderTemplatePicker();
  }

  /* ============================================================
     长按快捷菜单
     ============================================================ */
  var quickId = null;

  function openQuickMenu(id) {
    var p = getProduct(id);
    if (!p) return;
    quickId = id;
    var items = p.singleItems || [];
    var hasSingle = items.length > 0;

    $('#quick-title').textContent = p.name || '快捷操作';
    $('#quick-body').innerHTML =
      '<div class="quick-list">' +
        '<button class="quick-item quick-item--primary" type="button" data-quick="quote">' +
          '<span class="quick-item__icon">' + QUOTE_ICON + '</span><span>复制报价（发客人）</span></button>' +
        '<button class="quick-item" type="button" data-quick="copy-price"' + (p.price == null ? ' disabled' : '') + '>' +
          '<span class="quick-item__icon">' + YEN_ICON + '</span><span>复制售价 ¥' + (p.price != null ? fmtMoney(p.price) : '—') + '</span></button>' +
        '<button class="quick-item" type="button" data-quick="copy-single"' + (hasSingle ? '' : ' disabled') + '>' +
          '<span class="quick-item__icon">' + TAG_ICON + '</span><span>' +
            (hasSingle ? '复制单卖价（' + items.length + ' 项）' : '复制单卖价') + '</span></button>' +
        '<button class="quick-item" type="button" data-quick="copy-all">' +
          '<span class="quick-item__icon">' + COPY_ICON + '</span><span>复制全部信息</span></button>' +
      '</div>' +
      '<div class="quick-list" style="margin-top:10px">' +
        '<button class="quick-item" type="button" data-quick="detail">' +
          '<span class="quick-item__icon">' + EYE_ICON + '</span><span>查看详情</span></button>' +
        '<button class="quick-item" type="button" data-quick="edit">' +
          '<span class="quick-item__icon">' + EDIT_ICON + '</span><span>编辑</span></button>' +
        '<button class="quick-item quick-item--danger" type="button" data-quick="delete">' +
          '<span class="quick-item__icon">' + TRASH_ICON + '</span><span>删除</span></button>' +
      '</div>' +
      '<p class="hint" style="margin-top:12px;text-align:center">长按卡片即可打开这个菜单</p>';
    openSheet('quick');
  }

  var QUOTE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 6.5h16v9H9l-4 3.5v-3.5H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 10h8M8 12.8h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var YEN_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 6l5 6 5-6M12 12v7M8.5 13.5h7M8.5 16.5h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var TAG_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 11.5V5.5A1.5 1.5 0 0 1 5.5 4h6l8.5 8.5-7.5 7.5L4 11.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8.2" cy="8.2" r="1.4" fill="currentColor"/></svg>';
  var COPY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6.2A2.2 2.2 0 0 0 13.8 4H6.2A2.2 2.2 0 0 0 4 6.2v7.6A2.2 2.2 0 0 0 6.2 16H8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  var EYE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M2.8 12S6.5 5.8 12 5.8 21.2 12 21.2 12 17.5 18.2 12 18.2 2.8 12 2.8 12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.9" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  var EDIT_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 5.5l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var TRASH_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4.5 7h15M9 7V4.8h6V7M6.8 7l1 12.2h8.4L17.2 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';

  function closeQuickMenu() { closeSheet('quick'); quickId = null; }

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
      { name: '粉色碎花连衣裙', code: 'A1023', price: 199,
        singleItems: [{ name: '上衣', price: 89 }], singleMode: 'single',
        tags: ['夏款', '连衣裙', '爆款'], note: '只有 M 码了，面料偏薄' },
      { name: '奶白针织开衫', code: 'B2088', price: 159,
        singleItems: [], singleMode: 'no',
        tags: ['春秋款', '上衣'], note: '整套两件套，不拆卖' },
      { name: '牛仔背带裤三件套', code: 'C3311', price: 268,
        singleItems: [{ name: '上衣', price: 99 }, { name: '裤子', price: 89 }, { name: '内搭', price: 49 }],
        singleMode: 'single',
        tags: ['套装', '春秋款'], note: '三件套，可以拆开单卖' },
      { name: '小熊卫衣亲子装', code: 'D4512', price: 128,
        singleItems: [{ name: '大人款', price: 88 }, { name: '儿童款', price: 58 }], singleMode: 'single',
        tags: ['童装', '亲子装', '新品'], note: '大人小孩同款' },
      { name: '格纹半身裙', code: 'E5107', price: 118,
        singleItems: [], singleMode: 'ask',
        tags: ['春秋款'], note: '单卖要问一下上家' }
    ];
    return raw.map(function (r, i) {
      return normalizeProduct({
        id: DB.uuid(),
        name: r.name, code: r.code, price: r.price, singleItems: r.singleItems,
        singleMode: r.singleMode, tags: r.tags, note: r.note,
        imageCount: 0,
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
     长按检测：触摸按住 500ms 且位移 < 10px 才触发
     ============================================================ */
  var LONG_PRESS_MS = 500;
  var LONG_PRESS_MOVE_TOLERANCE = 10;

  function bindLongPress(root) {
    if (!root) return;
    var timer = null;
    var startX = 0, startY = 0;
    var fired = false;
    var cardEl = null;

    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      cardEl = null;
    }

    root.addEventListener('touchstart', function (e) {
      var card = e.target.closest('.card');
      if (!card) return;
      if (e.touches.length !== 1) return;
      cardEl = card;
      fired = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!cardEl) return;
        fired = true;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) { /* 忽略 */ }
        openQuickMenu(cardEl.dataset.id);
      }, LONG_PRESS_MS);
    }, { passive: true });

    root.addEventListener('touchmove', function (e) {
      if (!cardEl) return;
      var t = e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(t.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE) {
        cancel();
      }
    }, { passive: true });

    root.addEventListener('touchend', function (e) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (fired) {
        // 长按已触发，吞掉这次点击，避免同时打开详情页
        e.preventDefault();
        e.stopPropagation();
        fired = false;
        cardEl = null;
        return;
      }
      cardEl = null;
    });

    root.addEventListener('touchcancel', cancel);

    // 桌面：右键也可打开快捷菜单
    root.addEventListener('contextmenu', function (e) {
      var card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      openQuickMenu(card.dataset.id);
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

    /* ---- 长按卡片 → 快捷菜单 ---- */
    bindLongPress($('#view-products'));
    bindLongPress($('#view-search'));

    $('#view-products').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest('.card');
      if (card) { e.preventDefault(); openDetail(card.dataset.id); }
    });

    /* ---- 快捷菜单动作 ---- */
    $('#quick-body').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-quick]');
      if (!btn || btn.disabled) return;
      var p = getProduct(quickId);
      if (!p) return;
      var act = btn.dataset.quick;

      if (act === 'quote') {
        closeQuickMenu();
        copyWithToast(buildQuote(p), '报价');
        return;
      }
      if (act === 'copy-price') {
        closeQuickMenu();
        if (p.price == null) { toast('这件还没填售价'); return; }
        copyWithToast('售价 ¥' + fmtMoney(p.price), '售价');
        return;
      }
      if (act === 'copy-single') {
        closeQuickMenu();
        var items = p.singleItems || [];
        if (!items.length) { toast('这件没有单卖项'); return; }
        copyWithToast(items.length === 1
          ? singleItemLabel(items[0]) + ' ¥' + fmtMoney(items[0].price)
          : items.map(function (it) { return singleItemLabel(it) + ' ¥' + fmtMoney(it.price); }).join('\n'),
          '单卖价');
        return;
      }
      if (act === 'copy-all') {
        closeQuickMenu();
        copyWithToast(productToText(p), '商品信息');
        return;
      }
      if (act === 'detail') {
        var id = quickId;
        closeQuickMenu();
        setTimeout(function () { openDetail(id); }, 240);
        return;
      }
      if (act === 'edit') {
        var id2 = quickId;
        closeQuickMenu();
        setTimeout(function () { openForm(id2); }, 240);
        return;
      }
      if (act === 'delete') {
        var target = p;
        closeQuickMenu();
        setTimeout(function () {
          confirmDialog('删除「' + target.name + '」？', '删除后无法恢复，图片也会一起删掉。', '删除', true).then(function (ok) {
            if (!ok) return;
            deleteProductById(target.id).then(function () {
              renderAll();
              toast('已删除', 'ok');
            }).catch(function (err) {
              toast(err && err.message ? err.message : '删除失败', 'err');
            });
          });
        }, 240);
        return;
      }
    });

    $$('#sheet-quick [data-close]').forEach(function (el) {
      el.addEventListener('click', function () { closeQuickMenu(); });
    });

    $('#p-tags').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      state.filters.p.tag = chip.dataset.tag || null;
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

    /* ---- 检查更新（强制清缓存重载）---- */
    $('#set-update').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = '检查中…';

      var done = function (msg) {
        toast(msg);
      };

      if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) {
        btn.disabled = false;
        btn.textContent = '检查更新';
        done('当前环境不支持自动更新，请手动刷新页面');
        return;
      }

      navigator.serviceWorker.getRegistration().then(function (reg) {
        var refresh = function () {
          // 清掉所有缓存后硬重载，确保拿到最新文件
          navigator.serviceWorker.controller &&
            navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
          setTimeout(function () {
            location.reload();
          }, 500);
        };

        if (!reg) {
          navigator.serviceWorker.register('sw.js').then(refresh).catch(function () {
            btn.disabled = false;
            btn.textContent = '检查更新';
            done('注册失败，请手动刷新页面');
          });
          return;
        }

        reg.update().then(function () {
          if (reg.waiting) {
            // 有新版本在等待，直接启用
            applyUpdate();
            return;
          }
          refresh();
        }).catch(function () {
          refresh();
        });
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = '检查更新';
        done('检查失败，请手动刷新页面');
      });
    });
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

    /* ---- 报价模板 ---- */
    $('#set-tpl-list').addEventListener('click', function (e) {
      var card = e.target.closest('[data-tpl]');
      if (!card) return;
      setQuoteTemplate(card.dataset.tpl);
    });

    $('#set-tpl-custom').addEventListener('input', debounce(function () {
      state.quoteTemplateCustom = this.value;
      DB.setMeta('quoteTemplateCustom', this.value).catch(function () { /* 忽略 */ });
      // 实时更新右侧预览
      var card = document.querySelector('#set-tpl-list [data-tpl="custom"] .tpl-card__preview');
      if (card) {
        var sample = state.products[0] || sampleProducts()[0];
        var txt = renderTemplate(this.value || QUOTE_TEMPLATES.simple.tpl, sample);
        card.innerHTML = escapeHtml(txt).replace(/\n/g, '<br>');
      }
    }, 300));

    $('#set-tpl-preview').addEventListener('click', function () {
      var sample = state.products[0] || sampleProducts()[0];
      var txt = buildQuote(sample);
      showDialog({
        title: '报价预览',
        message: '以「' + escapeHtml(sample.name) + '」为例，实际复制时会换成对应商品：' +
          '<br><br><div class="preview-box">' + escapeHtml(txt).replace(/\n/g, '<br>') + '</div>',
        buttons: [{ text: '知道了', value: 'ok', style: 'primary' }]
      });
    });

    /* ---- 默认锁定 ---- */
    $('#set-lock').addEventListener('change', function () {
      state.lockByDefault = this.checked;
      DB.setMeta('lockByDefault', this.checked).catch(function () { /* 忽略 */ });
      toast(this.checked ? '以后打开详情默认锁定' : '以后打开详情默认解锁');
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

    $('#f-tag-chips').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      toggleInArray(state.formTags, chip.dataset.tag);
      renderTagChips();
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

    $('#f-tag-custom').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#f-tag-add').click();
      }
    });

    $('#f-name').addEventListener('input', function () {
      if (this.value.trim()) {
        $('#f-name-err').hidden = true;
        this.parentNode.classList.remove('is-invalid');
      }
    });

    /* ---- 草稿自动保存 ---- */
    ['f-name', 'f-code', 'f-price', 'f-note'].forEach(function (id) {
      $('#' + id).addEventListener('input', saveDraftSoon);
    });
    $('#f-mode').addEventListener('click', saveDraftSoon);

    /* ---- 单卖项：增 / 删 / 改 ---- */
    $('#f-single-add').addEventListener('click', addSingleItem);

    $('#f-single-list').addEventListener('click', function (e) {
      var del = e.target.closest('[data-single-del]');
      if (del) {
        removeSingleItem(Number(del.dataset.singleDel));
        return;
      }
    });

    $('#f-single-list').addEventListener('input', function (e) {
      var el = e.target.closest('[data-single]');
      if (!el) return;
      if (el.dataset.single === 'name') {
        syncSingleItemsFromDom();
      } else {
        // 价格输入：只留数字和一个小数点，随手清掉非法字符
        var cleaned = String(el.value).replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
        if (cleaned !== el.value) {
          var pos = el.selectionStart;
          el.value = cleaned;
          try { el.setSelectionRange(pos, pos); } catch (err) { /* 忽略 */ }
        }
        syncSingleItemsFromDom();
      }
      saveDraftSoon();
    });

    // 失焦时把价格规范化（比如 89. 变成 89）
    $('#f-single-list').addEventListener('blur', function (e) {
      var el = e.target.closest('[data-single="price"]');
      if (!el) return;
      var v = parsePrice(el.value);
      el.value = v == null ? '' : fmtMoney(v);
      syncSingleItemsFromDom();
      saveDraftSoon();
    }, true);

    // 回车跳到下一个输入框，方便连续录入
    $('#f-single-list').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var row = e.target.closest('.single-row');
      if (!row) return;
      var isName = e.target.dataset.single === 'name';
      if (isName) {
        var priceEl = row.querySelector('[data-single="price"]');
        if (priceEl) priceEl.focus();
      } else {
        var idx = Number(row.dataset.index);
        var rows = $$('#f-single-list .single-row');
        var next = rows[idx + 1];
        if (next) {
          next.querySelector('[data-single="name"]').focus();
        } else if (state.formSingleItems.length < MAX_SINGLE_ITEMS) {
          addSingleItem();
        } else {
          e.target.blur();
        }
      }
    });

    /* ---- 图片选择（多图）---- */
    $('#f-photo-grid').addEventListener('click', function (e) {
      var addBtn = e.target.closest('[data-photo-add]');
      if (addBtn) {
        if (state.formImagesLoading) return;
        $('#f-photo-input').click();
        return;
      }
      var delBtn = e.target.closest('[data-photo-del]');
      if (delBtn) {
        removePhotoAt(Number(delBtn.dataset.photoDel));
      }
    });

    $('#f-photo-input').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      addPhotoFromFile(file);
    });

    /* ---- 详情 ---- */
    $$('#sheet-detail [data-close]').forEach(function (el) {
      el.addEventListener('click', function () { closeSheet('detail'); });
    });

    /* ---- 锁定 / 解锁 ---- */
    $('#d-lock').addEventListener('click', function () {
      state.detailLocked = !state.detailLocked;
      applyDetailLock();
      toast(state.detailLocked ? '已锁定，只能查看' : '已解锁，可以编辑');
    });

    /* ---- 复制报价 ---- */
    $('#d-copy-quote').addEventListener('click', function () {
      var p = getProduct(state.detailId);
      if (!p) return;
      copyWithToast(buildQuote(p), '报价');
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
      var items = p.singleItems || [];
      if (!items.length) { toast('这件没有单卖项'); return; }
      if (items.length === 1) {
        copyWithToast(singleItemLabel(items[0]) + ' ¥' + fmtMoney(items[0].price), '单卖价');
        return;
      }
      // 多条时一次复制全部明细
      copyWithToast(items.map(function (it) {
        return singleItemLabel(it) + ' ¥' + fmtMoney(it.price);
      }).join('\n'), '单卖明细');
    });

    // 单卖明细里逐项复制
    $('#d-body').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-copy-item]');
      if (!btn) return;
      var p = getProduct(state.detailId);
      if (!p) return;
      var item = (p.singleItems || [])[Number(btn.dataset.copyItem)];
      if (!item) return;
      copyWithToast(singleItemLabel(item) + ' ¥' + fmtMoney(item.price), singleItemLabel(item));
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

    /* ---- 防止 iOS 双击缩放 ----
       注意：这里不要用 touchend + preventDefault。
       那样会把紧随其后的 click 事件一起取消掉，导致"连点两个按钮时第二个没反应"。
       正确做法是 CSS 的 touch-action: manipulation（见 styles.css），
       由浏览器原生处理双击缩放，不干扰 click。 */
  }

  function resetProductFilters() {
    state.filters.p.mode = 'all';
    state.filters.p.tag = null;
    $$('#p-chips .chip').forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.filter === 'all');
    });
    renderProductsView();
  }

  function resetSearchFilters() {
    state.filters.s.query = '';
    state.filters.s.mode = 'all';
    state.filters.s.tag = null;
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
        DB.getMeta('customTags', []),
        DB.getMeta('quoteTemplate', 'simple'),
        DB.getMeta('quoteTemplateCustom', ''),
        DB.getMeta('lockByDefault', true)
      ]);
    }).then(function (res) {
      state.products = (res[0] || []).map(normalizeProduct);
      state.lastBackupAt = res[1] || 0;
      state.remindBackup = res[2] !== false;
      state.customTags = res[3] || [];
      state.quoteTemplate = res[4] || 'simple';
      state.quoteTemplateCustom = res[5] || '';
      state.lockByDefault = res[6] !== false;
      $('#set-remind').checked = state.remindBackup;
      $('#set-lock').checked = state.lockByDefault;
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
    setupServiceWorker();

    /* ---- 阻止 iOS 上把整个页面拖拽回弹（弹层内滚动除外）---- */
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  }

  /* ============================================================
     Service Worker 注册与更新
     ------------------------------------------------------------
     历史上踩过的坑：改了代码重新部署，但缓存版本号没变，
     浏览器一直用旧缓存，手机上表现为"按钮点不了"。
     这里做了三件事避免再次发生：
       1. 发现新版本时提示用户刷新
       2. 每次启动都主动检查更新
       3. 设置页提供「检查更新」按钮，可强制清缓存重载
     ============================================================ */
  var swRegistration = null;
  var refreshing = false;

  function setupServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;

    // 新 SW 接管后自动刷新一次（只刷一次，避免循环）
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        swRegistration = reg;

        // 检测更新：发现等待中的新版本就提示刷新
        reg.addEventListener('updatefound', function () {
          var incoming = reg.installing;
          if (!incoming) return;
          incoming.addEventListener('statechange', function () {
            if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast();
            }
          });
        });

        // 已经有等待中的新版本（比如上次没刷新）
        if (reg.waiting && navigator.serviceWorker.controller) {
          showUpdateToast();
        }

        // 每次启动主动检查一次更新
        reg.update().catch(function () { /* 忽略 */ });
      }).catch(function () {
        /* 离线缓存注册失败不影响主功能 */
      });
    });

    // 从后台切回前台时检查更新
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && swRegistration) {
        swRegistration.update().catch(function () { /* 忽略 */ });
      }
    });
  }

  var updateToastShown = false;
  function showUpdateToast() {
    if (updateToastShown) return;
    updateToastShown = true;
    showDialog({
      title: '有新版本啦',
      message: '已经下载好新版本，点「立即更新」重启一下就能用上。',
      buttons: [
        { text: '稍后', value: null, style: 'ghost' },
        { text: '立即更新', value: 'go', style: 'primary' }
      ]
    }).then(function (v) {
      updateToastShown = false;
      if (v === 'go') applyUpdate();
    });
  }

  /** 让等待中的 SW 立刻接管并刷新页面 */
  function applyUpdate() {
    var waiting = swRegistration && swRegistration.waiting;
    if (!waiting) {
      location.reload();
      return;
    }
    refreshing = true;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    // 兜底：1.2 秒后无论如何都刷新一次
    setTimeout(function () { location.reload(); }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
