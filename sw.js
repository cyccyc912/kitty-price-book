/* ============================================================
   sw.js · Service Worker
   ------------------------------------------------------------
   策略：
   - 安装时预缓存 App Shell（HTML/CSS/JS/图标）
   - 导航请求（index.html）：网络优先，失败回落缓存 → 保证每次都能拿到新版
   - 其它静态资源：stale-while-revalidate（先用缓存秒开，同时后台拉新版）
   - 只处理同源 GET 请求，不碰任何第三方请求

   ⚠️ 重要：每次修改 js/css/html 后，必须把下面的 CACHE_VERSION 改成新版本号，
   否则浏览器会继续用旧缓存，用户永远看不到新代码（曾经因此出过
   "改了代码但手机上按钮点不了"的问题）。
   ============================================================ */

var CACHE_VERSION = 'kitty-price-book-v1.3.0';
var SHELL_CACHE = CACHE_VERSION + '-shell';
var RUNTIME_CACHE = CACHE_VERSION + '-runtime';

var SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './icons/kitty-b64.css',
  './js/db.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png'
];

/* ---------------- 安装：预缓存 ---------------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // 逐个添加，单个失败不影响整体安装
      return Promise.all(SHELL_ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {
          return null;
        });
      }));
    }).then(function () {
      // 新 SW 立即进入 waiting → active，不等旧页面全部关闭
      return self.skipWaiting();
    })
  );
});

/* ---------------- 激活：清理所有旧版本缓存 ---------------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        // 只保留当前版本的缓存，其余（含旧版本）全部删除
        if (key.indexOf(CACHE_VERSION) !== 0) {
          return caches.delete(key);
        }
        return null;
      }));
    }).then(function () {
      // 立即接管所有已打开的页面
      return self.clients.claim();
    })
  );
});

/* ---------------- 请求拦截 ---------------- */
self.addEventListener('fetch', function (event) {
  var req = event.request;

  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  var isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') >= 0;

  // 页面导航：网络优先，断网回落缓存。
  // 这样只要联网就一定能拿到最新版页面，避免被旧缓存卡住。
  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (cache) { cache.put('./index.html', copy); });
          return res;
        })
        .catch(function () {
          return caches.match('./index.html').then(function (cached) {
            return cached || caches.match('./') || new Response(
              '<!doctype html><meta charset="utf-8"><title>离线</title>' +
              '<body style="font-family:-apple-system,sans-serif;padding:40px;text-align:center;color:#5d4e56">' +
              '<h2>暂时打不开</h2><p>请先联网打开一次这个应用，之后就能离线使用了。</p></body>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 }
            );
          });
        })
    );
    return;
  }

  // 其它同源静态资源：先用缓存（秒开），同时后台更新缓存
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(RUNTIME_CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        if (cached) return cached;
        return Response.error();
      });
      // 有缓存就立刻返回，网络请求在后台跑（stale-while-revalidate）
      return cached || network;
    })
  );
});

/* ---------------- 消息：手动触发更新 / 清缓存 ---------------- */
self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }).then(function () {
        return self.clients.matchAll();
      }).then(function (clients) {
        clients.forEach(function (c) { c.postMessage({ type: 'CACHE_CLEARED' }); });
      })
    );
  }
});
