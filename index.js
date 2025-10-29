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

// Store recent syncs to prevent loops - using SKU as key
const recentSyncs = new Map();
const SYNC_TIMEOUT = 10000; // 10 seconds
const processingOrders = new Set(); // Track orders being processed

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
  try {
    const response = await axios.post(`${apiBase}/graphql.json`, {
      query,
      variables
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN
      }
    });

    if (response.data.errors) {
      console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
      throw new Error('GraphQL query failed');
    }

    return response.data.data;
  } catch (error) {
    console.error('GraphQL Error:', error.message);
    if (error.response?.data?.errors) {
      console.error('API Errors:', JSON.stringify(error.response.data.errors, null, 2));
    }
    throw error;
  }
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

  return data.productVariants.edges
    .filter(e => e.node.sku === normalizedSku) // Ensure exact SKU match
    .map(e => ({
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
// Add the detectUpdateSource function
function detectUpdateSource(webhookBody) {
  // Check webhook body for signs of order-related updates
  if (webhookBody.order_id || webhookBody.order_transaction_id) {
    return 'order';
  }
  if (webhookBody.refund_id || webhookBody.restock) {
    return 'cancel';
  }
  return 'manual';
}

// Update the shouldSkipSync function
function shouldSkipSync(sku, location_id, source = 'manual') {
  const syncKey = `${sku}-${location_id}`;
  
  if (recentSyncs.has(syncKey)) {
    const syncInfo = recentSyncs.get(syncKey);
    const timeSinceSync = Date.now() - syncInfo.timestamp;
    
    // Only skip if:
    // 1. Recent sync was from a manual update AND current update is also manual
    // 2. Time window hasn't expired
    if (syncInfo.source === 'manual' && source === 'manual' && timeSinceSync < SYNC_TIMEOUT) {
      console.log(`Skipping sync for SKU ${sku} - recent manual sync detected (${timeSinceSync}ms ago)`);
      return true;
    }
  }
  
  return false;
}

// --- Record sync operation ---
function recordSync(sku, location_id, inventory_item_ids, source ) {
  const syncKey = `${sku}-${location_id}`;
  
  recentSyncs.set(syncKey, {
    timestamp: Date.now(),
    sku,
    location_id,
    inventory_item_ids,
    source
  });
  
  // Clean up after timeout
  setTimeout(() => {
    recentSyncs.delete(syncKey);
    console.log(`Cleared sync record for ${syncKey}`);
  }, SYNC_TIMEOUT);
}
// Add this new function after the existing helper functions
function isOrderRelatedUpdate(webhookBody) {
  // Check common order-related fields in the webhook payload
  const orderFields = [
    'order_id',
    'order_name',
    'order_number',
    'order_transaction_id',
    'refund_id',
    'fulfillment_id',
    'restock'
  ];

  // Check if any order-related fields exist
  const hasOrderFields = orderFields.some(field => webhookBody[field]);

  // Also check for order tags or attributes that might indicate order processing
  const tags = webhookBody.tags || [];
  const isOrderTag = tags.some(tag => 
    tag.includes('order') || 
    tag.includes('fulfillment') || 
    tag.includes('restock')
  );

  return hasOrderFields || isOrderTag;
}
// --- Webhook handler for inventory level updates ---
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  try {
    if (!verifyWebhook(req)) {
      console.warn('Webhook verification failed');
      return res.status(401).send('Webhook verification failed');
    }

    const { inventory_item_id, location_id, available } = req.body;
    console.log('Incoming inventory webhook:', { inventory_item_id, location_id, available });
    // Check if this is an order-related update
    if (isOrderRelatedUpdate(req.body)) {
      console.log('Skipping sync - update is order-related');
      return res.status(200).send('Skipped - order-related update');
    }
    if (!inventory_item_id || !location_id || typeof available === 'undefined') {
      console.warn('Webhook payload missing required fields');
      return res.status(400).send('Bad payload');
    }

    // Get triggering item → extract SKU
    const inventoryItem = await getInventoryItem(inventory_item_id);
    const sku = inventoryItem?.sku;
    
    if (!sku) {
      console.warn('No SKU found for inventory_item_id', inventory_item_id);
      return res.status(200).send('No SKU; nothing to sync');
    }

    console.log('Trigger SKU:', sku);

    // Detect the source of the update
    const source = detectUpdateSource(req.body);
    
    // Check if we should skip this sync with detected source
    if (shouldSkipSync(sku, location_id, source)) {
      return res.status(200).send(`Skipped - ${source} update, part of recent sync operation`);
    }

 // Find all variants with this SKU
    const variants = await findVariantsBySKU(sku);
    console.log(`Found ${variants.length} variants for SKU ${sku}`);

    if (!variants || variants.length <= 1) {
      return res.status(200).send('No other variants with same SKU');
    }

    // Filter out the triggering item
    const variantsToUpdate = variants.filter(v => {
      const variantInventoryId = v.inventory_item_id.split('/').pop();
      return variantInventoryId !== String(inventory_item_id);
    });

    if (variantsToUpdate.length === 0) {
      return res.status(200).send('No other variants to update');
    }

   // Update recordSync call to include source
    recordSync(sku, location_id, variantsToUpdate.map(v => v.inventory_item_id), source);

    // Build input for GraphQL mutation
    const locationGid = `gid://shopify/Location/${location_id}`;
    const updates = variantsToUpdate.map(v => ({
      inventoryItemId: v.inventory_item_id,
      locationId: locationGid,
      quantity: available
    }));

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

    const input = { 
      reason: "correction", 
      setQuantities: updates 
    };

    const result = await shopifyGraphQL(mutation, { input });

    if (result.inventorySetOnHandQuantities.userErrors.length > 0) {
      console.error('Bulk set errors:', result.inventorySetOnHandQuantities.userErrors);
      return res.status(500).send('Failed to sync inventory');
    }

    console.log(`Successfully synced ${updates.length} variants for SKU ${sku}`);
    return res.status(200).send('Bulk sync complete');

  } catch (err) {
    console.error('Error in webhook handler:', err.response?.data || err.message);
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

    const orderId = order.id;
    
    // Prevent duplicate processing
    if (processingOrders.has(orderId)) {
      console.log(`Order ${orderId} is already being processed`);
      return res.status(200).send('Order already processing');
    }
    
    processingOrders.add(orderId);
    
    try {
      // Process each line item
      for (const item of order.line_items) {
        const sku = item.sku;
        const quantity = item.quantity;
        
        if (!sku || !quantity) continue;

        // Find the fulfillment location
        let location_id = order.location_id;
        if (!location_id && item.fulfillment_service) {
          // You might need to map fulfillment service to location
          console.log('No location_id found for order item');
          continue;
        }
        
        // Default to primary location if not specified
        if (!location_id) {
          // You should configure your primary location ID
          location_id = process.env.PRIMARY_LOCATION_ID;
          if (!location_id) {
            console.warn('No location_id available for order item');
            continue;
          }
        }

        // Record sync for this SKU to prevent loops
        recordSync(sku, location_id, [], 'order');

        // Find all variants with this SKU
        const variants = await findVariantsBySKU(sku);
        if (!variants || variants.length <= 1) continue;

        // Build input for GraphQL mutation
        const locationGid = `gid://shopify/Location/${location_id}`;
        const adjustments = variants.map(v => ({
          inventoryItemId: v.inventory_item_id,
          locationId: locationGid,
          delta: -Math.abs(quantity) // Negative for order creation
        }));

        const mutation = `
          mutation adjustQuantities($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
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
        
        const input = { 
          reason: "sold", 
          changes: adjustments 
        };
        
        const result = await shopifyGraphQL(mutation, { input });
        
        if (result.inventoryAdjustQuantities?.userErrors?.length > 0) {
          console.error('Order sync errors:', result.inventoryAdjustQuantities.userErrors);
        } else {
          console.log(`Order sync: adjusted ${variants.length} variants for SKU ${sku}`);
        }
      }
    } finally {
      // Remove from processing set after a delay
      setTimeout(() => {
        processingOrders.delete(orderId);
      }, 30000); // 30 seconds
    }

    return res.status(200).send('Order SKU sync complete');
  } catch (err) {
    console.error('Error in order webhook handler:', err.response?.data || err.message);
    return res.status(500).send('Internal error');
  }
});

// --- Order cancellation webhook handler ---
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

    const orderId = order.id;
    
    // Prevent duplicate processing
    const cancelKey = `cancel-${orderId}`;
    if (processingOrders.has(cancelKey)) {
      console.log(`Order cancellation ${orderId} is already being processed`);
      return res.status(200).send('Cancellation already processing');
    }
    
    processingOrders.add(cancelKey);
    
    try {
      for (const item of order.line_items) {
        const sku = item.sku;
        const quantity = item.quantity;
        
        if (!sku || !quantity) continue;

        let location_id = order.location_id || process.env.PRIMARY_LOCATION_ID;
        if (!location_id) {
          console.warn('No location_id available for cancelled order item');
          continue;
        }

        // Record sync to prevent loops
        recordSync(sku, location_id, [], 'cancel');

        // Find all variants with this SKU
        const variants = await findVariantsBySKU(sku);
        if (!variants || variants.length <= 1) continue;

        // Build input for GraphQL mutation
        const locationGid = `gid://shopify/Location/${location_id}`;
        const adjustments = variants.map(v => ({
          inventoryItemId: v.inventory_item_id,
          locationId: locationGid,
          delta: Math.abs(quantity) // Positive for cancellation
        }));

        const mutation = `
          mutation adjustQuantities($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
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
        
        const input = { 
          reason: "restock", 
          changes: adjustments 
        };
        
        const result = await shopifyGraphQL(mutation, { input });
        
        if (result.inventoryAdjustQuantities?.userErrors?.length > 0) {
          console.error('Cancel sync errors:', result.inventoryAdjustQuantities.userErrors);
        } else {
          console.log(`Cancel sync: restored ${variants.length} variants for SKU ${sku}`);
        }
      }
    } finally {
      setTimeout(() => {
        processingOrders.delete(cancelKey);
      }, 30000);
    }

    return res.status(200).send('Order cancellation SKU sync complete');
  } catch (err) {
    console.error('Error in order cancellation handler:', err.response?.data || err.message);
    return res.status(500).send('Internal error');
  }
});

// --- Health endpoint ---
app.get('/', (req, res) =>
  res.send('Shopify SKU inventory sync app running (Fixed version)')
);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));