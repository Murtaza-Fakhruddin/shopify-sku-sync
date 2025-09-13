require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const getRawBody = require('raw-body');

const app = express();

// Capture raw body for HMAC verification
app.use((req, res, next) => {
  getRawBody(req)
    .then(buf => {
      req.rawBody = buf;
      try {
        req.body = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        req.body = {};
      }
      next();
    })
    .catch(err => next(err));
});

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!SHOP || !TOKEN || !WEBHOOK_SECRET) {
  console.error(
    'Missing required env variables: SHOPIFY_SHOP, SHOPIFY_ADMIN_API_ACCESS_TOKEN, WEBHOOK_SECRET'
  );
  process.exit(1);
}

const apiBase = `https://${SHOP}/admin/api/${API_VERSION}`;

// --- Verify webhook ---
function verifyWebhook(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) return false;
  const generatedHash = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
}

// --- Shopify GraphQL helper ---
async function shopifyGraphQL(query, variables = {}) {
  const res = await axios.post(
    `${apiBase}/graphql.json`,
    { query, variables },
    {
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );
  if (res.data.errors) {
    console.error('GraphQL errors:', res.data.errors);
    throw new Error('GraphQL query failed');
  }
  return res.data.data;
}

// --- Find variants by SKU ---
async function findVariantsBySKU(sku) {
  if (!sku) return [];
  const normalizedSku = String(sku).trim();

  const query = `
    query($sku: String!) {
      productVariants(first: 100, query: $sku) {
        edges {
          node {
            id
            sku
            inventoryItem {
              id
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { sku: `sku:${normalizedSku}` });

  return data.productVariants.edges.map(e => ({
    id: e.node.id,
    sku: e.node.sku,
    inventory_item_id: e.node.inventoryItem.id
  }));
}

// --- Get inventory item details (for SKU lookup) ---
async function getInventoryItem(inventory_item_id) {
  const query = `
    query($id: ID!) {
      inventoryItem(id: $id) {
        id
        sku
      }
    }
  `;
  const data = await shopifyGraphQL(query, {
    id: `gid://shopify/InventoryItem/${inventory_item_id}`
  });
  return data.inventoryItem;
}

// --- Webhook handler ---
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  try {
    if (!verifyWebhook(req)) {
      console.warn('Webhook verification failed');
      return res.status(401).send('Webhook verification failed');
    }

    const { inventory_item_id, location_id, available } = req.body;
    console.log('Incoming webhook:', { inventory_item_id, location_id, available });

    if (!inventory_item_id || typeof available === 'undefined') {
      console.warn('Webhook payload missing inventory_item_id or available');
      return res.status(400).send('Bad payload');
    }

    // Get triggering item → extract SKU
    const inventoryItem = await getInventoryItem(inventory_item_id);
    const sku = inventoryItem && inventoryItem.sku;
    if (!sku) {
      console.warn('No SKU found for inventory_item_id', inventory_item_id);
      return res.status(200).send('No SKU; nothing to sync');
    }

    console.log('Trigger SKU:', sku);

    // Find all variants with this SKU
    const variants = await findVariantsBySKU(sku);
    console.log(`Found ${variants.length} variants for SKU ${sku}`);

    if (!variants || variants.length <= 1) {
      return res.status(200).send('No other variants with same SKU');
    }

    // Build input for GraphQL mutation
    const formattedUpdates = variants
      .filter(v => v.inventory_item_id.split('/').pop() !== String(inventory_item_id))
      .map(v => ({
        inventoryItemId: v.inventory_item_id,
        locationId: `gid://shopify/Location/${location_id}`,
        quantity: available
      }));

    if (formattedUpdates.length === 0) {
      return res.status(200).send('Nothing to update');
    }

    const mutation = `
      mutation setOnHand($input: InventorySetOnHandQuantitiesInput!) {
        inventorySetOnHandQuantities(input: $input) {
          inventoryAdjustmentGroup {
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const input = { reason: "correction", setQuantities: formattedUpdates };


    const result = await shopifyGraphQL(mutation, { input });

    if (result.inventorySetOnHandQuantities.userErrors.length > 0) {
      console.error(
        'Bulk set errors:',
        result.inventorySetOnHandQuantities.userErrors
      );
    } else {
      console.log(`Synced ${formattedUpdates.length} variants for SKU ${sku}`);
    }

    return res.status(200).send('Bulk sync complete');
  } catch (err) {
    console.error('Error in webhook handler', err.response?.data || err.message);
    return res.status(500).send('Internal error');
  }
});

// --- Health endpoint ---
app.get('/', (req, res) =>
  res.send('Shopify SKU inventory sync app running (GraphQL bulk version)')
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
