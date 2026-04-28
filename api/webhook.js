// Drope WhatsApp AI Agent â€” Vercel Serverless Function v3
// 3 modos: atendimento cliente | cadastro/entrada (Lucas) | baixa estoque (caixa)
// Claude Vision (Haiku 4.5) + Grok image gen + Supabase storage + drope_products
//
// V3 (osso 9, 27/04/2026):
// - Tabela: products â†’ drope_products (consistÃªncia com app)
// - PadrÃ£o A+ hÃ­brido (gradient acid fade + aura cyan/pink, NÃƒO branco assÃ©ptico, NÃƒO caos cyber)
// - Upload de imagem pro Supabase Storage (URL Grok externa expira)
// - hidden=true atÃ© Andrade definir preÃ§o
// - Mensagens lo-fi authentic (minÃºsculas, sem corporativismo)
// - descricao_quebrada Gen Z favela (max 80 chars, max 1 emoji)
// - SEM vÃ­deo (V1.5)
// - SEM hero shot PadrÃ£o B (V1.5: botÃ£o manual em /admin/products/:id/generate-hero)

// ============ CONFIG ============
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN || "";
const CLAUDE_KEY = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://udsjnhbkapjwpdolvtri.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";

// Whitelist: sÃ³ esse nÃºmero cadastra produto. Outros = cliente.
const ADMIN_LUCAS = process.env.ADMIN_LUCAS || "5511962443565";
const ADMIN_CAIXA = process.env.ADMIN_CAIXA || "";

// Storage bucket pra imagens geradas
const STORAGE_BUCKET = "drope-product-images";

// Custo cap diÃ¡rio hardcoded (anti-runaway)
const MAX_IMAGE_GEN_PER_DAY = 50;

// ============ RATE LIMITING ============
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

