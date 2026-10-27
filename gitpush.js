const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const p = path.join(process.env.TEMP, 'ghcred.json');
const a = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const c = a.find(x => x.user === 'x-access-token') || a[0];
const basic = Buffer.from('x-access-token:' + c.pass).toString('base64');
try {
  const out = execFileSync('git',
    ['-c', 'http.extraheader=AUTHORIZATION: Basic ' + basic, 'push', 'origin', 'main'],
    { cwd: 'C:/Users/ankit/x_panel', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('PUSH OK');
  console.log(out);
} catch (e) {
  console.log('PUSH FAILED');
  console.log(String(e.stdout || '').slice(0, 800));
  console.log(String(e.stderr || '').slice(0, 800));
}
