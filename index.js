require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');
require('@shopify/shopify-api/adapters/node');
const { shopifyApi, ApiVersion } = require('@shopify/shopify-api');
const https = require('https');

const app = express();
const DEBUG = true;

// Middleware to capture raw body for HMAC verification
app.use('/webhook/orders-create', express.raw({ type: 'application/json' }));

// Debug: Log Environment Variables
console.log('🔍 ENVIRONMENT VARIABLES CHECK:');
['API_KEY', 'API_SECRET_KEY', 'ADMIN_API_ACCESS_TOKEN', 'SHOP_DOMAIN', 'HOST_NAME', 'MONGODB_URI', 'MONGODB_DB_NAME'].forEach((key) => {
  console.log(`${key}:`, process.env[key] ? 'Loaded' : '❌ Missing');
});

// Initialize Shopify API Client
let shopify;

try {
  const missingEnvVars = ['API_KEY', 'API_SECRET_KEY', 'ADMIN_API_ACCESS_TOKEN', 'SHOP_DOMAIN', 'HOST_NAME'].filter(key => !process.env[key]);

  if (missingEnvVars.length > 0) {
    throw new Error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  }

  shopify = shopifyApi({
    apiKey: process.env.API_KEY,
    apiSecretKey: process.env.API_SECRET_KEY,
    scopes: ['write_orders', 'read_orders'],
    hostName: process.env.HOST_NAME,
    apiVersion: ApiVersion.October23,
    isEmbeddedApp: false,
  });

  console.log('✅ Shopify API client initialized successfully.');
} catch (error) {
  console.error('❌ Error initializing Shopify API:', error.message);
}

// MongoDB Connection
let client;
let db;
let codesCollection;

async function connectToMongoDB() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
  }

  try {
    await client.connect();
    db = client.db(process.env.MONGODB_DB_NAME);
    codesCollection = db.collection('codes');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
  }
}

// Ensure MongoDB connection before handling requests
app.use(async (req, res, next) => {
  if (!client || !client.topology || !client.topology.isConnected()) {
    await connectToMongoDB();
  }
  next();
});

function verifyShopifyWebhook(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!hmacHeader || !req.body) {
    console.error('❌ Missing HMAC header or request body');
    return false;
  }

  const bodyStr = req.body.toString('utf8');

  const generatedHash = crypto
    .createHmac('sha256', process.env.API_SECRET_KEY)
    .update(bodyStr)
    .digest('base64');

  console.log('Received HMAC:', hmacHeader);
  console.log('Generated HMAC:', generatedHash);
  console.log('HMAC verification:', hmacHeader === generatedHash ? '✅ Passed' : '❌ Failed');

  return hmacHeader === generatedHash;
}

// Function to determine code prefix based on product ID
function getCodePrefix(productId) {
  switch (productId) {
    case '9805574340930':
      return 'A';
    case '9845248131394':
      return 'B';
    default:
      return null;
  }
}

// Function to generate a unique code
async function generateUniqueCode(prefix) {
  let code;
  let isUnique = false;

  while (!isUnique) {
    code = `${prefix}${Math.floor(10000000 + Math.random() * 90000000)}`;
    const existingCode = await codesCollection.findOne({ code });
    if (!existingCode) {
      isUnique = true;
    }
  }

  return code;
}

// Function to update order with a note
async function updateOrderWithNote(orderId, note) {
  const graphqlQuery = {
    query: `mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order {
          id
          note
        }
        userErrors {
          field
          message
        }
      }
    }`,
    variables: {
      input: {
        id: `gid://shopify/Order/${orderId}`,
        note: note
      }
    }
  };

  const options = {
    hostname: process.env.SHOP_DOMAIN,
    path: '/admin/api/2024-01/graphql.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.ADMIN_API_ACCESS_TOKEN
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.data?.orderUpdate?.order?.note) {
            resolve(response.data.orderUpdate);
          } else {
            reject(new Error('Failed to update order note'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(JSON.stringify(graphqlQuery));
    req.end();
  });
}

// Function to send code to Comics Lounge API
async function sendCodeToComicsLounge(code) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      "membership_code": code
    });

    const options = {
      hostname: 'thecomicslounge.com.au',
      path: '/cs2/api/membership/save_membership_coupon.php',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          console.log(`✅ Code ${code} sent to Comics Lounge API`);
          resolve(data);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      console.error(`❌ Error sending code to Comics Lounge API:`, error);
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

// Function to process the order
async function processOrder(orderId, webhookData) {
  try {
    const hasValidProduct = webhookData.line_items?.some(item => 
      ['9805574340930', '9845248131394'].includes(item.product_id.toString())
    );

    if (!hasValidProduct) {
      console.log(`⏭️ Skipping order ${orderId}: No matching product IDs`);
      return;
    }

    const matchingItem = webhookData.line_items.find(item => 
      ['9805574340930', '9845248131394'].includes(item.product_id.toString())
    );

    const prefix = getCodePrefix(matchingItem.product_id.toString());
    const code = await generateUniqueCode(prefix);
    
    // Send code to Comics Lounge API
    await sendCodeToComicsLounge(code);
    
    // Store in MongoDB and update order note
    await codesCollection.insertOne({ orderId, code });
    const note = `Verification Code: ${code}`;
    await updateOrderWithNote(orderId, note);
    console.log(`✅ Processed order ${orderId} with code ${code}`);
  } catch (error) {
    console.error(`❌ Error processing order ${orderId}:`, error);
  }
}

// Webhook handler for order creation
app.post('/webhook/orders-create', async (req, res) => {
  console.log('\n🔔 NEW WEBHOOK REQUEST');

  try {
    const webhookData = JSON.parse(req.body.toString('utf8'));
    const orderId = webhookData.id?.toString();

    if (!orderId) {
      console.error('❌ No order ID found in webhook data');
      res.status(400).send('No order ID found');
      return;
    }

    await processOrder(orderId, webhookData);
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Webhook handler error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
