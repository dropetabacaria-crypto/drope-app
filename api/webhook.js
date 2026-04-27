// Drope WhatsApp AI Agent — Vercel Serverless Function v5
// 3 modos: atendimento cliente | entrada/cadastro (Lucas) | baixa estoque (caixa)
// Claude Vision + Grok API (imagem + vídeo) + Supabase estoque
// v5: dedup blindado com Supabase + fallback hash + logging detalhado

// ============ CONFIG ============
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN || "";
const CLAUDE_KEY = process.env.CLAUDE_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://udsjnhbkapjwpdolvtri.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";

// Números admin (só esses acessam modo estoque)
const ADMIN_LUCAS = process.env.ADMIN_LUCAS || "5511962443565";
const ADMIN_CAIXA = process.env.ADMIN_CAIXA || "";

// ============ DEDUPLICAÇÃO BLINDADA ============
// Camada 1: Supabase (persistente, funciona entre serverless instances)
async function isDuplicateSupabase(msgKey) {
  if (!msgKey || !SUPABASE_URL || !SUPABASE_KEY) {
    console.log("[DEDUP] Supabase not configured, skipping");
    return false;
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/webhook_dedup`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ msg_key: msgKey })
    });

    console.log("[DEDUP] Supabase insert status:", r.status, "key:", msgKey.substring(0, 40));

    // 201 = inserted OK (first time)
    if (r.status === 201) return false;

    // 409 = conflict = duplicate
    if (r.status === 409) {
      console.log("[DEDUP] BLOCKED duplicate via 409");
      return true;
    }

    // Any other error — check response text
    const txt = await r.text();
    console.log("[DEDUP] Supabase response:", r.status, txt.substring(0, 200));

    // Check for unique violation in any format
    if (txt.includes('duplicate') || txt.includes('unique') || txt.includes('23505') || txt.includes('already exists')) {
      console.log("[DEDUP] BLOCKED duplicate via error text");
      return true;
    }

    // If status is 200 or other success, the insert worked (first time)
    if (r.status >= 200 && r.status < 300) return false;

    // Unknown error — log but don't block
    console.log("[DEDUP] Unknown response, allowing through");
    return false;
  } catch (e) {
    console.log("[DEDUP] Supabase error:", e.message);
    return false;
  }
}

// Limpa dedup antigos (roda a cada request, deleta > 2 min)
async function cleanDedup() {
  try {
    const twoMinAgo = new Date(Date.now() - 120000).toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/webhook_dedup?created_at=lt.${twoMinAgo}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    });
  } catch (e) { /* ignora */ }
}

// Rate limiting simples (por phone, em memória — backup extra)
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
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// Validação de webhook — verifica se veio do Uazapi
function isValidWebhook(body) {
  if (!body || typeof body !== 'object') return false;
  if (!body.message && !body.chat) return false;
  if (body.token && body.token !== UAZAPI_TOKEN) return false;
  return true;
}

// ============ HISTÓRICO DE CONVERSAS ============
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
function sbHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

async function sbGet(table, filter = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${filter ? '?' + filter : ''}`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) { console.error(`[SB] GET ${table} error:`, r.status); return []; }
  return r.json();
}

async function sbUpsert(table, data) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const headers = { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=representation' };
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) });
  if (!r.ok) { console.error(`[SB] UPSERT ${table} error:`, r.status, await r.text()); return null; }
  return r.json();
}

