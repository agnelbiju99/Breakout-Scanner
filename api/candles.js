// Vercel serverless function — Yahoo Finance candle proxy
// /api/candles?sym=RELIANCE&interval=1d&range=3mo

const https = require('https');

// Rotate user agents to avoid rate limiting
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchURL(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=600'); // cache 10 mins

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { sym, interval = '1d', range = '3mo' } = req.query;
  if (!sym) return res.status(400).json({ error: 'sym required' });

  // Sanitize symbol
  const cleanSym = sym.replace(/[^A-Z0-9\-\^&\.]/gi, '').toUpperCase();
  const yfSym = cleanSym.startsWith('^') || cleanSym.includes('.')
    ? cleanSym
    : `${cleanSym}.NS`;

  // Validate params
  const validIntervals = ['1m','2m','5m','15m','30m','60m','90m','1h','1d','5d','1wk','1mo','3mo'];
  const validRanges    = ['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max'];
  const safeInterval   = validIntervals.includes(interval) ? interval : '1d';
  const safeRange      = validRanges.includes(range) ? range : '3mo';

  // Try query1 then query2, with retry on 429
  const hosts = ['query1', 'query2'];
  const buildUrl = (host) =>
    `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${safeInterval}&range=${safeRange}&includePrePost=false&events=div%2Csplits`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const host = hosts[attempt % 2];
    const url = buildUrl(host);
    try {
      const result = await fetchURL(url);
      if (result.status === 200) {
        return res.status(200).send(result.body);
      }
      if (result.status === 429) {
        // Rate limited — wait and retry
        await sleep(300 * (attempt + 1));
        continue;
      }
      if (result.status === 404) {
        return res.status(404).json({ error: `Symbol not found: ${yfSym}` });
      }
      // Other error — try next
      await sleep(200);
    } catch(e) {
      if (attempt < 3) { await sleep(300); continue; }
    }
  }

  return res.status(500).json({ error: `Failed after 4 attempts for ${yfSym}` });
};
