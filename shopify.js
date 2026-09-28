// Shopify Admin GraphQL fetcher. Read-only.
// Needs a custom-app Admin API token per store (env var named in clients.json accounts.shopify.tokenEnv,
// default SHOPIFY_TOKEN_<CLIENTID>) with scopes: read_orders, read_products, read_inventory, read_customers.
//
// Net sales here = current subtotal (after discounts and after any refunded line items), shipping and tax excluded.
// New-customer order = customerJourneySummary.customerOrderIndex == 1 (Shopify's own first-order flag).
// Checkouts started = orders + abandoned checkouts created that day (the Shopify signal for a stuck checkout).

import { config, shopifyTokenFor } from '../config.js';
import { fetchJson, emptyDaily, log, num, round, addDays, tzOffset } from '../util.js';

const ORDERS_Q = `query DeskOrders($q: String!, $after: String) { orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { id name createdAt cancelledAt displayFinancialStatus currentSubtotalPriceSet { shopMoney { amount currencyCode } } currentTotalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } } customer { id numberOfOrders } customerJourneySummary { customerOrderIndex firstVisit { source } } discountCodes lineItems(first: 50) { nodes { quantity title product { id title } variant { id } originalUnitPriceSet { shopMoney { amount } } } } } } }`;
const ABANDONED_Q = `query DeskAbandoned($q: String!, $after: String) { abandonedCheckouts(first: 100, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { id createdAt completedAt } } }`;
const PRODUCTS_Q = `query DeskProducts($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title totalInventory featuredMedia { preview { image { url } } } variants(first: 1) { nodes { price } } } } }`;
const SHOP_Q = `query DeskShop { shop { name myshopifyDomain currencyCode ianaTimezone plan { publicDisplayName } primaryDomain { url } } }`;

async function gql(client, query, variables) {
  const token = shopifyTokenFor(client);
  if (!token) throw new Error('no shopify token');
  const shop = client.accounts.shopify.shop;
  const body = await fetchJson(`https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
  }, { label: 'shopify' });
  if (body.errors?.length) throw new Error('shopify: ' + body.errors.map((e) => e.message).join('; '));
  return body.data;
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

export async function fetchDaily(client, since, until) {
  const off = tzOffset();
  const q = `created_at:>='${since}T00:00:00${off}' created_at:<='${until}T23:59:59${off}'`;
  const [orders, abandoned] = await Promise.all([
    allPages(client, ORDERS_Q, q, 'orders'),
    allPages(client, ABANDONED_Q, q, 'abandonedCheckouts'),
  ]);
  const byDay = {};
  const row = (d) => (byDay[d] = byDay[d] || emptyDaily(client.id, d, 'shopify'));
  for (let d = since; d <= until; d = addDays(d, 1)) row(d);
  const products = {};
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
    if (o.customerJourneySummary?.customerOrderIndex === 1 || (!o.customerJourneySummary && o.customer?.numberOfOrders === 1)) r.newCustomerOrders += 1;
    for (const li of o.lineItems?.nodes || []) {
      r.units += li.quantity;
      const pid = li.product?.id || li.title;
      const p = (products[pid] = products[pid] || { id: pid, title: li.product?.title || li.title, units: 0, units7: 0, revenue: 0, orders: 0 });
      p.units += li.quantity; p.revenue += li.quantity * num(li.originalUnitPriceSet?.shopMoney?.amount); p.orders += 1;
      if (d > addDays(until, -7)) p.units7 += li.quantity;
    }
  }
  for (const a of abandoned) { if (!a.completedAt) row(dayOf(a.createdAt)).checkoutsStarted += 1; }
  const rows = Object.values(byDay).map((r) => ({ ...r, grossSales: round(r.grossSales), netSales: round(r.netSales), refunds: round(r.refunds) }));
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
  return { rows, products: Object.values(products), recentOrders };
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
  return top.map((p) => ({ ...p, revenue: round(p.revenue), inventory: info[p.id]?.totalInventory ?? null, image: info[p.id]?.featuredMedia?.preview?.image?.url || '', price: num(info[p.id]?.variants?.nodes?.[0]?.price) }));
}

export async function testToken(client) {
  const data = await gql(client, SHOP_Q, {});
  log(`shopify ok: ${data.shop.name} (${data.shop.currencyCode}, ${data.shop.plan?.publicDisplayName}, ${data.shop.primaryDomain?.url})`);
  return data.shop;
}