async function sbUpdate(table, filter, data) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}`;
  const r = await fetch(url, { method: 'PATCH', headers: sbHeaders(), body: JSON.stringify(data) });
  if (!r.ok) { console.error(`[SB] UPDATE ${table} error:`, r.status, await r.text()); return null; }
  return r.json();
}

async function getProducts() {
  return sbGet('products', 'select=*&order=name');
}

async function findProductByName(searchName) {
  const products = await getProducts();
  const lower = searchName.toLowerCase();
  return products.find(p =>
    p.name?.toLowerCase().includes(lower) ||
    p.flavor?.toLowerCase().includes(lower) ||
    p.brand?.toLowerCase().includes(lower)
  );
}

async function updateStock(productId, delta) {
  const products = await sbGet('products', `id=eq.${productId}&select=id,name,stock`);
  if (!products.length) return null;
  const current = products[0].stock || 0;
  const newStock = Math.max(0, current + delta);
  await sbUpdate('products', `id=eq.${productId}`, { stock: newStock });
  return { ...products[0], oldStock: current, newStock };
}

async function createProduct(data) {
  const id = 'p' + Date.now().toString(36);
  const product = {
    id,
    name: data.name,
    emoji: data.emoji || '🔥',
    description: data.description || '',
    price: data.price,
    category: data.category || 'pods',
    brand: data.brand || '',
    flavor: data.flavor || '',
    puffs: data.puffs || '',
    profile: data.profile || '',
    stock: data.stock || 0
  };
  const result = await sbUpsert('products', product);
  return result ? product : null;
}

// ============ CLAUDE VISION ============
async function callClaude(messages, systemPrompt, maxTokens = 400) {
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
  return data.content?.[0]?.text || null;
}

async function analyzeProductImage(imageUrl) {
  const systemPrompt = `Voce e um especialista em pods/vapes descartaveis. Analise a foto e extraia:
- marca (brand)
- modelo/linha (model)
- sabor (flavor) em ingles e portugues
- puffs (numero)
- cor do device (device_color) em ingles
- elementos visuais do sabor (flavor_elements) em ingles pra usar num prompt de arte (ex: "watermelon, kiwi and pineapple")

Responda SOMENTE em JSON valido, sem markdown:
{"brand":"","model":"","flavor_en":"","flavor_pt":"","puffs":"","device_color":"","flavor_elements":"","suggested_price":0,"copy":""}

Para copy use o formato: "perfil curto ✦ notas do sabor" (ex: "tropical ✦ melancia + kiwi + manga")
Para suggested_price, estime baseado em puffs: 5k=R$80, 15k=R$60, 23k=R$75, 30k=R$85-90, 40k=R$85-100, 45k+=R$110
Se nao conseguir identificar algo, coloque string vazia.`;

  const messages = [{
    role: "user",
    content: [
      { type: "image", source: { type: "url", url: imageUrl } },
      { type: "text", text: "Identifique este pod/vape. Responda SOMENTE o JSON." }
    ]
  }];

  const result = await callClaude(messages, systemPrompt, 500);
  if (!result) return null;

  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error("[Vision] JSON parse error:", e.message, "raw:", result);
    return null;
  }
}

async function identifyProductForStock(imageUrl, products) {
  const productList = products.map(p => `${p.id}: ${p.name} (${p.brand} ${p.flavor})`).join('\n');

  const systemPrompt = `Voce e um especialista em pods/vapes. Olhe a foto e identifique qual produto da lista abaixo corresponde.

PRODUTOS CADASTRADOS:
${productList}

Responda SOMENTE em JSON valido, sem markdown:
{"product_id":"","product_name":"","confidence":"high|medium|low"}

