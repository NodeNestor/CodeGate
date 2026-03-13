// Seed demo accounts for screenshots
// These use fake API keys — they won't actually work

const BASE = process.env.BASE_URL || 'http://localhost:9211';

const demoAccounts = [
  { name: 'Claude Pro', provider: 'anthropic', auth_type: 'api_key', api_key: 'sk-ant-demo-1234567890abcdef', priority: 10, rate_limit: 60 },
  { name: 'Claude Team', provider: 'anthropic', auth_type: 'api_key', api_key: 'sk-ant-demo-abcdef1234567890', priority: 5, rate_limit: 120 },
  { name: 'GPT-4 Main', provider: 'openai', auth_type: 'api_key', api_key: 'sk-demo-openai-1234567890abcdef', priority: 8, rate_limit: 60 },
  { name: 'DeepSeek Coder', provider: 'deepseek', auth_type: 'api_key', api_key: 'sk-demo-deepseek-abcdef123456', base_url: 'https://api.deepseek.com', priority: 3, rate_limit: 30 },
  { name: 'Gemini Flash', provider: 'gemini', auth_type: 'api_key', api_key: 'AIzaSy-demo-gemini-key-1234567890', priority: 2, rate_limit: 30 },
  { name: 'OpenRouter', provider: 'openrouter', auth_type: 'api_key', api_key: 'sk-or-demo-1234567890abcdef', priority: 1, rate_limit: 60 },
];

const createdIds = [];

async function seed() {
  for (const account of demoAccounts) {
    const resp = await fetch(`${BASE}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account),
    });
    const data = await resp.json();
    if (data.id) {
      createdIds.push(data.id);
      console.log(`Created: ${account.name} (${account.provider}) → ${data.id}`);
    } else {
      console.log(`Failed: ${account.name}`, data);
    }
  }

  // Write IDs to file for cleanup
  const fs = await import('fs');
  fs.writeFileSync('scripts/demo-ids.json', JSON.stringify(createdIds, null, 2));
  console.log(`\nSeeded ${createdIds.length} accounts. IDs saved to scripts/demo-ids.json`);
}

seed().catch(e => { console.error(e); process.exit(1); });
