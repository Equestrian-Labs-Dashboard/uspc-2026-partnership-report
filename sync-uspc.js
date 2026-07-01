import fs from 'node:fs/promises';
import path from 'node:path';

const SHOPIFY_STORE = requiredEnv('SHOPIFY_STORE');
const SHOPIFY_TOKEN = requiredEnv('SHOPIFY_TOKEN');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const DISCOUNT_CODE = process.env.DISCOUNT_CODE || 'USPC 2026';
const REPORT_YEAR = Number(process.env.REPORT_YEAR || 2026);
const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.10);

const OUTPUT_FILE = process.env.OUTPUT_FILE || 'data/uspc-2026.json';

const MONTHS = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  console.log(`Starting USPC sync`);
  console.log(`Store: ${SHOPIFY_STORE}`);
  console.log(`Year: ${REPORT_YEAR}`);
  console.log(`Discount code: ${DISCOUNT_CODE}`);

  const orders = await fetchShopifyOrders();

  const report = buildReport(orders);

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2));

  console.log(`Report written to ${OUTPUT_FILE}`);
  console.log(`Orders: ${report.totals.orders_count}`);
  console.log(`Line items: ${report.totals.line_items_count}`);
  console.log(`Net Sales: ${report.totals.net_sales}`);
  console.log(`Commission: ${report.totals.commission}`);
}

