require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const getRawBody = require('raw-body');

const app = express();

// Improved raw body capture with size limits
app.use((req, res, next) => {
  // Skip if not a webhook endpoint
  if (!req.path.startsWith('/webhooks')) {
    return next();
  }
  
  getRawBody(req, {
    length: req.headers['content-length'],
    limit: '1mb' // Add size limit to prevent memory issues
  })
    .then(buf => {
      req.rawBody = buf;
      try {
        req.body = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        req.body = {};
      }
      next();
    })
    .catch(err => {
      console.error('Raw body parsing error:', err);
      res.status(400).send('Invalid request body');
    });
});

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Improved sync tracker with better memory management
class SyncTracker {
  constructor() {
    this.operations = new Map();
    this.processingQueue = new Map();
    this.batchSize = 50;
    this.timeout = 25000; // 25 seconds (under Render's 30s limit)
    this.maxMapSize = 1000; // Prevent unlimited growth
    
    // Periodic cleanup
    setInterval(() => this.cleanup(), 60000); // Clean every minute
  }

  cleanup() {
    const now = Date.now();
    
    // Clean operations map
    for (const [key, value] of this.operations.entries()) {
      if (now - value.timestamp > this.timeout) {
        this.operations.delete(key);
      }
    }
    
    // Clean processing queue
    for (const [sku, timestamp] of this.processingQueue.entries()) {
      if (now - timestamp > this.timeout) {
        this.processingQueue.delete(sku);
      }
    }
    
    // Emergency cleanup if maps get too large
    if (this.operations.size > this.maxMapSize) {
      const entries = Array.from(this.operations.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, Math.floor(this.maxMapSize / 2));
      toDelete.forEach(([key]) => this.operations.delete(key));
    }
  }

  isRecentSync(sku, locationId, quantity) {
    const key = `${sku}:${locationId}:${quantity}`;
    const now = Date.now();
    const syncInfo = this.operations.get(key);
    
    if (syncInfo && (now - syncInfo.timestamp) < this.timeout) {
      console.log(`Skipping duplicate sync for SKU ${sku} - Last sync was ${(now - syncInfo.timestamp)/1000}s ago`);
      return true;
    }
    return false;
  }

