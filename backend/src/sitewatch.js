// Site Watch: synthetic checks against the live store or landing page, every 30 minutes.
// Uses only the public store URL, no tokens. Never places an order.
//
// Ecom:  homepage, SSL expiry, pixel + GA tag present, product page, add to cart (Shopify /cart/add.js),
//        checkout page renders (contact + shipping form visible, no error page).
// Lead:  homepage, SSL, tags, landing page has a form with a submit button.
//
// Shopify stores are detected from the response; non-Shopify stores get the generic checks only.

import tls from 'node:tls';
import { config } from './config.js';
import { db } from './db.js';
import { log, nowIso } from './util.js';
import { raise } from './alerts.js';

function sslDaysLeft(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const cert = s.getPeerCertificate();
      s.end();
      if (!cert?.valid_to) return resolve(null);
      resolve(Math.round((new Date(cert.valid_to) - Date.now()) / 86400000));
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}

async function timed(fn) {
  const t = Date.now();
  try { const detail = await fn(); return { ok: true, ms: Date.now() - t, detail: detail || '' }; }
  catch (e) { return { ok: false, ms: Date.now() - t, detail: (e.message || String(e)).slice(0, 200) }; }
}

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36 Per4manceDesk/1.0';

async function req(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeout || config.sitewatch.timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}

