// Shopify Admin GraphQL fetcher. Read-only.
// Needs a custom-app Admin API token per store (env var named in clients.json accounts.shopify.tokenEnv,
// default SHOPIFY_TOKEN_<CLIENTID>) with scopes: read_orders, read_products, read_inventory, read_customers.
//
// Net sales here = current subtotal (after discounts and after any refunded line items), shipping and tax excluded.
// New-customer order = customerJourneySummary.customerOrderIndex == 1 (Shopify's own first-order flag).
// Checkouts started = orders + abandoned checkouts created that day (the Shopify signal for a stuck checkout).

import { catOf, UNTAGGED, otherCat, trimDetail } from '../categories.js';
import { config, shopifyTokenFor } from '../config.js';
import { fetchJson, emptyDaily, log, num, round, addDays, tzOffset } from '../util.js';
import { classifyOrder, isTestOrder, payOf, groupDay } from '../orderSources.js';

const ORDERS_Q = `query DeskOrders($q: String!, $after: String) { orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { id name createdAt cancelledAt displayFinancialStatus currentSubtotalPriceSet { shopMoney { amount currencyCode } } currentTotalPriceSet { shopMoney { amount } } currentTotalTaxSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } } customer { id numberOfOrders } %s discountCodes lineItems(first: 50) { nodes { quantity title product { id title productType } variant { id } originalUnitPriceSet { shopMoney { amount } } } } } } }`;
// Same query plus what the Order sources view needs: the last visit with its UTM parameters, landing
// page and referrer, the note attributes checkout apps write UTMs into, the payment gateway (COD or
// prepaid) and Shopify's own test flag. Kept as a second query, not an edit of the first, so a store
// whose token or API version rejects any of these fields still syncs its sales exactly as before.
const ORDERS_Q_BASE = ORDERS_Q.replace('%s', 'customerJourneySummary { customerOrderIndex firstVisit { source } }');
const ORDERS_Q_SRC = ORDERS_Q.replace('%s', 'customerJourneySummary { customerOrderIndex firstVisit { source } lastVisit { source referrerUrl landingPage utmParameters { source medium campaign term content } } } test paymentGatewayNames customAttributes { key value }');
const ABANDONED_Q = `query DeskAbandoned($q: String!, $after: String) { abandonedCheckouts(first: 100, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { id createdAt completedAt } } }`;
const PRODUCTS_Q = `query DeskProducts($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title handle onlineStoreUrl totalInventory featuredMedia { preview { image { url } } } variants(first: 1) { nodes { price } } } } }`;
const SHOP_Q = `query DeskShop { shop { name myshopifyDomain currencyCode ianaTimezone plan { publicDisplayName } primaryDomain { url } } }`;

// ShopifyQL against Shopify's own reporting engine. This is the whole point: gross sales, discounts,
// returns and net sales come back already defined the way the merchant sees them in Analytics, so the
// dashboard cannot drift from their reports. Computing these from raw orders was wrong three separate
// ways at once (tax sat inside the subtotal, refunds were credited to the order's date rather than the
// refund's, and the current* money fields keep changing after the row is stored), and every one of
// those bugs pushed net sales UP, which is the direction a performance dashboard must never be wrong in.
// Needs the read_reports scope; where a store's token predates it, fetchDaily quietly keeps the old
// per-order arithmetic so that client does not simply go blank.
const SALES_QL = (since, until) =>
  `FROM sales SHOW orders, gross_sales, discounts, returns, net_sales, taxes, total_sales TIMESERIES day SINCE ${since} UNTIL ${until}`;

