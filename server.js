const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const USGS_API = 'https://m2m.cr.usgs.gov/api/api/json/stable';

const USGS_USERNAME = process.env.USGS_USERNAME;
const USGS_TOKEN = process.env.USGS_TOKEN;
const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET || 'SatelliteApp2026SecretKey';

let usgsApiKey = null;
let usgsApiKeyExpiry = null;

async function getUsgsApiKey() {
  const now = Date.now();
  if (usgsApiKey && usgsApiKeyExpiry && now < usgsApiKeyExpiry) {
    return usgsApiKey;
  }
  console.log('[USGS] Logging into USGS with token...');
  const response = await fetch(`${USGS_API}/login-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: USGS_USERNAME,
      token: USGS_TOKEN
    })
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('USGS returned non-JSON response: ' + text.substring(0, 200));
  }
  if (data.errorCode) {
    throw new Error(data.errorCode + ': ' + data.errorMessage);
  }
  usgsApiKey = data.data;
  usgsApiKeyExpiry = now + (90 * 60 * 1000); // 90 minutes
  console.log('[USGS] Got new API key successfully');
  return usgsApiKey;
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SatelliteApp Proxy',
    usgsUser: USGS_USERNAME ? 'configured' : 'MISSING',
    usgsToken: USGS_TOKEN ? 'configured' : 'MISSING',
    appCredentials: APP_USERNAME ? 'configured' : 'MISSING'
  });
});

// App login
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`[LOGIN] ${username} is logging in...`);

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username !== APP_USERNAME || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  try {
    const apiKey = await getUsgsApiKey();
    const token = jwt.sign(
      { username, usgsApiKey: apiKey },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    console.log(`[LOGIN] ✅ ${username} authenticated successfully`);
    res.json({ token, username });
  } catch (err) {
    console.error('[LOGIN] USGS login failed:', err.message);
    res.status(500).json({ error: 'USGS authentication failed: ' + err.message });
  }
});

// Forward USGS requests
app.post('/usgs/:endpoint', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const endpoint = req.params.endpoint;
  console.log(`[USGS] ${decoded.username} → ${endpoint}`);

  try {
    // Always get a fresh valid USGS key
    const apiKey = await getUsgsApiKey();

    const response = await fetch(`${USGS_API}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': apiKey
      },
      body: JSON.stringify(req.body)
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error(`[USGS] Non-JSON response for ${endpoint}:`, text.substring(0, 200));
      return res.status(500).json({ error: 'USGS returned invalid response' });
    }

    if (data.errorCode) {
      console.error(`[USGS] ${endpoint} → errorCode: ${data.errorCode}`);
      // If unauthorized, reset cached key and retry once
      if (data.errorCode === 'UNAUTHORIZED_USER' || data.errorCode === 'AUTH_INVALID') {
        console.log('[USGS] Resetting API key and retrying...');
        usgsApiKey = null;
        usgsApiKeyExpiry = null;
        const newKey = await getUsgsApiKey();
        const retry = await fetch(`${USGS_API}/${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': newKey
          },
          body: JSON.stringify(req.body)
        });
        const retryData = await retry.json();
        console.log(`[USGS] ${endpoint} retry → status ${retry.status}`);
        return res.status(retry.status).json(retryData);
      }
    }

    console.log(`[USGS] ${endpoint} → status ${response.status}`);
    res.status(response.status).json(data);

  } catch (err) {
    console.error(`[USGS] ${endpoint} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SatelliteApp Proxy running on port ${PORT}`);
  console.log(`   USGS user configured: ${!!USGS_USERNAME}`);
  console.log(`   USGS token configured: ${!!USGS_TOKEN}`);
  console.log(`   App credentials configured: ${!!APP_USERNAME}`);
});