  async acquireLock(sku, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      if (!this.processingQueue.has(sku)) {
        this.processingQueue.set(sku, Date.now());
        return true;
      }
      
      // Check if existing lock is stale
      const lockTime = this.processingQueue.get(sku);
      if (Date.now() - lockTime > this.timeout) {
        console.log(`Breaking stale lock for SKU ${sku}`);
        this.processingQueue.set(sku, Date.now());
        return true;
      }
      
      if (i < maxRetries - 1) {
        console.log(`SKU ${sku} is locked, retry ${i + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    return false;
  }

  releaseLock(sku) {
    this.processingQueue.delete(sku);
  }

  markSync(sku, locationId, quantity, variantIds) {
    const key = `${sku}:${locationId}:${quantity}`;
    this.operations.set(key, {
      timestamp: Date.now(),
      variantIds: new Set(variantIds)
    });

    // Schedule cleanup
    setTimeout(() => {
      this.operations.delete(key);
    }, this.timeout).unref(); // unref() prevents keeping process alive

    console.log(`Marked sync complete for SKU ${sku} with ${variantIds.length} variants`);
  }
}

const syncTracker = new SyncTracker();

if (!SHOP || !TOKEN || !WEBHOOK_SECRET) {
  console.error(
    'Missing required env variables: SHOPIFY_SHOP, SHOPIFY_ADMIN_API_ACCESS_TOKEN, WEBHOOK_SECRET'
  );
  process.exit(1);
}

const apiBase = `https://${SHOP}/admin/api/${API_VERSION}`;

// Verify webhook with better error handling
function verifyWebhook(req) {
  try {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (!hmacHeader || !req.rawBody) return false;
    
    const generatedHash = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('base64');
    
    return crypto.timingSafeEqual(
      Buffer.from(generatedHash), 
      Buffer.from(hmacHeader)
    );
  } catch (err) {
    console.error('Webhook verification error:', err);
    return false;
  }
}

// Shopify GraphQL helper with retry logic
async function shopifyGraphQL(query, variables = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await axios.post(
        `${apiBase}/graphql.json`,
        { query, variables },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': TOKEN
          },
          timeout: 10000 // 10 second timeout
        }
      );

      if (response.data.errors) {
        // Check for throttling errors
        const throttled = response.data.errors.some(e => 
          e.message?.includes('throttled') || 
          e.extensions?.code === 'THROTTLED'
        );
        
        if (throttled && i < retries) {
          console.log(`GraphQL throttled, retry ${i + 1}/${retries}`);
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
          continue;
        }
        
        console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
        throw new Error('GraphQL query failed');
      }

      return response.data.data;
    } catch (error) {
      if (i === retries) {
        console.error('GraphQL Error after retries:', error.message);
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// Find variants by SKU with error handling
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

  try {
    const data = await shopifyGraphQL(query, { sku: `sku:${normalizedSku}` });
    return data.productVariants.edges.map(e => ({
      id: e.node.id,
      sku: e.node.sku,
      inventory_item_id: e.node.inventoryItem.id
    }));
  } catch (err) {
    console.error(`Failed to find variants for SKU ${sku}:`, err.message);
    return [];
  }
}

// Get inventory item details
async function getInventoryItem(inventory_item_id) {
  const query = `
    query($id: ID!) {
      inventoryItem(id: $id) {
        id
        sku
      }
    }
  `;
  
  try {
    const data = await shopifyGraphQL(query, {
      id: `gid://shopify/InventoryItem/${inventory_item_id}`
    });
    return data.inventoryItem;
  } catch (err) {
    console.error(`Failed to get inventory item ${inventory_item_id}:`, err.message);
    return null;
  }
}

// Main webhook handler with improved error handling
app.post('/webhooks/inventory_levels/update', async (req, res) => {
  const webhookId = crypto.randomUUID();
  const startTime = Date.now();
  let lockAcquired = false;
  let sku = null;
  
  try {
    console.log(`[${webhookId}] Processing webhook at ${new Date().toISOString()}`);

    // Verify webhook
    if (!verifyWebhook(req)) {
      console.warn(`[${webhookId}] Webhook verification failed`);
      return res.status(401).send('Unauthorized');
    }

    const { inventory_item_id, location_id, available } = req.body;
    console.log(`[${webhookId}] Webhook data:`, { inventory_item_id, location_id, available });

    // Validate payload
    if (!inventory_item_id || !location_id || typeof available === 'undefined') {
      return res.status(400).send('Invalid payload');
    }

    // Check if we're approaching timeout
    if (Date.now() - startTime > 20000) {
      console.warn(`[${webhookId}] Approaching timeout, aborting`);
      return res.status(200).send('Timeout prevention');
    }

    // Get SKU
    const inventoryItem = await getInventoryItem(inventory_item_id);
    sku = inventoryItem?.sku;
    
    if (!sku) {
      console.log(`[${webhookId}] No SKU found`);
      return res.status(200).send('No SKU');
    }

    // Check for recent sync
    if (syncTracker.isRecentSync(sku, location_id, available)) {
      return res.status(200).send('Recent sync detected');
    }

    // Acquire lock
    lockAcquired = await syncTracker.acquireLock(sku);
    if (!lockAcquired) {
      console.log(`[${webhookId}] Could not acquire lock for SKU ${sku}`);
      return res.status(200).send('SKU locked');
    }

    // Find variants
    const variants = await findVariantsBySKU(sku);
    console.log(`[${webhookId}] Found ${variants.length} variants for SKU ${sku}`);

    if (variants.length <= 1) {
      return res.status(200).send('No other variants');
    }

    // Build updates (excluding trigger variant)
    const locationGid = `gid://shopify/Location/${location_id}`;
    const updates = variants
      .filter(v => !v.inventory_item_id.endsWith(`/${inventory_item_id}`))
      .slice(0, syncTracker.batchSize) // Limit batch size
      .map(v => ({
        inventoryItemId: v.inventory_item_id,
        locationId: locationGid,
        quantity: available
      }));

    if (updates.length === 0) {
      return res.status(200).send('No updates needed');
    }

    // Check timeout again before mutation
    if (Date.now() - startTime > 22000) {
      console.warn(`[${webhookId}] Timeout before mutation`);
      return res.status(200).send('Timeout prevention');
    }

    // Execute mutation
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

    if (result.inventorySetOnHandQuantities?.userErrors?.length > 0) {
      console.error(`[${webhookId}] Mutation errors:`, 
        result.inventorySetOnHandQuantities.userErrors);
    } else {
      syncTracker.markSync(sku, location_id, available, 
        updates.map(u => u.inventoryItemId));
      console.log(`[${webhookId}] Successfully synced ${updates.length} variants`);
    }

    const duration = Date.now() - startTime;
    console.log(`[${webhookId}] Completed in ${duration}ms`);
    
    return res.status(200).send('OK');

  } catch (err) {
    console.error(`[${webhookId}] Error:`, err.message);
    return res.status(500).send('Error');
  } finally {
    if (lockAcquired && sku) {
      syncTracker.releaseLock(sku);
    }
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    operations: syncTracker.operations.size,
    queue: syncTracker.processingQueue.size
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
});