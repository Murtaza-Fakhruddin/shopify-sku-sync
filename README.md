# Shopify SKU Sync

A Node.js application that automatically synchronizes inventory levels across Shopify product variants sharing the same SKU. When inventory changes for one variant, all other variants with the same SKU are updated to maintain consistency. Now also syncs inventory on order creation and restores inventory on order cancellation/return.

## 🚀 Features

- Automatic inventory synchronization across variants with identical SKUs
- Shopify Webhook integration for real-time inventory updates
- **Order-based inventory sync:** Decrements inventory for all matching SKUs when an order is placed
- **Order cancellation/return sync:** Restores inventory for all matching SKUs when an order is cancelled or returned
- Secure webhook verification using HMAC
- Efficient bulk updates using Shopify's GraphQL API
- Health check endpoint
- Prevents feedback loops by only updating variants with mismatched inventory

## 📋 Prerequisites

- Node.js (LTS version recommended)
- A Shopify store with Admin API access
- Shopify webhooks configured for inventory level updates, order creation, and order cancellation

### Required Shopify API Permissions

When creating your Admin API access token, ensure it has the following permissions:

- `read_inventory`: Required to query inventory items and their SKUs
- `write_inventory`: Required to update inventory levels
- `read_products`: Required to query product variants and their SKUs
- `read_locations`: Required to handle location-based inventory updates
- `read_orders`: Required for order webhooks

## ⚙️ Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
SHOPIFY_SHOP=your-store.myshopify.com
SHOPIFY_ADMIN_API_ACCESS_TOKEN=your_admin_api_token
WEBHOOK_SECRET=your_webhook_secret
SHOPIFY_API_VERSION=2025-07 # Optional, defaults to 2025-07
PORT=3000 # Optional, defaults to 3000
```

## 🛠️ Installation

1. Clone the repository:
    ```bash
    git clone https://github.com/Murtaza-Fakhruddin/shopify-sku-sync.git
    cd shopify-sku-sync
    ```

2. Install dependencies:
    ```bash
    npm install
    ```

3. Set up your environment variables (see above)

4. Start the server:
    ```bash
    npm start
    ```

## 🔧 Configuration

### Shopify Webhook Setup

Set up the following webhooks in your Shopify admin (Settings > Notifications > Webhooks):

- **Inventory Level Update**
  - Event: Inventory Level Update
  - Format: JSON
  - URL: `https://your-domain.com/webhooks/inventory_levels/update`
  - Secret: Same as your `WEBHOOK_SECRET`

- **Order Creation**
  - Event: Order Created
  - Format: JSON
  - URL: `https://your-domain.com/webhooks/orders/create`
  - Secret: Same as your `WEBHOOK_SECRET`

- **Order Cancellation**
  - Event: Order Cancelled
  - Format: JSON
  - URL: `https://your-domain.com/webhooks/orders/cancelled`
  - Secret: Same as your `WEBHOOK_SECRET`

## 🚦 API Endpoints

- `GET /`: Health check endpoint
- `POST /webhooks/inventory_levels/update`: Webhook endpoint for inventory updates
- `POST /webhooks/orders/create`: Webhook endpoint for order creation (decrement inventory)
- `POST /webhooks/orders/cancelled`: Webhook endpoint for order cancellation/return (restore inventory)

## 🔄 How It Works

1. When an inventory level changes, or an order is created/cancelled, Shopify sends a webhook to the application.
2. The app verifies the webhook's authenticity using HMAC.
3. It looks up the SKU(s) involved in the event.
4. Finds all other variants with the same SKU.
5. Updates their inventory levels to match (or adjust) using Shopify's GraphQL API, **only if their inventory is out of sync**.

## 🛡️ Security

- Webhook requests are verified using HMAC authentication.
- Environment variables are used for sensitive data.
- Input validation on webhook payload.

## 📝 Logging

The application logs:
- Webhook receipts
- SKU lookup results
- Number of variants found and updated
- Any errors or failed operations

## ⚠️ Error Handling

- Invalid webhooks return 401
- Missing/invalid payload data returns 400
- Internal errors return 500
- All errors are logged to the console

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## 📄 License

[ISC](https://choosealicense.com/licenses/isc/)

## 📞 Support

For support, please open an issue in the GitHub repository.