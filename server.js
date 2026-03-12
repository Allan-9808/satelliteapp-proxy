const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const USGS_API = 'https://m2m.cr.usgs.gov/api/api/json/stable';
const USGS_USERNAME = process.env.USGS_USERNAME;
const USGS_TOKEN = process.env.USGS_TOKEN;
const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET || 'SatelliteApp2026SecretKey';
const SENTINEL_CLIENT_ID = process.env.SENTINEL_CLIENT_ID;
const SENTINEL_CLIENT_SECRET = process.env.SENTINEL_CLIENT_SECRET;

let usgsApiKey = null;
let usgsApiKeyExpiry = null;
let sentinelToken = null;
let sentinelTokenExpiry = null;

async function getUsgsApiKey() {
  const now = Date.now();
  if (usgsApiKey && usgsApiKeyExpiry && now < usgsApiKeyExpiry) return usgsApiKey;
  console.log('[USGS] Refreshing API key...');
  const response = await fetch(`${USGS_API}/login-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USGS_USERNAME, token: USGS_TOKEN })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error('USGS non-JSON: ' + text.substring(0, 100)); }
  if (data.errorCode) throw new Error(data.errorCode + ': ' + data.errorMessage);
  usgsApiKey = data.data;
  usgsApiKeyExpiry = now + 90 * 60 * 1000;
  console.log('[USGS] API key refreshed ✅');
  return usgsApiKey;
}

async function getSentinelToken() {
  if (!SENTINEL_CLIENT_ID || !SENTINEL_CLIENT_SECRET) throw new Error('Sentinel Hub credentials not configured');
  const now = Date.now();
  if (sentinelToken && sentinelTokenExpiry && now < sentinelTokenExpiry) return sentinelToken;
  console.log('[SENTINEL] Getting OAuth token...');
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SENTINEL_CLIENT_ID,
    client_secret: SENTINEL_CLIENT_SECRET,
  });
  const res = await fetch('https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Sentinel Hub auth failed: ' + JSON.stringify(data));
  sentinelToken = data.access_token;
  sentinelTokenExpiry = now + (data.expires_in - 60) * 1000;
  console.log('[SENTINEL] Token obtained ✅');
  return sentinelToken;
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'SatelliteApp Proxy',
    usgsUser: !!USGS_USERNAME, usgsToken: !!USGS_TOKEN,
    appCredentials: !!APP_USERNAME,
    sentinelHub: !!(SENTINEL_CLIENT_ID && SENTINEL_CLIENT_SECRET)
  });
});

// App login
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  console.log(`[LOGIN] ${username} is logging in...`);
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.trim() !== APP_USERNAME.trim() || password.trim() !== APP_PASSWORD.trim()) {
    console.log(`[LOGIN] Failed for ${username}`);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
  console.log(`[LOGIN] ✅ ${username} authenticated`);
  res.json({ token, username });
});

// USGS proxy
app.post('/usgs/:endpoint', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
  catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const endpoint = req.params.endpoint;
  console.log(`[USGS] ${decoded.username} → ${endpoint}`);

  try {
    const apiKey = await getUsgsApiKey();
    const doRequest = async (key) => fetch(`${USGS_API}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': key },
      body: JSON.stringify(req.body)
    });

    let response = await doRequest(apiKey);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { return res.status(500).json({ error: 'USGS invalid response' }); }

    if (data.errorCode === 'UNAUTHORIZED_USER' || data.errorCode === 'AUTH_INVALID') {
      console.log('[USGS] Auth expired, retrying...');
      usgsApiKey = null; usgsApiKeyExpiry = null;
      const newKey = await getUsgsApiKey();
      response = await doRequest(newKey);
      data = await response.json();
    }
    console.log(`[USGS] ${endpoint} → ${response.status}`);
    res.status(response.status).json(data);
  } catch(err) {
    console.error(`[USGS] ${endpoint} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sentinel Hub — get index map as base64 PNG
app.post('/sentinel/map', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { bbox, date, indexName, width = 512, height = 512 } = req.body;
  if (!bbox || !date || !indexName) return res.status(400).json({ error: 'bbox, date, indexName required' });

  const evalscripts = {
    NDVI:  'return colorBlend((B08-B04)/(B08+B04),[-0.2,0,0.2,0.4,0.6,0.8],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    NDWI:  'return colorBlend((B03-B08)/(B03+B08),[-0.6,-0.3,0,0.2,0.4,0.6],[[0.94,0.97,1],[0.75,0.89,0.97],[0.50,0.74,0.90],[0.22,0.55,0.80],[0.06,0.35,0.67],[0,0.19,0.52]]);',
    NDBI:  'return colorBlend((B11-B08)/(B11+B08),[-0.5,-0.2,0,0.2,0.4,0.6],[[0.13,0.55,0.13],[0.56,0.73,0.56],[0.96,0.96,0.86],[0.85,0.75,0.50],[0.70,0.50,0.20],[0.55,0.25,0.08]]);',
    EVI:   'let evi=2.5*(B08-B04)/(B08+6*B04-7.5*B02+1); return colorBlend(evi,[-0.2,0,0.2,0.4,0.6,0.9],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    SAVI:  'let savi=((B08-B04)/(B08+B04+0.5))*1.5; return colorBlend(savi,[-0.2,0,0.2,0.4,0.6,0.9],[[0.75,0.75,0.75],[0.86,0.86,0.86],[1,1,0.88],[0.56,0.82,0.31],[0.18,0.65,0.18],[0,0.4,0]]);',
    MNDWI: 'return colorBlend((B03-B11)/(B03+B11),[-0.6,-0.3,0,0.2,0.4,0.6],[[0.94,0.97,1],[0.75,0.89,0.97],[0.50,0.74,0.90],[0.22,0.55,0.80],[0.06,0.35,0.67],[0,0.19,0.52]]);',
  };

  const script = evalscripts[indexName] || evalscripts['NDVI'];
  const evalscript = Buffer.from(`//VERSION=3
function setup(){return{input:["B02","B03","B04","B08","B11"],output:{bands:3}}}
function evaluatePixel(s){let B02=s.B02,B03=s.B03,B04=s.B04,B08=s.B08,B11=s.B11;${script}}`).toString('base64');

  try {
    const token = await getSentinelToken();
    const payload = {
      input: {
        bounds: { bbox: [bbox.lon1, bbox.lat1, bbox.lon2, bbox.lat2], properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
        data: [{ type: 'sentinel-2-l2a', dataFilter: { timeRange: { from: date + 'T00:00:00Z', to: date + 'T23:59:59Z' }, maxCloudCoverage: 30 } }]
      },
      output: { width, height, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
      evalscript: `data:text/plain;base64,${evalscript}`
    };
    const imgRes = await fetch('https://services.sentinel-hub.com/api/v1/process', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!imgRes.ok) {
      const errText = await imgRes.text();
      return res.status(imgRes.status).json({ error: 'Sentinel Hub error: ' + errText.substring(0, 200) });
    }
    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    console.log(`[SENTINEL] Map for ${indexName} generated ✅`);
    res.json({ image: base64, mimeType: 'image/png' });
  } catch(err) {
    console.error('[SENTINEL] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SatelliteApp Proxy running on port ${PORT}`);
  console.log(`   USGS configured: ${!!(USGS_USERNAME && USGS_TOKEN)}`);
  console.log(`   App credentials: ${!!APP_USERNAME}`);
  console.log(`   Sentinel Hub: ${!!(SENTINEL_CLIENT_ID && SENTINEL_CLIENT_SECRET)}`);
});
