// Gera avatares pré-criados (camaleão neon em várias vibes) pro cliente escolher.
const fs = require('fs');
const sharp = require('sharp');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('sem OPENAI_API_KEY'); process.exit(1); }

const BASE = 'Round profile avatar illustration of a cute chibi CHAMELEON mascot, glossy, glowing with neon light, on a very dark near-black background with a soft radial glow, centered, filled detailed illustration (not line art), NO text. Palette:';
const VIBES = [
  { key: 'pink',   c: 'hot magenta-pink body with lime-green neon highlights (the classic brand look)' },
  { key: 'blue',   c: 'electric blue body with cyan neon highlights' },
  { key: 'purple', c: 'vivid purple body with pink neon highlights' },
  { key: 'gold',   c: 'warm orange-gold body with yellow neon highlights' },
  { key: 'teal',   c: 'teal-green body with mint neon highlights' },
];

async function gen(v) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: `${BASE} ${v.c}.`, size: '1024x1024', quality: 'high', n: 1 }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`${v.key}: HTTP ${r.status} ${JSON.stringify(d).slice(0, 160)}`);
  const buf = Buffer.from(d.data[0].b64_json, 'base64');
  fs.mkdirSync('icons/avatars', { recursive: true });
  await sharp(buf).resize(256, 256).png().toFile(`icons/avatars/av-${v.key}.png`);
  console.log(`✓ av-${v.key}`);
}
(async () => { for (const v of VIBES) await gen(v); console.log('=== ok ==='); })()
  .catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
