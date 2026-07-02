import fs from 'fs';
const server = fs.readFileSync('./server.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const required = [
  "app.post('/analyze'",
  "app.post('/api/ai-review'",
  'normalizeAiForFrontend',
  'trade_read',
  'anomaly_warning',
  'snapshotSummary',
  'v64-frontend-compatible'
];
const missing = required.filter(s => !server.includes(s));
if (missing.length) {
  console.error('Missing required server strings:', missing);
  process.exit(1);
}
if (!pkg.scripts?.start || !pkg.scripts?.test) {
  console.error('package.json scripts missing');
  process.exit(1);
}
console.log('v64 backend static tests passed');
