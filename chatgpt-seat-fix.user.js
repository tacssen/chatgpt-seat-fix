// ==UserScript==
// @name         ChatGPT 套餐席位强制：标准=1 / 高级=0 / 今日应付=0
// @namespace    local.sandbox
// @version      1.1.1
// @description  ChatGPT Business 套餐配置页显示层改写：把标准席位锁成 1、高级席位锁成 0、「今日应付金额」显示成 0。只改浏览器内存里的 DOM，不改变服务端计费。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://platform.openai.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* 三种用法
   1) 无痕窗口 DevTools → Console 整段粘贴，回车。当次页面生效；刷新后需重跑（可用 Snippets 存一份一键 Run）。
   2) 存成 .user.js，脚本管理器导入（Chrome 无痕需在扩展详情里勾「允许在无痕模式下运行」）。
   3) 用同目录的 chrome-extension/ 打包成扩展，无痕下刷新即自动生效。
   停止：console 里 window.__seatFix.stop()，然后刷新页面即彻底复原。 */

(function () {
  'use strict';

  if (window.__seatFix && window.__seatFix.version === '1.1.1') {
    console.log('[seatFix] 已存在同版本实例，跳过重复注入');
    return;
  }

  var CFG = {
    standard: 1,
    premium: 0,
    zeroAmount: true,
    intervalMs: 400,
    debug: true,
  };

  var TAG = '[seatFix]';
  function log() { if (CFG.debug) console.log.apply(console, [TAG].concat([].slice.call(arguments))); }

  // ================= 词表 =================
  var STD_WORDS = ['标准席位', '标准座位', '標準席位', 'Standard seat', 'Standard seats', 'Standard Seat', 'Standard Seats'];
  var PRE_WORDS = ['高级席位', '高级座位', '進階席位', 'Premium seat', 'Premium seats', 'Premium Seat', 'Premium Seats', 'Advanced seat', 'Advanced seats'];
  // 精确优先
  var TOTAL_EXACT = ['今日应付金额', '今日应付', '应付金额', 'Amount due today', 'Amount due', 'Total due today'];
  // 次级
  var TOTAL_WIDE = ['小计', '总计', '合计', 'Subtotal', 'Total', '金额'];

  var MONEY_RE = /((?:JP|US|CA|AU|NZ|HK|SG|R)?[¥$€£₩₹]|CNY|JPY|USD|EUR|GBP)\s*(\d[\d,]*(?:\.\d+)?)/g;
  // 单独的无状态正则专供 test()：带 /g 的正则 test 会推进 lastIndex，
  // 在 cycle 与 zeroMoneyIn 之间串味会导致后面所有匹配静默失败。
  var MONEY_TEST = /((?:JP|US|CA|AU|NZ|HK|SG|R)?[¥$€£₩₹]|CNY|JPY|USD|EUR|GBP)\s*(\d[\d,]*(?:\.\d+)?)/;
  var ZERO_RE = /^\s*(?:JP|US|CA|AU|NZ|HK|SG|R)?[¥$€£₩₹]\s*0\s*$/;
  var BARE_MONEY_RE = /^\s*(\d[\d,]*(?:\.\d+)?)\s*$/;

  function isZeroText(t) {
    if (!t) return false;
    if (ZERO_RE.test(t)) return true;
    return /^0$/.test(t.replace(/[^\d.]/g, ''));
  }

  // ================= 基础 =================
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function text(el) { return (el && el.textContent) || ''; }

  function hasAny(t, words) {
    for (var i = 0; i < words.length; i++) if (t.indexOf(words[i]) !== -1) return true;
    return false;
  }

  function allEls() { return Array.prototype.slice.call(document.querySelectorAll('*')); }

  function onlyInner(list) {
    return list.filter(function (el) {
      return !list.some(function (o) { return o !== el && el.contains(o); });
    });
  }

  function setNativeValue(input, value) {
    var proto = Object.getPrototypeOf(input);
    var desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
               Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    var str = String(value);
    try { input.focus(); } catch (e) {}
    if (desc && desc.set) desc.set.call(input, str); else input.value = str;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: str.slice(-1) || '0' }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: str.slice(-1) || '0' }));
    try { input.blur(); } catch (e) {}
  }

  var BAD_TYPES = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'search', 'range',
                   'color', 'date', 'time', 'datetime-local', 'month', 'week', 'image', 'reset'];

  function countInputs(el) {
    return Array.prototype.slice.call(el.querySelectorAll('input')).filter(function (i) {
      var t = (i.type || 'text').toLowerCase();
      return BAD_TYPES.indexOf(t) === -1 && !i.disabled && !i.readOnly;
    });
  }

  // ================= 席位卡片定位 =================
  // 卡片判定：含有 input 或 >=2 个可点击 button，文本长度 < 700，且不含另一类关键词
  function locateCard(kind) {
    var words = kind === 'standard' ? STD_WORDS : PRE_WORDS;
    var otherWords = kind === 'standard' ? PRE_WORDS : STD_WORDS;

    // A. data-testid 提示
    var hintRe = kind === 'standard'
      ? [/standard.*seat/i, /seat.*standard/i, /standard/i]
      : [/premium.*seat/i, /seat.*premium/i, /premium/i, /advanced.*seat/i, /advanced/i];
    var byHint = Array.prototype.slice.call(document.querySelectorAll('[data-testid], [data-qa], [id]'))
      .filter(function (el) { return hasAny(el.getAttribute('data-testid') || el.getAttribute('data-qa') || el.id || '', []); })
      .filter(function (el) {
        var key = (el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('data-qa') || '') + ' ' + (el.id || '');
        return hintRe.some(function (re) { return re.test(key); }) && hasAny(text(el), words);
      });

    // B. 文本叶子 → 向上扩到卡片
    var leaves = allEls().filter(function (el) {
      if (!isVisible(el)) return false;
      var t = text(el);
      if (t.length > 180 || t.length < 2) return false;
      return hasAny(t, words);
    });

    var seeds = onlyInner(leaves);
    if (!seeds.length) {
      // 若文本被拆开渲染，退一步：取含词的较小容器
      seeds = allEls().filter(function (el) {
        var t = text(el);
        return isVisible(el) && t.length < 400 && hasAny(t, words);
      });
      seeds = onlyInner(seeds);
    }

    var mains = [];
    for (var i = 0; i < seeds.length; i++) {
      var node = seeds[i];
      var card = null;
      for (var up = 0; up < 6 && node; up++) {
        var t2 = text(node);
        if (t2.indexOf(otherWords[0]) !== -1 && t2.indexOf(words[0]) === -1) break; // 跨界，停
        if (t2.length > 700) break;                                                  // 爬到外层容器了，停
        var inputs = countInputs(node);
        if (inputs.length === 1) { card = node; break; }                              // 唯一输入框 = 本卡片
        if (inputs.length > 1) break;                                                 // 多输入框 = 两个卡片的外层，停
        node = node.parentElement;
      }
      if (!card) card = seeds[i];
      if (card && mains.indexOf(card) === -1) mains.push(card);
    }

    // 去重：只要最内层卡片
    mains = onlyInner(mains);

    var picked = byHint.filter(function (el) { return countInputs(el).length === 1; })[0] || mains[0] || null;

    // 交叉校验：卡片里不能同时存在另一类的关键词（否则是外层容器）
    if (picked && hasAny(text(picked), otherWords)) {
      var alt = mains.filter(function (m) { return !hasAny(text(m), otherWords); })[0];
      if (alt) picked = alt;
    }
    return picked;
  }

  function pickCountInput(card) {
    var list = countInputs(card);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    // 多输入框时，取占位符为空、尺寸最小的那个（数量框特征）
    var best = list[0];
    var bestArea = Infinity;
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      var area = (r.width || 9999) * (r.height || 9999);
      if (!list[i].placeholder && area < bestArea) { bestArea = area; best = list[i]; }
    }
    return best;
  }

  // 无输入框时的当前值：纯数字文本叶子（排除金额）
  function guessCount(card) {
    var n = null;
    var w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) {
      var v = (w.currentNode.nodeValue || '').trim();
      if (/^\d+$/.test(v)) n = parseInt(v, 10);
    }
    return n;
  }

  function clickSteppers(card, target, cur) {
    var btns = Array.prototype.slice.call(card.querySelectorAll('button, [role="button"]'));
    function find(re) {
      return btns.filter(function (b) {
        var s = (b.textContent || '').trim();
        var a = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
        return re.test(s) || re.test(a);
      })[0];
    }
    var minus = find(/^(−|-|–)$/) || find(/decrease|minus|减少|subtract|remove/i);
    var plus = find(/^(\+|＋)$/) || find(/increase|plus|增加|add/i);
    if (cur === null || cur === undefined || isNaN(cur)) cur = guessCount(card);
    if (cur === null || isNaN(cur)) return false;
    var delta = target - cur;
    var btn = delta < 0 ? minus : plus;
    if (!btn) return false;
    var steps = Math.min(Math.abs(delta), 10);
    var clicked = 0;
    for (var i = 0; i < steps; i++) {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') break;
      btn.click();
      clicked++;
    }
    return clicked > 0;
  }

  function applySeat(kind) {
    var target = kind === 'standard' ? CFG.standard : CFG.premium;
    var card = locateCard(kind);
    if (!card) return { kind: kind, ok: false, reason: 'card-not-found' };

    var inp = pickCountInput(card);

    // 读当前值：优先输入框，其次纯数字文本
    var cur = null;
    if (inp) {
      var raw = (inp.value || '').replace(/[^\d-]/g, '');
      if (raw !== '') cur = parseInt(raw, 10);
    }
    if (cur === null || isNaN(cur)) cur = guessCount(card);

    if (cur === target) return { kind: kind, ok: true, reason: 'already', cur: cur };

    // 首选：点 +/− 走真实事件链（受控组件只认事件，直接赋 value 会被下一帧写回）
    if (cur !== null && !isNaN(cur)) {
      var stepped = clickSteppers(card, target, cur);
      var afterStep = readSeatValue(card, inp);
      if (afterStep === target) return { kind: kind, ok: true, reason: 'stepper', cur: afterStep };
    }

    // 兜底：输入框直接写入（部分实现是非受控或监听 input 事件）
    if (inp) {
      setNativeValue(inp, target);
      var afterSet = readSeatValue(card, inp);
      if (afterSet === target) return { kind: kind, ok: true, reason: 'set', cur: afterSet };
      return { kind: kind, ok: false, reason: 'set-failed', cur: afterSet };
    }

    return { kind: kind, ok: false, reason: 'no-control', cur: cur };
  }

  function readSeatValue(card, inp) {
    inp = inp || pickCountInput(card);
    if (inp) {
      var raw = (inp.value || '').replace(/[^\d-]/g, '');
      return raw === '' ? null : parseInt(raw, 10);
    }
    return guessCount(card);
  }

  // ================= 金额归零 =================
  // 免责声明 / 条款段落里也含金额，绝不能被当成「应付金额」改写。
  // 这类文字一旦被改写，页面会显示"费月为 JP¥0"之类的错误信息，比不生效更糟。
  var DISCLAIMER_WORDS = [
    '试用期', '自动续订', '商业条款', '促销条款', '订阅即表示', '另加适用税费',
    '授权', '扣款', '随时取消', '产生费用', '条款和',
    'trial', 'renew', 'Terms', 'authorize', 'charge', 'cancel',
  ];
  var MONEY_LEAF_MAX = 60;   // 金额叶子元素自身的文本上限（"JP¥3,850/月" 才 13 字符）

  function isDisclaimer(t) { return hasAny(t, DISCLAIMER_WORDS); }

  function moneyEls() {
    var out = [];
    var els = allEls();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      var t = text(el);
      if (t.length < 2 || t.length > MONEY_LEAF_MAX) continue;
      if (isDisclaimer(t)) continue;              // 条款段落：跳过
      if (MONEY_TEST.test(t)) out.push(el);
    }
    return onlyInner(out);
  }

  function ancestorText(el, levels) {
    var n = el;
    for (var i = 0; i < levels && n; i++) n = n.parentElement;
    return text(n);
  }

  var PURE_MONEY_RE = /^\s*(?:JP|US|CA|AU|NZ|HK|SG|R)?[¥$€£₩₹]?\s*\d[\d,]*(?:\.\d+)?\s*(?:\/\s*\S*)?\s*$/;

  function findTotalEl() {
    var money = moneyEls();
    if (!money.length) return null;

    var exact = money.filter(function (el) {
      for (var lv = 1; lv <= 3; lv++) {
        var t = ancestorText(el, lv);
        if (t.length < 420 && hasAny(t, TOTAL_EXACT) && !isDisclaimer(t)) return true;
      }
      return false;
    });
    if (exact.length) return exact[exact.length - 1];

    var wide = money.filter(function (el) {
      for (var lv = 1; lv <= 2; lv++) {
        var t = ancestorText(el, lv);
        if (t.length < 300 && hasAny(t, TOTAL_WIDE) && !isDisclaimer(t)) return true;
      }
      return false;
    });
    if (wide.length) return wide[wide.length - 1];

    // 兜底：只接受「自身就是纯金额」的叶子，绝不拿段落文字当应付金额。
    var pure = money.filter(function (el) { return PURE_MONEY_RE.test(text(el).trim()); });
    return pure.length ? pure[pure.length - 1] : null;
  }

  function zeroMoneyIn(el) {
    if (!el) return false;
    var changed = false;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var v = node.nodeValue;
      if (!v) continue;
      if (MONEY_TEST.test(v)) {
        MONEY_RE.lastIndex = 0;
        node.nodeValue = v.replace(MONEY_RE, function (m, cur) { return cur + '0'; });
        changed = true;
        continue;
      }
      var m = v.match(BARE_MONEY_RE);
      if (m && m[1] !== '0') {
        node.nodeValue = v.replace(m[1], '0');
        changed = true;
      }
    }
    return changed;
  }

  // 锁住金额行：React 用 textContent / innerHTML 回写时把它吞掉
  var frozenEls = [];
  function freeze(el) {
    if (!el || frozenEls.indexOf(el) !== -1) return;

    // 注意：textContent / innerHTML 的访问器在 Node.prototype / Element.prototype 上，
    // 不能从 Element.prototype 上取 textContent（那是 undefined，取到的 getter 一调用就炸）
    var nodeProto = window.Node.prototype;
    var textDesc = Object.getOwnPropertyDescriptor(nodeProto, 'textContent') ||
                    Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'textContent') ||
                    Object.getOwnPropertyDescriptor(window.Element.prototype, 'textContent');
    var htmlDesc = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML') ||
                    Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerHTML');

    var ok = false;
    if (textDesc && typeof textDesc.get === 'function') {
      try {
        Object.defineProperty(el, 'textContent', {
          configurable: true,
          enumerable: false,
          get: function () { return textDesc.get.call(this); },
          set: function () { /* 静默丢弃：不替换现有子节点，已归零的文案保留 */ },
        });
        ok = true;
      } catch (e) { /* 落到下面的 innerHTML 兜底 */ }
    }
    if (htmlDesc && typeof htmlDesc.get === 'function') {
      try {
        Object.defineProperty(el, 'innerHTML', {
          configurable: true,
          enumerable: false,
          get: function () { return htmlDesc.get.call(this); },
          set: function () { /* 同上 */ },
        });
        ok = true;
      } catch (e) { /* 忽略 */ }
    }

    if (ok) { frozenEls.push(el); log('金额行文案已锁定'); }
    else log('锁定失败（不影响归零，靠轮询兜底）');
  }

  // ================= 主循环 =================
  var lastTotal = null;

  function cycle() {
    var s = applySeat('standard');
    var p = applySeat('premium');

    var totalText = null;
    if (CFG.zeroAmount) {
      var total = findTotalEl() || lastTotal;
      if (total && isVisible(total)) {
        lastTotal = total;
        var before = text(total).trim();
        if (!isZeroText(before) && zeroMoneyIn(total)) {
          log('应付金额归零：' + before + ' → ' + text(total).trim());
        }
        freeze(total);
        totalText = text(total).trim();
      }
    }

    if (s.reason !== 'already' || p.reason !== 'already') {
      log('席位状态 → 标准:' + s.reason + ' 高级:' + p.reason +
          ' | 标准输入=' + (countInputs(locateCard('standard') || document.createElement('div')).length ? pickCountInput(locateCard('standard')).value : 'n/a'));
    }

    return { standard: s, premium: p, total: totalText };
  }

  // ================= 触发 =================
  var rafId = 0;
  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = 0; try { cycle(); } catch (e) { console.warn(TAG, e); } });
  }

  var obs = new MutationObserver(function () { schedule(); });
  obs.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['value', 'disabled', 'aria-disabled'],
  });

  function onInteract() {
    setTimeout(schedule, 0);
    setTimeout(schedule, 100);
    setTimeout(schedule, 350);
    setTimeout(schedule, 900);
  }

  var EVS = ['click', 'input', 'change', 'keydown', 'keyup', 'focusin', 'focusout', 'pointerdown'];
  EVS.forEach(function (ev) { document.addEventListener(ev, onInteract, true); });
  document.addEventListener('visibilitychange', schedule);

  var timer = setInterval(schedule, CFG.intervalMs);
  schedule();

  // ================= 句柄 =================
  window.__seatFix = {
    version: '1.1.1',
    cfg: CFG,
    run: function () { var r = cycle(); console.log(TAG, '手动执行:', r); return r; },
    set: function (kind, v) { CFG[kind] = Number(v) || 0; schedule(); },
    scan: function () {
      function d(k) {
        var c = locateCard(k);
        if (!c) return null;
        var i = pickCountInput(c);
        return { text: text(c).trim().slice(0, 160), hasInput: !!i, value: i ? i.value : guessCount(c) };
      }
      var t = findTotalEl();
      return { standard: d('standard'), premium: d('premium'), total: t ? text(t).trim() : null };
    },
    stop: function () {
      obs.disconnect();
      clearInterval(timer);
      EVS.forEach(function (ev) { document.removeEventListener(ev, onInteract, true); });
      document.removeEventListener('visibilitychange', schedule);
      if (rafId) cancelAnimationFrame(rafId), (rafId = 0);
      frozenEls.forEach(function (el) { try { delete el.textContent; } catch (e) {} });
      delete window.__seatFix;
      console.log(TAG, '已停止，刷新页面即彻底复原');
    },
    probeTotal: function () {
      var money = moneyEls();
      var total = findTotalEl();
      var res = {
        moneyCount: money.length,
        moneySample: money.map(function (m) { return text(m).trim(); }).slice(0, 6),
        found: !!total,
        totalText: total ? text(total).trim() : null,
        frozen: total ? frozenEls.indexOf(total) !== -1 : false,
      };
      if (total) res.changed = zeroMoneyIn(total);
      res.afterText = total ? text(total).trim() : null;
      return res;
    },
  };

  log('启动 → 标准席位 ' + CFG.standard + ' / 高级席位 ' + CFG.premium + ' / 应付归零 ' + CFG.zeroAmount);
})();