async function gql(client, query, variables) {
  const token = shopifyTokenFor(client);
  if (!token) throw new Error('no shopify token');
  const shop = client.accounts.shopify.shop;
  // Shopify meters GraphQL by query cost (a leaky bucket per store). A big store's 30-day order pull
  // with line items empties it, and the answer is a "Throttled" error rather than a slow reply. So:
  // on Throttled, wait for the bucket to refill enough for this query and try again; and after a
  // page that leaves the bucket low, pause before the next one instead of running into the wall.
  for (let attempt = 0; ; attempt++) {
    const body = await fetchJson(`https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
    }, { label: 'shopify' });
    const cost = body.extensions?.cost, ts = cost?.throttleStatus;
    const need = num(cost?.requestedQueryCost) || 200, have = num(ts?.currentlyAvailable), rate = num(ts?.restoreRate) || 50;
    const waitS = Math.min(60, Math.max(2, Math.ceil((need - have) / rate) + 1));
    if (body.errors?.length && body.errors.some((e) => /throttled/i.test(e.message || '') || e.extensions?.code === 'THROTTLED')) {
      if (attempt >= 12) throw new Error('shopify: Throttled (gave up after 12 waits)');
      log(`shopify ${client.id}: throttled, waiting ${waitS}s (bucket ${Math.round(have)}/${num(ts?.maximumAvailable) || '?'}, query ${need})`);
      await new Promise((r) => setTimeout(r, waitS * 1000)); continue;
    }
    if (body.errors?.length) throw new Error('shopify: ' + body.errors.map((e) => e.message).join('; '));
    if (ts && have < need * 1.2) await new Promise((r) => setTimeout(r, waitS * 1000));
    return body.data;
  }
}

async function allPages(client, query, q, key) {
  const out = []; let after = null;
  do {
    const data = await gql(client, query, { q, after });
    const conn = data[key]; out.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// Dates in the desk timezone. Shopify query dates are interpreted in the shop timezone; we pass ISO with offset.
function dayOf(iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: config.tz }); }

// Returns { 'YYYY-MM-DD': {orders, grossSales, discounts, refunds, netSales} }, or null when this
// store's token cannot read reports. Discounts and returns come back negative from ShopifyQL; they
// are stored positive here so the dashboard can show "returned" as a quantity rather than a subtraction.
export async function salesByDay(client, since, until) {
  let body;
  try {
    body = await gql(client, `query DeskSales($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { columns { name } rows } } }`, { q: SALES_QL(since, until) });
  } catch (e) {
    log(`shopify ${client.id}: reports unavailable (${String(e.message || e).slice(0, 120)}), falling back to per-order totals`);
    return null;
  }
  const res = body?.shopifyqlQuery;
  if (res?.parseErrors?.length) { log(`shopify ${client.id}: ShopifyQL rejected the query (${res.parseErrors.join('; ')})`); return null; }
  const rows = res?.tableData?.rows;
  if (!Array.isArray(rows)) { log(`shopify ${client.id}: reports returned no table, falling back to per-order totals`); return null; }
  const out = {};
  for (const r of rows) {
    const d = String(r.day || r.date || '').slice(0, 10);
    if (!d) continue;
    out[d] = {
      orders: Math.round(num(r.orders)),
      grossSales: round(num(r.gross_sales)),
      discounts: round(Math.abs(num(r.discounts))),
      refunds: round(Math.abs(num(r.returns))),
      netSales: round(num(r.net_sales)),
      taxes: round(num(r.taxes)),
      totalSales: round(num(r.total_sales)),
    };
  }
  return out;
}


// Store traffic straight from Shopify, for clients without GA4. Sessions, sessions that added to
// cart and sessions that reached checkout, all counted by Shopify's own analytics. Needs the same
// read_reports scope as the sales query; where it is missing the funnel simply stays on GA4.
export async function sessionsByDay(client, since, until) {
  try {
    const body = await gql(client, `query DeskSessions($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { columns { name } rows } } }`, { q: `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout TIMESERIES day SINCE ${since} UNTIL ${until}` });
    const res = body?.shopifyqlQuery;
    if (res?.parseErrors?.length || !Array.isArray(res?.tableData?.rows)) return null;
    const out = {};
    for (const r of res.tableData.rows) {
      const d = String(r.day || '').slice(0, 10); if (!d) continue;
      out[d] = { shSessions: Math.round(num(r.sessions)), shAtc: Math.round(num(r.sessions_with_cart_additions)), shReached: Math.round(num(r.sessions_that_reached_checkout)) };
    }
    return out;
  } catch (e) { log(`shopify ${client.id}: sessions unavailable (${String(e.message || e).slice(0, 100)})`); return null; }
}

export async function fetchDaily(client, since, until) {
  const off = tzOffset();
  const q = `created_at:>='${since}T00:00:00${off}' created_at:<='${until}T23:59:59${off}'`;
  const ordersWithSources = async () => {
    try { return { list: await allPages(client, ORDERS_Q_SRC, q, 'orders'), src: true }; }
    catch (e) {
      log(`shopify ${client.id}: order sources unavailable (${String(e.message || e).slice(0, 140)}), syncing sales without them`);
      return { list: await allPages(client, ORDERS_Q_BASE, q, 'orders'), src: false };
    }
  };
  const [{ list: orders, src: hasSources }, abandoned] = await Promise.all([
    ordersWithSources(),
    allPages(client, ABANDONED_Q, q, 'abandonedCheckouts'),
  ]);
  const byDay = {};
  const row = (d) => (byDay[d] = byDay[d] || emptyDaily(client.id, d, 'shopify'));
  for (let d = since; d <= until; d = addDays(d, 1)) row(d);
  const products = {}, untagged = {}, sample = {};
  // Where the store itself says each order came from. This is the only honest answer to "how
  // many orders came from Meta": the platforms each report the orders they believe their ads
  // caused, inside their own attribution window, so their counts overlap and add up to more
  // than the store ever sold. Shopify's firstVisit.source is a record, not a model. The data is
  // already in the orders response, so counting it costs nothing extra.
  const sourceOf = (o) => {
    const s = String(o.customerJourneySummary?.firstVisit?.source || '').toLowerCase();
    if (!s) return 'srcNone';
    if (s.includes('instagram') || s.includes('facebook')) return 'srcMeta';
    if (s.includes('google')) return 'srcGoogle';
    if (s === 'direct') return 'srcDirect';
    if (s.includes('unknown')) return 'srcUnknown';
    return 'srcOther';
  };

  for (const o of orders) {
    const d = dayOf(o.createdAt); const r = row(d);
    r.checkoutsStarted += 1;
    if (o.cancelledAt || o.displayFinancialStatus === 'VOIDED') continue;
    const gross = num(o.currentTotalPriceSet?.shopMoney?.amount), subtotal = num(o.currentSubtotalPriceSet?.shopMoney?.amount), refunded = num(o.totalRefundedSet?.shopMoney?.amount);
    // Net sales is after returns, the way Shopify's own reports define it. Leaving refunds out
    // inflated net sales, and with them AOV, MER and ROAS, which is the one direction a
    // performance dashboard must never be wrong in. Refunds stay on the row as well so the
    // return rate can be read on its own.
    const net = Math.max(0, subtotal - refunded);
    r.orders += 1; r.grossSales += gross; r.netSales += net; r.refunds += refunded;
    // Total sales is what the store shows as its headline: net sales plus GST (and shipping).
    r.totalSales = (r.totalSales || 0) + Math.max(0, gross - refunded); r.taxes = (r.taxes || 0) + num(o.currentTotalTaxSet?.shopMoney?.amount);
    r[sourceOf(o)] = (r[sourceOf(o)] || 0) + 1;
    if (o.customerJourneySummary?.customerOrderIndex === 1 || (!o.customerJourneySummary && o.customer?.numberOfOrders === 1)) r.newCustomerOrders += 1;
    // Category sales, product-wise: every line item goes to its category, so an order with two
    // products in one category counts twice there (the same way Shopify's product report counts).
    // Net is the line's share of the order's net sales (after discounts and returns, before tax).
    if (client.categories?.length) {
      const lis = o.lineItems?.nodes || [], lineGross = lis.reduce((t, li) => t + li.quantity * num(li.originalUnitPriceSet?.shopMoney?.amount), 0);
      const f = lineGross ? net / lineGross : 0; r.cats = r.cats || {};
      for (const li of lis) { const t = li.product?.title || li.title; const k = catOf(client, li.product?.productType, t) || UNTAGGED; const g = li.quantity * num(li.originalUnitPriceSet?.shopMoney?.amount);
        const c = (r.cats[k] = r.cats[k] || [0, 0, 0]); c[0] += 1; c[1] += g; c[2] += g * f;
        if (k === UNTAGGED || k === otherCat(client)) { r.catd = r.catd || {}; const dd = (r.catd[k] = r.catd[k] || {}), tk = String(t || '(no name)').slice(0, 90); const it = (dd[tk] = dd[tk] || [0, 0]); it[0] += 1; it[1] += g * f; }
        const sm = (sample[k] = sample[k] || {}); const sk = `${t} [${li.product?.productType || '-'}]`; sm[sk] = (sm[sk] || 0) + 1;
        if (k === UNTAGGED) untagged[t] = (untagged[t] || 0) + 1; }
    }
    for (const li of o.lineItems?.nodes || []) {
      r.units += li.quantity;
      const pid = li.product?.id || li.title;
      const p = (products[pid] = products[pid] || { id: pid, title: li.product?.title || li.title, units: 0, units7: 0, revenue: 0, orders: 0 });
      p.units += li.quantity; p.revenue += li.quantity * num(li.originalUnitPriceSet?.shopMoney?.amount); p.orders += 1;
      if (d > addDays(until, -7)) p.units7 += li.quantity;
    }
  }
  for (const a of abandoned) { if (!a.completedAt) row(dayOf(a.createdAt)).checkoutsStarted += 1; }

  // Shopify's own figures win wherever it will give them. The per-order pass above still supplies
  // units, first-time buyers, checkouts started and the product list, none of which ShopifyQL carries.
  const sales = await salesByDay(client, since, until);
  if (sales) for (const d in sales) { if (byDay[d]) Object.assign(byDay[d], sales[d]); }
  const traffic = await sessionsByDay(client, since, until);
  if (traffic) for (const d in traffic) { if (byDay[d]) Object.assign(byDay[d], traffic[d]); }

  if (Object.keys(untagged).length) log(`shopify ${client.id}: products with no category: ${Object.entries(untagged).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([t, n]) => `${t} (${n})`).join('; ')}`);
  for (const r of Object.values(byDay)) if (r.cats) for (const k in r.cats) r.cats[k] = [r.cats[k][0], round(r.cats[k][1]), round(r.cats[k][2])];
  for (const r of Object.values(byDay)) if (r.catd) r.catd = trimDetail(r.catd);
  if (client.categories?.length && since < addDays(until, -2)) log(`shopify ${client.id}: category check: ${Object.entries(sample).map(([k, m]) => `${k} = ${Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([t, n]) => `${t} (${n})`).join(', ')}`).join(' || ')}`.slice(0, 6000));
  if (client.categories?.length) for (const r of Object.values(byDay)) { if (!r.cats) r.cats = {}; if (!r.catd) r.catd = {}; }
  const rows = Object.values(byDay).map((r) => ({ ...r, grossSales: round(r.grossSales), netSales: round(r.netSales), totalSales: round(r.totalSales || 0), taxes: round(r.taxes || 0), discounts: round(r.discounts || 0), refunds: round(r.refunds) }));
  // Recent orders feed: the last two days, newest first, for the dashboard's Orders tab.
  const cutoff = addDays(until, -1);
  const recentOrders = orders.filter((o) => dayOf(o.createdAt) >= cutoff).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 60).map((o) => ({
    id: o.id, name: o.name, at: o.createdAt, total: round(num(o.currentTotalPriceSet?.shopMoney?.amount)),
    items: (o.lineItems?.nodes || []).map((li) => `${li.quantity} x ${li.product?.title || li.title}`).join(', '),
    units: (o.lineItems?.nodes || []).reduce((s, li) => s + li.quantity, 0),
    newCustomer: o.customerJourneySummary?.customerOrderIndex === 1 || (!o.customerJourneySummary && o.customer?.numberOfOrders === 1),
    status: o.cancelledAt ? 'cancelled' : (o.displayFinancialStatus || '').toLowerCase().replace(/_/g, ' '),
    source: o.customerJourneySummary?.firstVisit?.source || '',
    discount: (o.discountCodes || []).join(', '),
  }));
  // Order sources, one compact document per day (see orderSources.js). Every day in the window is
  // written, empty ones included, so a day that lost its orders to cancellations is overwritten too.
  let orderDays = null;
  if (hasSources) {
    orderDays = {};
    for (let d = since; d <= until; d = addDays(d, 1)) orderDays[d] = { list: [], test: { n: 0, v: 0 }, cancelled: { n: 0, v: 0 } };
    const gwTally = {};
    for (const o of orders) {
      const d = dayOf(o.createdAt); const day = orderDays[d]; if (!day) continue;
      const v = Math.max(0, num(o.currentTotalPriceSet?.shopMoney?.amount) - num(o.totalRefundedSet?.shopMoney?.amount));
      if (isTestOrder(o, v)) { day.test.n += 1; day.test.v = round(day.test.v + v); continue; }
      if (o.cancelledAt || o.displayFinancialStatus === 'VOIDED') { day.cancelled.n += 1; day.cancelled.v = round(day.cancelled.v + num(o.currentTotalPriceSet?.shopMoney?.amount)); continue; }
      const nc = o.customerJourneySummary?.customerOrderIndex === 1 || (!o.customerJourneySummary && o.customer?.numberOfOrders === 1);
      day.list.push({ ...classifyOrder(o), v: round(v), nc, cod: payOf(o) === 'COD' });
      { const gk = (o.paymentGatewayNames || []).join('+') || '(none)'; gwTally[gk] = (gwTally[gk] || 0) + 1; }
    }
    // How the store names its payment methods, so a COD gateway with an unusual name is visible.
    log(`shopify ${client.id}: payment gateways ${Object.entries(gwTally).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    for (const d in orderDays) { const x = orderDays[d]; orderDays[d] = { g: groupDay(x.list), test: x.test, cancelled: x.cancelled }; }
  }
  return { rows, products: Object.values(products), recentOrders, orderDays };
}

