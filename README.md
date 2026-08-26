# product-feed

Genera un feed de catálogo por tienda Shopify y lo publica en GitHub Pages.
Sin servidores: una GitHub Action con cron horario corre `feed.mjs` para cada
tienda en paralelo y hace un único deploy a Pages.

## Salida

Por cada tienda, en `https://<owner>.github.io/product-feed/<key>/`:

| key | tienda | dominio | moneda |
|-----|--------|---------|--------|
| `jack-uy` | jack-jones-uy.myshopify.com | jackjones.com.uy | UYU |
| `jack-cl` | jack-jones-ch.myshopify.com | jackjones.cl | CLP |
| `only-uy` | bs-only-uruguay.myshopify.com | only.com.uy | UYU |
| `only-cl` | bs-only-chile.myshopify.com | only.cl | CLP |

- `feed.xml` — RSS 2.0 con namespace `g:` (formato Google Merchant), un `<item>`
  por variante, `g:item_group_id` = id del producto padre. Enriquecido con
  campos extra (`<option>`, `<tags>`, `<quantity>`, `<handle>`, ...) para que un
  asistente de IA tenga la info completa.
- `feed.json` — mismo contenido, estructura producto → variantes, cómodo para RAG/LLM.

Solo productos `status:active`. El stock viene de `inventoryQuantity` (requiere
scope `read_inventory`), clampeado a 0.

## Cómo anda

1. `bulkOperationRunQuery` del Admin API baja el catálogo entero sin paginar.
2. Polling hasta `COMPLETED`, se baja el JSONL (viene plano, variantes
   enlazadas por `__parentId`).
3. Se arma `feed.xml` + `feed.json` en `dist/<key>/`.
4. El job `deploy` junta las 4 tiendas en `_site/` y publica todo junto.

## Correr local

```sh
SHOP=jack-jones-uy.myshopify.com \
SHOPIFY_TOKEN=shpca_xxx \
DOMAIN=jackjones.com.uy \
CURRENCY=UYU \
FEED_TITLE="Jack & Jones Uruguay" \
node feed.mjs
```

Genera `dist/feed.xml` y `dist/feed.json`. Variables opcionales: `API_VERSION`
(default `2026-07`), `OUT` (default `dist/feed.xml`), `OUT_JSON`.

## Secrets requeridos (repo → Settings → Secrets and variables → Actions)

Un Admin API access token por tienda:

- `TOKEN_JACK_UY`
- `TOKEN_JACK_CL`
- `TOKEN_ONLY_UY`
- `TOKEN_ONLY_CL`

## Pages

Settings → Pages → Source = **GitHub Actions**.