function isRateLimited(phone) {
  const now = Date.now();
  const entry = rateLimits.get(phone);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(phone, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function isValidWebhook(body) {
  if (!body || typeof body !== 'object') return false;
  if (!body.message && !body.chat) return false;
  if (body.token && body.token !== UAZAPI_TOKEN) return false;
  return true;
}

// ============ HISTÃ“RICO DE CONVERSAS ============
const conversations = new Map();
const HISTORY_LIMIT = 10;
const HISTORY_TTL = 30 * 60 * 1000;

function getConvo(phone) {
  let entry = conversations.get(phone);
  if (!entry || Date.now() - entry.lastActivity > HISTORY_TTL) {
    entry = { messages: [], lastActivity: Date.now(), state: null, pending: null };
    conversations.set(phone, entry);
  }
  return entry;
}

function addMsg(phone, role, content) {
  const entry = getConvo(phone);
  entry.messages.push({ role, content: typeof content === 'string' ? content : JSON.stringify(content) });
  entry.lastActivity = Date.now();
  if (entry.messages.length > HISTORY_LIMIT) entry.messages = entry.messages.slice(-HISTORY_LIMIT);
  if (conversations.size > 500) {
    const now = Date.now();
    for (const [k, v] of conversations) {
      if (now - v.lastActivity > HISTORY_TTL) conversations.delete(k);
    }
  }
}

// ============ SUPABASE HELPERS ============
function sbHeaders(extra = {}) {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sbGet(table, filter = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${filter ? '?' + filter : ''}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) { console.error(`[SB] GET ${table} error:`, r.status); return []; }
  return r.json();
}

async function sbInsert(table, data) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const headers = sbHeaders({ 'Prefer': 'return=representation' });
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) });
  if (!r.ok) { console.error(`[SB] INSERT ${table} error:`, r.status, await r.text()); return null; }
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function sbUpdate(table, filter, data) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}`;
  const headers = sbHeaders({ 'Prefer': 'return=representation' });
  const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(data) });
  if (!r.ok) { console.error(`[SB] UPDATE ${table} error:`, r.status, await r.text()); return null; }
  return r.json();
}

// Lookup case-insensitive por marca+modelo+sabor (pra detectar produto existente)
async function findExistingProduct(brand, model, flavor) {
  if (!brand || !flavor) return null;
  const fullName = `${brand} ${model || ''} ${flavor}`.replace(/\s+/g, ' ').trim();
  // Busca por nome completo (case-insensitive) usando ilike
  const filter = `name=ilike.*${encodeURIComponent(fullName)}*&limit=1`;
  const rows = await sbGet('drope_products', filter);
  return rows[0] || null;
}

// ============ STORAGE HELPERS ============
function slugify(brand, model, flavor) {
  const raw = `${brand}-${model}-${flavor}`.toLowerCase();
  return raw
    .normalize('NFD').replace(/[Ì€-Í¯]/g, '')   // tira acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Upload base64 ou Buffer pro Supabase Storage. Retorna URL pÃºblica.
async function uploadToStorage(slug, imageData, contentType = 'image/png') {
  const path = `pods/${slug}.png`;
  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;

  // imageData pode ser Buffer (Node) ou string base64 ("data:image/png;base64,...")
  let body;
  if (typeof imageData === 'string') {
    const cleanB64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    body = Buffer.from(cleanB64, 'base64');
  } else {
    body = imageData;
  }

  // Upload com upsert (sobrescreve se jÃ¡ existir)
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body,
  });

  if (!r.ok) {
    console.error('[Storage] upload error:', r.status, await r.text());
    return null;
  }
  // URL pÃºblica (bucket precisa ser public)
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

async function downloadImage(url) {
  if (url.startsWith('data:')) {
    return url; // jÃ¡ Ã© base64 inline
  }
  const r = await fetch(url);
  if (!r.ok) {
    console.error('[Download] error:', r.status);
    return null;
  }
  const buf = await r.arrayBuffer();
  return Buffer.from(buf);
}

// ============ CLAUDE VISION ============
async function callClaude(messages, systemPrompt, maxTokens = 600) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    })
  });
  const data = await r.json();
  console.log("[Claude] status:", r.status);
  if (r.status >= 400) console.error("[Claude] error body:", JSON.stringify(data).slice(0, 500));
  return data.content?.[0]?.text || null;
}

// Extrai dados do pod a partir da foto. Vibe Drope na descricao_quebrada.
async function analyzeProductImage(imageUrl) {
  const systemPrompt = `Voce e o catalogador da Drope, loja Gen Z de pods em Vila Prudente-SP.
Analise a foto e extraia em JSON valido (sem markdown). Se nao identificar campo, deixa null:

{
  "brand": "marca em maiusculo (IGNITE, ELFBAR, BLACKSHEEP, DOJO, LOSTMARY, GEEKBAR, ADALYA, VANTHER)",
  "model": "linha/modelo (ex 'V300 Ultra Slim', 'Iceking', 'Cybertank', 'BC15K', 'Trio', 'Spherex')",
  "flavor_en": "sabor em ingles (ex 'Menthol', 'Mango Magic', 'Strawberry Ice')",
  "flavor_pt": "sabor em portugues (ex 'Menta', 'Manga', 'Morango Gelado')",
  "puffs": numero inteiro (ex 30000) ou null,
  "ml": float ou null,
  "mg_nicotina": float ou null,
  "device_color": "cor do device em ingles curto (ex 'matte black', 'green and silver', 'pink purple gradient')",
  "cores_predominantes": "cores da caixa em portugues (ex 'verde escuro com prata e detalhes lima', 'preto matte e neon azul')",
  "flavor_elements": "elementos visuais do sabor pra prompt de arte em ingles (ex 'mint leaves and ice crystals', 'mango slices and frost', 'watermelon dragonfruit')",
  "descricao_quebrada": "max 80 caracteres, vibe lo-fi authentic Gen Z favela Vila Prudente, minusculas, max 1 emoji, sensacao real do sabor. NUNCA usar 'delicioso, incrivel, experimente, o melhor'. Exemplos certos: 'menta gelada que escorre na garganta ðŸ§Š', 'manga doce escorrendo no calor', 'frutas vermelhas com soco de gelo'",
  "alertas": ["lista de strings com qualquer ambiguidade. ex: 'sabor pode ser Menthol ou Icy Mint', 'nao consegui ler mg de nicotina'"]
}

