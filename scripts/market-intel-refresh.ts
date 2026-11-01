import { execSync } from 'child_process';

const ENDPOINTS = [
  '/api/market/regime',
  '/api/market/breadth',
  '/api/market/heatmap',
  '/api/fii-dii',
  '/api/option-chain?symbol=NIFTY',
  '/api/option-chain?symbol=BANKNIFTY',
];

const BASE = process.env.APP_BASE || 'http://localhost:3000';

async function refresh() {
  const now = new Date();
  const istHour = (() => {
    const utc = now.getTime() + now.getTimezoneOffset()*60000;
    return new Date(utc + 5.5*3600000).getUTCHours();
  })();
  if (istHour < 9 || istHour >= 16) {
    console.log('Outside market hours, skip');
    return;
  }
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(`${BASE}${ep}`, { cache: 'no-store' });
      console.log(`${ep} → ${res.status}`);
    } catch(e) {
      console.error(`Failed ${ep}`, e);
    }
  }
}

refresh();
