// OSSO 34 — Busca inteligente de referência visual.
// Roda na máquina do Andrade (não no Vercel). Itera produtos com ref_status
// in (none, auto_failed), busca no Google Images via Playwright, ranqueia
// candidatos com Claude Vision (Haiku) usando metadata.device_visual_detailed
// como critério de comparação, faz upload do melhor pro Supabase Storage e
// atualiza reference_image_url + ref_status.
//
// Setup:
//   cd DEPLOY-vercel-v2
//   npm install playwright @anthropic-ai/sdk @supabase/supabase-js sharp dotenv
//   npx playwright install chromium
//
// .env (mesmo dir):
//   SUPABASE_URL=https://mhkrcgoqgecahpfxcfgz.supabase.co
//   SUPABASE_KEY=<service_role_key>            # NÃO a anon — precisa write em Storage + update direto
//   ANTHROPIC_API_KEY=<claude_api_key>
//
// Uso:
//   node tools/busca-referencia.js --limit 5 --dry-run
//   node tools/busca-referencia.js --brand ELFBAR --limit 10
//   node tools/busca-referencia.js                       # default limit 50

try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }

const { chromium }      = require('playwright');
const Anthropic         = require('@anthropic-ai/sdk');
const { createClient }  = require('@supabase/supabase-js');
const sharp             = require('sharp');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
  console.error('FALTA env: SUPABASE_URL, SUPABASE_KEY (service role), ANTHROPIC_API_KEY');
  process.exit(1);
}

const supabase  = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

const args = process.argv.slice(2);
const arg  = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const limitArg     = parseInt(arg('--limit', '50'), 10);
const brandFilter  = arg('--brand', null);
const dryRun       = args.includes('--dry-run');

