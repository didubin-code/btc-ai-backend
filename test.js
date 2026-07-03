import fs from 'fs';
const server = fs.readFileSync('./server.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const required = [
  "app.post('/analyze'",
  "app.post('/api/ai-review'",
  'computeRawIndependentModel',
  'independentPolicy',
  'AI_ACT_ENGINE_CONSERVATIVE',
  'OPPOSITE_DIRECTION_STAND_DOWN',
  'DO_NOT_CHASE',
  'expected_value',
  'v73.2-ai-watchdog',
  'LIVE_SOFT',
  'CONSENSUS_FALLBACK',
  'SERIES_FALLBACK'
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
console.log('v73.2 data guard backend static tests passed');