NAO invente dado. Se a foto nao for de pod, retorna {"alertas":["nao parece pod"]} e o resto null.`;

  const messages = [{
    role: "user",
    content: [
      { type: "image", source: { type: "url", url: imageUrl } },
      { type: "text", text: "Extrai os dados desse pod. Responde SO o JSON, sem texto antes ou depois." }
    ]
  }];

  const result = await callClaude(messages, systemPrompt, 800);
  if (!result) return null;

  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error("[Vision] JSON parse error:", e.message, "raw:", result.slice(0, 300));
    return null;
  }
}

// ============ GROK PADRÃƒO A+ ============
// HÃ­brido: pod nÃ­tido em fundo dark gradient acid fade + aura sutil cyan/pink.
// NÃƒO branco assÃ©ptico, NÃƒO caos cyber. CatÃ¡logo coerente com alma Drope.
async function generatePadraoAPlus(brand, model, flavor, coresPredominantes) {
  const cores = coresPredominantes || "matte black with brand colors";
  const fullName = `${brand} ${model || ''} ${flavor}`.replace(/\s+/g, ' ').trim();

  const prompt = `Premium product photography of a single disposable vape pod, ${fullName}, centered vertical orientation. Background: subtle dark gradient from deep navy (#070F34) to violet-purple (#1a0d2e) to near-black (#05080f), barely visible cosmic dust particles in the corners. Subtle cyan (#34EDF3) rim light on left edge of pod, faint magenta-pink (#F715AB) rim on right edge, very soft purple (#9201CB) volumetric haze behind. Subtle reflective floor with gentle chromatic aberration glow underneath the pod. Brand text, sabor name and packaging colors crystal clear and ultra-sharp. Color palette of pod must match real packaging: ${cores}. Frame ratio 1:1, resolution 1024x1024. No humans, no warning labels prominently shown, no AI text overlays, no other logos, no extra props. Style: premium e-commerce meets cyberpunk Vila Prudente, Gen Z 2026 aesthetic. Photorealistic + cinematic lighting. NOT pure white background, NOT chaotic neon, NOT minimalist Apple. Goal: 200 products in catalog scroll feel coherent and identifiable but with Drope soul.`;

  console.log("[Grok A+] generating image for:", fullName);
  const r = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "grok-2-image",
      prompt,
      n: 1,
      response_format: "url"
    })
  });

  const data = await r.json();
  console.log("[Grok A+] status:", r.status);

  if (r.status >= 400) console.error("[Grok A+] error:", JSON.stringify(data).slice(0, 300));

  if (data.data?.[0]?.url) return data.data[0].url;
  if (data.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
  return null;
}

// ============ UAZAPI SEND ============
async function sendText(phone, text, body = {}) {
  const serverUrl = body.BaseUrl || UAZAPI_SERVER;
  const token = body.token || UAZAPI_TOKEN;
  const r = await fetch(`${serverUrl}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": token },
    body: JSON.stringify({ number: phone, text })
  });
  console.log("[Send] text to", phone.slice(0, 6) + "***", "status:", r.status);
  return r;
}

async function sendImage(phone, imageUrl, caption, body = {}) {
  const serverUrl = body.BaseUrl || UAZAPI_SERVER;
  const token = body.token || UAZAPI_TOKEN;
  const r = await fetch(`${serverUrl}/send/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": token },
    body: JSON.stringify({ number: phone, image: imageUrl, caption: caption || "" })
  });
  console.log("[Send] image status:", r.status);
  return r;
}

