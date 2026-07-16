// Vercel serverless function — NSE India data proxy
// NSE doesn't block server-side requests like Yahoo Finance does
// /api/candles?sym=RELIANCE&interval=1d&range=3mo

const https = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchURL(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nseindia.com/',
        'Connection': 'keep-alive',
        ...headers,
      },
      timeout: 12000,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Get NSE cookies first (required for API access)
async function getNSECookies() {
  try {
    const res = await fetchURL('https://www.nseindia.com/');
    const cookies = res.headers['set-cookie'];
    if (!cookies) return '';
    return cookies.map(c => c.split(';')[0]).join('; ');
  } catch(e) { return ''; }
}

// Fetch historical data from NSE
async function fetchNSEHistory(sym, range) {
  // Calculate date range
  const to = new Date();
  const from = new Date();
  const days = range === '1mo' ? 30 : range === '3mo' ? 90 : range === '6mo' ? 180 : range === '1y' ? 365 : 90;
  from.setDate(from.getDate() - days);
  const fmt = d => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;

  const cookies = await getNSECookies();
  const url = `https://www.nseindia.com/api/historical/cm/equity?symbol=${encodeURIComponent(sym)}&series=[%22EQ%22]&from=${fmt(from)}&to=${fmt(to)}&csv=false`;

  const result = await fetchURL(url, { Cookie: cookies });
  if (result.status !== 200) return null;

  const data = JSON.parse(result.body);
  const rows = data?.data;
  if (!rows || !rows.length) return null;

  // Convert NSE format to Yahoo Finance chart format for compatibility
  // NSE returns newest first — reverse to oldest first
  const sorted = [...rows].reverse();
  const timestamps = sorted.map(r => Math.floor(new Date(r.CH_TIMESTAMP).getTime() / 1000));
  const opens   = sorted.map(r => parseFloat(r.CH_OPENING_PRICE));
  const highs   = sorted.map(r => parseFloat(r.CH_TRADE_HIGH_PRICE));
  const lows    = sorted.map(r => parseFloat(r.CH_TRADE_LOW_PRICE));
  const closes  = sorted.map(r => parseFloat(r.CH_CLOSING_PRICE));
  const volumes = sorted.map(r => parseInt(r.CH_TOT_TRADED_QTY));

  return {
    chart: {
      result: [{
        timestamp: timestamps,
        indicators: {
          quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }]
        }
      }]
    }
  };
}

// Fetch Nifty 50 index from NSE
async function fetchNiftyIndex() {
  const cookies = await getNSECookies();
  const url = 'https://www.nseindia.com/api/allIndices';
  const result = await fetchURL(url, { Cookie: cookies });
  if (result.status !== 200) return null;
  const data = JSON.parse(result.body);
  const nifty = data?.data?.find(i => i.index === 'NIFTY 50');
  if (!nifty) return null;
  return {
    chart: {
      result: [{
        meta: { regularMarketPrice: nifty.last, previousClose: nifty.previousClose },
        timestamp: [Date.now()/1000],
        indicators: { quote: [{ close: [nifty.last], open: [nifty.previousClose], high: [nifty.last], low: [nifty.last], volume: [0] }] }
      }]
    }
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { sym, interval = '1d', range = '3mo' } = req.query;
  if (!sym) return res.status(400).json({ error: 'sym required' });

  const cleanSym = sym.replace(/[^A-Z0-9\-\^&]/gi, '').toUpperCase();

  // Handle Nifty index separately
  if (cleanSym === '^NSEI' || cleanSym === 'NIFTY') {
    try {
      const data = await fetchNiftyIndex();
      if (data) return res.status(200).json(data);
    } catch(e) {}
    return res.status(500).json({ error: 'Failed to fetch Nifty index' });
  }

  // Fetch stock data with retry
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetchNSEHistory(cleanSym, range);
      if (data) return res.status(200).json(data);
      if (attempt < 3) await sleep(500 * attempt);
    } catch(e) {
      if (attempt < 3) await sleep(500 * attempt);
      else return res.status(500).json({ error: e.message });
    }
  }

  return res.status(500).json({ error: `No data found for ${cleanSym}` });
};