async function fetchShopifyOrders() {
  const endpoint = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`;

  const startISO = `${REPORT_YEAR}-01-01T00:00:00Z`;
  const endISO = `${REPORT_YEAR}-12-31T23:59:59Z`;

  // Shopify supports order search query filters such as discount_code.
  // This keeps the sync lightweight.
  const searchQuery =
    `discount_code:"${DISCOUNT_CODE}" ` +
    `created_at:>=${startISO} ` +
    `created_at:<=${endISO}`;

  let cursor = null;
  let hasNextPage = true;
  const orders = [];

  while (hasNextPage) {
    const gql = `
      query USPCOrders($first: Int!, $after: String, $query: String!) {
        orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              name
              createdAt
              cancelledAt
              customer {
                displayName
                email
              }
              discountCode
              discountCodes
              lineItems(first: 100) {
                edges {
                  node {
                    title
                    quantity
                    discountedTotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    originalTotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN
      },
      body: JSON.stringify({
        query: gql,
        variables: {
          first: 100,
          after: cursor,
          query: searchQuery
        }
      })
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Shopify HTTP ${response.status}: ${text}`);
    }

    const body = JSON.parse(text);

    if (body.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
    }

    const connection = body.data?.orders;

    if (!connection) {
      throw new Error(`Invalid Shopify response: ${text}`);
    }

    for (const edge of connection.edges || []) {
      if (edge.node) orders.push(edge.node);
    }

    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    cursor = connection.pageInfo?.endCursor || null;

    if (hasNextPage) {
      await sleep(500);
    }
  }

  return orders;
}

function buildReport(orders) {
  const lines = [];

  for (const order of orders) {
    if (!order) continue;
    if (order.cancelledAt) continue;

    // Extra safety: make sure USPC 2026 is in discountCodes/discountCode.
    const allCodes = getOrderCodes(order);
    const hasCode = allCodes.some((code) => normalizeCode(code) === normalizeCode(DISCOUNT_CODE));

    if (!hasCode) continue;

    const date = new Date(order.createdAt);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const quarter = getQuarter(month);

    const customer =
      order.customer?.displayName ||
      order.customer?.email ||
      'N/A';

    const itemEdges = order.lineItems?.edges || [];

    for (const itemEdge of itemEdges) {
      const item = itemEdge.node;
      if (!item) continue;

      if (String(item.title || '').toLowerCase() === 'shipping') {
        continue;
      }

      const netSale = round2(Number(item.discountedTotalSet?.shopMoney?.amount || 0));
      const commission = round2(netSale * COMMISSION_RATE);

      lines.push({
        date: order.createdAt,
        date_short: formatShortDate(date),
        year,
        month,
        month_name: MONTHS[month],
        quarter,
        order: order.name || '',
        customer,
        product: item.title || 'N/A',
        quantity: Number(item.quantity || 0),
        discount_code: DISCOUNT_CODE,
        net_sale: netSale,
        commission_rate: COMMISSION_RATE,
        commission
      });
    }
  }

  lines.sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    ok: true,
    report_name: 'USPC 2026 Partnership Report',
    generated: new Date().toISOString(),
    generated_label: formatGeneratedLabel(new Date()),
    discount_code: DISCOUNT_CODE,
    commission_rate: COMMISSION_RATE,
    year: REPORT_YEAR,
    totals: buildTotals(lines),
    monthly: buildMonthlySummary(lines),
    quarterly: buildQuarterlySummary(lines),
    orders: lines
  };
}

function getOrderCodes(order) {
  const codes = [];

  if (order.discountCode) {
    codes.push(order.discountCode);
  }

  if (Array.isArray(order.discountCodes)) {
    for (const code of order.discountCodes) {
      if (code) codes.push(code);
    }
  }

  return [...new Set(codes)];
}

function buildMonthlySummary(lines) {
  const map = {};

  for (let m = 1; m <= 12; m++) {
    map[m] = {
      month: m,
      month_name: MONTHS[m],
      orders_count: 0,
      net_sales: 0,
      commission: 0
    };
  }

  const uniqueOrders = new Set();

  for (const line of lines) {
    const key = `${line.month}|${line.order}`;

    if (!uniqueOrders.has(key)) {
      uniqueOrders.add(key);
      map[line.month].orders_count += 1;
    }

    map[line.month].net_sales += Number(line.net_sale || 0);
    map[line.month].commission += Number(line.commission || 0);
  }

  return Object.values(map).map((row) => ({
    ...row,
    net_sales: round2(row.net_sales),
    commission: round2(row.commission)
  }));
}

function buildQuarterlySummary(lines) {
  const map = {
    Q1: { quarter: 'Q1', period: 'Jan–Mar', orders_count: 0, net_sales: 0, commission: 0 },
    Q2: { quarter: 'Q2', period: 'Apr–Jun', orders_count: 0, net_sales: 0, commission: 0 },
    Q3: { quarter: 'Q3', period: 'Jul–Sep', orders_count: 0, net_sales: 0, commission: 0 },
    Q4: { quarter: 'Q4', period: 'Oct–Dec', orders_count: 0, net_sales: 0, commission: 0 }
  };

  const uniqueOrders = new Set();

  for (const line of lines) {
    const q = line.quarter;
    if (!map[q]) continue;

    const key = `${q}|${line.order}`;

    if (!uniqueOrders.has(key)) {
      uniqueOrders.add(key);
      map[q].orders_count += 1;
    }

    map[q].net_sales += Number(line.net_sale || 0);
    map[q].commission += Number(line.commission || 0);
  }

  return Object.values(map).map((row) => ({
    ...row,
    net_sales: round2(row.net_sales),
    commission: round2(row.commission)
  }));
}

function buildTotals(lines) {
  const uniqueOrders = new Set();
  let netSales = 0;
  let commission = 0;

  for (const line of lines) {
    uniqueOrders.add(line.order);
    netSales += Number(line.net_sale || 0);
    commission += Number(line.commission || 0);
  }

  return {
    orders_count: uniqueOrders.size,
    line_items_count: lines.length,
    net_sales: round2(netSales),
    commission: round2(commission),
    avg_net_sale: uniqueOrders.size ? round2(netSales / uniqueOrders.size) : 0
  };
}

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function getQuarter(month) {
  if (month >= 1 && month <= 3) return 'Q1';
  if (month >= 4 && month <= 6) return 'Q2';
  if (month >= 7 && month <= 9) return 'Q3';
  if (month >= 10 && month <= 12) return 'Q4';
  return '';
}

function formatShortDate(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function formatGeneratedLabel(date) {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
