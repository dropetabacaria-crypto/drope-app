// Gera os ícones de app LOJISTA e ENTREGADOR no MESMO estilo do ícone da marca
// (camaleão neon no fundo escuro com reflexo). Cliente mantém o ícone atual.
const fs = require('fs');
const sharp = require('sharp');

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('sem OPENAI_API_KEY'); process.exit(1); }

const BASE = 'App icon in the style of a premium neon logo. A cute chibi CHAMELEON mascot glowing with neon light: hot magenta-pink body with lime-green neon stripes and a glowing coiled spiral tail, friendly face. The BACKGROUND IS VERY DARK near-black navy (#0A0A14) with a soft dark radial gradient — absolutely NOT white, NOT light. Cinematic neon glow, and a soft mirror reflection on a dark glossy floor beneath. Filled detailed illustration (NOT line art), centered, square, generous margin around the art, NO text, no letters, no words.';

const ROLES = [
  { key: 'lojista',    extra: 'Next to the chameleon there is a small glowing NEON STOREFRONT with a striped shop awning, same pink and green neon palette, signaling a shop-owner app.' },
  { key: 'entregador', extra: 'The chameleon RIDES a small glossy NEON DELIVERY MOTORCYCLE with a courier delivery box on the back, same pink and green neon palette, dynamic, signaling a courier app.' },
];

async function genOne(role) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: `${BASE} ${role.extra}`, size: '1024x1024', quality: 'high', n: 1 }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`${role.key}: HTTP ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  const b64 = d.data && d.data[0] && d.data[0].b64_json;
  if (!b64) throw new Error(`${role.key}: sem imagem`);
  const buf = Buffer.from(b64, 'base64');
  fs.writeFileSync(`icons/app-${role.key}-1024.png`, buf);
  await sharp(buf).resize(192, 192).png().toFile(`icons/app-${role.key}-192.png`);
  await sharp(buf).resize(512, 512).png().toFile(`icons/app-${role.key}-512.png`);
  await sharp(buf).resize(180, 180).png().toFile(`icons/apple-touch-${role.key}.png`);
  const inner = await sharp(buf).resize(410, 410).png().toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 10, g: 10, b: 20, alpha: 1 } } })
    .composite([{ input: inner, gravity: 'center' }]).png().toFile(`icons/app-${role.key}-maskable-512.png`);
  console.log(`✓ ${role.key} — gerado`);
}

(async () => { for (const role of ROLES) { await genOne(role); } console.log('=== ok ==='); })()
  .catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