// Light mode: the same checks without a headless browser, so Site Watch still runs on a 512 MB free
// instance where Chromium will not fit. It reads page source instead of a rendered page, so tag
// detection is a little less certain; everything else (status, SSL, product, cart, checkout) is the
// same real request the storefront makes.
export async function checkSiteLight(client) {
  const url = client.site?.url;
  if (!url) return null;
  const base = url.replace(/\/$/, '');
  const host = new URL(url).host;
  const T = config.sitewatch.timeoutMs;
  const checks = [];
  let isShopify = false, html = '', cookie = '';

  const home = await timed(async () => {
    const res = await req(url, { timeout: T });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
    if (/enter using password|opening soon/i.test(html)) throw new Error('store is password protected');
    if (client.site?.expectText && !html.includes(client.site.expectText)) throw new Error(`expected text not found: ${client.site.expectText}`);
    isShopify = /cdn\.shopify\.com|Shopify\.shop|shopify-section|web-pixels-manager/i.test(html);
    return `${res.status} OK`;
  });
  checks.push({ name: 'Homepage loads', ...home, slow: home.ms > config.sitewatch.slowMs });

  const days = await sslDaysLeft(host);
  checks.push({ name: 'SSL certificate', ok: days === null ? false : days > 7, ms: 0, detail: days === null ? 'could not read certificate' : `expires in ${days} days` });

  const fbOk = /connect\.facebook\.net|fbq\s*\(|facebook_pixel|facebook&#x20;pixel|"facebook"|meta pixel/i.test(html);
  const gaOk = /googletagmanager\.com\/gtag|googletagmanager\.com\/gtm|gtag\s*\(|google_analytics|"G-[A-Z0-9]{6,}"|G-[A-Z0-9]{8,}/i.test(html);
  checks.push({ name: 'Meta pixel present', ok: fbOk, ms: 0, detail: fbOk ? 'pixel code found in page source' : 'no pixel code in homepage source' });
  checks.push({ name: 'GA4 tag present', ok: gaOk, ms: 0, detail: gaOk ? 'GA4 or GTM code found in page source' : 'no GA4 or GTM in homepage source' });

  if (client.type !== 'lead') {
    let productPath = client.site?.productPath || '';
    let variantId = null;
    const prod = await timed(async () => {
      if (!productPath && isShopify) {
        const r = await req(`${base}/products.json?limit=5`, { timeout: T });
        if (r.ok) {
          const j = await r.json();
          const p = (j.products || []).find((x) => (x.variants || []).some((v) => v.available !== false));
          if (p) { productPath = `/products/${p.handle}`; variantId = (p.variants.find((v) => v.available !== false) || p.variants[0]).id; }
        }
      }
      if (!productPath) return 'skipped: no product found automatically (set site.productPath)';
      const res = await req(base + productPath, { timeout: T });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (/sold out/i.test(body) && !/add to cart|add to bag|buy now/i.test(body)) throw new Error('product shows sold out');
      return `${res.status} OK, ${productPath}`;
    });
    checks.push({ name: 'Product page loads', ...prod, slow: prod.ms > config.sitewatch.slowMs, skipped: /^skipped/.test(prod.detail) });

    if (isShopify && productPath && prod.ok && !/^skipped/.test(prod.detail)) {
      const atc = await timed(async () => {
        if (!variantId) {
          const r = await req(`${base}${productPath}.js`, { timeout: T });
          if (!r.ok) throw new Error('could not read product variants');
          const j = await r.json();
          variantId = (j.variants.find((v) => v.available) || j.variants[0])?.id;
        }
        const r = await req(`${base}/cart/add.js`, { method: 'POST', timeout: T, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }) });
        const m = (r.headers.get('set-cookie') || '').match(/cart=([^;,\s]+)/);
        if (m) cookie = `cart=${m[1]}`;
        const body = await r.text();
        if (!r.ok) {
          // Shopify answers a rejected add with a readable reason, which is exactly what we want to surface.
          let why = `HTTP ${r.status}`;
          try { const j = JSON.parse(body); if (j.description || j.message) why = (j.description || j.message).slice(0, 140); } catch { /* not json */ }
          throw new Error(`cart rejected the item: ${why}`);
        }
        // The add response itself carries the line that was added, so this does not depend on the cart cookie.
        let added = null;
        try { const j = JSON.parse(body); added = j.items ? j.items[0] : j; } catch { /* not json */ }
        if (!added || !added.id) throw new Error('cart/add.js did not return the added item');
        return `added ${added.quantity || 1} x ${(added.product_title || added.title || 'item').slice(0, 40)}`;
      });
      checks.push({ name: 'Add to cart', ...atc });

      const co = await timed(async () => {
        const res = await req(`${base}/checkout`, { timeout: T, headers: cookie ? { Cookie: cookie } : {} });
        const text = await res.text();
        // 403 and 429 here are Shopify's bot protection refusing an automated request, not a broken
        // checkout. Real checkout health is watched from the data side by the checkout-stuck signal
        // (checkouts started vs orders against the client's own 14 day norm).
        if (res.status === 403 || res.status === 429) return `skipped: Shopify bot protection blocked the request (HTTP ${res.status})`;
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        if (/something went wrong|checkout is unavailable|this store is unavailable|not accepting orders|unable to process/i.test(text)) throw new Error('checkout returned an error page');
        return `${res.status} OK, checkout reachable`;
      });
      checks.push({ name: 'Checkout page loads', ...co, slow: co.ms > config.sitewatch.slowMs, skipped: /^skipped/.test(co.detail) });
    }
  } else if (client.site?.leadFormPath) {
    const lp = await timed(async () => {
      const res = await req(base + client.site.leadFormPath, { timeout: T });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      const forms = (body.match(/<form[\s>]/gi) || []).length;
      const submit = (body.match(/type=["']?submit|<button[\s>]/gi) || []).length;
      if (!forms || !submit) throw new Error(`no submittable form found (${forms} forms, ${submit} buttons)`);
      return `${forms} form(s) found`;
    });
    checks.push({ name: 'Landing page form present', ...lp, slow: lp.ms > config.sitewatch.slowMs });
  }

  return { clientId: client.id, url, at: nowIso(), ok: checks.every((c) => c.ok), checks, isShopify, mode: 'light', sample: false };
}

export async function checkSite(client) {
  const url = client.site?.url;
  if (!url) return null;
  const { chromium } = await import('playwright');
  const host = new URL(url).host;
  const checks = [];
  const T = config.sitewatch.timeoutMs;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36 Per4manceDesk/1.0', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  let isShopify = false, html = '';
  // Tag detection by network activity: works whether the pixel is inline, via GTM, or a Shopify web pixel.
  const seen = { fb: false, ga: false };
  page.on('request', (req) => {
    const u = req.url();
    if (/facebook\.com\/tr|connect\.facebook\.net/.test(u)) seen.fb = true;
    if (/google-analytics\.com\/g\/collect|googletagmanager\.com\/gtag|googletagmanager\.com\/gtm|analytics\.google\.com\/g\/collect/.test(u)) seen.ga = true;
  });
  try {
    // 1. Homepage
    const home = await timed(async () => {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: T });
      if (!res || res.status() >= 400) throw new Error(`HTTP ${res ? res.status() : 'no response'}`);
      await page.waitForTimeout(3000); // let tags fire
      html = await page.content();
      if (/password page|opening soon|enter using password/i.test(html) && /password/i.test(await page.title())) throw new Error('store is password protected');
      if (client.site?.expectText && !html.includes(client.site.expectText)) throw new Error(`expected text not found: ${client.site.expectText}`);
      isShopify = /cdn\.shopify\.com|Shopify\.shop|shopify-section/i.test(html);
      return `${res.status()} OK`;
    });
    home.ms = Math.max(0, home.ms - 3000);
    checks.push({ name: 'Homepage loads', ...home, slow: home.ms > config.sitewatch.slowMs });

    // 2. SSL
    const days = await sslDaysLeft(host);
    checks.push({ name: 'SSL certificate', ok: days === null ? false : days > 7, ms: 0, detail: days === null ? 'could not read certificate' : `expires in ${days} days` });

    // 3. Tags
    const fbOk = seen.fb || /connect\.facebook\.net|fbq\(/.test(html);
    const gaOk = seen.ga || /googletagmanager\.com\/gtag|gtag\(|googletagmanager\.com\/gtm/.test(html);
    checks.push({ name: 'Meta pixel fires', ok: fbOk, ms: 0, detail: seen.fb ? 'pixel request seen on page load' : fbOk ? 'pixel code present' : 'no pixel request or code on homepage' });
    checks.push({ name: 'GA4 tag fires', ok: gaOk, ms: 0, detail: seen.ga ? 'GA request seen on page load' : gaOk ? 'gtag or GTM code present' : 'no GA4 or GTM on homepage' });

    if (client.type !== 'lead') {
      // 4. Product page: configured path, else first product from /products.json (Shopify)
      let productPath = client.site?.productPath || '';
      let variantId = null;
      const prod = await timed(async () => {
        if (!productPath && isShopify) {
          const r = await page.request.get(`${url.replace(/\/$/, '')}/products.json?limit=5`, { timeout: T });
          if (r.ok()) {
            const j = await r.json();
            const p = (j.products || []).find((x) => (x.variants || []).some((v) => v.available !== false));
            if (p) { productPath = `/products/${p.handle}`; variantId = (p.variants.find((v) => v.available !== false) || p.variants[0]).id; }
          }
        }
        if (!productPath) return 'skipped: no product found automatically (set site.productPath)';
        const res = await page.goto(url.replace(/\/$/, '') + productPath, { waitUntil: 'domcontentloaded', timeout: T });
        if (!res || res.status() >= 400) throw new Error(`HTTP ${res ? res.status() : 'no response'}`);
        const body = await page.content();
        if (/sold out/i.test(body) && !/add to cart|add to bag|buy now/i.test(body)) throw new Error('product shows sold out');
        return `${res.status()} OK, ${productPath}`;
      });
      checks.push({ name: 'Product page loads', ...prod, slow: prod.ms > config.sitewatch.slowMs, skipped: /^skipped/.test(prod.detail) });

      if (isShopify && productPath && prod.ok) {
        // 5. Add to cart through the storefront AJAX API (same call the theme's button makes)
        const atc = await timed(async () => {
          if (!variantId) {
            const r = await page.request.get(`${url.replace(/\/$/, '')}${productPath}.js`, { timeout: T });
            if (!r.ok()) throw new Error('could not read product variants');
            const j = await r.json(); variantId = (j.variants.find((v) => v.available) || j.variants[0])?.id;
          }
          const r = await page.request.post(`${url.replace(/\/$/, '')}/cart/add.js`, { data: { items: [{ id: variantId, quantity: 1 }] }, timeout: T });
          if (!r.ok()) throw new Error(`cart/add.js HTTP ${r.status()}`);
          const cart = await page.request.get(`${url.replace(/\/$/, '')}/cart.js`, { timeout: T });
          const cj = await cart.json();
          if (!cj.item_count) throw new Error('cart is empty after add');
          return `cart has ${cj.item_count} item`;
        });
        checks.push({ name: 'Add to cart', ...atc });

        // 6. Checkout renders
        const co = await timed(async () => {
          const res = await page.goto(`${url.replace(/\/$/, '')}/checkout`, { waitUntil: 'domcontentloaded', timeout: T });
          await page.waitForTimeout(2500);
          if (!res || res.status() >= 400) throw new Error(`HTTP ${res ? res.status() : 'no response'}`);
          const text = await page.locator('body').innerText().catch(() => '');
          if (/something went wrong|checkout is unavailable|this store is unavailable|not accepting orders|can.t be processed|unable to process/i.test(text)) throw new Error('checkout shows an error message');
          const inputs = await page.locator('input[type=email], input[name=email], input[type=tel], input[autocomplete*="address"], input[autocomplete*="name"]').count();
          const hasForm = inputs > 0 || /contact|shipping address|delivery|phone|email/i.test(text);
          if (!hasForm) throw new Error('checkout page has no contact or shipping form');
          return 'contact + shipping form visible';
        });
        checks.push({ name: 'Checkout page loads', ...co, slow: co.ms > config.sitewatch.slowMs });
      }
    } else if (client.site?.leadFormPath) {
      const lp = await timed(async () => {
        const res = await page.goto(url.replace(/\/$/, '') + client.site.leadFormPath, { waitUntil: 'domcontentloaded', timeout: T });
        if (!res || res.status() >= 400) throw new Error(`HTTP ${res ? res.status() : 'no response'}`);
        const forms = await page.locator('form').count();
        const inputs = await page.locator('form input, form textarea, form select').count();
        const submit = await page.locator('form button, form input[type=submit]').count();
        if (!forms || !submit) throw new Error(`no submittable form found (${forms} forms, ${submit} buttons)`);
        return `form with ${inputs} fields`;
      });
      checks.push({ name: 'Landing page form present', ...lp, slow: lp.ms > config.sitewatch.slowMs });
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { clientId: client.id, url, at: nowIso(), ok: checks.every((c) => c.ok), checks, isShopify, sample: false };
}

// DESK_SITEWATCH_LIGHT=true skips the headless browser entirely. Set it on a free 512 MB instance
// where Chromium cannot run; leave it unset anywhere with room for the browser.
const LIGHT = /^(1|true|yes)$/i.test(process.env.DESK_SITEWATCH_LIGHT || '');

function failedResult(client, e) {
  return { clientId: client.id, url: client.site.url, at: nowIso(), ok: false, sample: false,
    checks: [{ name: 'Site check ran', ok: false, ms: 0, detail: (e.message || String(e)).slice(0, 200) }] };
}

export async function runSitewatch(clients) {
  const store = await db();
  log(`sitewatch mode: ${LIGHT ? 'light (no browser)' : 'browser'}`);
  for (const client of clients) {
    if (!client.site?.url || client.sample) { log(`sitewatch ${client.id}: skipped (${client.sample ? 'sample client' : 'no site url'})`); continue; }
    let result;
    if (LIGHT) {
      try { result = await checkSiteLight(client); }
      catch (e) { result = failedResult(client, e); }
    } else {
      try { result = await checkSite(client); }
      catch (e) {
        log(`sitewatch ${client.id}: browser mode unavailable (${(e.message || e).toString().slice(0, 120)}), using light checks`);
        try { result = await checkSiteLight(client); }
        catch (e2) { result = failedResult(client, e2); }
      }
    }
    const prev = (await store.get('sitewatch', client.id)) || {};
    const history = [...(prev.history || []), { at: result.at, ok: result.ok, failed: result.checks.filter((c) => !c.ok).map((c) => c.name), ms: result.checks[0]?.ms || 0 }].slice(-96);
    await store.set('sitewatch', client.id, { ...result, history });
    await store.merge('syncs', client.id, { sitewatch: { at: result.at, ok: result.ok, error: result.ok ? '' : result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | ') } });
    const failed = result.checks.filter((c) => !c.ok);
    log(`sitewatch ${client.id}: ${result.ok ? 'all ok' : 'FAILED ' + failed.map((c) => c.name).join(', ')}`);
    // Alert on the second consecutive failure of the same check, to skip one-off network blips.
    const prevFailed = new Set((prev.history || []).slice(-1)[0]?.failed || []);
    const confirmed = failed.filter((c) => prevFailed.has(c.name));
    if (confirmed.length) await raise(client, 'sitewatch', 'critical', `${client.name}: ${confirmed.map((c) => `${c.name} failed (${c.detail})`).join('; ')}. Two checks in a row, 30 minutes apart.`);
    if (result.ok && (prev.history || []).slice(-1)[0]?.failed?.length) await raise(client, 'sitewatch-recovered', 'info', `${client.name}: site checks back to normal.`);
  }
}
