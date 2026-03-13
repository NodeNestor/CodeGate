// Remove demo accounts created by seed-demo.mjs

const BASE = process.env.BASE_URL || 'http://localhost:9211';
const fs = await import('fs');

const idsFile = 'scripts/demo-ids.json';
if (!fs.existsSync(idsFile)) {
  console.log('No demo-ids.json found, nothing to clean up.');
  process.exit(0);
}

const ids = JSON.parse(fs.readFileSync(idsFile, 'utf-8'));
for (const id of ids) {
  const resp = await fetch(`${BASE}/api/accounts/${id}`, { method: 'DELETE' });
  console.log(`Deleted ${id}: ${resp.status}`);
}

fs.unlinkSync(idsFile);
console.log(`Cleaned up ${ids.length} demo accounts.`);
