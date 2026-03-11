// ============================================================
// SatelliteApp Proxy Server v2.0
// Deployed on Render.com (FREE tier)
// ------------------------------------------------------------
// HOW IT WORKS:
// 1. Your mobile app sends username + password to /auth/login
// 2. This server checks them against your env vars
// 3. If correct, it logs into USGS using YOUR stored token
// 4. Returns a session key to the app
// 5. App uses session key for all USGS searches
// ------------------------------------------------------------
// ENVIRONMENT VARIABLES to set on Render:
//   USGS_USERNAME   = your USGS username e.g. Allan_Tester
//   USGS_TOKEN      = your 64-char USGS Application Token
//   APP_USERNAME    = username you want to use in the app
//   APP_PASSWORD    = password you want to use in the app
//   JWT_SECRET      = any long random string e.g. MySecret2026XYZ
// ============================================================

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Read credentials from Render environment variables
const USGS_USERNAME = process.env.USGS_USERNAME;
const USGS_TOKEN    = process.env.USGS_TOKEN;
const APP_USERNAME  = process.env.APP_USERNAME;
const APP_PASSWORD  = process.env.APP_PASSWORD;
const JWT_SECRET    = process.env.JWT_SECRET || 'changeme_please';
const USGS_BASE     = 'https://m2m.cr.usgs.gov/api/api/json/stable';

// ── Health check (visit this URL to confirm server is running) ──
app.get('/', (req, res) => {
  const configured = !!(USGS_USERNAME && USGS_TOKEN && APP_USERNAME && APP_PASSWORD);
  res.json({
    status: '✅ SatelliteApp Proxy v2.0 Running',
    configured,
    hint: configured
      ? 'All environment variables are set ✅'
      : '⚠️ Missing env vars — set USGS_USERNAME, USGS_TOKEN, APP_USERNAME, APP_PASSWORD, JWT_SECRET on Render',
  });
});

// ── App Login ──────────────────────────────────────────────────
// Called by the mobile app when user enters username + password
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};

  // Check server is configured
  if (!USGS_USERNAME || !USGS_TOKEN || !APP_USERNAME || !APP_PASSWORD) {
    return res.status(500).json({
      success: false,
      error: 'Server not configured. Please set environment variables on Render.',
    });
  }

  // Check app credentials
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password are required.' });
  }
  if (username !== APP_USERNAME || password !== APP_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Incorrect username or password.' });
  }

  console.log(`[LOGIN] ${username} is logging in...`);

  // Login to USGS using stored token
  try {
    const usgsRes = await fetch(`${USGS_BASE}/login-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 SatelliteApp/2.0',
      },
      body: JSON.stringify({
        username: USGS_USERNAME,
        token: USGS_TOKEN,
      }),
    });

    const text = await usgsRes.text();
    let usgsData;
    try {
      usgsData = JSON.parse(text);
    } catch (e) {
      console.error('[LOGIN] USGS returned non-JSON:', text.substring(0, 200));
      return res.status(502).json({
        success: false,
        error: 'USGS server returned unexpected response. Check your USGS_TOKEN is correct.',
      });
    }

    if (usgsData.errorCode || !usgsData.data) {
      console.error('[LOGIN] USGS error:', usgsData.errorCode, usgsData.errorMessage);
      return res.status(401).json({
        success: false,
        error: `USGS Error: ${usgsData.errorCode} — ${usgsData.errorMessage}.\n\nCheck your USGS_TOKEN on Render.`,
      });
    }

    console.log(`[LOGIN] ✅ ${username} authenticated successfully`);

    // Create a session JWT containing the USGS API key
    const sessionToken = jwt.sign(
      { username, usgsApiKey: usgsData.data },
      JWT_SECRET,
      { expiresIn: '8h' } // session lasts 8 hours
    );

    res.json({ success: true, token: sessionToken, username });

  } catch (err) {
    console.error('[LOGIN] Network error:', err.message);
    res.status(500).json({
      success: false,
      error: 'Cannot reach USGS servers: ' + err.message,
    });
  }
});

// ── Verify Session Token Middleware ───────────────────────────
const verifyToken = (req, res, next) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ errorCode: 'NOT_LOGGED_IN', errorMessage: 'Please log in first.' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({
      errorCode: 'SESSION_EXPIRED',
      errorMessage: 'Your session has expired. Please log in again.',
    });
  }
};

// ── Proxy USGS Endpoints ───────────────────────────────────────
// Forwards any USGS API call from the app through to USGS
app.post('/usgs/:endpoint', verifyToken, async (req, res) => {
  const endpoint = req.params.endpoint;

  // Inject the USGS API key from the session
  const body = { ...req.body, apiKey: req.user.usgsApiKey };

  console.log(`[USGS] ${req.user.username} → ${endpoint}`);

  try {
    const response = await fetch(`${USGS_BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 SatelliteApp/2.0',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();

    try {
      const data = JSON.parse(text);
      console.log(`[USGS] ${endpoint} → status ${response.status}, errorCode: ${data.errorCode || 'none'}`);
      res.json(data);
    } catch (e) {
      console.error(`[USGS] ${endpoint} returned non-JSON:`, text.substring(0, 300));
      res.status(502).json({
        errorCode: 'PARSE_ERROR',
        errorMessage: 'USGS returned an unexpected response. Try again later.',
      });
    }

  } catch (err) {
    console.error(`[USGS] ${endpoint} network error:`, err.message);
    res.status(500).json({
      errorCode: 'NETWORK_ERROR',
      errorMessage: 'Cannot reach USGS: ' + err.message,
    });
  }
});

// ── Start Server ───────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ SatelliteApp Proxy running on port ${PORT}`);
  console.log(`   USGS user configured: ${!!USGS_USERNAME}`);
  console.log(`   USGS token configured: ${!!USGS_TOKEN}`);
  console.log(`   App credentials configured: ${!!(APP_USERNAME && APP_PASSWORD)}`);
});
