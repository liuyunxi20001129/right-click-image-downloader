// ==UserScript==
// @name         右键原图静默下载（按网页命名）
// @name:en      Silent Original Image Download on Right-Click (named by page)
// @namespace    https://github.com/workbuddy
// @id          right-click-image-downloader@workbuddy
// @version      1.3
// @description  鼠标右键点击网页图片，自动静默下载原图（最高清版本），并以网页上显示的图片名称作为文件名。按住 Shift 右键可恢复原生菜单。
// @description:en  Right-click any web image to silently download the original (highest-resolution) file, named after the filename shown on the page. Hold Shift to restore the native context menu.
// @author       WorkBuddy
// @license      MIT
// @homepageURL  https://github.com/liuyunxi20001129/right-click-image-downloader
// @supportURL   https://github.com/liuyunxi20001129/right-click-image-downloader/issues
// @icon data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAClklEQVR4nO3c3VHDMBQFYcPQBwWY7qiD7nABtxIY3vixYymSjXV3v3cShrNSYMhkmiRJEtHD0U8wz/PH0c+R3bIsh+3U/YEdfKwguj2Qw48ZQvMDOPzYITy2PLHjX0PLDneV4/B5boPqG8Dxr612n6oAHH8MNTsVB+D4YyndqygAxx9TyW5NfwVofLsBePrHtrffzQAcP4dbO/oSALcZgKc/l609vQHgVgPw9Oe0tqs3AJwBwBkA3J8AfP3P7fe+3gBwBgBnAHAGAGcAcAYAZwBwBgBnAHAGAGcAcAYAZwBwBgBnAHAGAGcAcAYA9zQl8vz6ftpzxdvLlIE3AJwBwBkAnAHAGQCcAcAZAJwBwBkAnAHAGQCcAcAZAJwBwBkAnAHAGQCcAcAZAJwBwBkAnAHAGQCcAcAZAJwBwBkAnAHAGQCcAcAZAJwBwBkAnAHAGQCcAcAZANzQnxJ25qeC7T33qJ8aNvQNcJUfelzk+8AFcIUffgw8fooA/nOEGHz8NAHofmkCOPs0RoLTnyqAM0eJJOOnC+CMcSLR+CkDOHKkSDZ+2gCOGCsSjp86gJ6jRdLx0wegfekDaD29kfj0IwJoGTGSj48J4J4xAzA+KoCaUQMyPi6AknEDND4yAP2EDGDrlAfs9GMDWBs7gOOjA/g+ekDHn+gB0Mf/gg+AzgDg/gSwLMvD/3wrOsPvfb0B4AwAzgDgVgPw94Cc1nb1BoDbDMBbIJetPb0B4G4G4C2Qw60dd28AIxjb3n6+BMAVBeAtMKaS3YpvACMYS+leVS8BRjCGmp2qfwcwgmur3afpX7/zPH+0fL36ufdgNv0V4G1wDS07dHvzh7fB+XocwO7v/jGE4/W8eQ9/+5dBtPOlVpI09fcJ7uG0YhTAQuEAAAAASUVORK5CYII=
// @match        *://*/*
// @match        file:///*
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ 配置区 ============================ */
  const CONFIG = {
    // 是否屏蔽原生右键菜单（true=右键图片直接下载，不弹菜单；false=下载的同时仍弹菜单）
    SUPPRESS_NATIVE_MENU: GM_getValue('suppressMenu', true),
    // 按住此修饰键右键可恢复原生菜单（不触发下载）
    NORMAL_MENU_KEY: 'shift',
    // 文件名最大长度
    MAX_NAME_LEN: 80,
    // 是否优先使用 srcset 中最大的那张图
    SRCSET_USE_LARGEST: true,
    // 是否显示下载结果的轻提示
    SHOW_TOAST: true,
  };
  /* =============================================================== */

  // 注册可在篡改猴菜单里切换的选项
  GM_registerMenuCommand('切换：右键是否屏蔽原生菜单', () => {
    const v = !GM_getValue('suppressMenu', true);
    GM_setValue('suppressMenu', v);
    CONFIG.SUPPRESS_NATIVE_MENU = v;
    toast('已' + (v ? '开启' : '关闭') + '「右键屏蔽原生菜单」（下次右键生效）');
  });
  GM_registerMenuCommand('使用说明', () => {
    alert(
      '右键图片 = 静默下载原图（按网页名称命名）\n' +
      '按住 Shift 右键图片 = 恢复浏览器原生菜单\n' +
      '按住 Alt 右键图片 = 调试模式：列出抓到的候选名称与原图地址，不下载\n\n' +
      '文件名优先级：\n' +
      '1. 包裹图片的 <a> 的 title/aria-label（花瓣等站点的描述常在这里）\n' +
      '2. alt / title / aria-label / data-* 名称属性\n' +
      '3. <figure> 的 <figcaption> / .description / .pin-desc\n' +
      '4. 附近带 caption/title/desc/说明/图注 等类名的元素\n' +
      '5. 相邻短文本（如图注、名称行）\n' +
      '6. 兜底：使用图片 URL 中的文件名\n\n' +
      '花瓣网：自动去掉 _fwXXX/格式后缀下载原图；文件名优先用「上传者发布的内容」(接口 raw_text)，\n' +
      '        没有发布内容时再用网页其它文字 / 画板名。'
    );
  });

  /* ----------------------- 工具函数 ----------------------- */

  function isImageUrl(u) {
    return /\.(jpe?g|png|gif|webp|bmp|svg|avif|tiff?|ico)(\?|#|$)/i.test(u);
  }

  function toAbs(url) {
    try {
      return new URL(url, location.href).href;
    } catch (e) {
      return url;
    }
  }

  function cleanText(s) {
    if (!s) return '';
    return s
      .replace(/\s+/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
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
      let m = path.match(/\.([a-z0-9]{2,5})$/i);
      if (m) return '.' + m[1].toLowerCase();
      const q = u.search.match(/[?&][^=?]*\.([a-z0-9]{2,5})(?:$|&)/i);
      if (q) return '.' + q[1].toLowerCase();
    } catch (e) {}
    return '';
  }

  function sanitize(name) {
    let s = (name || '').trim().replace(/\s+/g, ' ');
    // 去掉文件名非法字符
    s = s.replace(/[\\/:*?"<>|\r\n\t]/g, '');
    // 去掉可能导致越级的路径点
    s = s.replace(/\.{2,}/g, '.');
    // 去掉可能混进来的扩展名，稍后统一补
    s = s.replace(/\.[a-z0-9]{2,5}$/i, '');
    s = s.slice(0, CONFIG.MAX_NAME_LEN).trim();
    return s;
  }

  // 判断文件名是否为无语义随机串（UUID / 长 hex / 纯时间戳等）
  function isMeaninglessName(s) {
    if (!s) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true; // UUID
    if (/^[0-9a-f]{16,}$/i.test(s)) return true; // 长 hex
    if (/^\d{10,}$/.test(s)) return true; // 时间戳
    if (/^[a-z0-9]{20,}$/i.test(s)) return true; // 随机字母数字串
    return false;
  }

  /* ----------------------- 取原图地址 ----------------------- */

  function largestFromSrcset(set) {
    const parts = set.split(',').map((p) => p.trim()).filter(Boolean);
    let best = '', bestN = -1;
    for (const p of parts) {
      const m = p.match(/^(\S+)\s+(?:(\d+)w|(\d+(?:\.\d+)?)x)$/);
      if (!m) continue;
      const u = m[1];
      const n = m[2]
        ? parseInt(m[2], 10)
        : parseFloat(m[3]) * (window.devicePixelRatio || 1) * 1000;
      if (n > bestN) {
        bestN = n;
        best = u;
      }
    }
    return best;
  }

  function getOriginalUrl(el) {
    let url = '';
    // 1. 常见的“真实大图”懒加载属性
    const dataKeys = [
      'original', 'src', 'real-src', 'realSrc', 'real',
      'large', 'big', 'zoom', 'full', 'hires', 'high', 'hd',
      'lazy-src', 'data-src', 'ori', 'origin',
    ];
    for (const k of dataKeys) {
      const v = el.getAttribute && el.getAttribute('data-' + k);
      if (v && /^(https?:|\/\/|data:image\/)/.test(v)) {
        url = v;
        break;
      }
    }
    // 2. srcset 中最大的一张
    if (CONFIG.SRCSET_USE_LARGEST && el.srcset) {
      const s = largestFromSrcset(el.srcset);
      if (s) url = s;
    }
    // 3. 回退到当前图
    if (!url) url = el.currentSrc || el.src || '';
    // 4. 被 <a> 包裹且链接指向图片（通常是大图），优先用链接
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
    return null;
  }

  function getMeta(name) {
    const m = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    return m ? m.getAttribute('content') : '';
  }

  // 花瓣网：去掉 _fwXXX / @XXX 尺寸后缀及 /format/webp，得到原图地址
  function huabanOriginal(url) {
    if (!/hbimg\.huabanimg\.com/i.test(url)) return url;
    return url.replace(/^(https?:\/\/hbimg\.huabanimg\.com\/[^_?#\s]+).*$/i, '$1');
  }

  // 花瓣网：通过官方接口取「上传者发布的内容」(pin.raw_text) 与画板名
  function isHuaban() {
    return /huaban\.com/i.test(location.hostname);
  }
  // 从详情页 URL 或图片所在链接拿到 pin_id
  function huabanPinIdFromContext(target) {
    const m = location.pathname.match(/\/pins?\/(\d+)/i);
    if (m) return m[1];
    try {
      const a = target && target.closest && target.closest('a[href]');
      if (a) {
        const mm = (a.getAttribute('href') || '').match(/\/pins?\/(\d+)/i);
        if (mm) return mm[1];
      }
    } catch (e) {}
    return null;
  }
  // 调接口获取发布内容；回调 { rawText, board }
  function getHuabanRawText(pinId, cb) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://huaban.com/v3/pins/' + pinId,
      headers: {
        'User-Agent': navigator.userAgent,
        'Referer': location.href,
        'Accept': 'application/json',
      },
      timeout: 8000,
      onload: (res) => {
        try {
          const j = JSON.parse(res.responseText);
          const pin = j && j.pin;
          const raw = (pin && (pin.raw_text || '')) || '';
          const board = (pin && pin.board && pin.board.title) || '';
          cb({ rawText: raw, board: board });
        } catch (e) {
          cb({ rawText: '', board: '' });
        }
      },
      onerror: () => cb({ rawText: '', board: '' }),
      ontimeout: () => cb({ rawText: '', board: '' }),
    });
  }

  /* ----------------------- 取网页显示的名称 ----------------------- */

  function collectNameCandidates(el) {
    const cands = [];
    const push = (s, score) => {
      s = cleanText(s);
      if (s && !isJunk(s)) cands.push({ s, score });
    };

    // 1. 图片自身属性
    push(el.alt, 50);
    push(el.title, 45);
    push(el.getAttribute && el.getAttribute('aria-label'), 40);
    ['name', 'caption', 'title', 'alt', 'desc', 'label', 'figcaption'].forEach((k) => {
      const v = el.getAttribute && el.getAttribute('data-' + k);
      if (v) push(v, 42);
    });

    // 1.5 页面级 meta 标题/描述（花瓣等站点的 pin 标题常放在 og:title）
    push(getMeta('og:title'), 80);
    push(getMeta('twitter:title'), 78);
    push(getMeta('og:description'), 70);
    push(getMeta('description'), 60);
    push(document.title, 25);

    // 1.6 花瓣网：画板名仅作低优先级兜底（发布内容优先，由右键处经接口获取）
    const bLink = document.querySelector('a[href*="/boards/"]');
    if (bLink && bLink.textContent.trim()) push(bLink.textContent, 35);

    // 2. <figure><figcaption>
    let node = el;
    while (node && node.parentElement && node.tagName !== 'FIGURE') node = node.parentElement;
    if (node && node.tagName === 'FIGURE') {
      const fc = node.querySelector('figcaption');
      if (fc) push(fc.textContent, 60);
    }

    // 3. 包裹图片的链接（花瓣等站点常把描述放在 <a> 的 title/aria-label 或子文本里）
    try {
      const a = el.closest && el.closest('a[href]');
      if (a) {
        push(a.getAttribute('title'), 72);
        push(a.getAttribute('aria-label'), 66);
        const aText = Array.from(a.childNodes)
          .filter((n) => n.nodeType === 3 && n.textContent.trim())
          .map((n) => n.textContent)
          .join(' ');
        if (aText.length <= 60) push(aText, 35);
        a.querySelectorAll('.description, .pin-desc, .pin-title, [class*="desc" i], [class*="title" i]')
          .forEach((c) => push(c.textContent, 58));
      }
    } catch (e) {}

    // 4. 附近带 caption/title/desc/name/说明/图注 等类名的元素
    const captionSel =
      'figcaption, .description, .pin-desc, .pin-title, [class*="caption" i], [class*="title" i], ' +
      '[class*="desc" i], [class*="name" i], [class*="info" i], [id*="caption" i], ' +
      '[class*="图注" i], [class*="说明" i], [class*="图名" i]';
    const container = el.closest
      ? el.closest('figure, li, .item, [class*="item" i], [class*="card" i], a[href], div, td')
      : null;
    if (container) {
      container.querySelectorAll(captionSel).forEach((c) => push(c.textContent, 55));
    }

    // 5. 相邻短文本（图注/名称行），仅取较短的，避免抓到整段正文
    if (el.parentElement) {
      Array.from(el.parentElement.children).forEach((ch) => {
        if (ch !== el && ch.textContent && ch.textContent.trim().length <= 60) {
          push(ch.textContent, 30);
        }
      });
      const parentText = Array.from(el.parentElement.childNodes)
        .filter((n) => n.nodeType === 3 && n.textContent.trim())
        .map((n) => n.textContent)
        .join(' ');
      if (parentText.length <= 60) push(parentText, 22);
    }

    return cands;
  }

  function getImageName(el) {
    const cands = collectNameCandidates(el);
    if (cands.length === 0) return '';
    // 去重
    const seen = new Set();
    const uniq = cands.filter((c) => {
      const k = c.s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // 评分高者优先；同分时取更短、更像“名称”的
    uniq.sort((a, b) => b.score - a.score || a.s.length - b.s.length);
    return uniq[0].s;
  }

  /* ----------------------- 下载 ----------------------- */

  function fallbackName(url) {
    try {
      const u = new URL(url, location.href);
      const seg = u.pathname.split('/').pop();
      const m = seg && seg.match(/^[^.?#]+/);
      if (m && m[0] && m[0] !== '') return m[0].slice(0, CONFIG.MAX_NAME_LEN);
    } catch (e) {}
    return 'image_' + Date.now();
  }

  function download(url, name) {
    if (!url) {
      toast('未找到可下载的图片地址');
      return;
    }
    let ext = getExt(url);
    if (!ext) ext = '.jpg'; // 兜底
    let base = sanitize(name);
    // 网页没抓到有意义的名字、且回退到图床 URL 的 UUID/随机串时，
    // 改用网页标题等语义化信息命名，避免文件名变成无意义乱码
    if (!base || isMeaninglessName(base)) {
      const pageName = sanitize(
        getMeta('og:title') || getMeta('twitter:title') || document.title
      );
      if (pageName && !isMeaninglessName(pageName)) base = pageName;
    }
    if (!base) base = fallbackName(url);
    const finalName = base + ext;

    GM_download({
      url: url,
      name: finalName,
      saveAs: false,
      headers: { Referer: location.href },
      onload: () => toast('已下载：' + finalName),
      onerror: (err) => {
        const msg = (err && (err.error || err.message)) || '未知错误';
        toast('下载失败：' + msg);
      },
    });
  }

  /* ----------------------- 右键监听 ----------------------- */

  document.addEventListener(
    'contextmenu',
    (e) => {
      const keyMap = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey };
      // Shift 右键：放行原生菜单
      if (CONFIG.NORMAL_MENU_KEY && keyMap[CONFIG.NORMAL_MENU_KEY]) return;

      const hit = getImageFromTarget(e.target);
      if (!hit) return;
      if (CONFIG.SUPPRESS_NATIVE_MENU) e.preventDefault();

      const rawUrl = hit.bgUrl ? toAbs(hit.bgUrl) : getOriginalUrl(hit.el);
      const url = huabanOriginal(rawUrl);

      // 花瓣网：优先用“上传者发布的内容”(pin.raw_text) 命名
      const pinId = isHuaban() ? huabanPinIdFromContext(e.target) : null;

      // 调试模式：列出候选名称 + （花瓣）接口返回的发布内容
      if (e.altKey) {
        const cands = collectNameCandidates(hit.el);
        const list = cands.length
          ? cands
              .slice()
              .sort((a, b) => b.score - a.score || a.s.length - b.s.length)
              .map((c) => '[' + c.score + '] ' + c.s)
              .join('\n')
          : '（未找到任何候选名称）';
        let msg =
          '【调试】候选名称（DOM）：\n' + list +
          '\n\n原图地址：\n' + url +
          '\n\n最终将命名为：' + (getImageName(hit.el) || '(兜底：' + fallbackName(url) + ')');
        if (pinId) {
          getHuabanRawText(pinId, (info) => {
            msg += '\n\n【花瓣接口】发布内容(raw_text)：' + (info.rawText || '（空）') +
                   '\n画板名：' + (info.board || '（空）');
            alert(msg);
          });
          return;
        }
        alert(msg);
        return;
      }

      // 花瓣网：用接口返回的发布内容命名；无发布内容再回退到 DOM 候选 / 画板名
      if (pinId) {
        getHuabanRawText(pinId, (info) => {
          let name = '';
          if (info.rawText) {
            name = cleanText(info.rawText); // 发布内容优先
          } else {
            name = getImageName(hit.el);    // 无发布内容：退回 alt/title 等
            if (!name && info.board) name = info.board; // 仍无：用画板名兜底
          }
          download(url, name || fallbackName(url));
        });
        return;
      }

      const name = getImageName(hit.el) || fallbackName(url);
      download(url, name);
    },
    true
  );

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
    toastTimer = setTimeout(() => {
      if (box) box.style.opacity = '0';
    }, 2200);
  }
})();
