import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Config por env — la matrix del workflow setea SHOP / SHOPIFY_TOKEN /
// DOMAIN / CURRENCY / FEED_TITLE / OUT por tienda.
// ---------------------------------------------------------------------------
const SHOP      = requireEnv('SHOP');            // xxx.myshopify.com
const TOKEN     = requireEnv('SHOPIFY_TOKEN');   // shpca_... / shpat_...
const DOMAIN    = requireEnv('DOMAIN');          // jackjones.com.uy  (sin protocolo, sin barra final)
const CURRENCY  = process.env.CURRENCY || 'USD';
const API       = process.env.API_VERSION || '2026-07';
const OUT       = process.env.OUT || 'dist/feed.xml';
const OUT_JSON  = process.env.OUT_JSON || OUT.replace(/\.xml$/i, '.json');
const TITLE     = process.env.FEED_TITLE || DOMAIN;

const ENDPOINT = `https://${SHOP}/admin/api/${API}/graphql.json`;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// GraphQL con reintentos (429 / 5xx / error de red)
// ---------------------------------------------------------------------------
async function gql(query, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });
    } catch (e) {
      if (attempt >= tries) throw e;
      await sleep(attempt * 2000);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= tries) throw new Error(`HTTP ${res.status} tras ${tries} intentos`);
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep(retryAfter || attempt * 2000);
      continue;
    }

    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Respuesta no-JSON: ${text.slice(0, 500)}`);
    }
    if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
    return json.data;
  }
}

// ---------------------------------------------------------------------------
// 1. Bulk operation
//    - En bulk las conexiones anidadas NO llevan argumentos (variants{edges{node}}).
//    - featuredImage / image son objetos sueltos => vienen inline, no como filas.
//    - tags / options / selectedOptions son listas planas => vienen inline.
// ---------------------------------------------------------------------------
const BULK_QUERY = `
{
  products(query: "status:active") {
    edges {
      node {
        id
        handle
        title
        descriptionHtml
        vendor
        productType
        tags
        updatedAt
        totalInventory
        options { name }
        featuredImage { url }
        variants {
          edges {
            node {
              id
              sku
              title
              price
              compareAtPrice
              availableForSale
              inventoryQuantity
              barcode
              selectedOptions { name value }
              image { url }
            }
          }
        }
      }
    }
  }
}`;

const START = `
mutation {
  bulkOperationRunQuery(query: ${JSON.stringify(BULK_QUERY)}) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const POLL = `{
  currentBulkOperation { id status errorCode objectCount fileSize url }
}`;

async function runBulk() {
  const start = await gql(START);
  const errs = start.bulkOperationRunQuery.userErrors;
  if (errs.length) throw new Error('bulkOperationRunQuery: ' + JSON.stringify(errs, null, 2));

  const MAX_MS = 20 * 60 * 1000;
  const t0 = Date.now();
  console.log(`[${SHOP}] bulk lanzado, esperando...`);

  while (true) {
    await sleep(5000);
    const { currentBulkOperation: op } = await gql(POLL);
    process.stdout.write(`  [${SHOP}] ${op.status} — ${op.objectCount || 0} objetos\r`);

    if (op.status === 'COMPLETED') {
      console.log(`\n[${SHOP}] bulk completo: ${op.objectCount} objetos`);
      if (!op.url) return []; // catálogo vacío
      const jsonl = await (await fetch(op.url)).text();
      return jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(op.status)) {
      throw new Error(`[${SHOP}] bulk ${op.status}: ${op.errorCode}`);
    }
    if (Date.now() - t0 > MAX_MS) {
      throw new Error(`[${SHOP}] bulk timeout tras 20 min (status ${op.status})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Rearmar producto -> variantes (JSONL plano, enlace por __parentId)
// ---------------------------------------------------------------------------
function nest(rows) {
  const products = new Map();
  for (const row of rows) {
    if (String(row.id).startsWith('gid://shopify/Product/')) {
      products.set(row.id, { ...row, variants: [] });
    }
  }
  for (const row of rows) {
    if (String(row.id).startsWith('gid://shopify/ProductVariant/') && products.has(row.__parentId)) {
      products.get(row.__parentId).variants.push(row);
    }
  }
  return [...products.values()];
}

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------
const esc = (s = '') =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decodeEntities = (s = '') =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_, e) => ENTITIES[e.toLowerCase()] ?? ' ');

const plainText = (html = '') =>
  decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);

// monedas sin decimales (CLP, etc.) vs con decimales (UYU, USD...)
const ZERO_DECIMAL = new Set(['CLP', 'JPY', 'KRW', 'ISK', 'VND', 'PYG', 'UGX', 'RWF', 'XOF', 'XAF', 'COP']);
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${ZERO_DECIMAL.has(CURRENCY) ? Math.round(n) : n.toFixed(2)} ${CURRENCY}`;
};

const numId = (gid) => String(gid || '').split('/').pop();

const OPT_NAMES = {
  size: ['size', 'talle', 'talles', 'talla', 'tallas', 'tamaño', 'tamano', 'tamaño/talle'],
  color: ['color', 'colour', 'colores'],
};
const findOpt = (selectedOptions, kind) => {
  const names = OPT_NAMES[kind];
  const hit = (selectedOptions || []).find((o) =>
    names.includes(String(o.name || '').toLowerCase().trim())
  );
  return hit?.value || null;
};

// ---------------------------------------------------------------------------
// GTIN vs MPN
//
// En estas tiendas los dos campos vienen cruzados respecto de lo que significan
// en Shopify: `sku` guarda el EAN-13 (100% de las variantes pasan el checksum)
// y `barcode` guarda el número de estilo de 8 dígitos — el mismo prefijo que el
// handle (`12138115_2795706`), repetido idéntico en todas las variantes del
// producto, así que no puede ser un GTIN.
//
// En vez de invertirlos a mano, se decide por checksum: el valor que valida
// como GTIN va a g:gtin y el otro a g:mpn. Si algún día se corrige el dato en
// Shopify, esto sigue publicando bien sin tocar el código.
// ---------------------------------------------------------------------------
const isGtin = (s) => {
  if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return false;
  const digits = [...s].map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, mult = 3; i >= 0; i--, mult = mult === 3 ? 1 : 3) {
    sum += digits[i] * mult;
  }
  return (10 - (sum % 10)) % 10 === check;
};

function identifiers(v) {
  const barcode = String(v.barcode ?? '').trim();
  const sku = String(v.sku ?? '').trim();
  // Si los dos validan, gana el más largo: un número de estilo de 8 dígitos
  // pasa el checksum 1 de cada 10 veces por pura casualidad, y ahí le estaría
  // ganando al EAN-13 real. Empate -> gana barcode, que es el campo correcto.
  const gtin = [barcode, sku].filter(isGtin).sort((a, b) => b.length - a.length)[0] || null;
  const mpn = (gtin === sku ? barcode : sku) || barcode || null;
  return { gtin, mpn };
}

const priceOf = (v) => {
  const base = Number(v.price);
  const cmp = Number(v.compareAtPrice);
  const onSale = Number.isFinite(cmp) && cmp > base && base > 0;
  return { regular: onSale ? cmp : base, sale: onSale ? base : null, onSale };
};

// ---------------------------------------------------------------------------
// 4. XML (RSS 2.0 + g:)  — un <item> por variante
// ---------------------------------------------------------------------------
function buildXml(products) {
  const items = [];
  const skipped = { noPrice: 0, noImage: 0, noGtin: 0 };
  let variantCount = 0;

  for (const p of products) {
    const pid = numId(p.id);
    const productImg = p.featuredImage?.url || '';

    for (const v of p.variants) {
      const { regular, sale } = priceOf(v);
      const priceStr = money(regular);
      if (!priceStr) { skipped.noPrice++; continue; }
      variantCount++;

      const salePriceStr = sale != null ? money(sale) : null;
      const img = v.image?.url || productImg;
      if (!img) skipped.noImage++;

      const vid = numId(v.id);
      const variantName = v.title && v.title !== 'Default Title' ? v.title : '';
      const fullTitle = variantName ? `${p.title} - ${variantName}` : p.title;
      const url = `https://${DOMAIN}/products/${p.handle}?variant=${vid}`;
      const qty = Math.max(0, v.inventoryQuantity ?? 0);
      const size = findOpt(v.selectedOptions, 'size');
      const color = findOpt(v.selectedOptions, 'color');
      const desc = plainText(p.descriptionHtml);

      const L = [];
      L.push(`    <g:id>${esc(vid)}</g:id>`);
      L.push(`    <g:item_group_id>${esc(pid)}</g:item_group_id>`);
      L.push(`    <g:title>${esc(fullTitle)}</g:title>`);
      if (desc) L.push(`    <g:description>${esc(desc)}</g:description>`);
      L.push(`    <g:link>${esc(url)}</g:link>`);
      if (img) L.push(`    <g:image_link>${esc(img)}</g:image_link>`);
      L.push(`    <g:availability>${v.availableForSale ? 'in stock' : 'out of stock'}</g:availability>`);
      L.push(`    <g:price>${esc(priceStr)}</g:price>`);
      if (salePriceStr) L.push(`    <g:sale_price>${esc(salePriceStr)}</g:sale_price>`);
      if (p.vendor) L.push(`    <g:brand>${esc(p.vendor)}</g:brand>`);
      if (p.productType) L.push(`    <g:product_type>${esc(p.productType)}</g:product_type>`);
      L.push(`    <g:condition>new</g:condition>`);
      const { gtin, mpn } = identifiers(v);
      if (gtin) L.push(`    <g:gtin>${esc(gtin)}</g:gtin>`);
      else skipped.noGtin++;
      if (mpn) L.push(`    <g:mpn>${esc(mpn)}</g:mpn>`);
      if (!gtin && !mpn) L.push(`    <g:identifier_exists>no</g:identifier_exists>`);
      if (size) L.push(`    <g:size>${esc(size)}</g:size>`);
      if (color) L.push(`    <g:color>${esc(color)}</g:color>`);

      // --- extra para el asistente de IA ---
      L.push(`    <product_title>${esc(p.title)}</product_title>`);
      if (variantName) L.push(`    <variant_title>${esc(variantName)}</variant_title>`);
      L.push(`    <handle>${esc(p.handle)}</handle>`);
      if (v.sku) L.push(`    <sku>${esc(v.sku)}</sku>`);
      L.push(`    <quantity>${qty}</quantity>`);
      for (const o of v.selectedOptions || []) {
        L.push(`    <option name="${esc(o.name)}">${esc(o.value)}</option>`);
      }
      if (p.tags?.length) L.push(`    <tags>${esc(p.tags.join(', '))}</tags>`);
      if (p.updatedAt) L.push(`    <updated_at>${esc(p.updatedAt)}</updated_at>`);

      items.push(`  <item>\n${L.join('\n')}\n  </item>`);
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>${esc(TITLE)}</title>
  <link>https://${esc(DOMAIN)}</link>
  <description>Catálogo de productos activos — ${esc(SHOP)}</description>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.join('\n')}
</channel>
</rss>`;

  return { xml, variantCount, skipped };
}

// ---------------------------------------------------------------------------
// 5. JSON (mismo contenido, cómodo para RAG / LLM)
// ---------------------------------------------------------------------------
function buildJson(products) {
  const out = [];
  for (const p of products) {
    const variants = [];
    for (const v of p.variants) {
      const { regular, sale } = priceOf(v);
      if (!(regular > 0)) continue;
      const { gtin, mpn } = identifiers(v);
      variants.push({
        id: numId(v.id),
        sku: v.sku || null,
        gtin,                 // el identificador que valida checksum GTIN
        mpn,                  // el otro (en estas tiendas, el nº de estilo)
        title: v.title && v.title !== 'Default Title' ? v.title : null,
        options: Object.fromEntries((v.selectedOptions || []).map((o) => [o.name, o.value])),
        size: findOpt(v.selectedOptions, 'size'),
        color: findOpt(v.selectedOptions, 'color'),
        price: regular,
        sale_price: sale,
        currency: CURRENCY,
        available: !!v.availableForSale,
        quantity: Math.max(0, v.inventoryQuantity ?? 0),
        image: v.image?.url || p.featuredImage?.url || null,
        url: `https://${DOMAIN}/products/${p.handle}?variant=${numId(v.id)}`,
      });
    }
    if (!variants.length) continue;
    out.push({
      id: numId(p.id),
      title: p.title,
      handle: p.handle,
      description: plainText(p.descriptionHtml) || null,
      brand: p.vendor || null,
      product_type: p.productType || null,
      tags: p.tags || [],
      options: (p.options || []).map((o) => o.name),
      url: `https://${DOMAIN}/products/${p.handle}`,
      image: p.featuredImage?.url || null,
      total_inventory: p.totalInventory ?? null,
      updated_at: p.updatedAt || null,
      variants,
    });
  }
  return {
    store: SHOP,
    domain: DOMAIN,
    currency: CURRENCY,
    generated_at: new Date().toISOString(),
    product_count: out.length,
    products: out,
  };
}

// ---------------------------------------------------------------------------
const rows = await runBulk();
const products = nest(rows);
const { xml, variantCount, skipped } = buildXml(products);
const json = buildJson(products);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, xml, 'utf8');
await writeFile(OUT_JSON, JSON.stringify(json, null, 2), 'utf8');

console.log(`[${SHOP}] OK: ${products.length} productos / ${variantCount} variantes`);
console.log(`[${SHOP}]   -> ${OUT}`);
console.log(`[${SHOP}]   -> ${OUT_JSON}`);
if (skipped.noPrice) console.log(`[${SHOP}]   ! ${skipped.noPrice} variantes sin precio (omitidas)`);
if (skipped.noImage) console.log(`[${SHOP}]   ! ${skipped.noImage} variantes sin imagen (incluidas sin g:image_link)`);
if (skipped.noGtin) console.log(`[${SHOP}]   ! ${skipped.noGtin} variantes sin un GTIN valido (van con g:mpn solo)`);
