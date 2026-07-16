// Vercel serverless function — fetches Yahoo Finance candle data
// Deployed at: /api/candles?sym=RELIANCE&interval=1d&range=3mo

const https = require('https');

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { sym, interval = '1d', range = '3mo' } = req.query;
  if (!sym) return res.status(400).json({ error: 'sym required' });

  // Sanitize
  const cleanSym = sym.replace(/[^A-Z0-9\-\^&\.]/gi, '').toUpperCase();
  const yfSym = cleanSym.includes('.') ? cleanSym : `${cleanSym}.NS`;

  const validIntervals = ['1m','5m','15m','30m','60m','1d','1wk','1mo'];
  const validRanges    = ['1d','5d','1mo','3mo','6mo','1y','2y'];
  const safeInterval   = validIntervals.includes(interval) ? interval : '1d';
  const safeRange      = validRanges.includes(range) ? range : '3mo';

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${safeInterval}&range=${safeRange}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${safeInterval}&range=${safeRange}&includePrePost=false`,
  ];

  for (const url of urls) {
    try {
      const result = await fetchURL(url);
      if (result.status === 200) {
        return res.status(200).send(result.body);
      }
    } catch(e) { continue; }
  }

  return res.status(500).json({ error: 'Failed to fetch from Yahoo Finance' });
};
