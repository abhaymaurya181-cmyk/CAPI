/*! lucira tracker — v0.1 */
(function (window, document) {
  "use strict";

  var CLICK_COOKIE_MAX_AGE = 90 * 24 * 3600;
  var FBC_COOKIE = "_fbc";
  var FBP_COOKIE = "_fbp";
  var GCLID_COOKIE = "_lucira_gclid";
  var WBRAID_COOKIE = "_lucira_wbraid";
  var GBRAID_COOKIE = "_lucira_gbraid";

  var EVENT_MAP = {
    page_view: "page_view",
    pageview: "page_view",
    page: "page_view",
    add_to_cart: "addToCart",
    addtocart: "addToCart",
    login: "login",
    signup: "signup",
    sign_up: "signup",
    begin_checkout: "begin_checkout",
    initiate_checkout: "begin_checkout",
    purchase: "purchase",
    customer_data: "customerData",
    customerdata: "customerData",
    newsletter: "newsletterSubscription",
    newsletter_subscription: "newsletterSubscription"
  };

  var config = {
    endpoint: "",
    tenant: "",
    cookieDomain: "",
    debug: false
  };
  var initialized = false;
  var ready = [];

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value, maxAgeSeconds) {
    var parts = [
      name + "=" + encodeURIComponent(value),
      "Max-Age=" + maxAgeSeconds,
      "Path=/",
      "SameSite=Lax"
    ];
    if (window.location.protocol === "https:") parts.push("Secure");
    if (config.cookieDomain) parts.push("Domain=" + config.cookieDomain);
    document.cookie = parts.join("; ");
  }

  function getUrlParam(name) {
    var m = window.location.search.match(new RegExp("[?&]" + name + "=([^&#]+)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function captureClickIds() {
    var now = Math.floor(Date.now() / 1000);

    var fbclid = getUrlParam("fbclid");
    if (fbclid && !getCookie(FBC_COOKIE)) {
      setCookie(FBC_COOKIE, "fb.1." + now + "." + fbclid, CLICK_COOKIE_MAX_AGE);
    }

    if (!getCookie(FBP_COOKIE)) {
      var rand = Math.floor(Math.random() * 2147483647);
      setCookie(FBP_COOKIE, "fb.1." + now + "." + rand, CLICK_COOKIE_MAX_AGE);
    }

    var gclid = getUrlParam("gclid");
    if (gclid) setCookie(GCLID_COOKIE, gclid, CLICK_COOKIE_MAX_AGE);

    var wbraid = getUrlParam("wbraid");
    if (wbraid) setCookie(WBRAID_COOKIE, wbraid, CLICK_COOKIE_MAX_AGE);

    var gbraid = getUrlParam("gbraid");
    if (gbraid) setCookie(GBRAID_COOKIE, gbraid, CLICK_COOKIE_MAX_AGE);
  }

  function normalizeEventName(name) {
    if (!name) return null;
    var key = String(name).toLowerCase();
    return EVENT_MAP[key] || null;
  }

  function buildPayload(eventName, data) {
    var d = data || {};
    return {
      event: eventName,
      event_id: d.event_id || uuid(),
      tenant: config.tenant || undefined,
      user_id: d.user_id,
      shopify_customer_id: d.shopify_customer_id || d.customer_id,
      phone: d.phone,
      email: d.email,
      first_name: d.first_name || d.firstName,
      last_name: d.last_name || d.lastName,
      zip: d.zip || d.postal_code,
      city: d.city,
      state: d.state,
      country: d.country,
      cookies: {
        gclid: getCookie(GCLID_COOKIE) || undefined,
        fbclid: (function () {
          var fbc = getCookie(FBC_COOKIE);
          if (!fbc) return undefined;
          var parts = fbc.split(".");
          return parts.length === 4 ? parts[3] : undefined;
        })(),
        _fbc: getCookie(FBC_COOKIE) || undefined,
        _fbp: getCookie(FBP_COOKIE) || undefined,
        client_cookie_id: getCookie("lcid") || undefined
      },
      consent: d.consent,
      source_url: window.location.href,
      referrer: document.referrer || undefined,
      sent_at: new Date().toISOString()
    };
  }

  function post(payload) {
    var url = config.endpoint + "/identify";
    var body = JSON.stringify(payload);

    if (config.debug && window.console) {
      window.console.log("[lucira]", payload.event, payload);
    }

    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch (e) {}

    try {
      fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  function send(eventName, data) {
    var normalized = normalizeEventName(eventName);
    if (!normalized) {
      if (config.debug && window.console) window.console.warn("[lucira] unknown event:", eventName);
      return;
    }
    if (!initialized) {
      ready.push([eventName, data]);
      return;
    }
    post(buildPayload(normalized, data));
  }

  function inferEndpoint() {
    try {
      var src = (document.currentScript && document.currentScript.src) || "";
      if (src) {
        var u = new URL(src);
        return u.protocol + "//" + u.host;
      }
    } catch (e) {}
    return window.location.protocol + "//" + window.location.host;
  }

  function inferCookieDomain() {
    var host = window.location.hostname;
    if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return "";
    var parts = host.split(".");
    if (parts.length < 2) return "";
    return "." + parts.slice(-2).join(".");
  }

  function init(opts) {
    opts = opts || {};
    config.tenant = opts.tenant || config.tenant;
    config.endpoint = (opts.endpoint || inferEndpoint()).replace(/\/+$/, "");
    config.cookieDomain = opts.cookieDomain != null ? opts.cookieDomain : inferCookieDomain();
    config.debug = !!opts.debug;
    captureClickIds();
    initialized = true;
    while (ready.length) {
      var args = ready.shift();
      send(args[0], args[1]);
    }
  }

  function lucira() {
    var args = Array.prototype.slice.call(arguments);
    var cmd = args[0];
    if (cmd === "init") return init(args[1]);
    if (cmd === "identify") return send(args[1] || "login", args[2] || args[1]);
    if (cmd === "track") return send(args[1], args[2]);
    if (cmd === "page") return send("page_view", args[1]);
    if (cmd === "debug") { config.debug = !!args[1]; return; }
    if (window.console) window.console.warn("[lucira] unknown command:", cmd);
  }

  var prev = window.lucira;
  var queued = (prev && prev.q) || [];
  lucira.q = [];
  window.lucira = lucira;

  try {
    var scriptEl = document.currentScript;
    if (scriptEl) {
      var tenant = scriptEl.getAttribute("data-tenant");
      var endpoint = scriptEl.getAttribute("data-endpoint");
      var auto = scriptEl.getAttribute("data-auto-init");
      if (tenant && auto !== "false") {
        init({ tenant: tenant, endpoint: endpoint || undefined });
      }
    }
  } catch (e) {}

  for (var i = 0; i < queued.length; i++) {
    try { lucira.apply(null, queued[i]); } catch (e) {}
  }
})(window, document);
