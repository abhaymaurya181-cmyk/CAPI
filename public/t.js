/*! lucira tracker — v0.1 */
(function (window, document) {
  "use strict";

  var CLICK_COOKIE_MAX_AGE = 90 * 24 * 3600;
  var FBC_COOKIE = "_fbc";
  var FBP_COOKIE = "_fbp";
  var GCLID_COOKIE = "_lucira_gclid";
  var WBRAID_COOKIE = "_lucira_wbraid";
  var GBRAID_COOKIE = "_lucira_gbraid";
  // Click time (ms) for each Google id, and landing context per platform,
  // written only when a click param is in the URL.
  var CLICK_AT_SUFFIX = "_at";
  var GOOGLE_LANDING_COOKIE = "_lucira_g_lp";
  var META_LANDING_COOKIE = "_lucira_m_lp";
  // Cookies written by Google's own tag (gtag / GTM conversion linker).
  var GCL_AW_COOKIE = "_gcl_aw";
  var GCL_GB_COOKIE = "_gcl_gb";
  var GCL_AU_COOKIE = "_gcl_au";
  var GA_COOKIE = "_ga";

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

  // fbclid is the 4th dot-separated part of fb.{subdomain}.{time}.{fbclid}.
  function fbclidFromFbc(fbc) {
    if (!fbc) return null;
    var parts = fbc.split(".");
    return parts.length >= 4 ? parts.slice(3).join(".") : null;
  }

  function landingInfo() {
    var info = {
      u: window.location.href.slice(0, 500),
      r: (document.referrer || "").slice(0, 300)
    };
    var utm = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    for (var i = 0; i < utm.length; i++) {
      var v = getUrlParam(utm[i]);
      if (v) info[utm[i]] = v.slice(0, 100);
    }
    return JSON.stringify(info);
  }

  function readJsonCookie(name) {
    var raw = getCookie(name);
    if (!raw) return undefined;
    try {
      var o = JSON.parse(raw);
      return {
        url: o.u || undefined,
        referrer: o.r || undefined,
        utm_source: o.utm_source,
        utm_medium: o.utm_medium,
        utm_campaign: o.utm_campaign,
        utm_content: o.utm_content,
        utm_term: o.utm_term
      };
    } catch (e) {
      return undefined;
    }
  }

  function captureClickIds() {
    // Meta's fbc/fbp creation time is in milliseconds.
    var nowMs = Date.now();

    // A new fbclid in the URL is a new ad click: overwrite _fbc so it always
    // carries the latest click (Meta's guidance), not the first one.
    var fbclid = getUrlParam("fbclid");
    if (fbclid && fbclidFromFbc(getCookie(FBC_COOKIE)) !== fbclid) {
      setCookie(FBC_COOKIE, "fb.1." + nowMs + "." + fbclid, CLICK_COOKIE_MAX_AGE);
      setCookie(META_LANDING_COOKIE, landingInfo(), CLICK_COOKIE_MAX_AGE);
    }

    if (!getCookie(FBP_COOKIE)) {
      var rand = Math.floor(Math.random() * 2147483647);
      setCookie(FBP_COOKIE, "fb.1." + nowMs + "." + rand, CLICK_COOKIE_MAX_AGE);
    }

    var googleIds = [
      ["gclid", GCLID_COOKIE],
      ["wbraid", WBRAID_COOKIE],
      ["gbraid", GBRAID_COOKIE]
    ];
    var googleClick = false;
    for (var i = 0; i < googleIds.length; i++) {
      var value = getUrlParam(googleIds[i][0]);
      if (value && getCookie(googleIds[i][1]) !== value) {
        setCookie(googleIds[i][1], value, CLICK_COOKIE_MAX_AGE);
        setCookie(googleIds[i][1] + CLICK_AT_SUFFIX, String(nowMs), CLICK_COOKIE_MAX_AGE);
        googleClick = true;
      }
    }
    if (googleClick) setCookie(GOOGLE_LANDING_COOKIE, landingInfo(), CLICK_COOKIE_MAX_AGE);
  }

  function numCookie(name) {
    var v = getCookie(name);
    return v && /^\d+$/.test(v) ? Number(v) : undefined;
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
      date_of_birth: d.date_of_birth || d.dob,
      gender: d.gender,
      cookies: {
        gclid: getCookie(GCLID_COOKIE) || undefined,
        gclid_at: numCookie(GCLID_COOKIE + CLICK_AT_SUFFIX),
        wbraid: getCookie(WBRAID_COOKIE) || undefined,
        wbraid_at: numCookie(WBRAID_COOKIE + CLICK_AT_SUFFIX),
        gbraid: getCookie(GBRAID_COOKIE) || undefined,
        gbraid_at: numCookie(GBRAID_COOKIE + CLICK_AT_SUFFIX),
        _gcl_aw: getCookie(GCL_AW_COOKIE) || undefined,
        _gcl_gb: getCookie(GCL_GB_COOKIE) || undefined,
        _gcl_au: getCookie(GCL_AU_COOKIE) || undefined,
        _ga: getCookie(GA_COOKIE) || undefined,
        fbclid: fbclidFromFbc(getCookie(FBC_COOKIE)) || undefined,
        _fbc: getCookie(FBC_COOKIE) || undefined,
        _fbp: getCookie(FBP_COOKIE) || undefined,
        client_cookie_id: getCookie("lcid") || undefined
      },
      landing: {
        google: readJsonCookie(GOOGLE_LANDING_COOKIE),
        meta: readJsonCookie(META_LANDING_COOKIE)
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
    if (cmd === "identify") {
      // Two signatures:
      //   lucira("identify", {phone, email, ...})         → event defaults to "login"
      //   lucira("identify", "signup", {phone, email})    → explicit event name
      var isStr = typeof args[1] === "string";
      return send(isStr ? args[1] : "login", isStr ? args[2] : args[1]);
    }
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
    // document.currentScript is null when the <script> is injected dynamically
    // (which Next.js <Script strategy="afterInteractive"> does). Fall back to
    // querying any script tag that references this file and carries data-tenant.
    var scriptEl = document.currentScript;
    if (!scriptEl) {
      scriptEl = document.querySelector('script[data-tenant][src*="/t.js"]');
    }
    if (scriptEl) {
      var tenant = scriptEl.getAttribute("data-tenant");
      var endpoint = scriptEl.getAttribute("data-endpoint");
      var auto = scriptEl.getAttribute("data-auto-init");
      if (tenant && auto !== "false") {
        init({ tenant: tenant, endpoint: endpoint || undefined });
      }
    }
    // Final safety net: if the SDK is loaded but no auto-init tag is found,
    // still initialize with inferred defaults so manual lucira(...) calls work.
    if (!initialized) {
      init({});
    }
  } catch (e) {}

  for (var i = 0; i < queued.length; i++) {
    try { lucira.apply(null, queued[i]); } catch (e) {}
  }
})(window, document);
