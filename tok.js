const fs = require('fs'), path = require('path');
const p = path.join(process.env.TEMP, 'ghcred.json');
const a = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const c = a.find(x => x.user === 'x-access-token') || a[0];
process.stdout.write(String(c.pass));