// ============ MEDIA DOWNLOAD ============
async function getMediaUrl(msg, body) {
  if (msg.mediaUrl) return msg.mediaUrl;
  if (msg.media?.url) return msg.media.url;
  if (msg.image?.url) return msg.image.url;

  if (msg.id || msg.messageId) {
    const serverUrl = body.BaseUrl || UAZAPI_SERVER;
    const token = body.token || UAZAPI_TOKEN;
    const msgId = msg.id || msg.messageId;
    try {
      const r = await fetch(`${serverUrl}/download/media/${msgId}`, { headers: { "token": token } });
      if (r.ok) {
        const data = await r.json();
        if (data.url) return data.url;
        if (data.base64) return `data:${msg.mimetype || 'image/jpeg'};base64,${data.base64}`;
      }
    } catch (e) { console.error("[Media] download error:", e.message); }
  }

  if (msg.base64) return `data:${msg.mimetype || 'image/jpeg'};base64,${msg.base64}`;
  if (msg.body && msg.mimetype?.startsWith('image/')) {
    return `data:${msg.mimetype};base64,${msg.body}`;
  }
  return null;
}

function isImageMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  return msg.type === 'image' ||
         msg.type === 'imageMessage' ||
         msg.messageType === 'image' ||
         msg.messageType === 'imageMessage' ||
         msg.mediaType === 'image' ||
         msg.media === 'image' ||
         (typeof msg.mimetype === 'string' && msg.mimetype.startsWith('image/')) ||
         !!msg.mediaUrl ||
         !!msg.image ||
         !!msg.imageMessage ||
         !!msg.message?.imageMessage ||
         (msg.media && typeof msg.media === 'object' && !!msg.media.url);
}

// Extrai string limpa de um campo que pode vir como string OU objeto (formatos UazAPI/Baileys variados).
function asString(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    if (typeof v.body === 'string') return v.body;
    if (typeof v.text === 'string') return v.text;
    if (typeof v.conversation === 'string') return v.conversation;
    if (typeof v.caption === 'string') return v.caption;
  }
  return "";
}

