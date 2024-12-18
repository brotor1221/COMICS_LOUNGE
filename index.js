require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
require('@shopify/shopify-api/adapters/node');
const { shopifyApi, ApiVersion } = require('@shopify/shopify-api');
const https = require('https');
const Shopify = require('@shopify/shopify-api').Shopify;
const { RestClient } = require('@shopify/shopify-api/rest/admin/2024-01');

const app = express();
const DEBUG = true;

// Middleware to capture raw body for HMAC verification
app.use('/webhook/orders-create', express.raw({ type: 'application/json' }));

// Debug: Log Environment Variables
console.log('🔍 ENVIRONMENT VARIABLES CHECK:');
['API_KEY', 'API_SECRET_KEY', 'ADMIN_API_ACCESS_TOKEN', 'SHOP_DOMAIN', 'HOST_NAME'].forEach((key) => {
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

// Simple delay function
const delay = (ms) => new Promise((resolve, reject) => {
  console.log(`Starting ${ms}ms delay...`);
  const timeout = setTimeout(() => {
    console.log(`${ms}ms delay completed`);
    resolve();
  }, ms);
  
  // Add error handling for the timeout
  timeout.unref();
});

// Function to get order details from REST API
async function getOrderDetails(token) {
  console.log(`🔍 Getting order details for token: ${token}`);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: process.env.SHOP_DOMAIN,
      path: `/admin/api/2024-01/orders.json?status=any&name=${token}`,
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': process.env.ADMIN_API_ACCESS_TOKEN
      }
    };

    console.log('Making REST API request with options:', {
      hostname: options.hostname,
      path: options.path,
      method: options.method
    });

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log('REST API response:', JSON.stringify(response, null, 2));
          if (response.orders && response.orders.length > 0) {
            resolve(response.orders[0]);
          } else {
            reject(new Error('Order not found'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      console.error('REST API request error:', error);
      reject(error);
    });

    req.end();
  });
}

async function updateOrderWithNote(orderId, note) {
  console.log('Starting updateOrderWithNote function...');
  
  // Using the exact format from Shopify's webhook data
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
        console.log('Receiving data chunk:', chunk.toString());
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log('GraphQL Response:', response);
          
          if (response.data?.orderUpdate?.order?.note) {
            console.log('✅ Order note updated successfully to:', response.data.orderUpdate.order.note);
            resolve(response.data.orderUpdate);
          } else {
            console.error('❌ Failed to update order note:', response);
            reject(new Error('Failed to update order note'));
          }
        } catch (error) {
          console.error('❌ Error parsing response:', error);
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      console.error('❌ Request error:', error);
      reject(error);
    });

    const requestBody = JSON.stringify(graphqlQuery);
    console.log('📝 Sending GraphQL mutation for order:', orderId);
    
    req.end(requestBody);  // This combines req.write() and req.end()

    req.write(requestBody, (err) => {
        if (err) {
          console.error('Error writing request:', err);
          reject(err);
          return;
        }
        console.log('Request body written successfully');
        req.end();
      });
  });
}

// Add this helper function to test the API directly
async function testAPI() {
  try {
    const testOrder = {
      id: '6095205400898',  // Use your latest order ID
      note: 'Test note from API'
    };
    
    console.log('Testing API with order:', testOrder);
    const result = await updateOrderWithNote(testOrder.id, testOrder.note);
    console.log('API test result:', result);
  } catch (error) {
    console.error('API test failed:', error);
  }
}

// Add a test endpoint
app.get('/test-api', async (req, res) => {
  await testAPI();
  res.send('API test completed - check logs');
});

// Update the retry operation function
async function retryOperation(operation, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\nAttempt ${attempt} of ${maxAttempts}`);
    try {
      const result = await operation();
      console.log('Operation successful');
      return result;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);
      if (attempt === maxAttempts) {
        throw error;
      }
      console.log('Retrying...');
      // Wait 2 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

app.post('/webhook/orders-create', async (req, res) => {
  console.log('\n🔔 NEW WEBHOOK REQUEST');
  
  // Send immediate response to Shopify
  res.status(200).send('OK');

  try {
    const webhookData = JSON.parse(req.body.toString('utf8'));
    console.log(webhookData);
    // Skip test webhooks
    if (webhookData.test === true) {
      console.log('📝 Skipping test webhook');
      return;
    }

    const orderId = webhookData.id?.toString();
    if (!orderId) {
      console.error('❌ No order ID found in webhook data');
      return;
    }

    console.log('Processing order:', {
      id: orderId,
      order_number: webhookData.order_number,
      financial_status: webhookData.financial_status
    });

    // Keep the process alive for async operation
    const keepAlive = setInterval(() => {
      console.log('Still processing...');
    }, 1000);

    try {
      const note = `Verification Code: A${Math.floor(10000000 + Math.random() * 90000000)}`;
      console.log(`📝 Generated note for order ${orderId}: ${note}`);
      
      await updateOrderWithNote(orderId, note);
      console.log('✅ Order note updated successfully');
    } finally {
      clearInterval(keepAlive);
    }

  } catch (error) {
    console.error('❌ Webhook handler error:', error);
  }
});

// Keep the process alive
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Add health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Export the Express app for Vercel's serverless function handling
module.exports = app;
