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

// SERVER-SIDE PROMISE QUEUE
// All USGS requests are chained one after another - never concurrent
let usgsQueueChain = Promise.resolve();
function queueUsgsRequest(fn) {
  const result = usgsQueueChain.then(() => fn()).catch(err => { throw err; });
  usgsQueueChain = result.catch(() => {});
  return result;
}

// FETCH WITH TIMEOUT - 45 seconds max
function fetchWithTimeout(url, options, ms = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getUsgsApiKey() {
  const now = Date.now();
  if (usgsApiKey && usgsApiKeyExpiry && now < usgsApiKeyExpiry) return usgsApiKey;
  console.log('[USGS] Refreshing API key...');
  const response = await fetchWithTimeout(`${USGS_API}/login-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USGS_USERNAME, token: USGS_TOKEN })
  }, 30000);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error('USGS non-JSON: ' + text.substring(0, 100)); }
  if (data.errorCode) throw new Error(data.errorCode + ': ' + data.errorMessage);
  usgsApiKey = data.data;
  usgsApiKeyExpiry = now + 90 * 60 * 1000;
  console.log('[USGS] API key refreshed, waiting 2s for slot to clear...');
  await sleep(2000); // Let USGS release the login slot before search
  return usgsApiKey;
}

async function getSentinelToken() {
  if (!SENTINEL_CLIENT_ID || !SENTINEL_CLIENT_SECRET) throw new Error('Sentinel Hub credentials not configured');
  const now = Date.now();
  if (sentinelToken && sentinelTokenExpiry && now < sentinelTokenExpiry) return sentinelToken;
  const params = new URLSearchParams({ grant_type: 'client_credentials', client_id: SENTINEL_CLIENT_ID, client_secret: SENTINEL_CLIENT_SECRET });
  const res = await fetch('https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Sentinel Hub auth failed: ' + JSON.stringify(data));
  sentinelToken = data.access_token;
  sentinelTokenExpiry = now + (data.expires_in - 60) * 1000;
  console.log('[SENTINEL] Token obtained');
  return sentinelToken;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SatelliteApp Proxy', usgsConfigured: !!(USGS_USERNAME && USGS_TOKEN), sentinelHub: !!(SENTINEL_CLIENT_ID && SENTINEL_CLIENT_SECRET), queueEnabled: true });
});

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.trim() !== APP_USERNAME.trim() || password.trim() !== APP_PASSWORD.trim()) return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '8h' });
  console.log(`[LOGIN] ${username} authenticated`);
  res.json({ token, username });
});

// FULLY FIXED USGS PROXY
app.post('/usgs/:endpoint', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
  catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const endpoint = req.params.endpoint;
  console.log(`[USGS] ${decoded.username} -> ${endpoint} (queued)`);

  try {
    const data = await queueUsgsRequest(async () => {
      const apiKey = await getUsgsApiKey();

      const makeReq = (key) => fetchWithTimeout(`${USGS_API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': key },
        body: JSON.stringify(req.body)
      }, 45000);

      let response = await makeReq(apiKey);
      let result;
      try { result = JSON.parse(await response.text()); }
      catch(e) { throw new Error('USGS invalid JSON response'); }

      // CONCURRENT fix: wait 6 seconds then retry
      if (result.errorCode === 'CONCURRENT_REQUEST_LIMIT' ||
          (result.errorMessage || '').toLowerCase().includes('multiple requests')) {
        console.log('[USGS] CONCURRENT_REQUEST_LIMIT -> waiting 6s then retrying...');
        await sleep(6000);
        response = await makeReq(apiKey);
        try { result = JSON.parse(await response.text()); }
        catch(e) { throw new Error('USGS invalid JSON on retry'); }
        console.log('[USGS] Retry done, errorCode:', result.errorCode || 'none');
      }

      // Auth expired fix: refresh key then retry
      if (result.errorCode === 'UNAUTHORIZED_USER' || result.errorCode === 'AUTH_INVALID') {
        console.log('[USGS] Auth expired -> refreshing...');
        usgsApiKey = null; usgsApiKeyExpiry = null;
        const newKey = await getUsgsApiKey();
        response = await makeReq(newKey);
        try { result = JSON.parse(await response.text()); }
        catch(e) { throw new Error('USGS invalid JSON after auth refresh'); }
      }

      console.log(`[USGS] ${endpoint} complete, error: ${result.errorCode || 'none'}`);
      return result;
    });

    res.json(data);
  } catch(err) {
    console.error(`[USGS] Error:`, err.message);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'USGS request timed out. Please try again in 30 seconds.' });
    res.status(500).json({ error: err.message });
  }
});

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
  const evalscript = Buffer.from(`//VERSION=3\nfunction setup(){return{input:["B02","B03","B04","B08","B11"],output:{bands:3}}}\nfunction evaluatePixel(s){let B02=s.B02,B03=s.B03,B04=s.B04,B08=s.B08,B11=s.B11;${script}}`).toString('base64');
  try {
    const token = await getSentinelToken();
    const payload = {
      input: { bounds: { bbox: [bbox.lon1,bbox.lat1,bbox.lon2,bbox.lat2], properties:{crs:'http://www.opengis.net/def/crs/EPSG/0/4326'} }, data:[{type:'sentinel-2-l2a',dataFilter:{timeRange:{from:date+'T00:00:00Z',to:date+'T23:59:59Z'},maxCloudCoverage:30}}] },
      output: { width, height, responses:[{identifier:'default',format:{type:'image/png'}}] },
      evalscript: `data:text/plain;base64,${evalscript}`
    };
    const imgRes = await fetch('https://services.sentinel-hub.com/api/v1/process', {
      method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(payload)
    });
    if (!imgRes.ok) { const e=await imgRes.text(); return res.status(imgRes.status).json({error:'Sentinel: '+e.substring(0,200)}); }
    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
    res.json({ image: base64, mimeType: 'image/png' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`SatelliteApp Proxy on port ${PORT}`);
  console.log(`USGS queue: ENABLED - no more concurrent errors`);
  console.log(`Sentinel Hub: ${!!(SENTINEL_CLIENT_ID && SENTINEL_CLIENT_SECRET)}`);
});