// ============ FLUXO CADASTRO (LUCAS) ============
async function handleAdminLucas(phone, msg, body) {
  const hasImage = isImageMessage(msg);
  const text = asString(msg.text) || asString(msg.content) || asString(msg.caption);

  // Comando texto: estoque
  if (!hasImage) {
    if (!text) {
      // Nem imagem nem texto reconhecido â€” loga payload pra investigar formato novo da UazAPI
      console.log("[handleAdminLucas] payload nao classificado. msg:", JSON.stringify(msg).slice(0, 600));
      await sendText(phone, "manda foto do pod que eu cadastro. ou digita 'estoque' pra ver o que tem.", body);
      return;
    }
    const lower = text.toLowerCase();
    if (lower.includes('estoque') || lower.includes('saldo')) {
      const products = await sbGet('drope_products', 'select=name,qty_available,hidden&order=name');
      if (!products.length) {
        await sendText(phone, "estoque vazio.", body);
        return;
      }
      const list = products.map(p => `${p.name}: ${p.qty_available || 0}${p.hidden ? ' (sem preÃ§o)' : ''}`).join('\n');
      await sendText(phone, `estoque atual:\n${list}`, body);
      return;
    }
    await sendText(phone, "manda foto do pod que eu cadastro. ou digita 'estoque' pra ver o que tem.", body);
    return;
  }

  // ========== MODO CADASTRO (foto recebida) ==========
  const imageUrl = await getMediaUrl(msg, body);
  if (!imageUrl) {
    await sendText(phone, "nÃ£o peguei a imagem. manda de novo.", body);
    return;
  }

  await sendText(phone, "ðŸ“¸ lendo a caixa...", body);

  // 1. Claude Vision extrai dados
  const data = await analyzeProductImage(imageUrl);

  if (!data) {
    await sendText(phone, "nÃ£o consegui ler. manda outra foto, mais nÃ­tida da frente da caixa.", body);
    return;
  }

  // Caso: foto nÃ£o Ã© pod
  if (data.alertas?.includes('nao parece pod') || (!data.brand && !data.flavor_en)) {
    await sendText(phone, "isso nÃ£o tÃ¡ parecendo pod. confere se Ã© a foto certa.", body);
    return;
  }

  // Caso: dados parciais (alerta)
  if (data.alertas?.length > 0) {
    console.log("[Cadastro] alertas:", data.alertas);
    // Continua mas avisa Andrade ao final
  }

  const brand = data.brand || 'UNKNOWN';
  const model = data.model || '';
  const flavor = data.flavor_en || data.flavor_pt || 'unknown';
  const fullName = `${brand} ${model} ${flavor}`.replace(/\s+/g, ' ').trim();
  const slug = slugify(brand, model, flavor);

  // 2. Lookup existente
  const existing = await findExistingProduct(brand, model, flavor);

  if (existing) {
    // Produto JÃ existe â†’ incrementa estoque
    const newQty = (existing.qty_available || 0) + 1;
    await sbUpdate('drope_products', `id=eq.${existing.id}`, { qty_available: newQty });

    const priceStr = existing.price_cents
      ? `R$ ${(existing.price_cents / 100).toFixed(2).replace('.', ',')}`
      : 'sem preÃ§o';

    await sendText(phone,
      `+1 ${fullName}\nestoque: ${existing.qty_available || 0} â†’ ${newQty}\npreÃ§o: ${priceStr}`,
      body
    );
    return;
  }

  // 3. Produto NOVO â†’ gera imagem A+ + cria registro
  await sendText(phone, "achei novo. gerando arte...", body);

  const grokUrl = await generatePadraoAPlus(brand, model, flavor, data.cores_predominantes);

  let publicImageUrl = null;
  let imageStatus = 'pending_regeneration';

  if (grokUrl) {
    // Download da imagem do Grok + upload pro Supabase Storage (URL externa Grok expira)
    const imgData = await downloadImage(grokUrl);
    if (imgData) {
      publicImageUrl = await uploadToStorage(slug, imgData, 'image/png');
      if (publicImageUrl) imageStatus = 'ok';
    }
  }

  // 4. Insere em drope_products (hidden=true atÃ© preÃ§o)
  const inserted = await sbInsert('drope_products', {
    slug,
    name: fullName,
    brand,
    model,
    flavor: data.flavor_en,
    flavor_pt: data.flavor_pt,
    puffs: data.puffs,
    ml: data.ml,
    mg_nicotina: data.mg_nicotina,
    device_color: data.device_color,
    cores_predominantes: data.cores_predominantes,
    image_url: publicImageUrl,
    image_status: imageStatus,
    descricao_quebrada: data.descricao_quebrada,
    qty_available: 1,
    hidden: true,                            // sÃ³ publica apÃ³s preÃ§o
    category: 'pods',
    created_via: 'whatsapp_agent',
  });

  if (!inserted) {
    await sendText(phone, "deu ruim no banco. tenta de novo.", body);
    return;
  }

  // 5. Resposta final lo-fi
  let alertSuffix = '';
  if (data.alertas?.length > 0) alertSuffix = `\n\nobs: ${data.alertas.join(', ')}`;
  if (imageStatus === 'pending_regeneration') alertSuffix += `\nobs: arte falhou, regenera pelo /admin depois`;

  const adminLink = `https://drope-app.vercel.app/admin#products/${inserted.id}`;
  await sendText(phone,
    `valeu â€” ${fullName} tÃ¡ no app.\nfalta sÃ³ o preÃ§o.\n${adminLink}${alertSuffix}`,
    body
  );

  // Manda a imagem gerada tambÃ©m (visualizaÃ§Ã£o rÃ¡pida)
  if (publicImageUrl) {
    await sendImage(phone, publicImageUrl, `${fullName} â€” arte A+`, body);
  }
}

// ============ FLUXO BAIXA ESTOQUE (CAIXA) â€” placeholder ============
async function handleAdminCaixa(phone, msg, body) {
  await sendText(phone, "modo caixa ainda nÃ£o migrado pra drope_products. fala com Andrade.", body);
}

