import assert from 'assert/strict';
import fs from 'fs';

const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
assert(server.includes("app.post('/api/ai-review'"));
assert(server.includes('localFallback'));
assert(server.includes('json_schema'));
assert(!server.includes('sk-your-key-here'));
console.log('backend static tests passed');
