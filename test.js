import fs from 'fs';
const required = ['package.json','server.js','README.md','render.yaml','.gitignore'];
for (const f of required) {
  if (!fs.existsSync(f)) throw new Error(`Missing ${f}`);
}
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
if (pkg.scripts.start !== 'node server.js') throw new Error('Bad start script');
if (!pkg.dependencies['openai']) throw new Error('Missing OpenAI SDK');
const server = fs.readFileSync('server.js','utf8');
for (const needle of ['app.get(\'/health\'', 'app.post(\'/analyze\'', 'OPENAI_API_KEY', 'response_format']) {
  if (!server.includes(needle)) throw new Error(`server.js missing ${needle}`);
}
console.log('Backend static tests passed.');