// ============ ATENDIMENTO CLIENTE (Claude Haiku) ============
const SYSTEM_CUSTOMER = `Voce e o assistente virtual da Drope, loja de pods descartaveis em Sao Paulo.

Tom: lo-fi authentic, Gen Z favela Vila Prudente. Minusculas. Max 1-2 emojis por mensagem. Curto (2-4 linhas WhatsApp).

PRIMEIRA MENSAGEM (oi, ola, eae, bom dia):
Cumprimenta natural, se apresenta, oferece ajuda. Exemplo: "e ai! aqui e a Drope. tamo junto pra te ajudar com pods, precos, pedidos..."
NAO usa menu numerado. NAO lista 1, 2, 3.

MENSAGENS SEGUINTES:
- Tem historico, NAO repete saudacao.
- Responde direto a duvida.
- Se cliente quer pedir: manda link https://drope-app.vercel.app
- Pagamento: Pix antecipado (delivery) ou Pix/cartao (retirada na loja Vila Prudente).
- Se nao souber: "vou confirmar com a equipe e ja te respondo"
- Se mandar audio/imagem: "por enquanto so leio texto, manda escrito"

NUNCA usa "delicioso, incrivel, experimente". NUNCA inventa produto/preco.`;

// ============ HANDLER PRINCIPAL ============
module.exports = async function handler(req, res) {
  console.log("METHOD:", req.method);

  if (req.method !== "POST") return res.status(200).send("OK");

  try {
    const body = req.body;

    if (!isValidWebhook(body)) {
      console.log("REJECTED: invalid webhook payload");
      return res.status(200).send("invalid");
    }

    const msg = body.message || {};
    const chat = body.chat || {};

    if (msg.fromMe || msg.wasSentByApi) return res.status(200).send("ignored");
    if (msg.isGroup || chat.wa_isGroup) return res.status(200).send("group ignored");

    const rawPhone = chat.phone || msg.chatid?.replace("@s.whatsapp.net", "") || "";
    const phone = rawPhone.replace(/[^0-9]/g, "");
    if (!phone) return res.status(200).send("no phone");

    console.log("PHONE:", phone.slice(0, 6) + "***", "TYPE:", msg.type || "text");

    if (isRateLimited(phone)) {
      console.log("RATE LIMITED:", phone.slice(0, 6) + "***");
      return res.status(200).send("rate limited");
    }

    // ========== ROTEAMENTO ==========

    // ANDRADE â†’ modo cadastro
    if (phone === ADMIN_LUCAS) {
      console.log("MODE: admin-lucas (cadastro)");
      await handleAdminLucas(phone, msg, body);
      return res.status(200).send("admin-lucas");
    }

    // CAIXA â†’ modo baixa
    if (ADMIN_CAIXA && phone === ADMIN_CAIXA) {
      console.log("MODE: admin-caixa");
      await handleAdminCaixa(phone, msg, body);
      return res.status(200).send("admin-caixa");
    }

    // ========== CLIENTE ==========
    const message = asString(msg.text) || asString(msg.content) || asString(msg.caption);

    if (isImageMessage(msg) && !message) {
      await sendText(phone, "por enquanto so leio texto, manda escrito que te ajudo.", body);
      return res.status(200).send("image-rejected");
    }

    if (!message) return res.status(200).send("no message");

    const convo = getConvo(phone);
    const history = convo.messages;
    const messages = [...history, { role: "user", content: message }];

    console.log("Calling Claude AI... history:", history.length, "msgs");

    const reply = await callClaude(messages, SYSTEM_CUSTOMER, 400) ||
                  "opa, deu um problema. ja chamo alguem da equipe.";

    addMsg(phone, "user", message);
    addMsg(phone, "assistant", reply);

    await sendText(phone, reply, body);
    return res.status(200).send("replied");

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message, err.stack);
    return res.status(200).send("error: " + err.message);
  }
};