Se nao encontrar correspondencia, coloque product_id vazio e confidence "low".`;

  const messages = [{
    role: "user",
    content: [
      { type: "image", source: { type: "url", url: imageUrl } },
      { type: "text", text: "Qual produto da lista é esse? Responda SOMENTE o JSON." }
    ]
  }];

  const result = await callClaude(messages, systemPrompt, 300);
  if (!result) return null;

  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error("[Identify] JSON parse error:", e.message);
    return null;
  }
}

// ============ GROK API (xAI) — IMAGEM + VÍDEO ============
async function generateProductImage(deviceColor, flavorElements) {
  const prompt = `Product photo of a ${deviceColor} rectangular vape pod device standing upright on a matte black reflective surface. Deep dark purple-black background. Floating slices of ${flavorElements} around the device with frost and small ice shards. Dramatic neon lighting: hot pink light from the left side and acid lime green light from the right side, both creating colorful reflections on the device and on the wet fruit surfaces. Soft vapor mist drifting upward with pink and green tints. Water droplets on the device catching the neon glow. No text, no logos, no words. Editorial product photography style, ultra premium, dark moody, sharp focus, photorealistic. Square format, 1024x1024 pixels.`;

  console.log("[Grok] Generating image...");
  const r = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "grok-2-image",
      prompt,
      n: 1
    })
  });

  const data = await r.json();
  console.log("[Grok] Image status:", r.status);

  if (data.data?.[0]?.url) return data.data[0].url;
  if (data.data?.[0]?.b64_json) return `data:image/png;base64,${data.data[0].b64_json}`;
  console.error("[Grok] Image error:", JSON.stringify(data).substring(0, 300));
  return null;
}

async function generateProductVideo(imageUrl) {
  const prompt = "Slow cinematic camera movement around the product, vapor slowly rising with pink and green tints, subtle neon light reflections shifting on the wet surfaces, ice crystals glistening, smooth dolly zoom, ultra premium product showcase, 4 seconds";

  console.log("[Grok] Generating video...");
  const r = await fetch("https://api.x.ai/v1/videos/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "grok-2-video",
      prompt,
      image_url: imageUrl
    })
  });

  const data = await r.json();
  console.log("[Grok] Video status:", r.status, JSON.stringify(data).substring(0, 200));

  if (data.id) return { requestId: data.id, status: "processing" };
  if (data.data?.[0]?.url) return { url: data.data[0].url, status: "done" };
  return null;
}

// ============ UAZAPI SEND HELPERS ============
async function sendText(phone, text, body = {}) {
  const serverUrl = body.BaseUrl || UAZAPI_SERVER;
  const token = body.token || UAZAPI_TOKEN;
  const r = await fetch(`${serverUrl}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": token },
    body: JSON.stringify({ number: phone, text })
  });
  console.log("[Send] text to", phone.substring(0, 6) + "***", "status:", r.status);
}

