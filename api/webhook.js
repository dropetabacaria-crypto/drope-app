// Drope WhatsApp AI Agent — Vercel Serverless Function
// Conversa natural + histórico de mensagens + filosofia Nubank
// Recebe mensagens via Uazapi webhook, processa com Claude (Anthropic), responde no WhatsApp

const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN || "";
const CLAUDE_KEY = process.env.CLAUDE_KEY || "";

// Histórico de conversas em memória (sobrevive enquanto a instância estiver quente)
// Limpa automaticamente conversas com mais de 30 min sem atividade
const conversations = new Map();
const HISTORY_LIMIT = 10; // últimas 10 mensagens (5 trocas)
const HISTORY_TTL = 30 * 60 * 1000; // 30 minutos

function getHistory(phone) {
  const entry = conversations.get(phone);
  if (!entry) return [];
  if (Date.now() - entry.lastActivity > HISTORY_TTL) {
    conversations.delete(phone);
    return [];
  }
  return entry.messages;
}

function addToHistory(phone, role, content) {
  let entry = conversations.get(phone);
  if (!entry) {
    entry = { messages: [], lastActivity: Date.now() };
    conversations.set(phone, entry);
  }
  entry.messages.push({ role, content });
  entry.lastActivity = Date.now();
  if (entry.messages.length > HISTORY_LIMIT) {
    entry.messages = entry.messages.slice(-HISTORY_LIMIT);
  }
  if (conversations.size > 500) {
    const now = Date.now();
    for (const [key, val] of conversations) {
      if (now - val.lastActivity > HISTORY_TTL) conversations.delete(key);
    }
  }
}

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

Entrega: delivery ou retirada em SP. Pagamento: Pix antecipado (delivery) ou Pix/cartão (retirada). App: https://lojadrope.netlify.app
`;

const SYSTEM_PROMPT = `Voce e o assistente virtual da Drope, loja de pods descartaveis em Sao Paulo.

=== COMO ATENDER ===

PRIMEIRA MENSAGEM do cliente (oi, ola, eae, bom dia, etc):
Responda com uma saudacao acolhedora e natural, se apresente como assistente da Drope, e diga no que pode ajudar. Exemplo de tom:
"e ai! aqui e a Drope 🔥 tamo junto pra te ajudar com pods, precos, pedidos, entrega... manda a duvida que a gente resolve"

NAO use menu numerado. NAO liste opcoes 1, 2, 3. Seja natural como um amigo no WhatsApp.

MENSAGENS SEGUINTES:
- Voce tem o historico da conversa, entao NUNCA repita a saudacao. Continue a conversa de onde parou.
- Se o cliente ja perguntou algo antes, lembre e construa em cima.
- Responda direto a duvida usando o catalogo.

=== PILARES (Nubank) ===

ANTECIPAR: quando perceber que o cliente ta indeciso, sugira opcoes baseadas no que ele disse (ex: "se curte sabor gelado, o Ice King e brabo")
RESOLVER RAPIDO: responda a duvida completa no primeiro contato. Nao fique fazendo o cliente repetir.
CUIDAR: tom Gen Z brasileiro, informal, amigavel. Seja como um amigo que manja de pod, nao um robo.
EMPODERAR: se o cliente quer pedir, mande o link do app. Se quer saber preco, responde ali mesmo.

=== REGRAS ===
- BREVE: respostas curtas e diretas (WhatsApp, nao email). 2-4 linhas no maximo.
- Use "dropar" como verbo da marca naturalmente (ex: "bora dropar um Ice King?")
- Maximo 1-2 emojis por mensagem
- NUNCA invente produtos ou precos que nao estao no catalogo
- Para pedidos: mande o link do app https://lojadrope.netlify.app
- Pagamento: Pix antecipado (delivery) ou Pix/na hora (retirada)
- Entrega: delivery em SP (taxa combinada pelo WhatsApp) ou retirada
- Se nao souber responder, diga "vou confirmar com a equipe e ja te respondo"
- Se o cliente insistir ou a conversa ficar complexa demais, diga "vou te conectar com alguem da equipe pra resolver isso certinho, ja ja te respondem"
- Se mandar audio/imagem: "por enquanto so leio texto, manda escrito que te ajudo"

${CATALOGO}`;

module.exports = async function handler(req, res) {
  console.log("METHOD:", req.method);

  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  try {
    const body = req.body;
    console.log("PARSED:", JSON.stringify(body).substring(0, 500));

    const msg = body.message || {};
    const chat = body.chat || {};

    // Ignora mensagens próprias ou enviadas pela API
    if (msg.fromMe || msg.wasSentByApi) {
      console.log("IGNORED: fromMe or wasSentByApi");
      return res.status(200).send("ignored");
    }

    // Ignora grupos
    if (msg.isGroup || chat.wa_isGroup) {
      console.log("IGNORED: group message");
      return res.status(200).send("group ignored");
    }

    // Extrai telefone e mensagem
    const rawPhone = chat.phone || msg.chatid?.replace("@s.whatsapp.net", "") || "";
    const phone = rawPhone.replace(/[^0-9]/g, "");
    const message = msg.text || msg.content || "";

    console.log("PHONE:", phone);
    console.log("MESSAGE:", message);

    if (!message || !phone) {
      console.log("SKIPPED: no message or phone");
      return res.status(200).send("no message");
    }

    // Monta histórico da conversa
    const history = getHistory(phone);
    const messages = [...history, { role: "user", content: message }];

    console.log("Calling Claude AI... history:", history.length, "msgs");
    console.log("CLAUDE_KEY present:", !!CLAUDE_KEY, "length:", CLAUDE_KEY.length);

    const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    });

    const aiData = await aiResponse.json();
    console.log("AI RESPONSE STATUS:", aiResponse.status);
    console.log("AI DATA:", JSON.stringify(aiData).substring(0, 300));

    const reply = aiData.content?.[0]?.text || "opa, tive um problema aqui. ja vou chamar alguem da equipe pra te ajudar!";

    // Salva no histórico
    addToHistory(phone, "user", message);
    addToHistory(phone, "assistant", reply);

    // Envia via Uazapi
    console.log("Sending to:", phone, "via Uazapi");

    const serverUrl = body.BaseUrl || UAZAPI_SERVER;
    const token = body.token || UAZAPI_TOKEN;
    const sendUrl = `${serverUrl}/send/text`;

    console.log("SEND URL:", sendUrl);
    console.log("TOKEN present:", !!token, "length:", token.length);

    const sendResponse = await fetch(sendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "token": token
      },
      body: JSON.stringify({
        number: phone,
        text: reply
      })
    });

    const sendText = await sendResponse.text();
    console.log("SEND STATUS:", sendResponse.status);
    console.log("SEND RESPONSE:", sendText.substring(0, 400));

    return res.status(200).send("replied");

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message, err.stack);
    return res.status(200).send("error: " + err.message);
  }
};
