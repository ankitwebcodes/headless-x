const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const p = path.join(process.env.TEMP, 'ghcred.json');
const a = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const c = a.find(x => x.user === 'x-access-token') || a[0];
const credFile = 'C:/Users/ankit/x_panel/.git/.git-credentials';
fs.writeFileSync(credFile, 'https://x-access-token:' + c.pass + '@github.com\n');
const run = (args) => execFileSync('git', args, { cwd: 'C:/Users/ankit/x_panel', encoding: 'utf8' });
// reset inherited helpers (GCM) for THIS repo, then use a file-backed store
run(['config', '--local', '--replace-all', 'credential.helper', '']);
run(['config', '--local', '--add', 'credential.helper', 'store --file=' + credFile]);
console.log('configured ' + credFile);
