// Drope — Regenera arte do Grok pra produto existente.
// POST /api/admin-regenerate-art
// Header: x-admin-token: <ADMIN_TOKEN>
// Body: { slug: string }
//
// Usa metadata salvo (brand/model/flavor/device_visual/cores_predominantes) pra montar prompt.
// Substitui image_url no banco e atualiza image_status='ok'.
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN, XAI_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";
const XAI_API_KEY  = process.env.XAI_API_KEY || "";
const STORAGE_BUCKET = "drope-product-images";

async function generatePadraoAPlus(brand, model, flavor, coresPredominantes, deviceVisual) {
  const cores = coresPredominantes || "matte black with brand colors";
  const fullName = `${brand} ${model || ''} ${flavor}`.replace(/\s+/g, ' ').trim();
  const subject = deviceVisual
    ? `Premium product photography of a single disposable vape pod (${fullName}). DEVICE TO RENDER: ${deviceVisual}. The shape, proportions, display, buttons, mouthpiece and features described MUST be respected exactly`
    : `Premium product photography of a single disposable vape pod, ${fullName}`;
  const prompt = `${subject}, centered vertical orientation. Background: subtle dark gradient from deep navy (#070F34) to violet-purple (#1a0d2e) to near-black (#05080f), barely visible cosmic dust particles in the corners. Subtle cyan (#34EDF3) rim light on left edge of pod, faint magenta-pink (#F715AB) rim on right edge, very soft purple (#9201CB) volumetric haze behind. Subtle reflective floor with gentle chromatic aberration glow underneath the pod. Brand text, sabor name and packaging colors crystal clear and ultra-sharp. Color palette of pod must match real packaging: ${cores}. Frame ratio 1:1, resolution 1024x1024. No humans, no warning labels prominently shown, no AI text overlays, no other logos, no extra props. Style: premium e-commerce meets cyberpunk Vila Prudente, Gen Z 2026 aesthetic. Photorealistic + cinematic lighting. NOT pure white background, NOT chaotic neon, NOT minimalist Apple. Goal: 200 products in catalog scroll feel coherent and identifiable but with Drope soul.`;
  const r = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify({ model: "grok-imagine-image", prompt, n: 1, response_format: "url" })
  });
  const data = await r.json();
  if (r.status >= 400) { console.error("[Grok]", JSON.stringify(data).slice(0, 300)); return null; }
  return data.data?.[0]?.url || (data.data?.[0]?.b64_json ? `data:image/png;base64,${data.data[0].b64_json}` : null);
}

async function downloadImage(url) {
  if (url.startsWith('data:')) {
    const b64 = url.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(b64, 'base64');
  }
  const r = await fetch(url);
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

async function uploadToStorage(slug, buf) {
  const path = `pods/${slug}.png`;
  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': 'image/png',
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: buf,
  });
  if (!r.ok) { console.error('[Storage]', r.status, await r.text()); return null; }
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

module.exports = async function handler(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  if (!ADMIN_TOKEN) return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
  const provided = req.headers['x-admin-token'] || '';
  if (provided !== ADMIN_TOKEN) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'supabase not configured' });
  if (!XAI_API_KEY) return res.status(500).json({ error: 'XAI_API_KEY not configured' });

  try {
    const { slug } = req.body || {};
    if (!slug || typeof slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(slug)) {
      return res.status(400).json({ error: 'invalid slug' });
    }

    // Busca produto pra pegar metadata
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_products?slug=eq.${encodeURIComponent(slug)}&select=name,metadata,cores_predominantes&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return res.status(404).json({ error: 'product not found' });

    const p = rows[0];
    const m = p.metadata || {};
    const brand = m.brand || p.name.split(' ')[0] || 'UNKNOWN';
    const model = m.model || '';
    const flavor = m.flavor_en || m.flavor_pt || 'pod';

    const grokUrl = await generatePadraoAPlus(brand, model, flavor, p.cores_predominantes, m.device_visual);
    if (!grokUrl) return res.status(502).json({ error: 'grok generation failed' });

    const buf = await downloadImage(grokUrl);
    if (!buf) return res.status(502).json({ error: 'download from grok failed' });

    const publicUrl = await uploadToStorage(slug, buf);
    if (!publicUrl) return res.status(502).json({ error: 'storage upload failed' });

    // Atualiza produto
    const cacheBust = `${publicUrl}?t=${Date.now()}`;
    const upd = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_products?slug=eq.${encodeURIComponent(slug)}`,
      {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ image_url: publicUrl, image_status: 'ok' }),
      }
    );
    if (!upd.ok) { console.error('[update]', upd.status, await upd.text()); }

    return res.status(200).json({ ok: true, image_url: cacheBust });
  } catch (err) {
    console.error('[regenerate-art]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
