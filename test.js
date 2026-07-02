import fs from 'fs';
const server = fs.readFileSync('./server.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const required = [
  "app.post('/analyze'",
  "app.post('/api/ai-review'",
  'v78-ai-priority-continuous-stream',
  'computeRawIndependentModel',
  'applyEvidenceCalibration',
  'extractCalibrationContext',
  'fetchServerMarket',
  'enrichSnapshotWithServerMarket',
  'validateAiSchema',
  'independentPolicy',
  'AI_ACT_ENGINE_CONSERVATIVE',
  'OPPOSITE_DIRECTION_STAND_DOWN',
  'SERVER_VALIDATED_FALLBACK',
  'openai_degraded_local_ev_fallback',
  'compactSnapshotForOpenAI',
  'callOpenAIJsonWithRetry',
  'lastGoodAiBySession',
  'openai_degraded_recent_ai_hold',
  'aiDataStream'
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
console.log('v78 AI-priority continuous stream backend static tests passed');
