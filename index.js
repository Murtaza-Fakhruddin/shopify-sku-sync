require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

const app = express();

// Use raw body only for Shopify webhook routes
const rawWebhook = express.raw({ type: 'application/json' });

// --- Env/config ---
const SHOP = process.env.SHOPIFY_SHOP; // e.g. mystore.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01'; // set to a tested, available version
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!SHOP || !TOKEN || !WEBHOOK_SECRET) {
  console.error('Missing required env variables: SHOPIFY_SHOP, SHOPIFY_ADMIN_API_ACCESS_TOKEN, WEBHOOK_SECRET');
  process.exit(1);
}

const apiBase = `https://${SHOP}/admin/api/${API_VERSION}`;

// --- HTTP client with keep-alive and timeout ---
const keepAliveAgent = new https.Agent({ keepAlive: true });

async function shopifyGraphQL(query, variables = {}) {
  try {
    const response = await axios.post(
      `${apiBase}/graphql.json`,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': TOKEN
        },
        timeout: 15000,
        httpsAgent: keepAliveAgent,
        decompress: true,
        maxContentLength: 5 * 1024 * 1024
      }
    );

    if (response.data.errors) {
      console.error('GraphQL Top-level Errors:', JSON.stringify(response.data.errors, null, 2));
      throw new Error('GraphQL query failed (top-level errors)');
    }

    return response.data.data;
  } catch (error) {
    const apiErrors = error.response?.data?.errors || error.response?.data || error.message;
    console.error('GraphQL Error:', apiErrors);
    throw error;
  }
}

// --- Verify Shopify HMAC ---
function verifyWebhook(rawBodyBuffer, hmacHeaderBase64) {
  if (!hmacHeaderBase64 || !rawBodyBuffer) return false;
  try {
    const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBodyBuffer).digest();
    const provided = Buffer.from(hmacHeaderBase64, 'base64');
    if (provided.length !== digest.length) return false;
    return crypto.timingSafeEqual(digest, provided);
  } catch (e) {
    console.error('HMAC verification error:', e.message);
    return false;
  }
}

