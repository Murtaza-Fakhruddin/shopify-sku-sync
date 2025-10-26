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
      headers:
        {
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

    // Fetch current inventory for all variants (except the triggering one)
    const getLevelQuery = `
      query($inventoryItemId: ID!, $locationId: ID!) {
        inventoryLevel(inventoryItemId: $inventoryItemId, locationId: $locationId) {
          quantities(first: 1) {
            edges {
              node {
                available
              }
            }
          }
        }
      }
    `;
    
    const locationGid = `gid://shopify/Location/${location_id}`;
    const updates = [];
    
    for (const v of variants) {
      const vId = v.inventory_item_id.split('/').pop();
      if (vId === String(inventory_item_id)) continue;
      
      // Get current available for this variant at this location
      let currentAvailable = null;
      try {
        const data = await shopifyGraphQL(getLevelQuery, { 
          inventoryItemId: v.inventory_item_id,
          locationId: locationGid 
        });
        currentAvailable = data.inventoryLevel?.quantities?.edges?.[0]?.node?.available;
      } catch (e) {
        console.warn(`Could not fetch inventory for ${v.inventory_item_id} at ${location_id}`, e.message);
        continue;
      }
      
      // Only update if the quantities don't match
      if (currentAvailable !== available) {
        updates.push({
          inventoryItemId: v.inventory_item_id,
          locationId: locationGid,
          quantity: available
        });
      }
    }

    if (updates.length === 0) {
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

    const input = { reason: "correction", setQuantities: updates };

    const result = await shopifyGraphQL(mutation, { input });

    if (result.inventorySetOnHandQuantities.userErrors.length > 0) {
      console.error(
        'Bulk set errors:',
        result.inventorySetOnHandQuantities.userErrors
      );
    } else {
      console.log(`Synced ${updates.length} variants for SKU ${sku}`);
    }

    return res.status(200).send('Bulk sync complete');
  } catch (err) {
    console.error('Error in webhook handler', err.response?.data || err.message);
    return res.status(500).send('Internal error');
  }
});

// --- Order webhook handler: sync all matching SKUs on order creation ---
app.post('/webhooks/orders/create', async (req, res) => {
  try {
    if (!verifyWebhook(req)) {
      console.warn('Order webhook verification failed');
      return res.status(401).send('Webhook verification failed');
    }

    const order = req.body;
    if (!order || !order.line_items) {
      return res.status(400).send('Invalid order payload');
    }

    // For each line item, sync all matching SKUs
    for (const item of order.line_items) {
      const sku = item.sku;
      const quantity = item.quantity;
      const location_id = order.location_id || (order.fulfillments && order.fulfillments[0]?.location_id);
      if (!sku || !location_id) continue;

      // Find all variants with this SKU
      const variants = await findVariantsBySKU(sku);
      if (!variants || variants.length <= 1) continue;

      // Get the current available quantity for the triggering item (from Shopify)
      // We'll use the first variant's inventory item id
      const inventory_item_id = variants[0].inventory_item_id.split('/').pop();
      // Optionally, you could fetch the latest available quantity here

      // Build input for GraphQL mutation: reduce quantity for all except the triggering item
      const formattedUpdates = variants.map(v => ({
        inventoryItemId: v.inventory_item_id,
        locationId: `gid://shopify/Location/${location_id}`,
        // This will just decrement by the order quantity
        availableDelta: -Math.abs(quantity)
      }));

      const mutation = `
        mutation adjustQuantities($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            inventoryAdjustmentGroup { createdAt }
            userErrors { field message }
          }
        }
      `;
      const input = { reason: "sale", adjustQuantities: formattedUpdates };
      const result = await shopifyGraphQL(mutation, { input });
      if (result.inventoryAdjustQuantities.userErrors.length > 0) {
        console.error('Order sync errors:', result.inventoryAdjustQuantities.userErrors);
      } else {
        console.log(`Order sync: decremented ${variants.length} variants for SKU ${sku}`);
      }
    }
    return res.status(200).send('Order SKU sync complete');
  } catch (err) {
    console.error('Error in order webhook handler', err.response?.data || err.message);
    return res.status(500).send('Internal error');
  }
});

// --- Order cancellation/return webhook handler: restore inventory for all matching SKUs ---
app.post('/webhooks/orders/cancelled', async (req, res) => {
  try {
    if (!verifyWebhook(req)) {
      console.warn('Order cancelled webhook verification failed');
      return res.status(401).send('Webhook verification failed');
    }

    const order = req.body;
    if (!order || !order.line_items) {
      return res.status(400).send('Invalid order payload');
    }

    // For each line item, restore inventory for all matching SKUs
    for (const item of order.line_items) {
      const sku = item.sku;
      const quantity = item.quantity;
      const location_id = order.location_id || (order.fulfillments && order.fulfillments[0]?.location_id);
      if (!sku || !location_id) continue;

      // Find all variants with this SKU
      const variants = await findVariantsBySKU(sku);
      if (!variants || variants.length <= 1) continue;

      // Build input for GraphQL mutation: increment quantity for all variants
      const formattedUpdates = variants.map(v => ({
        inventoryItemId: v.inventory_item_id,
        locationId: `gid://shopify/Location/${location_id}`,
        availableDelta: Math.abs(quantity)
      }));

      const mutation = `
        mutation adjustQuantities($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            inventoryAdjustmentGroup { createdAt }
            userErrors { field message }
          }
        }
      `;
      const input = { reason: "return_or_cancel", adjustQuantities: formattedUpdates };
      const result = await shopifyGraphQL(mutation, { input });
      if (result.inventoryAdjustQuantities.userErrors.length > 0) {
        console.error('Cancel/return sync errors:', result.inventoryAdjustQuantities.userErrors);
      } else {
        console.log(`Cancel/return sync: incremented ${variants.length} variants for SKU ${sku}`);
      }
    }
    return res.status(200).send('Order cancel/return SKU sync complete');
  } catch (err) {
    console.error('Error in order cancel/return webhook handler', err.response?.data || err.message);
    return res.status(500).send('Internal error');
  }
});

// --- Health endpoint ---
app.get('/', (req, res) =>
  res.send('Shopify SKU inventory sync app running (GraphQL bulk version)')
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