// Top products for the last 30 days with live inventory, so ads on an out-of-stock SKU show up.
export async function fetchProducts(client, until) {
  const since = addDays(until, -29);
  const { products } = await fetchDaily(client, since, until);
  const top = products.sort((a, b) => b.revenue - a.revenue).slice(0, 25);
  const ids = top.map((p) => p.id).filter((id) => id.startsWith('gid://'));
  let info = {};
  if (ids.length) {
    const data = await gql(client, PRODUCTS_Q, { ids });
    info = Object.fromEntries((data.nodes || []).filter(Boolean).map((n) => [n.id, n]));
  }
  // The store link: Shopify's own online store URL when the product is published there, else the
  // store domain plus /products/<handle>. The name comes from the product itself first, because a
  // line item keeps whatever title the product had on the day it was ordered (or none at all).
  const base = String(client.site?.url || (client.accounts?.shopify?.shop ? `https://${client.accounts.shopify.shop}` : '')).replace(/\/$/, '');
  return top.map((p) => {
    const n = info[p.id] || {};
    const url = /^https:\/\//.test(n.onlineStoreUrl || '') ? n.onlineStoreUrl : (n.handle && base ? `${base}/products/${n.handle}` : '');
    return { ...p, title: n.title || p.title || '', url, revenue: round(p.revenue), inventory: n.totalInventory ?? null, image: n.featuredMedia?.preview?.image?.url || '', price: num(n.variants?.nodes?.[0]?.price) };
  });
}

export async function testToken(client) {
  const data = await gql(client, SHOP_Q, {});
  log(`shopify ok: ${data.shop.name} (${data.shop.currencyCode}, ${data.shop.plan?.publicDisplayName}, ${data.shop.primaryDomain?.url})`);
  return data.shop;
}

// Every product's category, by Shopify product id (number). Used to put Meta catalog ad spend,
// which Meta reports per catalog product, into the same categories as the store's sales.
const PCAT = new Map();
export async function productCategories(client) {
  const hit = PCAT.get(client.id); if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.map;
  const map = new Map(); let after = null;
  do {
    const data = await gql(client, `query DeskProdCats($after: String) { products(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title productType } } }`, { after });
    for (const n of data.products.nodes) { const id = String(n.id).split('/').pop(); map.set(id, { title: n.title, cat: catOf(client, n.productType, n.title) || UNTAGGED }); }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);
  PCAT.set(client.id, { at: Date.now(), map });
  return map;
}