// --- Inventory sync state & locking (in-memory; single-instance safe) ---
const syncTracker = {
  operations: new Map(),
  batchSize: 50,
  timeout: 30000, // 30s anti-loop window
  processingQueue: new Map(),

  isRecentSync(sku, locationId, quantity) {
    const key = `${sku}:${locationId}:${quantity}`;
    const now = Date.now();
    const syncInfo = this.operations.get(key);
    if (syncInfo && (now - syncInfo.timestamp) < this.timeout) {
      console.log(`Skipping duplicate sync for SKU ${sku} - Last sync was ${(now - syncInfo.timestamp) / 1000}s ago`);
      return true;
    }
    return false;
  },

  async acquireLock(sku) {
    if (this.processingQueue.has(sku)) {
      console.log(`SKU ${sku} is already being processed, waiting...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return false;
    }
    this.processingQueue.set(sku, Date.now());
    return true;
  },

  releaseLock(sku) {
    this.processingQueue.delete(sku);
  },

  markSync(sku, locationId, quantity, variantIds) {
    const key = `${sku}:${locationId}:${quantity}`;
    this.operations.set(key, {
      timestamp: Date.now(),
      variantIds: new Set(variantIds)
    });

    setTimeout(() => {
      this.operations.delete(key);
    }, this.timeout);

    console.log(`Marked sync complete for SKU ${sku} with ${variantIds.length} variants`);
  }
};

// --- Helpers ---
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
  const edges = data?.productVariants?.edges || [];
  return edges.map(e => ({
    id: e.node.id,
    sku: e.node.sku,
    inventory_item_id: e.node.inventoryItem.id // This is a GID
  }));
}

async function getInventoryItem(inventory_item_id_numeric) {
  if (!inventory_item_id_numeric) return null;
  const query = `
    query($id: ID!) {
      inventoryItem(id: $id) {
        id
        sku
      }
    }
  `;
  const variables = { id: `gid://shopify/InventoryItem/${inventory_item_id_numeric}` };
  const data = await shopifyGraphQL(query, variables);
  return data?.inventoryItem || null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function setOnHandBatched(updates, reason = 'correction') {
  const mutation = `
    mutation setOnHand($input: InventorySetOnHandQuantitiesInput!) {
      inventorySetOnHandQuantities(input: $input) {
        inventoryAdjustmentGroup { createdAt }
        userErrors { field message }
      }
    }
  `;

  for (const part of chunk(updates, syncTracker.batchSize)) {
    const input = { reason, setQuantities: part };
    const result = await shopifyGraphQL(mutation, { input });
    const errs = result?.inventorySetOnHandQuantities?.userErrors || [];
    if (errs.length) {
      console.error('SetOnHand userErrors:', errs);
    }
  }
}

async function adjustQuantitiesBatched(updates, reason = 'sale') {
  const mutation = `
    mutation adjustQuantities($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup { createdAt }
        userErrors { field message }
      }
    }
  `;

  for (const part of chunk(updates, syncTracker.batchSize)) {
    const input = { reason, adjustQuantities: part };
    const result = await shopifyGraphQL(mutation, { input });
    const errs = result?.inventoryAdjustQuantities?.userErrors || [];
    if (errs.length) {
      console.error('AdjustQuantities userErrors:', errs);
    }
  }
}

// --- Webhook: Inventory Levels Update ---
app.post('/webhooks/inventory_levels/update', rawWebhook, async (req, res) => {
  const webhookId = crypto.randomUUID();
  const topic = req.get('X-Shopify-Topic') || 'inventory_levels/update';
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  // Verify HMAC first
  const verified = verifyWebhook(req.body, hmacHeader);
  if (!verified) {
    console.warn(`[${webhookId}] Webhook verification failed for ${topic}`);
    return res.status(401).send('Webhook verification failed');
  }

  // Parse JSON payload
  let payload = {};
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    console.warn(`[${webhookId}] Failed to parse webhook body JSON:`, e.message);
    return res.status(400).send('Invalid JSON');
  }

  // Ack early to avoid Shopify retries
  res.status(200).send('OK');

  // Process async
  process.nextTick(async () => {
    let lockAcquired = false;
    let sku;

    try {
      const { inventory_item_id, location_id, available } = payload || {};
      console.log(`[${webhookId}] ${topic} payload:`, { inventory_item_id, location_id, available });

      if (!inventory_item_id || !location_id || typeof available === 'undefined') {
        console.warn(`[${webhookId}] Missing required fields`);
        return;
      }

      const inventoryItem = await getInventoryItem(inventory_item_id);
      sku = inventoryItem?.sku;
      if (!sku) {
        console.warn(`[${webhookId}] No SKU found for inventory_item_id ${inventory_item_id}`);
        return;
      }

      if (syncTracker.isRecentSync(sku, location_id, available)) {
        console.log(`[${webhookId}] Skipping - recent sync for ${sku}`);
        return;
      }

      // Acquire lock (retry up to 3 times)
      for (let i = 0; i < 3; i++) {
        lockAcquired = await syncTracker.acquireLock(sku);
        if (lockAcquired) break;
      }
      if (!lockAcquired) {
        console.log(`[${webhookId}] Could not acquire lock for SKU ${sku}`);
        return;
      }

      console.log(`[${webhookId}] Trigger SKU: ${sku}`);

      const variants = await findVariantsBySKU(sku);
      console.log(`[${webhookId}] Found ${variants.length} variants for SKU ${sku}`);

      if (!variants || variants.length <= 1) {
        console.log(`[${webhookId}] No other variants to sync for SKU ${sku}`);
        return;
      }

      const locationGid = `gid://shopify/Location/${location_id}`;
      const updates = variants
        .filter(v => v.inventory_item_id.split('/').pop() !== String(inventory_item_id))
        .map(v => ({
          inventoryItemId: v.inventory_item_id,
          locationId: locationGid,
          quantity: available
        }));

      if (updates.length === 0) {
        console.log(`[${webhookId}] Nothing to update for SKU ${sku}`);
        return;
      }

      await setOnHandBatched(updates, 'correction');

      // Prevent loops for 30s window
      syncTracker.markSync(sku, location_id, available, updates.map(u => u.inventoryItemId));

      console.log(`[${webhookId}] Synced ${updates.length} variants for SKU ${sku}`);
    } catch (err) {
      console.error(`[${webhookId}] Error in inventory_levels/update handler`, err.response?.data || err.message);
    } finally {
      if (lockAcquired && sku) {
        syncTracker.releaseLock(sku);
        console.log(`[${webhookId}] Released lock for SKU ${sku}`);
      }
    }
  });
});

// --- Webhook: Order Created (decrement inventory for all matching SKUs) ---
app.post('/webhooks/orders/create', rawWebhook, async (req, res) => {
  const webhookId = crypto.randomUUID();
  const topic = req.get('X-Shopify-Topic') || 'orders/create';
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  const verified = verifyWebhook(req.body, hmacHeader);
  if (!verified) {
    console.warn(`[${webhookId}] Webhook verification failed for ${topic}`);
    return res.status(401).send('Webhook verification failed');
  }

  let order = {};
  try {
    order = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    console.warn(`[${webhookId}] Failed to parse order webhook JSON:`, e.message);
    return res.status(400).send('Invalid JSON');
  }

  res.status(200).send('OK');

  process.nextTick(async () => {
    try {
      if (!order || !Array.isArray(order.line_items)) {
        console.warn(`[${webhookId}] Invalid order payload`);
        return;
      }

      for (const item of order.line_items) {
        const sku = item?.sku;
        const quantity = item?.quantity;
        const location_id =
          order?.location_id ||
          (Array.isArray(order?.fulfillments) && order.fulfillments[0]?.location_id);

        if (!sku || !location_id || !quantity) {
          continue;
        }

        const variants = await findVariantsBySKU(sku);
        if (!variants || variants.length <= 1) continue;

        const updates = variants.map(v => ({
          inventoryItemId: v.inventory_item_id,
          locationId: `gid://shopify/Location/${location_id}`,
          availableDelta: -Math.abs(quantity)
        }));

        await adjustQuantitiesBatched(updates, 'sale');
        console.log(`[${webhookId}] Order sync: decremented ${variants.length} variants for SKU ${sku}`);
      }
    } catch (err) {
      console.error(`[${webhookId}] Error in orders/create handler`, err.response?.data || err.message);
    }
  });
});

// --- Webhook: Order Cancelled/Returned (restore inventory for all matching SKUs) ---
app.post('/webhooks/orders/cancelled', rawWebhook, async (req, res) => {
  const webhookId = crypto.randomUUID();
  const topic = req.get('X-Shopify-Topic') || 'orders/cancelled';
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');

  const verified = verifyWebhook(req.body, hmacHeader);
  if (!verified) {
    console.warn(`[${webhookId}] Webhook verification failed for ${topic}`);
    return res.status(401).send('Webhook verification failed');
  }

  let order = {};
  try {
    order = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    console.warn(`[${webhookId}] Failed to parse order cancelled webhook JSON:`, e.message);
    return res.status(400).send('Invalid JSON');
  }

  res.status(200).send('OK');

  process.nextTick(async () => {
    try {
      if (!order || !Array.isArray(order.line_items)) {
        console.warn(`[${webhookId}] Invalid order payload`);
        return;
      }

      for (const item of order.line_items) {
        const sku = item?.sku;
        const quantity = item?.quantity;
        const location_id =
          order?.location_id ||
          (Array.isArray(order?.fulfillments) && order.fulfillments[0]?.location_id);

        if (!sku || !location_id || !quantity) {
          continue;
        }

        const variants = await findVariantsBySKU(sku);
        if (!variants || variants.length <= 1) continue;

        const updates = variants.map(v => ({
          inventoryItemId: v.inventory_item_id,
          locationId: `gid://shopify/Location/${location_id}`,
          availableDelta: Math.abs(quantity)
        }));

        await adjustQuantitiesBatched(updates, 'return_or_cancel');
        console.log(`[${webhookId}] Cancel/return sync: incremented ${variants.length} variants for SKU ${sku}`);
      }
    } catch (err) {
      console.error(`[${webhookId}] Error in orders/cancelled handler`, err.response?.data || err.message);
    }
  });
});

// --- Health endpoint ---
app.get('/', (req, res) => res.send('Shopify SKU inventory sync app running (GraphQL bulk version)'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));