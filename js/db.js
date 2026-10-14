/* ============================================================
   db.js · 数据存储层
   ------------------------------------------------------------
   优先使用 IndexedDB（商品 + 图片 + 设置）。
   如果浏览器禁用了 IndexedDB（例如某些隐私模式），
   自动降级到 localStorage，接口完全一致，页面无感知。

   对外暴露：window.DB
   ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'kitty_price_book';
  var DB_VERSION = 1;
  var LS_KEY = 'kitty_price_book_fallback_v1';
  var STORE_PRODUCTS = 'products';
  var STORE_IMAGES = 'images';
  var STORE_META = 'meta';

  /* ---------------- 工具 ---------------- */
  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(v); } catch (e) { /* 降级 */ }
    }
    return JSON.parse(JSON.stringify(v));
  }

  function toPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB 操作失败')); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB 事务失败')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务被中止')); };
    });
  }

  /* ============================================================
     后端 A：IndexedDB
     ============================================================ */
  var IdbBackend = {
    mode: 'idb',
    _db: null,

    open: function () {
      var self = this;
      if (self._db) return Promise.resolve(self._db);
      return new Promise(function (resolve, reject) {
        var req;
        try {
          req = global.indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = function (event) {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
            var ps = db.createObjectStore(STORE_PRODUCTS, { keyPath: 'id' });
            ps.createIndex('updatedAt', 'updatedAt', { unique: false });
            ps.createIndex('createdAt', 'createdAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_IMAGES)) {
            db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_META)) {
            db.createObjectStore(STORE_META, { keyPath: 'key' });
          }
          void event;
        };
        req.onsuccess = function () {
          self._db = req.result;
          self._db.onversionchange = function () { self._db.close(); self._db = null; };
          resolve(self._db);
        };
        req.onerror = function () { reject(req.error || new Error('无法打开 IndexedDB')); };
        req.onblocked = function () { reject(new Error('IndexedDB 被其它标签页占用')); };
      });
    },

    _store: function (name, mode) {
      return this.open().then(function (db) {
        return db.transaction(name, mode).objectStore(name);
      });
    },

    /* ---- 商品 ---- */
    allProducts: function () {
      return this._store(STORE_PRODUCTS, 'readonly')
        .then(function (store) { return toPromise(store.getAll()); })
        .then(function (rows) { return rows || []; });
    },
    getProduct: function (id) {
      return this._store(STORE_PRODUCTS, 'readonly')
        .then(function (store) { return toPromise(store.get(id)); })
        .then(function (row) { return row || null; });
    },
    putProduct: function (product) {
      var self = this;
      return self._store(STORE_PRODUCTS, 'readwrite').then(function (store) {
        store.put(clone(product));
        return txDone(store.transaction);
      });
    },
    deleteProduct: function (id) {
      return this._store(STORE_PRODUCTS, 'readwrite').then(function (store) {
        store.delete(id);
        return txDone(store.transaction);
      });
    },
    bulkPutProducts: function (list) {
      return this._store(STORE_PRODUCTS, 'readwrite').then(function (store) {
        list.forEach(function (p) { store.put(clone(p)); });
        return txDone(store.transaction);
      });
    },

    /* ---- 图片 ---- */
    putImage: function (id, blob, meta) {
      return this._store(STORE_IMAGES, 'readwrite').then(function (store) {
        store.put({
          id: id,
          blob: blob,
          thumb: (meta && meta.thumb) || null,
          w: (meta && meta.w) || 0,
          h: (meta && meta.h) || 0,
          bytes: (meta && meta.bytes) || (blob && blob.size) || 0,
          updatedAt: Date.now()
        });
        return txDone(store.transaction);
      });
    },
    getImage: function (id) {
      return this._store(STORE_IMAGES, 'readonly')
        .then(function (store) { return toPromise(store.get(id)); })
        .then(function (row) { return row || null; });
    },
    allImages: function () {
      return this._store(STORE_IMAGES, 'readonly')
        .then(function (store) { return toPromise(store.getAll()); })
        .then(function (rows) { return rows || []; });
    },
    deleteImage: function (id) {
      return this._store(STORE_IMAGES, 'readwrite').then(function (store) {
        store.delete(id);
        return txDone(store.transaction);
      });
    },

    /* ---- 设置 ---- */
    getMeta: function (key, fallback) {
      return this._store(STORE_META, 'readonly')
        .then(function (store) { return toPromise(store.get(key)); })
        .then(function (row) { return row ? row.value : fallback; })
        .catch(function () { return fallback; });
    },
    setMeta: function (key, value) {
      return this._store(STORE_META, 'readwrite').then(function (store) {
        store.put({ key: key, value: clone(value) });
        return txDone(store.transaction);
      });
    },

    /* ---- 清空 ---- */
    clearAll: function () {
      var self = this;
      return self.open().then(function (db) {
        var tx = db.transaction([STORE_PRODUCTS, STORE_IMAGES, STORE_META], 'readwrite');
        tx.objectStore(STORE_PRODUCTS).clear();
        tx.objectStore(STORE_IMAGES).clear();
        tx.objectStore(STORE_META).clear();
        return txDone(tx);
      });
    },

    estimate: function () {
      if (!global.navigator || !navigator.storage || !navigator.storage.estimate) {
        return Promise.resolve(null);
      }
      return navigator.storage.estimate().catch(function () { return null; });
    }
  };

  /* ============================================================
     后端 B：localStorage 降级
     图片以 dataURL 字符串保存（空间有限，但保证能用）
     ============================================================ */
  var LsBackend = {
    mode: 'ls',
    _cache: null,

    open: function () {
      if (!this._cache) this._read();
      return Promise.resolve(true);
    },

    _read: function () {
      var raw = null;
      try { raw = global.localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
      if (raw) {
        try {
          var parsed = JSON.parse(raw);
          this._cache = {
            products: parsed.products || [],
            images: parsed.images || {},
            meta: parsed.meta || {}
          };
          return;
        } catch (e) { /* 数据坏了，重建 */ }
      }
      this._cache = { products: [], images: {}, meta: {} };
    },

    _write: function () {
      try {
        global.localStorage.setItem(LS_KEY, JSON.stringify(this._cache));
        return true;
      } catch (e) {
        throw new Error('本地存储空间不足，建议先导出备份再清理部分图片');
      }
    },

    allProducts: function () {
      this._read();
      return Promise.resolve(this._cache.products.map(clone));
    },
    getProduct: function (id) {
      this._read();
      var found = this._cache.products.filter(function (p) { return p.id === id; })[0];
      return Promise.resolve(found ? clone(found) : null);
    },
    putProduct: function (product) {
      this._read();
      var list = this._cache.products.filter(function (p) { return p.id !== product.id; });
      list.push(clone(product));
      this._cache.products = list;
      this._write();
      return Promise.resolve();
    },
    deleteProduct: function (id) {
      this._read();
      this._cache.products = this._cache.products.filter(function (p) { return p.id !== id; });
      delete this._cache.images[id];
      this._write();
      return Promise.resolve();
    },
    bulkPutProducts: function (list) {
      this._read();
      var map = {};
      this._cache.products.forEach(function (p) { map[p.id] = p; });
      list.forEach(function (p) { map[p.id] = clone(p); });
      this._cache.products = Object.keys(map).map(function (k) { return map[k]; });
      this._write();
      return Promise.resolve();
    },

    putImage: function (id, blob, meta) {
      this._read();
      var self = this;
      return blobToDataURL(blob).then(function (dataUrl) {
        var row = {
          id: id,
          dataUrl: dataUrl,
          w: (meta && meta.w) || 0,
          h: (meta && meta.h) || 0,
          bytes: (meta && meta.bytes) || (blob && blob.size) || 0,
          updatedAt: Date.now()
        };
        // localStorage 空间紧张，缩略图不再单独存一份
        self._cache.images[id] = row;
        self._write();
      });
    },
    getImage: function (id) {
      this._read();
      var row = this._cache.images[id];
      if (!row) return Promise.resolve(null);
      return dataURLToBlob(row.dataUrl).then(function (blob) {
        return { id: id, blob: blob, dataUrl: row.dataUrl, w: row.w, h: row.h, bytes: row.bytes };
      });
    },
    allImages: function () {
      this._read();
      var self = this;
      var ids = Object.keys(this._cache.images);
      return Promise.all(ids.map(function (id) { return self.getImage(id); }))
        .then(function (rows) { return rows.filter(Boolean); });
    },
    deleteImage: function (id) {
      this._read();
      delete this._cache.images[id];
      this._write();
      return Promise.resolve();
    },

    getMeta: function (key, fallback) {
      this._read();
      return Promise.resolve(this._cache.meta.hasOwnProperty(key) ? clone(this._cache.meta[key]) : fallback);
    },
    setMeta: function (key, value) {
      this._read();
      this._cache.meta[key] = clone(value);
      this._write();
      return Promise.resolve();
    },

    clearAll: function () {
      this._cache = { products: [], images: {}, meta: {} };
      try { global.localStorage.removeItem(LS_KEY); } catch (e) { /* 忽略 */ }
      return Promise.resolve();
    },

    estimate: function () {
      var bytes = 0;
      try {
        var raw = global.localStorage.getItem(LS_KEY) || '';
        bytes = raw.length * 2;
      } catch (e) { bytes = 0; }
      // localStorage 一般 5MB 左右
      return Promise.resolve({ usage: bytes, quota: 5 * 1024 * 1024, fallback: true });
    }
  };

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('图片读取失败')); };
      fr.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataUrl) {
    return new Promise(function (resolve) {
      try {
        var parts = String(dataUrl).split(',');
        var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
        var bin = atob(parts[1] || '');
        var len = bin.length;
        var u8 = new Uint8Array(len);
        for (var i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
        resolve(new Blob([u8], { type: mime }));
      } catch (e) {
        resolve(new Blob([], { type: 'image/jpeg' }));
      }
    });
  }

  /* ============================================================
     选择后端 + 对外接口
     ============================================================ */
  var backend = IdbBackend;
  var readyPromise = null;
  var modeReported = 'idb';

  function detect() {
    if (!global.indexedDB) return Promise.resolve(false);
    // 有些隐私模式 open 会抛异常 / 一直 blocked，这里用超时兜底
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; resolve(false); }
      }, 2500);
      try {
        var req = global.indexedDB.open('__kitty_probe__', 1);
        req.onsuccess = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { req.result.close(); } catch (e) { /* 忽略 */ }
          try { global.indexedDB.deleteDatabase('__kitty_probe__'); } catch (e) { /* 忽略 */ }
          resolve(true);
        };
        req.onerror = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        };
        req.onblocked = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        };
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(false); }
      }
    });
  }

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = detect().then(function (ok) {
      backend = ok ? IdbBackend : LsBackend;
      modeReported = backend.mode;
      return backend.open().then(function () {
        return modeReported;
      }).catch(function (err) {
        // IndexedDB 打开失败 → 再降级一次
        if (backend === IdbBackend) {
          backend = LsBackend;
          modeReported = 'ls';
          return backend.open().then(function () { return modeReported; });
        }
        throw err;
      });
    });
    return readyPromise;
  }

  var DB = {
    ready: ready,
    get mode() { return modeReported; },
    get usingFallback() { return modeReported === 'ls'; },
    uuid: uuid,

    allProducts: function () { return ready().then(function () { return backend.allProducts(); }); },
    getProduct: function (id) { return ready().then(function () { return backend.getProduct(id); }); },
    putProduct: function (p) { return ready().then(function () { return backend.putProduct(p); }); },
    deleteProduct: function (id) { return ready().then(function () { return backend.deleteProduct(id); }); },
    bulkPutProducts: function (l) { return ready().then(function () { return backend.bulkPutProducts(l); }); },

    putImage: function (id, blob, meta) { return ready().then(function () { return backend.putImage(id, blob, meta); }); },
    getImage: function (id) { return ready().then(function () { return backend.getImage(id); }); },
    allImages: function () { return ready().then(function () { return backend.allImages(); }); },
    deleteImage: function (id) { return ready().then(function () { return backend.deleteImage(id); }); },

    getMeta: function (k, d) { return ready().then(function () { return backend.getMeta(k, d); }); },
    setMeta: function (k, v) { return ready().then(function () { return backend.setMeta(k, v); }); },

    clearAll: function () { return ready().then(function () { return backend.clearAll(); }); },
    estimate: function () { return ready().then(function () { return backend.estimate(); }); }
  };

  global.DB = DB;
})(window);