const MIN_WIDTH               = 300;
const MIN_HEIGHT              = 300;
const MAX_RATIO               = 3;
const CANDIDATES_PER_PRODUCT  = 5;
const DELAY_BETWEEN_SEARCHES  = 2500;
const VISION_MIN_CONFIDENCE   = 0.4;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getProductsPending() {
  let q = supabase
    .from('drope_products')
    .select('id,name,slug,category,reference_image_url,box_photo_url,ref_status,image_status,metadata')
    .in('ref_status', ['none', 'auto_failed'])
    .order('created_at', { ascending: false })
    .limit(limitArg);
  if (brandFilter) q = q.filter('metadata->>brand', 'ilike', `%${brandFilter}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

function buildSearchQuery(p) {
  const m = p.metadata || {};
  const parts = [m.brand, m.model, m.puffs ? `${m.puffs}puffs` : '', 'vape pod device'];
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function searchGoogleImages(page, query) {
  const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 18000 });
  return await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[data-src], img[src]'));
    return imgs
      .map(img => img.getAttribute('data-src') || img.getAttribute('src'))
      .filter(s => s && (s.startsWith('http') || s.startsWith('data:image')))
      .filter(s => !s.includes('google.com/images') && !s.includes('gstatic.com'))
      .slice(0, 15);
  });
}

async function downloadImage(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/*',
        'Referer': 'https://www.google.com/',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

async function validateImage(buffer) {
  try {
    const m = await sharp(buffer).metadata();
    if (m.width < MIN_WIDTH || m.height < MIN_HEIGHT) return false;
    const ratio = Math.max(m.width, m.height) / Math.min(m.width, m.height);
    if (ratio > MAX_RATIO) return false;
    return true;
  } catch { return false; }
}

async function visionRankCandidates(candidates, deviceDescription) {
  const content = [];
  for (let i = 0; i < candidates.length; i++) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: candidates[i].buffer.toString('base64') } });
    content.push({ type: 'text', text: `Candidato ${i + 1}` });
  }
  let prompt = `Voce avalia ${candidates.length} imagens candidatas para FOTO DE REFERENCIA de um pod/vape descartavel.

Foto IDEAL: dispositivo REAL (nao caixa, nao render 3D, nao ilustracao), de frente ou levemente angulado, fundo limpo, sem watermark, alta resolucao, formato/cores/bocal/logo visiveis.
Foto NAO ideal: so a caixa, banner com texto, lifestyle (pessoa usando), render 3D, mockup, produto diferente.`;
  if (deviceDescription && deviceDescription.length > 20) {
    prompt += `\n\nDESCRICAO DO PRODUTO REAL (do Vision na caixa):\n"${deviceDescription}"\nUsa pra checar se o dispositivo na foto BATE.`;
  }
  prompt += `\n\nResponde SO JSON:\n{ "ranking": [ { "candidato": 1, "score": 0.0-1.0, "motivo": "breve" } ], "melhor": numero (1-indexed) ou null, "confianca": 0.0-1.0 }`;
  content.push({ type: 'text', text: prompt });

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content }],
    });
    const txt = resp.content[0]?.text || '';
    const clean = txt.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[Vision] erro:', e.message);
    return null;
  }
}

async function uploadToStorage(productId, imageBuffer) {
  const fileName = `references/ref-${productId}.jpg`;
  const optimized = await sharp(imageBuffer).jpeg({ quality: 85 }).toBuffer();
  const { error } = await supabase.storage
    .from('product-art')
    .upload(fileName, optimized, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('product-art').getPublicUrl(fileName);
  return data.publicUrl;
}

async function updateProduct(productId, refUrl, refStatus) {
  const patch = { ref_status: refStatus };
  if (refUrl) patch.reference_image_url = refUrl;
  const { error } = await supabase.from('drope_products').update(patch).eq('id', productId);
  if (error) throw error;
}

async function main() {
  console.log('=== Drope OSSO 34 — busca de referência visual ===');
  console.log(`limit=${limitArg} brand=${brandFilter || 'ALL'} dryRun=${dryRun}`);
  const products = await getProductsPending();
  console.log(`Produtos pendentes: ${products.length}`);
  if (products.length === 0) return console.log('nada pra fazer.');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });
  const page = await ctx.newPage();

  let found = 0, failed = 0, skipped = 0;
  for (const p of products) {
    const meta = p.metadata || {};
    const desc = meta.device_visual_detailed || meta.device_visual || '';
    const query = buildSearchQuery(p);
    console.log(`\n[${p.id}] ${p.name}\n  query: "${query}"`);

    if (dryRun) { console.log('  [DRY] pulando'); skipped++; continue; }

    try {
      const urls = await searchGoogleImages(page, query);
      console.log(`  urls: ${urls.length}`);
      if (urls.length === 0) {
        await updateProduct(p.id, null, 'auto_failed'); failed++;
        await sleep(DELAY_BETWEEN_SEARCHES); continue;
      }

      const cands = [];
      for (const u of urls) {
        if (cands.length >= CANDIDATES_PER_PRODUCT) break;
        let buf;
        if (u.startsWith('data:image')) {
          const b64 = u.split(',')[1];
          if (!b64) continue;
          buf = Buffer.from(b64, 'base64');
        } else {
          buf = await downloadImage(u);
        }
        if (!buf || !(await validateImage(buf))) continue;
        cands.push({ buffer: buf });
      }
      console.log(`  candidatos válidos: ${cands.length}`);
      if (cands.length === 0) {
        await updateProduct(p.id, null, 'auto_failed'); failed++;
        await sleep(DELAY_BETWEEN_SEARCHES); continue;
      }

      const ranking = await visionRankCandidates(cands, desc);
      if (!ranking || !ranking.melhor || (ranking.confianca || 0) < VISION_MIN_CONFIDENCE) {
        console.log(`  Vision sem winner (conf=${ranking?.confianca || 0})`);
        await updateProduct(p.id, null, 'auto_failed'); failed++;
        await sleep(DELAY_BETWEEN_SEARCHES); continue;
      }
      const winner = cands[ranking.melhor - 1];
      console.log(`  winner: candidato ${ranking.melhor} (conf=${ranking.confianca})`);

      const publicUrl = await uploadToStorage(p.id, winner.buffer);
      await updateProduct(p.id, publicUrl, 'auto_found');
      console.log(`  ✅ ${publicUrl}`);
      found++;
    } catch (e) {
      console.error(`  ERRO: ${e.message}`);
      try { await updateProduct(p.id, null, 'auto_failed'); } catch (_) {}
      failed++;
    }
    await sleep(DELAY_BETWEEN_SEARCHES);
  }

  await browser.close();
  console.log(`\n=== RESULTADO ===\n✅ encontrados: ${found}\n❌ falharam: ${failed}\n⏭️ pulados: ${skipped}\n📋 total: ${products.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
