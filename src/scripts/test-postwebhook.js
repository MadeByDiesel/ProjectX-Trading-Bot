// Plain Node test (no TS, no external deps)
const { execFile } = require('child_process');

const URL   = process.env.URL   || 'http://192.168.4.170:8080/signal?secret=toast';
const LOCAL = process.env.LOCAL || '192.168.4.50';
const CURL  = process.env.CURL  || '/usr/bin/curl';

function hit(action, qty) {
  const payload = { symbol: 'MNQ', action };
  if (action !== 'FLAT') payload.qty = Math.max(1, Number(qty ?? 1));

  const args = [
    '--interface', LOCAL,
    '-sS', '-f', // -f makes curl fail on HTTP >= 400
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(payload),
    URL,
  ];

  return new Promise((resolve, reject) => {
    execFile(CURL, args, { timeout: 3000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim() || stderr.trim());
    });
  });
}

(async () => {
  console.log('Webhook URL:', URL);
  console.log('Local bind :', LOCAL, '\n');

  try {
    console.log('→ FLAT (no qty)');
    console.log('  ', await hit('FLAT'));

    console.log('\n→ BUY qty=1');
    console.log('  ', await hit('BUY', 1));

    console.log('\n→ SELL qty=1');
    console.log('  ', await hit('SELL', 1));

    console.log('\nAll webhook calls succeeded.');
  } catch (e) {
    console.error('\nWebhook test failed:', e.message);
    process.exit(1);
  }
})();