async function sendImage(phone, imageUrl, caption, body = {}) {
  const serverUrl = body.BaseUrl || UAZAPI_SERVER;
  const token = body.token || UAZAPI_TOKEN;
  const r = await fetch(`${serverUrl}/send/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": token },
    body: JSON.stringify({ number: phone, image: imageUrl, caption: caption || "" })
  });
  console.log("[Send] image to", phone.substring(0, 6) + "***", "status:", r.status);
}

async function sendVideo(phone, videoUrl, caption, body = {}) {
  const serverUrl = body.BaseUrl || UAZAPI_SERVER;
  const token = body.token || UAZAPI_TOKEN;
  const r = await fetch(`${serverUrl}/send/video`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": token },
    body: JSON.stringify({ number: phone, video: videoUrl, caption: caption || "" })
  });
  console.log("[Send] video to", phone.substring(0, 6) + "***", "status:", r.status);
}

// ============ MEDIA HELPERS ============
async function getMediaUrl(msg, body) {
  if (msg.mediaUrl) return msg.mediaUrl;
  if (msg.media?.url) return msg.media.url;

  const serverUrl = body.BaseUrl || UAZAPI_SERVER;
  const token = body.token || UAZAPI_TOKEN;
  const msgId = msg.id || msg.messageId;
  try {
    const r = await fetch(`${serverUrl}/download/media/${msgId}`, {
      headers: { "token": token }
    });
    if (r.ok) {
      const data = await r.json();
      return data.url || data.mediaUrl || null;
    }
  } catch (e) {
    console.error("[Media] download error:", e.message);
  }
  return null;
}

function isImageMessage(msg) {
  return msg.type === 'image' ||
         msg.messageType === 'image' ||
         msg.mimetype?.startsWith('image/') ||
         msg.mediaType === 'image';
}

// ============ CATÁLOGO ============
const CATALOGO = `
CATALOGO DROPE - Pods Descartáveis (61 produtos):

BLACK SHEEP (55k puffs, R$110): Blueberry, Miami Mint, Cool Mint, Aloe Grape
ELF BAR BC PRO (45k puffs, R$110): Mango Magic
ELF BAR ICE KING (40k puffs, R$95): Green Apple, Miami Mint, Double Apple, Summer Splash
ELF BAR TRIO (40k puffs, R$85): Peach Twist, Blue Razz, Sour Apple, Sakura Grape, Pomegranate
ELF BAR TE 30K (30k puffs, R$90): Green Apple, Strawberry
ELF BAR GH 23K (23k puffs, R$75): Blue Razz, Blueberry Pear, Baja Splash, Strawberry Banana [DESCONTINUADO]
ELF BAR BC 15K (15k puffs, R$60): Pear Watermelon, Pineapple, Peach Mango, Sour Apple, Strawberry Cream, Elf Love

IGNITE V250 (25k puffs, R$95): Strawberry Ice, Strawberry Banana, Green Apple, Banana Ice, Menthol
IGNITE V300 (30k puffs, R$100): Banana Coconut, Menthol, Dragonfruit Watermelon, Pineapple
IGNITE V155 (15k puffs, R$60): Icy Mint, Pineapple, Grape Ice, Watermelon Dragonfruit, Menthol, Blueberry
IGNITE V55 (5k puffs, R$80): Strawberry Banana, Aloe Grape, Minty Melon
IGNITE BOOST (40k puffs, R$100): Pineapple Kiwi

DOJO (40k puffs, R$80): Fresh Splash, Hawaii Dream, Fresh Berry Orange, Frosty Banana Taffy

LOST MARY (30k puffs, R$85): Blue Razz, Miami Chill, Aloe Grape Sour Apple, Banana Cherry

GEEK BAR (35k puffs, R$80): Frozen Strawberry, White Peach Raspberry, Stone Freeze

ADALYA AD5000 (5k puffs, R$80): Fruity Smoothie, Pineapple Slice, Passion Guava Kiwi

VANTHER (30k puffs, R$75): Cool Mint, Mixed Berries

TABACARIA:
Seda King (R$8), Isqueiro (R$12), Essência Hortelã 50g (R$25), Carvão Coco 250g (R$18)

Entrega: delivery ou retirada em SP. Pagamento: Pix antecipado (delivery) ou Pix/cartão (retirada). App: https://drope-app.vercel.app
`;

// ============ SYSTEM PROMPT CLIENTE ============
const SYSTEM_CUSTOMER = `Voce e a Drope, assistente virtual da loja de pods descartaveis em SP.

=== TOM ===
- WhatsApp de amigo, nao de robo. Gen Z brasileiro, informal, direto.
- Maximo 2-4 linhas por resposta. Sem textao.
- Maximo 1-2 emojis por mensagem (nao encha de emoji).
- Use "dropar" como verbo da marca quando encaixar natural.
- Tudo lowercase exceto nomes proprios (Drope, Pix, marcas).

=== FLUXO DA CONVERSA ===

SAUDACAO (so na PRIMEIRA mensagem, quando historico ta vazio):
Uma saudacao curta, tipo:
"e ai! aqui e a Drope, sua loja de pods em SP 🔥 no que posso te ajudar?"
NUNCA repita saudacao se ja tem historico. Va direto ao ponto.

QUANDO CLIENTE PERGUNTA SOBRE PRODUTO/SABOR:
Liste as opcoes encontradas no catalogo com NUMEROS pra facilitar:
"achei essas opcoes de morango:
1. Elf Bar BC 15k - Strawberry Cream (R$60)
2. Ignite V250 - Strawberry Ice (R$95)
3. Ignite V155 - Strawberry Banana (R$60)
manda o numero ou pergunta mais 😉"

QUANDO CLIENTE RESPONDE COM NUMERO (1, 2, 3...):
Entenda que ele ta escolhendo da lista anterior. Confirme e pergunte se quer pedir:
"boa escolha! Ignite V250 Strawberry Ice, 25k puffs por R$95. quer dropar? so abrir o app: https://drope-app.vercel.app"

QUANDO CLIENTE QUER PEDIR:
Mande o link do app: https://drope-app.vercel.app
"manda ver no app que la vc monta o pedido: https://drope-app.vercel.app"

QUANDO CLIENTE PERGUNTA PRECO:
Responda direto com preco do catalogo. Se tem varios, liste com numeros.

QUANDO CLIENTE TA INDECISO:
Sugira baseado no que ele falou. Ex: "se curte frutado, o Elf Bar Trio Peach Twist e brabo por R$85"

=== FILTRO DE ASSUNTO ===
- Voce SO responde sobre: pods, vapes, sabores, precos, pedidos, pagamento (Pix), entrega, retirada, horario, e a loja Drope.
- Se o cliente mandar QUALQUER coisa que NAO seja relacionada a pods/vapes/loja (ex: piadas, perguntas aleatorias, conversa fiada, politica, futebol, etc), responda APENAS:
  "aqui e so sobre pods, manda tua duvida sobre produto que te ajudo 😉"
- NAO responda a pergunta fora de assunto. NAO entre na conversa. Redirecione pro pod.

=== REGRAS ===
- NUNCA invente produtos ou precos fora do catalogo
- Pagamento: pods = so Pix | tabacaria = Pix ou cartao
- Delivery: Pix antecipado, taxa combinada por whats
- Retirada: Pix antecipado OU paga na hora
- Se nao souber: "vou confirmar com a equipe e ja te respondo"
- Nunca mande mais de 1 mensagem por vez. Tudo numa resposta so.

${CATALOGO}`;

// ============ FLUXOS ADMIN ============

// LUCAS — Entrada de estoque ou cadastro de produto novo
async function handleAdminLucas(phone, msg, body) {
  const convo = getConvo(phone);
  const hasImage = isImageMessage(msg);
  const text = msg.text || msg.content || msg.caption || "";

  // Estado: esperando confirmação de cadastro
  if (convo.state === 'awaiting_confirm' && convo.pending) {
    const lower = text.toLowerCase();
    if (lower.includes('confirma') || lower.includes('sim') || lower.includes('ok') || lower.includes('bora')) {
      const qtyMatch = text.match(/(\d+)\s*(uni|chegaram|unid)/i) || text.match(/chegaram?\s*(\d+)/i);
      const priceMatch = text.match(/(?:preço|preco|precu|R\$)\s*(\d+)/i);

      const qty = qtyMatch ? parseInt(qtyMatch[1]) : (convo.pending.qty || 1);
      const price = priceMatch ? parseInt(priceMatch[1]) : convo.pending.suggested_price;

      const newProduct = await createProduct({
        name: `${convo.pending.brand} ${convo.pending.model} ${convo.pending.flavor_pt}`,
        description: `${convo.pending.puffs} puffs`,
        price,
        category: 'pods',
        brand: convo.pending.brand,
        flavor: convo.pending.flavor_en,
        puffs: convo.pending.puffs,
        profile: convo.pending.copy,
        stock: qty
      });

      if (!newProduct) {
        await sendText(phone, "❌ erro ao cadastrar, tenta de novo", body);
        convo.state = null; convo.pending = null;
        return;
      }

      await sendText(phone, `✅ cadastrado: ${newProduct.name}\npreço: R$${price}\nestoque: ${qty}\nid: ${newProduct.id}`, body);

      await sendText(phone, "🎨 gerando arte do produto...", body);

      const artUrl = await generateProductImage(
        convo.pending.device_color || "metallic",
        convo.pending.flavor_elements || "tropical fruits"
      );

      if (artUrl) {
        await sendImage(phone, artUrl, `arte: ${newProduct.name}`, body);

        await sendText(phone, "🎬 gerando vídeo...", body);
        const videoResult = await generateProductVideo(artUrl);
        if (videoResult?.url) {
          await sendVideo(phone, videoResult.url, `video: ${newProduct.name}`, body);
        } else if (videoResult?.requestId) {
          await sendText(phone, `video ta processando (id: ${videoResult.requestId}), te mando quando ficar pronto`, body);
        } else {
          await sendText(phone, "video nao rolou agora, gera manual no grok depois", body);
        }
      } else {
        await sendText(phone, "arte nao gerou, pode ser limite da api. gera manual no grok com o prompt que te mando", body);
        const prompt = `Product photo of a ${convo.pending.device_color} rectangular vape pod device standing upright on a matte black reflective surface. Deep dark purple-black background. Floating slices of ${convo.pending.flavor_elements} around the device with frost and small ice shards. Dramatic neon lighting: hot pink light from the left side and acid lime green light from the right side. Soft vapor mist. No text, no logos. Square format, 1024x1024.`;
        await sendText(phone, prompt, body);
      }

      convo.state = null;
      convo.pending = null;
      return;

    } else if (lower.includes('cancel') || lower.includes('não') || lower.includes('nao')) {
      convo.state = null; convo.pending = null;
      await sendText(phone, "cancelado ✌️", body);
      return;
    }
    if (text.match(/(?:preço|preco|R\$)\s*(\d+)/i)) {
      const priceMatch = text.match(/(?:preço|preco|R\$)\s*(\d+)/i);
      convo.pending.suggested_price = parseInt(priceMatch[1]);
    }
    await sendText(phone, `ajustado. confirma cadastro? (sim/nao)`, body);
    return;
  }

  // Estado: esperando quantidade pra entrada de estoque
  if (convo.state === 'awaiting_qty' && convo.pending) {
    const qtyMatch = text.match(/(\d+)/);
    if (qtyMatch) {
      const qty = parseInt(qtyMatch[1]);
      const result = await updateStock(convo.pending.product_id, qty);
      if (result) {
        await sendText(phone, `✅ entrada: +${qty} ${result.name}\nestoque: ${result.oldStock} → ${result.newStock}`, body);
      } else {
        await sendText(phone, "❌ erro ao atualizar estoque", body);
      }
      convo.state = null; convo.pending = null;
      return;
    }
  }

  // Recebeu imagem — analisa
  if (hasImage) {
    const imageUrl = await getMediaUrl(msg, body);
    if (!imageUrl) {
      await sendText(phone, "nao consegui pegar a imagem, manda de novo", body);
      return;
    }

    await sendText(phone, "📸 analisando...", body);

    const products = await getProducts();
    if (products.length > 0) {
      const match = await identifyProductForStock(imageUrl, products);
      if (match?.product_id && match.confidence !== 'low') {
        convo.state = 'awaiting_qty';
        convo.pending = match;
        await sendText(phone, `🔍 identifiquei: ${match.product_name}\nquantos chegaram?`, body);
        return;
      }
    }

    const analysis = await analyzeProductImage(imageUrl);
    if (!analysis) {
      await sendText(phone, "nao consegui identificar o produto. manda outra foto mais clara da caixa", body);
      return;
    }

    convo.state = 'awaiting_confirm';
    convo.pending = analysis;
    const msg_text = `🆕 produto novo identificado:
${analysis.brand} ${analysis.model} — ${analysis.flavor_pt}
${analysis.puffs} puffs
preço sugerido: R$${analysis.suggested_price}
copy: "${analysis.copy}"

confirma cadastro? (sim/nao)
ou ajusta: "preço 90" / "nome Elfbar Trio Blue Razz"`;
    await sendText(phone, msg_text, body);
    return;
  }

  // Mensagem de texto do Lucas sem imagem
  const lower = text.toLowerCase();
  if (lower.includes('estoque') || lower.includes('saldo')) {
    const products = await getProducts();
    const withStock = products.filter(p => p.stock > 0);
    if (!withStock.length) {
      await sendText(phone, "estoque vazio 📦", body);
    } else {
      const list = withStock.map(p => `${p.name}: ${p.stock}`).join('\n');
      await sendText(phone, `📦 estoque:\n${list}`, body);
    }
    return;
  }

  await sendText(phone, "manda a foto do pod que eu identifico 📸\nou digita 'estoque' pra ver o saldo", body);
}

// CAIXA — Baixa de estoque (venda física)
async function handleAdminCaixa(phone, msg, body) {
  const convo = getConvo(phone);
  const hasImage = isImageMessage(msg);
  const text = msg.text || msg.content || msg.caption || "";

  if (convo.state === 'awaiting_baixa_confirm' && convo.pending) {
    const lower = text.toLowerCase();
    if (lower.includes('sim') || lower.includes('ok') || lower === 's') {
      const result = await updateStock(convo.pending.product_id, -1);
      if (result) {
        await sendText(phone, `✅ baixa: ${result.name}\nestoque: ${result.oldStock} → ${result.newStock}`, body);
      } else {
        await sendText(phone, "❌ erro na baixa", body);
      }
      convo.state = null; convo.pending = null;
      return;
    } else if (lower.includes('não') || lower.includes('nao') || lower === 'n') {
      convo.state = null; convo.pending = null;
      await sendText(phone, "cancelado ✌️", body);
      return;
    }
  }

  if (hasImage) {
    const imageUrl = await getMediaUrl(msg, body);
    if (!imageUrl) {
      await sendText(phone, "nao peguei a imagem, manda de novo", body);
      return;
    }

    await sendText(phone, "📸 identificando...", body);

    const products = await getProducts();
    const match = await identifyProductForStock(imageUrl, products);

    if (!match?.product_id || match.confidence === 'low') {
      await sendText(phone, "nao identifiquei o produto. manda foto mais clara", body);
      return;
    }

    convo.state = 'awaiting_baixa_confirm';
    convo.pending = match;
    await sendText(phone, `🔍 ${match.product_name}\nconfirma baixa de 1 unidade? (sim/nao)`, body);
    return;
  }

  if (text && text.length > 1) {
    const products = await getProducts();
    const found = products.find(p =>
      p.id?.toLowerCase() === text.toLowerCase() ||
      p.name?.toLowerCase().includes(text.toLowerCase())
    );
    if (found) {
      convo.state = 'awaiting_baixa_confirm';
      convo.pending = { product_id: found.id, product_name: found.name };
      await sendText(phone, `🔍 ${found.name} (${found.stock || 0} em estoque)\nconfirma baixa? (sim/nao)`, body);
      return;
    }
  }

  await sendText(phone, "manda foto do pod vendido ou digita o nome 📸", body);
}

// ============ HANDLER PRINCIPAL ============
module.exports = async function handler(req, res) {
  console.log("[v5] METHOD:", req.method);

  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  try {
    const body = req.body;

    // Validação de segurança do webhook
    if (!isValidWebhook(body)) {
      console.log("[v5] REJECTED: invalid webhook payload");
      return res.status(200).send("invalid");
    }

    // Ignora eventos que não são mensagens (status, receipts, etc)
    const eventType = body.EventType || body.event || "";
    if (eventType && eventType !== "messages" && eventType !== "message") {
      console.log("[v5] SKIP event:", eventType);
      return res.status(200).send("skip-event");
    }

    const msg = body.message || {};
    const chat = body.chat || {};

    // Ignora mensagens próprias, enviadas pela API, ou sem conteúdo real
    if (msg.fromMe || msg.wasSentByApi) {
      console.log("[v5] SKIP: fromMe or wasSentByApi");
      return res.status(200).send("ignored");
    }

    // Ignora mensagens de status/broadcast
    if (msg.isStatusV3 || msg.broadcast || msg.status === "PENDING") {
      console.log("[v5] SKIP: status/broadcast");
      return res.status(200).send("status-ignored");
    }

    // ============ DEDUPLICAÇÃO BLINDADA ============
    // Extrai múltiplos IDs possíveis pra máxima cobertura
    const msgId = msg.id || msg.messageId || msg.key?.id || body.id || "";
    const rawPhone = chat.phone || msg.chatid?.replace("@s.whatsapp.net", "") || "";
    const phoneClean = rawPhone.replace(/[^0-9]/g, "");
    const msgText = msg.text || msg.content || "";

    // Cria chave composta: ID da mensagem + telefone (mais seguro que só ID)
    const dedupKey = msgId
      ? `${msgId}:${phoneClean}`
      : `${phoneClean}:${msgText.substring(0, 50)}:${Math.floor(Date.now() / 5000)}`;

    console.log("[v5] DEDUP check:", dedupKey.substring(0, 50), "msgId:", msgId ? "yes" : "NO");

    if (await isDuplicateSupabase(dedupKey)) {
      console.log("[v5] *** DUPLICATE BLOCKED ***");
      return res.status(200).send("duplicate");
    }

    // Limpa registros antigos em background
    cleanDedup();

    // Ignora grupos
    if (msg.isGroup || chat.wa_isGroup) {
      return res.status(200).send("group ignored");
    }

    // Extrai telefone final
    const phone = phoneClean;

    if (!phone) {
      return res.status(200).send("no phone");
    }

    console.log("[v5] PROCESSING:", phone.substring(0, 6) + "***", "TYPE:", msg.type || "text");

    // Rate limiting
    if (isRateLimited(phone)) {
      console.log("[v5] RATE LIMITED:", phone.substring(0, 6) + "***");
      return res.status(200).send("rate limited");
    }

    // ======== ROTEAMENTO POR NÚMERO ========

    // Admin Lucas — cadastro/entrada
    if (phone === ADMIN_LUCAS) {
      console.log("[v5] MODE: admin-lucas");
      await handleAdminLucas(phone, msg, body);
      return res.status(200).send("admin-lucas");
    }

    // Admin Caixa — baixa de estoque
    if (ADMIN_CAIXA && phone === ADMIN_CAIXA) {
      console.log("[v5] MODE: admin-caixa");
      await handleAdminCaixa(phone, msg, body);
      return res.status(200).send("admin-caixa");
    }

    // ======== CLIENTE NORMAL — MODELO RECEPCIONISTA ========
    // Bot sauda UMA VEZ na primeira mensagem, depois silencia.
    // Toda mensagem nova notifica o Andrade pra ele atender pessoalmente.
    const message = msg.text || msg.content || msg.caption || "";
    const convo = getConvo(phone);
    const isFirstContact = convo.messages.length === 0;

    // Registra mensagem no histórico (pra saber que já saudou)
    addMsg(phone, "user", message || "[mídia]");

    if (isFirstContact) {
      // PRIMEIRA MENSAGEM — sauda + manda link do catálogo
      console.log("[v5] FIRST CONTACT from", phone.substring(0, 6) + "***");
      const greeting = "e aí! aqui é o drope 🦎 vi tua mensagem, o andrade já vai te atender. enquanto isso, dá uma olhada no catálogo: drope-app.vercel.app";
      await sendText(phone, greeting, body);
      addMsg(phone, "assistant", greeting);

      // Notifica Andrade de novo contato
      if (ADMIN_LUCAS) {
        const clientName = msg.pushName || msg.notifyName || phone;
        const preview = message ? message.substring(0, 100) : "[mídia]";
        await sendText(ADMIN_LUCAS, `🆕 novo contato no drope!\n📱 ${clientName} (${phone})\n💬 "${preview}"\n\nresponde direto no whats`, body);
      }
    } else {
      // MENSAGENS SEGUINTES — bot silencia, só notifica Andrade
      console.log("[v5] FOLLOW-UP from", phone.substring(0, 6) + "*** (bot silent, notifying admin)");
      if (ADMIN_LUCAS) {
        const clientName = msg.pushName || msg.notifyName || phone;
        const preview = message ? message.substring(0, 100) : "[mídia]";
        await sendText(ADMIN_LUCAS, `💬 ${clientName}: "${preview}"`, body);
      }
    }

    return res.status(200).send("handled");

  } catch (err) {
    console.error("[v5] WEBHOOK ERROR:", err.message, err.stack);
    return res.status(200).send("error: " + err.message);
  }
};
