# Shopify SKU Sync

A Node.js application that automatically synchronizes inventory levels across Shopify product variants sharing the same SKU. When inventory changes for one variant, all other variants with the same SKU are updated to maintain consistency.

## 🚀 Features

- Automatic inventory synchronization across variants with identical SKUs
- Shopify Webhook integration for real-time inventory updates
- Secure webhook verification using HMAC
- Efficient bulk updates using Shopify's GraphQL API
- Health check endpoint

## 📋 Prerequisites

- Node.js (LTS version recommended)
- A Shopify store with Admin API access
- Shopify webhook configured for inventory level updates

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
npm test
```

## 🔧 Configuration

### Shopify Webhook Setup

1. In your Shopify admin, go to Settings > Notifications > Webhooks
2. Add a webhook with:
   - Event: Inventory Level Update
   - Format: JSON
   - URL: `https://your-domain.com/webhooks/inventory_levels/update`
   - Secret: Same as your WEBHOOK_SECRET environment variable

## 🚦 API Endpoints

- `GET /`: Health check endpoint
- `POST /webhooks/inventory_levels/update`: Webhook endpoint for inventory updates

## 🔄 How It Works

1. When an inventory level changes, Shopify sends a webhook to the application
2. The app verifies the webhook's authenticity using HMAC
3. It looks up the SKU of the updated inventory item
4. Finds all other variants with the same SKU
5. Updates their inventory levels to match using Shopify's GraphQL API

## 🛡️ Security

- Webhook requests are verified using HMAC authentication
- Environment variables are used for sensitive data
- Input validation on webhook payload

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