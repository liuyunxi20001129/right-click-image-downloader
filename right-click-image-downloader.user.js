// ==UserScript==
// @name         快速下载原图
// @name:en      Quick Original Image Downloader
// @namespace    https://github.com/workbuddy
// @id          right-click-image-downloader@workbuddy
// @version      3.0.5
// @description  Alt + 左键点击网页图片（含缩略图卡片外层），自动进详情页找原图并下载最高清版本，按网页上显示的名称命名；文件头识别真实格式，本地文件名与提示完全一致。花瓣网走官方接口取签名原图与发布内容命名。右键为浏览器原生菜单。
// @description:en  Alt + left-click any web image to download the original (highest-resolution) file — enters the detail page to locate the true original, saves with magic-byte format detection so the filename on disk always matches the toast. Huaban uses the official API for signed originals and raw_text naming. Right-click is the native menu.
// @author       WorkBuddy
// @license      MIT
// @homepageURL  https://github.com/liuyunxi20001129/right-click-image-downloader
// @supportURL   https://github.com/liuyunxi20001129/right-click-image-downloader/issues
// @icon      data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA3UlEQVR4nO3WQQ7CMAwF0d6L23FotrBHRWrSxGObGSl7/6cuehxmZgt6PF/vyPdXY9Og0ANRCHoUikCPQRHoESgCfTyKQB+NI9AHowD0sTgCfagA3QF+JUAGgIhPkQK4hCCAAAIIIIAAAggggAACCCCAAAKEjY+CQAFGagVwp/IAKyoJsKMSABGlBYgsFQAZDpAhBCBjIQAV2gZQqWmAM4TKDY//BujQFEDHLgPQh+5KgJFmfzWzvqHxAjRDmBrfBeHW+OoIS8ZXRVg6vhrClvEVILYPz4SCjjWzNn0A+n8GFautD9YAAAAASUVORK5CYII=
// @match        *://*/*
// @match        file:///*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      huaban.com
// @connect      huabanimg.com
// @connect      self
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    MAX_NAME_LEN: 80,
    SRCSET_USE_LARGEST: true,
    SHOW_TOAST: true,
    FETCH_TIMEOUT: 9000,
  };

  GM_registerMenuCommand('使用说明', () => {
    alert(
      'Alt + 左键图片 = 下载原图（按网页名称命名）\n' +
      '普通右键 = 浏览器原生菜单（脚本不拦截）\n\n' +
      '下载机制：\n' +
      '· 多个候选原图【并发竞速】，最快者先落盘，典型 <1 秒\n' +
      '· 每候选走【页面 fetch + GM_xhr 双通道】：fetch 命中浏览器缓存/CDN 最快，GM_xhr 兜底跨域\n\n' +
      '原图判断逻辑：\n' +
      '1. 花瓣网：调官方 v3 接口拿签名原图 + 发布内容命名（异步追加，不拖慢开拉）\n' +
      '2. 缩略图外链详情页：抓 og:image / 主图 data-original / srcset 最大图\n' +
      '3. 常见缩略图规则变换：WordPress -300x200、微博 orj360→oslarge、twimg name=orig、Pinterest /236x/→/originals/、B站 @后缀\n\n' +
      '文件名优先级（通用站）：\n' +
      '包裹图片 <a> 的 title/aria-label > figcaption > alt/title/data-* > 相邻短文本 > 详情页标题 > URL 文件名\n' +
      '花瓣网：发布内容(raw_text) > 网页文字 > 画板名 > 花瓣_<pin号>\n\n' +
      '失败提示自查：\n' +
      '· 连接超时/被拦截 → 篡改猴域名授权未放行（设置→域名 允许 huaban.com、hbimg.huaban.com 等）\n' +
      '· 传输中断 → 网络波动；fetch跨域被拦截 → 当前站点禁止跨域下载（换花瓣站内即可）'
    );
  });

  /* ----------------------- 工具函数 ----------------------- */

  function isImageUrl(u) {
    return /\.(jpe?g|png|gif|webp|bmp|svg|avif|tiff?|ico)(\?|#|$)/i.test(u);
  }

  function toAbs(url) {
    try { return new URL(url, location.href).href; } catch (e) { return url; }
  }

  function cleanText(s) {
    if (!s) return '';
    return s.replace(/\s+/g, ' ').replace(/[\r\n\t]+/g, ' ').trim();
  }

  function isJunk(s) {
    if (!s || s.length > 120) return true;
    if (/^(点击|查看|click|view|enlarge|放大|加载中|loading)/i.test(s)) return true;
    if (/^https?:\/\//i.test(s)) return true;
    return false;
  }

  function getExt(url) {
    try {
      const u = new URL(url, location.href);
      const path = decodeURIComponent(u.pathname);
      const m = path.match(/\.([a-z0-9]{2,5})$/i);
      if (m) return '.' + m[1].toLowerCase();
      const q = u.search.match(/[?&][^=?]*\.([a-z0-9]{2,5})(?:$|&)/i);
      if (q) return '.' + q[1].toLowerCase();
    } catch (e) {}
    return '';
  }

  function mimeToExt(mime) {
    const m = {
      'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
      'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
      'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/tiff': '.tif',
    };
    return m[(mime || '').toLowerCase().split(';')[0].trim()] || '';
  }

  function sanitize(name) {
    let s = (name || '').trim().replace(/\s+/g, ' ');
    s = s.replace(/[\\/:*?"<>|\r\n\t]/g, '');
    s = s.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
    s = s.replace(/\.{2,}/g, '.');
    s = s.replace(/\.[a-z0-9]{2,5}$/i, '');
    s = s.slice(0, CONFIG.MAX_NAME_LEN).trim();
    s = s.replace(/[. ]+$/g, '');
    return s;
  }

  function isMeaninglessName(s) {
    if (!s) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
    if (/^[0-9a-f]{16,}$/i.test(s)) return true;
    if (/^\d{10,}$/.test(s)) return true;
    if (/^[a-z0-9]{20,}$/i.test(s)) return true;
    return false;
  }

  function dedupe(arr) { return Array.from(new Set(arr)); }

  /* ----------------------- 元素级原图地址 ----------------------- */

  function largestFromSrcset(set) {
    const parts = set.split(',').map((p) => p.trim()).filter(Boolean);
    let best = '', bestN = -1;
    for (const p of parts) {
      const m = p.match(/^(\S+)\s+(?:(\d+)w|(\d+(?:\.\d+)?)x)$/);
      if (!m) continue;
      const u = m[1];
      const n = m[2] ? parseInt(m[2], 10) : parseFloat(m[3]) * (window.devicePixelRatio || 1) * 1000;
      if (n > bestN) { bestN = n; best = u; }
    }
    return best;
  }

  function getOriginalUrl(el) {
    let url = '';
    const dataKeys = [
      'original', 'src', 'real-src', 'realSrc', 'real', 'large', 'big', 'zoom',
      'full', 'hires', 'high', 'hd', 'lazy-src', 'ori', 'origin', 'osrc',
      'large-src', 'big-src', 'full-src', 'original-src', 'source-src',
      'orjURL', 'zoom-src', 'hd-src', 'true-src', 'bdata-src',
    ];
    for (const k of dataKeys) {
      const v = el.getAttribute && el.getAttribute('data-' + k);
      if (v && /^(https?:|\/\/|data:image\/)/.test(v)) { url = v; break; }
    }
    if (CONFIG.SRCSET_USE_LARGEST && el.srcset) {
      const s = largestFromSrcset(el.srcset);
      if (s) url = s;
    }
    if (!url) url = el.currentSrc || el.src || '';
    try {
      const a = el.closest && el.closest('a[href]');
      if (a) {
        const h = a.getAttribute('href');
        if (h && isImageUrl(h) && toAbs(h) !== toAbs(url)) url = h;
      }
    } catch (e) {}
    return toAbs(url);
  }

  function getBgImage(el) {
    try {
      const cs = getComputedStyle(el);
      const bi = cs.backgroundImage || cs.webkitMaskImage || '';
      if (bi && bi !== 'none') {
        const m = bi.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) return m[1];
      }
    } catch (e) {}
    return null;
  }

  function getImageFromTarget(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target.tagName === 'IMG') return { el: target, bgUrl: null };
    const bg = getBgImage(target);
    if (bg) return { el: target, bgUrl: bg };
    const found = findNearestImg(target);
    if (found) return { el: found, bgUrl: null };
    return null;
  }

  function findNearestImg(node) {
    if (!node || !node.querySelector) return null;
    const child = node.querySelector('img');
    if (child) return child;
    let p = node.parentElement, depth = 0;
    while (p && depth < 5) {
      const im = p.querySelector && p.querySelector('img');
      if (im) return im;
      p = p.parentElement;
      depth++;
    }
    return null;
  }

  /* ----------------------- 花瓣网：接口取原图 ----------------------- */

  function isHuabanPage() {
    return /(^|\.)huaban\.com$/i.test(location.hostname);
  }

  function isHuabanCdn(url) {
    try {
      const h = new URL(url).hostname;
      return /hbimg/i.test(h) && /\.huaban(img)?\.com$/i.test(h);
    } catch (e) { return false; }
  }

  // Referer 智能匹配：避免给跨站图片硬塞第三方 Referer 触发 CDN 反盗链/头异常
  function refererFor(url) {
    try {
      const h = new URL(url, location.href).hostname;
      if (/\.huaban(img)?\.com$/i.test(h)) return 'https://huaban.com/';
      if (h === location.hostname) return location.href;
    } catch (e) {}
    return ''; // 跨站第三方图：不带 Referer
  }

  function huabanCdnOriginal(url) {
    if (!isHuabanCdn(url)) return url;
    try {
      const u = new URL(url);
      u.hostname = u.hostname.replace(/^gd-hbimg-edge\./i, 'gd-hbimg.');
      u.pathname = u.pathname
        .replace(/_(?:sq|fw|sf|sh|fh)\d+.*$/i, '')
        .replace(/\/format\/.*$/i, '');
      u.search = '';
      u.hash = '';
      return u.href;
    } catch (e) { return url; }
  }

  function huabanPinIdFromContext(target) {
    let node = target;
    for (let i = 0; i < 15 && node; i++) {
      try {
        const a = node.closest && node.closest('a[href]');
        if (a) {
          const mm = (a.getAttribute('href') || '').match(/\/pins?\/(\d+)/i);
          if (mm) return mm[1];
        }
        const holder = node.closest && node.closest('[data-pin-id], [data-pinid]');
        if (holder) {
          const did = holder.getAttribute('data-pin-id') || holder.getAttribute('data-pinid');
          if (did && /^\d+$/.test(did)) return did;
        }
      } catch (e) {}
      node = node.parentElement;
    }
    const img = target && target.tagName === 'IMG' ? target : (target && target.querySelector ? target.querySelector('img') : null);
    if (img) {
      const did = img.getAttribute('data-id') || img.getAttribute('data-pin-id');
      if (did && /^\d{5,}$/.test(did)) return did;
      const key = huabanKeyFromUrl(img.currentSrc || img.src || '');
      if (key) {
        const pid = huabanPinIdByImgKey(key);
        if (pid) return pid;
      }
    }
    const m = location.pathname.match(/\/pins?\/(\d+)/i);
    if (m) return m[1];
    return null;
  }

  function huabanKeyFromUrl(u) {
    try {
      if (!u || !isHuabanCdn(u)) return '';
      const p = new URL(u, location.href).pathname.replace(/^\//, '');
      return p.replace(/_(?:sq|fw|sf|sh|fh)\d+.*$/i, '').replace(/\/format\/.*$/i, '');
    } catch (e) { return ''; }
  }

  function huabanPinIdByImgKey(key) {
    try {
      const links = document.querySelectorAll('a[href*="/pins/"]');
      for (const a of links) {
        const img = a.querySelector('img');
        const src = img ? (img.currentSrc || img.getAttribute('src') || '') : '';
        if (src && src.indexOf(key) !== -1) {
          const m = (a.getAttribute('href') || '').match(/\/pins?\/(\d+)/i);
          if (m) return m[1];
        }
      }
    } catch (e) {}
    try {
      const st = window.__INITIAL_STATE__ || window.__APOLLO_STATE__ || window.__PRELOADED_STATE__;
      if (st) {
        const pid = findPinIdInState(st, key, 0, { n: 8000 });
        if (pid) return pid;
      }
    } catch (e) {}
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (t.length < 20 || t.length > 3000000) continue;
        const i = t.indexOf(key);
        if (i === -1) continue;
        const before = t.slice(Math.max(0, i - 2000), i);
        const re = /"pin_id"\s*:\s*(\d+)/g;
        let m, last = null;
        while ((m = re.exec(before))) last = m[1];
        if (last) return last;
      }
    } catch (e) {}
    return null;
  }

  function findPinIdInState(obj, key, depth, budget) {
    if (!obj || typeof obj !== 'object' || depth > 8 || budget.n <= 0) return null;
    budget.n--;
    const f = obj.file;
    if (f && typeof f === 'object' && f.key === key) {
      const id = obj.pin_id || obj.pinId || obj.id;
      if (id && /^\d+$/.test(String(id))) return String(id);
    }
    for (const k in obj) {
      const r = findPinIdInState(obj[k], key, depth + 1, budget);
      if (r) return r;
    }
    return null;
  }

  function getHuabanPin(pinId, cb) {
    const apiUrl = 'https://huaban.com/v3/pins/' + pinId;
    const parse = (json) => {
      const pin = json && json.pin;
      if (!pin) throw new Error('no pin');
      const f = pin.file || {};
      const urls = [];
      if (f.url) urls.push(f.url);
      if (f.bucket && f.key) urls.push('https://' + f.bucket + '.huaban.com/' + f.key);
      return {
        urls: dedupe(urls),
        ext: mimeToExt(f.type),
        width: f.width || 0,
        height: f.height || 0,
        rawText: cleanText(pin.raw_text || ''),
        board: (pin.board && pin.board.title) || '',
      };
    };
    if (isHuabanPage()) {
      fetch(apiUrl, { headers: { 'Accept': 'application/json' } })
        .then((r) => r.json())
        .then((j) => cb(parse(j)))
        .catch(() => cb(null));
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url: apiUrl,
      headers: { 'User-Agent': navigator.userAgent, 'Referer': refererFor(apiUrl) || 'https://huaban.com/', 'Accept': 'application/json' },
      timeout: CONFIG.FETCH_TIMEOUT,
      onload: (res) => { try { cb(parse(JSON.parse(res.responseText))); } catch (e) { cb(null); } },
      onerror: () => cb(null),
      ontimeout: () => cb(null),
    });
  }

  /* ----------------------- 通用站：缩略图规则变换 ----------------------- */

  function transformThumbUrl(url) {
    const out = [];
    try {
      const u = new URL(url);
      const h = u.hostname;
      const p = u.pathname;
      if (/-\d{2,4}x\d{2,4}(\.[a-z0-9]{2,5})$/i.test(p)) {
        out.push(u.origin + p.replace(/-\d{2,4}x\d{2,4}(\.[a-z0-9]{2,5})$/i, '$1'));
      }
      if (/(?:_thumb|-thumb|_small|-small|_medium|-medium|_s)(\.[a-z0-9]{2,5})$/i.test(p)) {
        out.push(u.origin + p.replace(/(?:_thumb|-thumb|_small|-small|_medium|-medium|_s)(\.[a-z0-9]{2,5})$/i, '$1'));
      }
      if (/sinaimg\.cn$/i.test(h)) {
        out.push(url.replace(/\/(orj360|bmiddle|orj1080|thumb150|thumbnail|square|mw690)\//i, '/oslarge/'));
      }
      if (/twimg\.com$/i.test(h) && u.search) {
        const nu = new URL(url);
        nu.searchParams.set('name', 'orig');
        out.push(nu.href);
      }
      if (/pinimg\.com$/i.test(h)) {
        out.push(url.replace(/\/\d{2,4}x\//, '/originals/'));
      }
      if (/hdslb\.com$/i.test(h) && /@/.test(p)) {
        out.push(u.origin + p.replace(/@.*$/, ''));
      }
    } catch (e) {}
    return dedupe(out).filter((x) => x && x !== url);
  }

  /* ----------------------- 通用站：进详情页找原图 ----------------------- */

  function fetchDetailCandidates(pageUrl, cb) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: pageUrl,
      headers: { 'User-Agent': navigator.userAgent, 'Accept': 'text/html,application/xhtml+xml' },
      timeout: CONFIG.FETCH_TIMEOUT,
      onload: (res) => {
        try {
          const doc = new DOMParser().parseFromString(res.responseText || '', 'text/html');
          const urls = [];
          const abs = (x) => { try { return new URL(x, pageUrl).href; } catch (e) { return ''; } };
          doc.querySelectorAll('meta[property="og:image"], meta[name="og:image"], meta[property="twitter:image"], meta[name="twitter:image"]')
            .forEach((m) => {
              const u = abs(m.getAttribute('content') || '');
              if (u && isImageUrl(u)) urls.push({ url: u, trust: 'og' });
            });
          doc.querySelectorAll('a[href]').forEach((a) => {
            const h = a.getAttribute('href') || '';
            if (isImageUrl(h)) {
              const u = abs(h);
              if (u) urls.push({ url: u, trust: 'struct' });
            }
          });
          const imgs = Array.from(doc.querySelectorAll('img')).map((im) => {
            const w = parseInt(im.getAttribute('width') || '0', 10);
            const hh = parseInt(im.getAttribute('height') || '0', 10);
            let best = '';
            const keys = ['original', 'src', 'real-src', 'large', 'big', 'full', 'hires', 'zoom', 'lazy-src'];
            for (const k of keys) {
              const v = im.getAttribute('data-' + k);
              if (v && /^(https?:|\/\/)/.test(v)) { best = v; break; }
            }
            if (!best && im.getAttribute('srcset')) best = largestFromSrcset(im.getAttribute('srcset'));
            if (!best) best = im.getAttribute('src') || '';
            return { u: abs(best), area: w * hh, dataDriven: !!im.getAttribute('data-original') || !!im.getAttribute('data-src') };
          }).filter((x) => x.u && isImageUrl(x.u));
          imgs.sort((a, b) => (b.dataDriven - a.dataDriven) || (b.area - a.area));
          imgs.slice(0, 2).forEach((x) => urls.push({ url: x.u, trust: x.dataDriven ? 'struct' : 'og' }));
          const ogTitle = (doc.querySelector('meta[property="og:title"], meta[name="og:title"]') || {}).content || '';
          const title = cleanText(ogTitle || (doc.title || ''));
          cb({ urls: dedupe(urls.map((x) => x.url)).map((u) => urls.find((x) => x.url === u)), title: title });
        } catch (e) {
          cb({ urls: [], title: '' });
        }
      },
      onerror: () => cb({ urls: [], title: '' }),
      ontimeout: () => cb({ urls: [], title: '' }),
    });
  }

  /* ----------------------- 取网页显示的名称 ----------------------- */

  function collectNameCandidates(el) {
    const cands = [];
    const push = (s, score) => {
      s = cleanText(s);
      if (s && !isJunk(s)) cands.push({ s, score });
    };
    push(el.alt, 50);
    push(el.title, 45);
    push(el.getAttribute && el.getAttribute('aria-label'), 40);
    ['name', 'caption', 'title', 'alt', 'desc', 'label', 'figcaption'].forEach((k) => {
      const v = el.getAttribute && el.getAttribute('data-' + k);
      if (v) push(v, 42);
    });
    let node = el;
    while (node && node.parentElement && node.tagName !== 'FIGURE') node = node.parentElement;
    if (node && node.tagName === 'FIGURE') {
      const fc = node.querySelector('figcaption');
      if (fc) push(fc.textContent, 60);
    }
    try {
      const a = el.closest && el.closest('a[href]');
      if (a) {
        push(a.getAttribute('title'), 72);
        push(a.getAttribute('aria-label'), 66);
        const aText = Array.from(a.childNodes)
          .filter((n) => n.nodeType === 3 && n.textContent.trim())
          .map((n) => n.textContent).join(' ');
        if (aText.length <= 60) push(aText, 35);
        a.querySelectorAll('.description, .pin-desc, .pin-title, [class*="desc" i], [class*="title" i]')
          .forEach((c) => push(c.textContent, 58));
      }
    } catch (e) {}
    const captionSel =
      'figcaption, .description, .pin-desc, .pin-title, [class*="caption" i], [class*="title" i], ' +
      '[class*="desc" i], [class*="name" i], [class*="info" i], [id*="caption" i], ' +
      '[class*="图注" i], [class*="说明" i], [class*="图名" i]';
    const container = el.closest
      ? el.closest('figure, li, .item, [class*="item" i], [class*="card" i], a[href], div, td')
      : null;
    if (container) container.querySelectorAll(captionSel).forEach((c) => push(c.textContent, 55));
    if (el.parentElement) {
      Array.from(el.parentElement.children).forEach((ch) => {
        if (ch !== el && ch.textContent && ch.textContent.trim().length <= 60) push(ch.textContent, 30);
      });
      const parentText = Array.from(el.parentElement.childNodes)
        .filter((n) => n.nodeType === 3 && n.textContent.trim())
        .map((n) => n.textContent).join(' ');
      if (parentText.length <= 60) push(parentText, 22);
    }
    return cands;
  }

  function getImageName(el) {
    const cands = collectNameCandidates(el);
    if (cands.length === 0) return '';
    const seen = new Set();
    const uniq = cands.filter((c) => {
      const k = c.s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    uniq.sort((a, b) => b.score - a.score || a.s.length - b.s.length);
    return uniq[0].s;
  }

  function fallbackName(url) {
    try {
      const u = new URL(url, location.href);
      const seg = u.pathname.split('/').pop();
      const m = seg && seg.match(/^[^.?#]+/);
      if (m && m[0] && m[0] !== '') return m[0].slice(0, CONFIG.MAX_NAME_LEN);
    } catch (e) {}
    return 'image_' + Date.now();
  }

  function getMeta(name) {
    const m = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    return m ? m.getAttribute('content') : '';
  }

  function resolveName(name, url) {
    let base = sanitize(name);
    if (!base || isMeaninglessName(base)) {
      const pageName = sanitize(getMeta('og:title') || getMeta('twitter:title') || document.title);
      if (pageName && !isMeaninglessName(pageName)) base = pageName;
    }
    if (!base) base = fallbackName(url);
    return base;
  }

  /* ----------------------- 下载（blob + <a download>，文件名 100% 精确）------ */

  function sniffExt(buf) {
    const b = new Uint8Array(buf);
    if (b.length < 4) return '';
    if (b[0] === 0x3C) return 'HTML';
    if (b[0] === 0xFF && b[1] === 0xD8) return '.jpg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return '.png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
    if (b[0] === 0x42 && b[1] === 0x4D) return '.bmp';
    if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 &&
        String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return '.webp';
    return '';
  }

  // blob URL + <a download> 落盘（文件名由脚本 100% 控制）
  function save(blob, fileName) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 15000);
  }

  const _dlUsed = {};
  const STALL_TIMEOUT = 8000;    // 传输 stall：收到过数据后 8s 无新字节才判传输中断（真卡死）
  const OVERALL_TIMEOUT = 15000; // 整体兜底：15s 无任何进展（连接被拦/无响应/无进度事件环境）才判死，慢图靠此撑到 onload
  const HARD_TIMEOUT = 60000;    // GM_xhr 自带硬超时

  function fmtSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB';
  }

  // 校验 + 命名 + 落盘。返回 Promise<null=成功, string=失败原因>
  function finishBlob(blob, url, baseName, extFallback, onOk) {
    if (!blob || blob.size < 400) return Promise.resolve('响应过小(' + (blob ? blob.size : 0) + 'B)');
    return blob.slice(0, 16).arrayBuffer().then((buf) => {
      const sniffed = sniffExt(buf);
      if (sniffed === 'HTML') return '返回的是网页(反爬/重定向)';
      if (onOk() === false) return null; // 别的候选已完成，静默丢弃
      let ext = sniffed || mimeToExt(blob.type) || '';
      if (ext && !ext.startsWith('.')) ext = '.' + ext;
      if (!ext) ext = getExt(url) || '';
      if (!ext) ext = extFallback || '.jpg';
      const fn = baseName + ext;
      save(blob, fn);
      toast('已下载：' + fn + '（' + fmtSize(blob.size) + '）');
      return null;
    }).catch(() => '数据校验异常');
  }

  // GM_xmlhttpRequest 抓数据（arraybuffer，页面侧重组 blob——MV3 下直接返 blob 可能是空壳）
  // onWin：本候选成功落盘后回调，用于 abort 其它竞速候选；onabort 自清 stall 定时器
  function blobViaXhr(url, baseName, extFallback, onOk, onNext, onProgress, onWin) {
    const startTime = Date.now();
    let lastData = startTime;
    let gotHeaders = false;   // 是否已收到响应头（readyState>=2），一定随连接进展触发
    let gotProgress = false;  // onprogress 是否触发过（部分 MV3 环境不触发）
    let wd = null, req = null;
    const stop = () => { if (wd) { clearInterval(wd); wd = null; } };
    const fail = (reason) => { stop(); onNext(reason); };
    const hdrs = { Accept: '*/*' };
    const _rf = refererFor(url);
    if (_rf) hdrs.Referer = _rf;
    try {
      req = GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer',
        headers: hdrs,
        timeout: HARD_TIMEOUT,
        onabort: () => { stop(); },
        onloadstart: () => { lastData = Date.now(); },
        onreadystatechange: (resp) => {
          if (resp && resp.readyState >= 2) { gotHeaders = true; lastData = Date.now(); }
        },
        onprogress: (e) => {
          gotProgress = true;
          lastData = Date.now();
          if (onProgress && e && e.loaded) onProgress(e.loaded);
        },
        onload: (res) => {
          stop();
          if (res.status && res.status >= 400) { fail('HTTP ' + res.status); return; }
          const buf = res.response;
          if (!buf || !buf.byteLength) { fail('空响应'); return; }
          const ctM = (res.responseHeaders || '').match(/content-type:\s*([^\r\n;]+)/i);
          const blob = new Blob([buf], { type: ctM ? ctM[1].trim() : '' });
          finishBlob(blob, url, baseName, extFallback, onOk)
            .then((reason) => { if (reason) fail(reason); else if (onWin) onWin(); });
        },
        onerror: () => fail('XHR 网络错误/被拦截(检查脚本域名授权)'),
        ontimeout: () => fail('XHR 硬超时'),
      });
    } catch (e) { fail('请求被拦截(检查脚本域名授权)'); return req; }
    wd = setInterval(() => {
      const now = Date.now();
      if (gotHeaders && gotProgress && now - lastData > STALL_TIMEOUT) {
        stop();
        try { req && req.abort && req.abort(); } catch (e) {}
        onNext('传输中断(' + Math.round(STALL_TIMEOUT / 1000) + 's无数据)');
      } else if (now - startTime > OVERALL_TIMEOUT) {
        stop();
        try { req && req.abort && req.abort(); } catch (e) {}
        onNext(gotHeaders ? ('下载超时(' + Math.round(OVERALL_TIMEOUT / 1000) + 's未完成)')
                          : ('连接超时(' + Math.round(OVERALL_TIMEOUT / 1000) + 's无响应/被拦截)'));
      }
    }, 1000);
    return req;
  }

  // 页面原生 fetch 通道（直接走浏览器：命中已加载图片的缓存/CDN，不受 GM_xhr 跨域代理挂起影响；
  // 跨域无 CORS 时快速失败，交由 GM_xhr 兜底）。返回 { abort }
  function blobViaFetch(url, baseName, extFallback, onOk, onNext, onProgress, onWin) {
    const ctrl = new AbortController();
    const startTime = Date.now();
    let lastData = startTime, gotHeaders = false, gotProgress = false;
    let wd = null;
    const stop = () => { if (wd) { clearInterval(wd); wd = null; } };
    const fail = (reason) => { stop(); onNext(reason); };
    wd = setInterval(() => {
      const now = Date.now();
      if (gotHeaders && gotProgress && now - lastData > STALL_TIMEOUT) {
        try { ctrl.abort(); } catch (e) {}
        stop(); onNext('传输中断(' + Math.round(STALL_TIMEOUT / 1000) + 's无数据)');
      } else if (now - startTime > OVERALL_TIMEOUT) {
        try { ctrl.abort(); } catch (e) {}
        stop();
        onNext(gotHeaders ? ('下载超时(' + Math.round(OVERALL_TIMEOUT / 1000) + 's未完成)') : 'fetch跨域被拦截(无CORS)');
      }
    }, 1000);
    fetch(url, { signal: ctrl.signal, mode: 'cors', cache: 'force-cache', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then((res) => {
        if (!res.ok) { fail('HTTP ' + res.status); return; }
        gotHeaders = true; lastData = Date.now();
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (!reader) {
          return res.arrayBuffer().then((buf) => ({ buf: buf, chunks: null, received: buf ? buf.byteLength : 0 }));
        }
        const chunks = []; let received = 0;
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) return { buf: null, chunks, received };
          gotProgress = true; received += value.byteLength; lastData = Date.now();
          if (onProgress) onProgress(received);
          chunks.push(value); return pump();
        });
        return pump();
      })
      .then((data) => {
        if (!data) return;
        stop();
        let buf = data.buf;
        if (!buf && data.chunks) {
          buf = new Uint8Array(data.received);
          let pos = 0; for (const c of data.chunks) { buf.set(c, pos); pos += c.byteLength; }
          buf = buf.buffer;
        }
        if (!buf || !buf.byteLength) { fail('空响应'); return; }
        const blob = new Blob([buf], { type: '' }); // 类型由 finishBlob 按魔数嗅探
        finishBlob(blob, url, baseName, extFallback, onOk)
          .then((reason) => { if (reason) fail(reason); else if (onWin) onWin(); });
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        fail('fetch跨域被拦截(无CORS)');
      });
    return { abort: () => { try { ctrl.abort(); } catch (e) {} } };
  }

  // 统一入口：并发竞速下载（所有候选同时发起，第一个成功落盘即 abort 其余），典型 <1s
  function raceDownload(urls, name, extHint) {
    const queue = dedupe(urls).filter((u) => /^https?:/i.test(u));
    if (!queue.length) { toast('未找到可下载的图片地址'); return null; }
    const ext = getExt(queue[0]) || extHint || '.jpg';
    let base = resolveName(name, queue[0]);
    if (_dlUsed[base + ext]) { let n = 1; while (_dlUsed[base + '_' + n + ext]) n++; base = base + '_' + n; }
    _dlUsed[base + ext] = true;

    let done = false;
    const runners = [];
    const reasons = [];
    let lastProg = 0;
    const onOk = () => { if (done) return false; done = true; return true; };
    const progress = (loaded, idx) => {
      const now = Date.now();
      if (now - lastProg < 400) return;
      lastProg = now;
      toast('下载中… ' + fmtSize(loaded) + (queue.length > 1 ? '（竞速 ' + queue.length + ' 路）' : ''));
    };
    const checkAllFail = () => {
      if (done) return;
      if (runners.length && runners.every((r) => r && r.finished)) {
        const joined = reasons.slice(0, 2).join('；') || '所有候选地址均不可用';
        const authHint = /被拦截|无响应|跨域/.test(joined)
          ? '（持续出现请检查篡改猴该脚本的域名权限是否已允许 huaban.com 等，或在当前站点限制了跨域下载）' : '';
        console.log('[快速下载原图] 下载失败详情：', reasons);
        toast('下载失败：' + joined + authHint);
      }
    };
    const onWin = (winnerIdx) => {
      runners.forEach((r, i) => {
        if (i === winnerIdx || !r) return;
        r.finished = true;
        r.reqs.forEach((x) => { if (x.req && x.req.abort) { try { x.req.abort(); } catch (e) {} } });
      });
    };
    function launch(u, idx) {
      const r = { finished: false, reqs: [] };
      runners[idx] = r;
      // GM_xhr 主判定：失败才记为该候选失败（并 abort 掉 fetch 路）
      r.reqs.push({
        _isFetch: false,
        req: blobViaXhr(u, base, extHint, onOk,
          (reason) => {
            if (r.finished) return;
            r.finished = true;
            reasons.push('地址' + idx + ':' + reason);
            r.reqs.forEach((x) => { if (x._isFetch && x.req && x.req.abort) { try { x.req.abort(); } catch (e) {} } });
            checkAllFail();
          },
          (loaded) => progress(loaded, idx),
          () => onWin(idx)),
      });
      // 页面 fetch 加速通道：命中缓存/开 CORS 秒下；失败静默，不计入失败原因
      r.reqs.push({
        _isFetch: true,
        req: blobViaFetch(u, base, extHint, onOk,
          () => {},
          (loaded) => progress(loaded, idx),
          () => onWin(idx)),
      });
    }
    queue.forEach((u, i) => launch(u, i));
    return {
      // 竞速中途追加候选（如花瓣接口返回的签名原图），并动态优化命名
      add(extraUrls, newBase, newExt) {
        if (done) return;
        if (newBase) {
          const nb = resolveName(newBase, queue[0]);
          if (nb && !isMeaninglessName(nb)) base = nb;
        }
        const more = dedupe(extraUrls || []).filter((u) => /^https?:/i.test(u) && queue.indexOf(u) === -1);
        more.forEach((u) => { queue.push(u); launch(u, queue.length - 1); });
      },
    };
  }

  /* ----------------------- 主流程 ----------------------- */

  function handleHuaban(hit, elUrl) {
    const cdnOrig = huabanCdnOriginal(elUrl);
    const domName = getImageName(hit.el);
    toast('正在下载原图…');
    // 0 延迟并发竞速：裸 key CDN 原图 + 页面原始 src 同时开拉
    const racer = raceDownload(dedupe([cdnOrig, elUrl]), domName, '');
    // 异步取官方接口：签名原图 + raw_text 命名，回来即追加进竞速并优化文件名
    const pinId = huabanPinIdFromContext(hit.el);
    if (pinId && racer) {
      getHuabanPin(pinId, (pin) => {
        if (pin && pin.urls.length) {
          racer.add(pin.urls, pin.rawText || domName || pin.board, pin.ext || '');
        }
      });
    }
  }

  function handleGeneric(hit, elUrl) {
    const cands = dedupe([elUrl].concat(transformThumbUrl(elUrl)));
    const name = getImageName(hit.el);
    toast('正在下载原图…');
    raceDownload(cands, name, '');
    const wrapA = hit.el.closest ? hit.el.closest('a[href]') : null;
    const aHref = wrapA && wrapA.getAttribute('href');
    if (aHref && !isImageUrl(aHref)) {
      fetchDetailCandidates(toAbs(aHref), (dc) => {
        if (dc && dc.urls.length) {
          console.log('[快速下载原图] 详情页候选：', dc.urls.map((x) => x.url));
        }
      });
    }
  }

  /* ----------------------- Alt + 左键监听 ----------------------- */

  // Alt + 左键图片 = 下载原图；普通右键 = 浏览器原生菜单
  // 捕获阶段 + stopPropagation 拦在站点自己的点击处理之前，避免误跳转
  document.addEventListener('click', (e) => {
    if (!e.altKey) return;
    const hit = getImageFromTarget(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const elUrl = hit.bgUrl ? toAbs(hit.bgUrl) : getOriginalUrl(hit.el);
    if (isHuabanPage() || isHuabanCdn(elUrl)) handleHuaban(hit, elUrl);
    else handleGeneric(hit, elUrl);
  }, true);

  /* ----------------------- 轻提示 ----------------------- */

  let toastTimer = null;
  function toast(msg) {
    if (!CONFIG.SHOW_TOAST) return;
    let box = document.getElementById('rcid-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rcid-toast';
      box.style.cssText =
        'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);' +
        'z-index:2147483647;background:rgba(20,20,22,.92);color:#fff;' +
        'padding:10px 16px;border-radius:8px;font-size:14px;line-height:1.4;' +
        'max-width:80vw;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
        'pointer-events:none;transition:opacity .3s;';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (box) box.style.opacity = '0'; }, 2600);
  }
})();
