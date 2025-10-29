# AI Agent Instructions for shopify-sku-sync

This document provides key context for AI agents working in the shopify-sku-sync codebase.

## Project Overview

shopify-sku-sync is a Node.js application that maintains inventory consistency across Shopify product variants sharing the same SKU. When inventory changes for one variant, the app automatically syncs all other variants with the same SKU. It also handles inventory adjustments during order creation and cancellation/return events.

## Core Architecture

The application is built around three main webhooks that handle different inventory scenarios:

1. `/webhooks/inventory_levels/update` - Handles manual inventory adjustments
2. `/webhooks/orders/create` - Decrements inventory when orders are placed
3. `/webhooks/orders/cancelled` - Restores inventory on order cancellation/return

### Key Components & Patterns

- **Webhook Processing Flow** (`index.js`):
  1. HMAC verification using `WEBHOOK_SECRET`
  2. SKU lookup from inventory item
  3. Find all variants with matching SKU
  4. Bulk update inventory levels via GraphQL API

- **Loop Prevention** (`recentSyncs` Map):
  ```javascript
  const syncKey = `${sku}-${location_id}`;
  // Syncs are tracked for 10 seconds to prevent feedback loops
  const SYNC_TIMEOUT = 10000;
  ```

- **Concurrent Order Processing** (`processingOrders` Set):
  ```javascript
  // Track orders being processed to prevent duplicate processing
  const processingOrders = new Set();
  ```

## Development Workflow

### Environment Setup

Required environment variables (in `.env`):
```env
SHOPIFY_SHOP=your-store.myshopify.com
SHOPIFY_ADMIN_API_ACCESS_TOKEN=your_admin_api_token
WEBHOOK_SECRET=your_webhook_secret
PORT=3000 # Optional
```

### Running Locally

```bash
npm install
npm start
```

## Integration Points

### Shopify GraphQL API

- Uses Admin API for inventory operations
- Key mutations:
  - `inventorySetOnHandQuantities` - For direct inventory updates
  - `inventoryAdjustQuantities` - For order-related adjustments
- Required API scopes: `read_inventory`, `write_inventory`, `read_products`, `read_locations`, `read_orders`

### Error Handling Patterns

The codebase follows these error handling conventions:
- Webhook verification failures → 401
- Invalid payloads → 400
- Processing errors → 500 with logging
- Always respond to webhooks, even on errors

### Cross-Component Communication

- All inventory updates go through GraphQL API
- Webhooks must complete within Shopify's 10-second timeout
- Order processing uses a distributed lock pattern via `processingOrders` Set

## Common Development Tasks

### Adding New Webhook Types

1. Create route in `index.js`
2. Add HMAC verification
3. Extract SKU information
4. Implement loop prevention
5. Update inventory via GraphQL

### Debugging Tips

- Check webhook verification by comparing HMAC signatures
- Monitor `recentSyncs` Map for loop prevention
- Review GraphQL error responses in logs
- Verify webhook payload structure against Shopify's schema