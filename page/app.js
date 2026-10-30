// magpie 沙箱页（入口卡）逻辑。
//
// 硬约束（宿主沙箱）：iframe sandbox="allow-scripts"、CSP connect-src 'none' ——
// 没有 fetch / WebSocket / EventSource，没有内联脚本。本文件零网络请求。
// package.json 的 magpie.permissions 是空数组 → 不调用 magpie.read（连
// 'providers:list' 也不调），账号信息只做静态说明。
// 可用的宿主 API（按防御式写法消费，形状不确定时全部静默降级）：
//   magpie.ready / magpie.theme / magpie.onTheme / magpie.options.get() / magpie.onAction
// 主题：跟随宿主 data-theme；本卡的增量样式（style.css）与看板同一套 token。
(function () {
  "use strict";

  var DEFAULT_URL = "http://127.0.0.1:4390";

  function $(sel) {
    return document.querySelector(sel);
  }

  // ---- 主题 ------------------------------------------------------------------

  function normalizeTheme(t) {
    if (typeof t === "string") return t;
    if (t && typeof t === "object") {
      if (typeof t.theme === "string") return t.theme;
      if (typeof t.value === "string") return t.value;
      if (typeof t.mode === "string") return t.mode;
    }
    return "";
  }

  function applyTheme(t) {
    var mode = normalizeTheme(t);
    var root = document.documentElement;
    if (mode === "dark" || mode === "light") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme"); // 跟随系统（CSS prefers-color-scheme 兜底）
  }

  // ---- 看板地址 ----------------------------------------------------------------

  function setDashboardUrl(raw) {
    var url = typeof raw === "string" ? raw.trim() : "";
    if (!/^https?:\/\//i.test(url)) url = DEFAULT_URL; // 只接受 http(s)，其余回退默认
    var code = $("#dashUrl");
    var link = $("#dashLink");
    if (code) code.textContent = url;
    if (link) link.setAttribute("href", url);
    updateTunnelHint(url);
  }

  // dashboardUrl 写的是回环地址（127.0.0.1/localhost/::1）时提示 SSH 隧道用法：
  // 隧道映射后仍可用 127.0.0.1:<port> 打开，无需改选项。非回环地址或解析失败
  // 一律静默隐藏，不炸页面（沙箱页零网络、零报错的纪律不变）。
  function updateTunnelHint(url) {
    var hint = $("#tunnelHint");
    if (!hint) return;
    var port = "";
    try {
      var u = new URL(url);
      var h = u.hostname;
      if (h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1") {
        port = u.port || (u.protocol === "https:" ? "443" : "80");
      }
    } catch (e) { port = ""; }
    if (!port) {
      hint.hidden = true;
      return;
    }
    var code = $("#tunnelUrl");
    if (code) code.textContent = "127.0.0.1:" + port;
    hint.hidden = false;
  }

  // ---- 复制（clipboard API 在沙箱里可能被拒 → execCommand 兜底） ------------------

  function showToast(msg, ok) {
    var dash = document.querySelector(".wb-dash");
    if (!dash) return;
    var old = dash.querySelector(".wb-toast");
    if (old) old.remove();
    var p = document.createElement("p");
    p.className = ok ? "wb-toast wb-toast-ok" : "wb-toast";
    p.textContent = msg; // 只走 textContent，无注入面
    dash.appendChild(p);
    setTimeout(function () {
      p.remove();
    }, 3200);
  }

  function copyDashboardUrl() {
    var code = $("#dashUrl");
    var text = code ? code.textContent : DEFAULT_URL;
    var done = function (ok) {
      showToast(ok ? "已复制：" + text : "复制被沙箱拒绝，请手动选中地址复制。", ok);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { done(true); },
          function () { done(fallbackCopy(text)); },
        );
        return;
      }
    } catch (e) { /* 落到兜底 */ }
    done(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("style", "position:fixed;top:0;left:0;opacity:0");
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---- 宿主桥接（防御式：任何 API 缺失都不炸页面） --------------------------------

  function consumeHost(mp) {
    if (!mp || typeof mp !== "object") return;

    // 初始主题
    try {
      var t = typeof mp.theme === "function" ? mp.theme() : mp.theme;
      if (t != null) applyTheme(t);
    } catch (e) {}

    // 主题变化
    try {
      if (typeof mp.onTheme === "function") mp.onTheme(applyTheme);
    } catch (e) {}

    // 插件选项（dashboardUrl；声明默认值见 package.json 的 magpie.options）
    try {
      if (mp.options && typeof mp.options.get === "function") {
        Promise.resolve(mp.options.get()).then(
          function (opts) {
            if (opts && typeof opts.dashboardUrl === "string" && opts.dashboardUrl) {
              setDashboardUrl(opts.dashboardUrl);
            }
          },
          function () {},
        );
      }
    } catch (e) {}

    // onAction：宿主动作回调。本卡没有需要响应的宿主动作，注册一个安全的空实现，
    // 避免宿主在缺少 handler 时报错；不做任何越权 RPC。
    try {
      if (typeof mp.onAction === "function") {
        mp.onAction(function () {
          /* no-op：入口卡无宿主动作 */
        });
      }
    } catch (e) {}

    // 注意：magpie.read('providers:list' | 'usage:summary') 一律不调用 ——
    // package.json 的 magpie.permissions 为空，未申报任何读取权限。
  }

  function waitForHost(tries) {
    var mp = window.magpie;
    if (mp) {
      consumeHost(mp);
      return;
    }
    if (tries <= 0) return; // 宿主桥始终没出现：静态入口卡照常可用
    setTimeout(function () {
      waitForHost(tries - 1);
    }, 120);
  }

  function start() {
    setDashboardUrl(DEFAULT_URL); // 先落默认值，宿主选项到达后再覆盖
    var copyBtn = $("#copyBtn");
    if (copyBtn) copyBtn.addEventListener("click", copyDashboardUrl);

    var mp = window.magpie;
    if (mp && typeof mp.ready === "function") {
      // ready 可能是「回调式」或「返回 Promise」——两种都兜住
      try {
        var r = mp.ready(function () {
          consumeHost(window.magpie);
        });
        if (r && typeof r.then === "function") r.then(function () { consumeHost(window.magpie); }, function () {});
      } catch (e) {
        consumeHost(mp);
      }
      // 有的实现 ready(cb) 之外还允许直接消费；再补一次轮询兜底
      waitForHost(10);
      return;
    }
    waitForHost(25); // 桥可能稍后注入
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
