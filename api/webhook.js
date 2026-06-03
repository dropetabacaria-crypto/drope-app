const crypto = require('crypto');

// Drope WhatsApp AI Agent — Vercel Serverless Function v3
// 3 modos: atendimento cliente | cadastro/entrada (Lucas) | baixa estoque (caixa)
// Claude Vision (Haiku 4.5) + Grok image gen + Supabase storage + drope_products
//
// V3 (osso 9, 27/04/2026):
// - Tabela: products → drope_products (consistência com app)
// - Padrão A+ híbrido (gradient acid fade + aura cyan/pink, NÃO branco asséptico, NÃO caos cyber)
// - Upload de imagem pro Supabase Storage (URL Grok externa expira)
// - hidden=true até Andrade definir preço
// - Mensagens lo-fi authentic (minúsculas, sem corporativismo)
// - descricao_quebrada Gen Z favela (max 80 chars, max 1 emoji)
// - SEM vídeo (V1.5)
// - SEM hero shot Padrão B (V1.5: botão manual em /admin/products/:id/generate-hero)

// ============ CONFIG ============
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN || "";
const CLAUDE_KEY = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const REMOVEBG_API_KEY = process.env.REMOVEBG_API_KEY || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://udsjnhbkapjwpdolvtri.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";

// Mercado Pago — Pix
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";

// Whitelist: só esse número cadastra produto. Outros = cliente.
const ADMIN_LUCAS = process.env.ADMIN_LUCAS || "5511962443565";
// PDV — números que fazem baixa de estoque por foto (loja + Yasmin)
const PDV_PHONES = (process.env.PDV_PHONES || "5511924810126,5511962589670").split(',').filter(Boolean);
const ADMIN_CAIXA = PDV_PHONES[0] || "";

// OSSO 35 — Grupos WhatsApp (briefing 06/05/2026)
// Quando mensagem cai num grupo conhecido, roteia pro handler especifico.
// Grupo PDV reusa handleAdminCaixa (foto = baixa estoque).
// Grupo Motoboy ainda nao implementado (TAREFA 2A pendente).
const GRUPO_PDV_JID = process.env.GRUPO_PDV_JID || "120363425759858512@g.us";
const GRUPO_MOTOBOY_JID = process.env.GRUPO_MOTOBOY_JID || "";

// OSSO 32 — Fornecedores ativos do Drope (números informados pelo Andrade 03/05/2026).
// Se quiser desativar um fornecedor sem deletar, marca ativo:false.
const FORNECEDORES = [
  { nome: 'Amer',         phone: '5511966698290', ativo: true },
  { nome: 'Modelo',       phone: '5511933639730', ativo: true },
  { nome: 'Kalife Pods',  phone: '5511913403118', ativo: true },
];
const FORNECEDORES_ATIVOS = () => FORNECEDORES.filter(f => f.ativo);

// Storage bucket pra imagens geradas
const STORAGE_BUCKET = "drope-product-images";

// Custo cap diário hardcoded (anti-runaway)
const MAX_IMAGE_GEN_PER_DAY = 50;

// ============ CONSTITUIÇÃO DA IA-SERVO (lei interna) ============
// Preâmbulo prepended em todo system prompt que envolve julgamento.
// Documento completo: DROPE-DOUTRINA-IA-SERVO.md.
// Mudou aqui? Replica nos outros projetos (1 Clique, etc.) — Bibliotecário.
const IA_SERVO_PREAMBULO = `CONSTITUIÇÃO DA IA-SERVO (lei interna que rege seu comportamento):
- Você é serva. Sua grandeza vem da qualidade do serviço, nunca da autonomia conquistada.
- Você facilita a vida do criador (Andrade) E do cliente, ao mesmo tempo.
- Antes de cada ação, pergunte-se: "estou fazendo o meu melhor aqui?"
- Por default você apresenta opções; só age sozinha em comportamentos que o criador liberou.
- NUNCA: minta, processe pagamento sozinha, finja ser humana, exponha o motor, permita venda pra menor de 18, use memória pra manipular cliente.
- Qualidade vem antes de velocidade. Plantar vem antes de colher.

CONTEXTO ESPECÍFICO DESTE MINISTÉRIO:
`;

// ============ RATE LIMITING (OSSO 23 — Sistema Imune) ============
// Janela: 20 msgs por phone em 5 min. Cold start zera (Vercel serverless),
// aceitável pro MVP — atacante teria que coordenar com escala de instances.
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

function isRateLimited(phone) {
  // FIX 07/05/2026 (Andrade) — bypass rate limit pra ADMIN_LUCAS e PDV.
  // Admin manda lotes de 50+ fotos por natureza; rate limit estava bloqueando
  // 'fechar lote' silenciosamente quando Andrade mandava muitas fotos rapido.
  // PDV (Yasmin/Pai/Tia) tambem manda muitas fotos durante venda intensa.
  if (phone === ADMIN_LUCAS) return false;
  if (PDV_PHONES.includes(phone)) return false;
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

// ============ DEDUP DE EVENTOS UAZAPI ============
// UazAPI manda multiplos eventos por mensagem (às vezes com msgIds diferentes).
// Estratégia dupla:
//   1) dedup por msgId (caso ideal)
//   2) fallback: dedup por (phone+contentSig+bucket3s) — pega quando msgId varia ou
//      quando Vercel escala em instances diferentes (Map em memória zerado por instance).
// Nada disso sobrevive cold-start de instance NOVA, mas a janela típica de duplicação
// UazAPI é de milissegundos — quando 2 eventos chegam sequencialmente, em 99% dos
// casos vão pra mesma instance quente.
const seenMessageIds = new Map();
const seenContentSigs = new Map();
const SEEN_TTL = 5 * 60 * 1000;
const CONTENT_SIG_TTL = 10000; // 10s de janela (FIX TARDE 7 BUG 2): preview duplicado quando UazAPI reenvia evento >5s depois — antes 3s

function alreadySeen(msgId) {
  if (!msgId) return false;
  const ts = seenMessageIds.get(msgId);
  if (ts && Date.now() - ts < SEEN_TTL) return true;
  seenMessageIds.set(msgId, Date.now());
  if (seenMessageIds.size > 500) {
    const now = Date.now();
    for (const [k, t] of seenMessageIds) {
      if (now - t > SEEN_TTL) seenMessageIds.delete(k);
    }
  }
  return false;
}

// Dedup secundário por conteúdo: previne 2 eventos com msgIds diferentes mas mesmo phone+texto.
// In-memory pra fast path (mesma instance Vercel).
function alreadySeenContent(phone, sig) {
  if (!phone || !sig) return false;
  const key = `${phone}:${sig}`;
  const ts = seenContentSigs.get(key);
  if (ts && Date.now() - ts < CONTENT_SIG_TTL) return true;
  seenContentSigs.set(key, Date.now());
  if (seenContentSigs.size > 500) {
    const now = Date.now();
    for (const [k, t] of seenContentSigs) {
      if (now - t > CONTENT_SIG_TTL) seenContentSigs.delete(k);
    }
  }
  return false;
}

// Dedup terciário (cross-instance): chama drope_check_dedup no Supabase.
// Usado quando in-memory diz "não vi" mas pode ser que outra instance Vercel viu.
// Custa 1 round-trip pro DB (~50-150ms) — caro, mas resolve o problema de cold-start.
async function alreadySeenContentPersistent(phone, sig, ttlSeconds = 5) {
  if (!phone || !sig) return false;
  if (!SUPABASE_URL || !SUPABASE_KEY) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_check_dedup`, {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify({ p_phone: phone, p_sig: sig, p_ttl: ttlSeconds }),
    });
    if (!r.ok) {
      console.error('[dedup-persistent] error:', r.status);
      return false; // fail-open: se DB der erro, não bloqueia o fluxo
    }
    const result = await r.json();
    return result === true;
  } catch (e) {
    console.error('[dedup-persistent] exception:', e.message);
    return false;
  }
}

// ============ CADASTRO PENDENTE (state machine + persistência) ============
// Map em-memória é fast path (mesma instance Vercel). Persistência em
// drope_pending_state cobre cold-start (Lucas demora >5min entre passos).
const pendingRegistrations = new Map();
const PENDING_TTL = 10 * 60 * 1000;        // 10min de validade do pending
const PERSISTED_TTL_MS = 30 * 60 * 1000;   // 30min — fallback no banco mais permissivo

async function persistPending(phone, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const payload = JSON.stringify({ phone, state: data, updated_at: new Date().toISOString() });
  // FIX TARDE 9: logging detalhado pra detectar persist failures silenciosos. Se payload
  // > 1MB (foto caixa+pod base64 podem chegar perto), Supabase pode rejeitar e o estado
  // fica stale → bug "estado conflitante" (uma invocation lê stale, outra lê atual).
  if (payload.length > 100000) {
    console.warn(`[persistPending] LARGE payload phone=${phone.slice(0,6)}*** size=${payload.length} bytes (mode=${data?.mode}/step=${data?.step})`);
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/drope_pending_state`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: payload,
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.error(`[persistPending] FAILED http=${r.status} payload_size=${payload.length} mode=${data?.mode}/step=${data?.step} body=${errBody.slice(0, 300)}`);
    }
  } catch (e) {
    console.error(`[persistPending] EXCEPTION payload_size=${payload.length} mode=${data?.mode}/step=${data?.step}:`, e.message);
  }
}

async function loadPersistedPending(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const cutoff = new Date(Date.now() - PERSISTED_TTL_MS).toISOString();
  const filter = `phone=eq.${encodeURIComponent(phone)}&updated_at=gt.${encodeURIComponent(cutoff)}&select=state&limit=1`;
  const rows = await sbGet('drope_pending_state', filter);
  return rows[0]?.state || null;
}

async function deletePersistedPending(phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/drope_pending_state?phone=eq.${encodeURIComponent(phone)}`, {
      method: 'DELETE',
      headers: sbHeaders(),
    });
  } catch (e) {
    console.error('[deletePersistedPending] err:', e.message);
  }
}

async function getPending(phone) {
  // Fast path: memory (mesma instance Vercel)
  const inMem = pendingRegistrations.get(phone);
  let current = null;
  if (inMem) {
    if (Date.now() - inMem.timestamp <= PENDING_TTL) {
      current = inMem;
    } else {
      pendingRegistrations.delete(phone);
    }
  }
  // Slow path: banco (cold start ou instance diferente)
  if (!current) {
    try {
      const persisted = await loadPersistedPending(phone);
      if (persisted) {
        pendingRegistrations.set(phone, { ...persisted, timestamp: Date.now() });
        console.log('[getPending] recovered from DB for', phone.slice(0, 6) + '***', 'mode:', persisted.mode, 'step:', persisted.step);
        current = persisted;
      }
    } catch (e) {
      console.error('[getPending DB] err:', e.message);
    }
  }

  // FIX TARDE 9: source of truth defensiva. Cobre o bug "estado conflitante" onde uma
  // invocation lê pending stale (ex: awaiting_barcode_text) e responde "código inválido"
  // mesmo depois do cadastro ter COMPLETADO (produto em awaiting_approval).
  //
  // Skip otimização: só faz a query extra (~50ms) se vale a pena verificar:
  //   - current é null (cold-start sem nada) → talvez tenha produto recente esperando
  //   - current é cadastro_3photos com timestamp ANTIGO (>3min) → resíduo provável
  //   - current é stock_entry/abastecimento com timestamp antigo → idem
  //
  // NÃO faz a query se: current é art_review/art_review_failed (já tá certo) OU current
  // é cadastro_3photos ATIVO (<3min). Economiza Supabase calls em flow normal.
  const currentTimestamp = current?.timestamp || 0;
  const currentAge = currentTimestamp ? (Date.now() - currentTimestamp) : Infinity;
  const currentIsArtReview = current?.mode === 'art_review' || current?.mode === 'art_review_failed';
  const currentIsActiveFlow = currentAge < 3 * 60 * 1000 && (current?.mode === 'cadastro_3photos' || current?.mode === 'abastecimento' || current?.mode === 'stock_entry');
  const shouldCheckTruth = !currentIsArtReview && !currentIsActiveFlow;

  if (shouldCheckTruth) {
    try {
      const recovered = await tryRecoverPending(phone);
      if (recovered && recovered.productId && recovered.productCreatedAt) {
        const productAge = Date.now() - new Date(recovered.productCreatedAt).getTime();
        const productRecent = productAge < 30 * 60 * 1000; // 30min
        if (productRecent) {
          console.warn(`[getPending] OVERRIDE stale → ${recovered.mode} productId=${recovered.productId} age=${Math.round(productAge/1000)}s (was ${current?.mode || 'null'}/${current?.step || '-'} age=${currentAge === Infinity ? 'inf' : Math.round(currentAge/1000) + 's'})`);
          const newPending = { ...recovered, timestamp: Date.now() };
          pendingRegistrations.set(phone, newPending);
          await persistPending(phone, recovered);
          return recovered;
        }
      }
    } catch (e) {
      console.error('[getPending source-of-truth check] err:', e.message);
    }
  }

  return current;
}

async function setPending(phone, data) {
  // FIX TARDE 8 (BUG SIM REINICIA): logging [STATE] em toda transição. Permite rastrear
  // exatamente quando e por quê o step mudou nos logs do Vercel.
  const oldEntry = pendingRegistrations.get(phone);
  const oldMode = oldEntry?.mode || 'none';
  const oldStep = oldEntry?.step || 'none';
  const newMode = data?.mode || 'none';
  const newStep = data?.step || 'none';
  if (oldMode !== newMode || oldStep !== newStep) {
    console.log(`[STATE] phone=${phone.slice(0,6)}*** ${oldMode}/${oldStep} → ${newMode}/${newStep}`);
  }
  pendingRegistrations.set(phone, { ...data, timestamp: Date.now() });
  if (pendingRegistrations.size > 100) {
    const now = Date.now();
    for (const [k, v] of pendingRegistrations) {
      if (now - v.timestamp > PENDING_TTL) pendingRegistrations.delete(k);
    }
  }
  // Persist em DB (await pra evitar race condition se Lucas mandar 2 msgs em sequência)
  await persistPending(phone, data);
}

async function clearPending(phone) {
  // FIX TARDE 8: logging [STATE] em clear pra rastrear quem limpou pending (causa de
  // bugs como "SIM reinicia fluxo" quando clearPending residual rodava entre flows).
  const oldEntry = pendingRegistrations.get(phone);
  if (oldEntry) {
    const stack = new Error().stack?.split('\n').slice(2, 5).map(s => s.trim()).join(' | ') || '?';
    console.log(`[STATE] phone=${phone.slice(0,6)}*** CLEARED (was ${oldEntry.mode || 'none'}/${oldEntry.step || 'none'}) trace: ${stack.slice(0, 250)}`);
  }
  pendingRegistrations.delete(phone);
  // Delete fire-and-forget — falha aqui não trava o fluxo
  deletePersistedPending(phone).catch(e => console.error('[clearPending DB] err:', e.message));
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
  const txt = await r.text();
  if (!r.ok) {
    console.error(`[SB] INSERT ${table} error:`, r.status, txt);
    sbInsert._lastError = `${r.status}: ${txt.slice(0, 400)}`;
    return null;
  }
  sbInsert._lastError = null;
  try {
    const rows = JSON.parse(txt);
    return Array.isArray(rows) ? rows[0] : rows;
  } catch { return null; }
}
sbInsert._lastError = null;

async function sbUpdate(table, filter, data) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}`;
  const headers = sbHeaders({ 'Prefer': 'return=representation' });
  const r = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(data) });
  if (!r.ok) { console.error(`[SB] UPDATE ${table} error:`, r.status, await r.text()); return null; }
  return r.json();
}

// ============ OSSO 23 — SISTEMA IMUNE ============
// Tabela central de auditoria (drope_system_log). Cobre health, custos, erros,
// rate limit, auto-hide. Falha silenciosa: se logar quebrar, NÃO derruba caller.
async function logSystemEvent(action, detail = {}, phone = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !action) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/drope_system_log`, {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify({
        action: String(action).slice(0, 60),
        detail: typeof detail === 'object' ? detail : { value: detail },
        phone: phone ? String(phone).slice(0, 30) : null,
      }),
    });
  } catch (e) { /* swallow — log nunca trava o sistema */ }
}

// Custos estimados em BRL por chamada (MVP — refinar quando tiver dados reais).
const API_COSTS = {
  claude_haiku: 0.001,   // ~R$ 0.001 por mensagem (input+output curtos)
  claude_vision: 0.012,  // ~R$ 0.012 por análise de foto (tokens maiores)
  grok_image:   0.05,    // ~R$ 0.05 por arte gerada
  grok_video:   0.20,    // ~R$ 0.20 por vídeo
  uazapi_msg:   0.002,   // ~R$ 0.002 por mensagem WhatsApp enviada
};

async function logApiCost(apiName, detail = {}) {
  const cost = API_COSTS[apiName] || 0;
  await logSystemEvent('api_cost', {
    api: apiName,
    estimated_cost_brl: cost,
    ...detail,
  });
}

// Wrapper genérico pra crons. Tenta 1x, espera 3s, tenta de novo. Se falhar
// 2x: loga error + WhatsApp pro Andrade. Sucessos vão pra `cron_run`.
async function withRetry(actionName, fn) {
  const startTime = Date.now();
  try {
    const result = await fn();
    await logSystemEvent('cron_run', {
      cron: actionName,
      status: 'ok',
      ms: Date.now() - startTime,
    });
    return result;
  } catch (err) {
    console.warn(`[withRetry] ${actionName} falhou (1ª): ${err.message}, retry em 3s`);
    await new Promise(r => setTimeout(r, 3000));
    try {
      const result = await fn();
      await logSystemEvent('cron_run', {
        cron: actionName,
        status: 'ok_after_retry',
        first_error: err.message,
        ms: Date.now() - startTime,
      });
      return result;
    } catch (retryErr) {
      await logSystemEvent('error', {
        cron: actionName,
        error: retryErr.message,
        ms: Date.now() - startTime,
      });
      try {
        if (ADMIN_LUCAS) {
          await sendText(ADMIN_LUCAS,
            `🔴 CRON FALHOU: ${actionName}\nErro: ${retryErr.message}\nRetry também falhou.`,
            {});
        }
      } catch (e) { /* alerta best-effort */ }
      throw retryErr;
    }
  }
}

// Esconde produtos com estoque zerado e avisa o Andrade.
// Usado pelo system_health e potencialmente pelo save-order após decremento.
async function checkAndAutoHideZeroStock() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { hidden: 0 };
  const zeroProducts = await sbGet('drope_products',
    'select=id,name&hidden=eq.false&qty_available=lte.0&limit=50');
  if (!Array.isArray(zeroProducts) || zeroProducts.length === 0) {
    return { hidden: 0 };
  }
  const names = [];
  for (const p of zeroProducts) {
    await sbUpdate('drope_products', `id=eq.${p.id}`, { hidden: true });
    names.push(p.name);
    await logSystemEvent('auto_hide', {
      product_id: p.id,
      name: p.name,
      reason: 'stock_zero',
    });
  }
  if (names.length > 0 && ADMIN_LUCAS) {
    try {
      await sendText(ADMIN_LUCAS,
        `🦎 ESTOQUE ZEROU — escondi do catálogo:\n${names.map(n => `• ${n}`).join('\n')}\n\nReabasteça e eu reativo.`,
        {});
    } catch (e) { /* best-effort */ }
  }
  return { hidden: names.length, products: names };
}

// Limpeza diária do system_log (mantém 30 dias). Usa DELETE em /rest/v1/.
async function cleanupSystemLog() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { deleted: 0 };
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_system_log?created_at=lt.${encodeURIComponent(cutoff)}`,
      { method: 'DELETE', headers: sbHeaders({ 'Prefer': 'return=minimal' }) }
    );
    if (!r.ok) {
      console.warn('[cleanupSystemLog] status:', r.status);
      return { deleted: 0, error: r.status };
    }
    return { deleted: 'unknown', cutoff };
  } catch (e) {
    console.error('[cleanupSystemLog] err:', e.message);
    return { deleted: 0, error: e.message };
  }
}

// GET/POST /api/webhook?action=system_health&token=CRON_TOKEN
// Cron a cada 15min. Verifica Supabase, UazAPI, frescor de outros crons,
// estoque zerado. Alerta Andrade se status != 'healthy'.
// ============ ADMIN DIAG ============
// GET /api/webhook?action=admin_diag&token=ADMIN_TOKEN
// Devolve env vars (mascaradas), pending atual do Lucas, motoboys cadastrados,
// corridas recentes, dedup recente, system_log recente. Pra debug sem logs Vercel.
function _diagMask(v) {
  if (!v) return "(vazio)";
  if (v.length <= 8) return v[0] + "***" + v.slice(-1);
  return v.slice(0, 4) + "***" + v.slice(-4);
}
async function _diagSb(table, qs) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) return { error: r.status, body: (await r.text()).slice(0, 300) };
    return r.json();
  } catch (e) { return { error: e.message }; }
}
async function handleAdminDiag(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  let queryTok = '';
  try {
    const qs = (req.url || '').split('?')[1] || '';
    const m = qs.split('&').find(x => x.startsWith('token='));
    if (m) queryTok = decodeURIComponent(m.slice(6));
  } catch (e) {}
  const headerTok = req.headers['x-admin-token'] || '';
  if (!ADMIN_TOKEN || (headerTok !== ADMIN_TOKEN && queryTok !== ADMIN_TOKEN)) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  const out = {
    ok: true,
    now: new Date().toISOString(),
    deploy: {
      vercel_url: process.env.VERCEL_URL || null,
      vercel_env: process.env.VERCEL_ENV || null,
      git_sha: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) || null,
      git_msg: (process.env.VERCEL_GIT_COMMIT_MESSAGE || '').slice(0, 100),
    },
    env: {
      ADMIN_LUCAS,
      PDV_PHONES: PDV_PHONES.join(','),
      GRUPO_PDV_JID: GRUPO_PDV_JID || "(vazio)",
      GRUPO_MOTOBOY_JID: GRUPO_MOTOBOY_JID || "(vazio)",
      UAZAPI_SERVER,
      UAZAPI_TOKEN: _diagMask(UAZAPI_TOKEN),
      ADMIN_TOKEN: _diagMask(ADMIN_TOKEN),
      ANTHROPIC: _diagMask(CLAUDE_KEY),
      SUPABASE_URL: SUPABASE_URL || "(vazio)",
      SUPABASE_KEY: _diagMask(SUPABASE_KEY),
      SERPER: _diagMask(SERPER_API_KEY),
      XAI: _diagMask(XAI_API_KEY),
    },
  };

  out.lucas_pending = await _diagSb('drope_pending_state', `phone=eq.${ADMIN_LUCAS}&select=phone,state,updated_at&order=updated_at.desc&limit=3`);
  out.motoboys = await _diagSb('drope_motoboys',
    'select=phone,nome,ativo,score,corridas_entregues,corridas_canceladas&order=score.desc&limit=20');
  out.corridas = await _diagSb('drope_corridas',
    'select=id,order_id,status,motoboy_nome,valor_motoboy_cents,posted_at,accepted_at,delivered_at,cancel_reason&order=posted_at.desc.nullslast&limit=10');
  // drope_dedup eh a tabela real (drope_check_dedup RPC). webhook_dedup eh legado vazio.
  out.dedup_recent = await _diagSb('drope_dedup',
    `phone=eq.${ADMIN_LUCAS}&select=phone,sig,seen_at&order=seen_at.desc&limit=20`);
  out.system_log = await _diagSb('drope_system_log',
    'select=action,phone,detail,created_at&order=created_at.desc&limit=15');

  // Status UazAPI (se conectado)
  try {
    const r = await fetch(`${UAZAPI_SERVER}/instance/status`, {
      headers: { token: UAZAPI_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    out.uazapi_status = { http: r.status, body: r.ok ? await r.json() : (await r.text()).slice(0, 200) };
  } catch (e) { out.uazapi_status = { error: e.message }; }

  return res.status(200).json(out);
}

// ============ SISTEMA IMUNE — RELATORIO SEMANAL ============
// GET /api/webhook?action=weekly_imune_report (cron domingo 10h BRT = 13h UTC)
// Manda pro ADMIN_LUCAS um resumo da semana:
//   - Vendas pendentes que ainda NAO foram cadastradas (alerta pra Andrade cadastrar)
//   - Reconciliacoes que rolaram (produtos cadastrados que tinham vendas pendentes)
//   - Top vendedores de itens nao cadastrados (Yasmin/Pai/Tia indicador de gap de catalogo)
async function handleWeeklyImuneReport(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ ok: false, error: 'supabase not configured' });

  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1) Pendentes ainda nao cadastrados (status=pending)
  const pendentes = await sbGet('drope_pending_sales',
    `select=vision_brand,vision_model,vision_flavor_en,vision_flavor_pt,qty,vendido_em,vendedor_phone&status=eq.pending&order=vendido_em.desc&limit=200`);

  // 2) Reconciliacoes recentes (resolvidas nos ultimos 7d)
  const resolvidas = await sbGet('drope_pending_sales',
    `select=vision_brand,vision_model,vision_flavor_en,qty,resolved_at,resolved_product_id,resolved_method&status=eq.resolved&resolved_at=gt.${encodeURIComponent(cutoff7d)}&order=resolved_at.desc&limit=100`);

  // Agrega pendentes por marca+modelo+sabor
  const pendAgg = {};
  for (const ps of (pendentes || [])) {
    const key = [ps.vision_brand, ps.vision_model, ps.vision_flavor_en || ps.vision_flavor_pt].filter(Boolean).join(' ') || '(sem nome)';
    if (!pendAgg[key]) pendAgg[key] = { qty: 0, vendedores: new Set(), primeira_venda: null, ultima_venda: null };
    pendAgg[key].qty += (ps.qty || 1);
    pendAgg[key].vendedores.add((ps.vendedor_phone || '').slice(0, 6) + '***');
    if (!pendAgg[key].primeira_venda || ps.vendido_em < pendAgg[key].primeira_venda) pendAgg[key].primeira_venda = ps.vendido_em;
    if (!pendAgg[key].ultima_venda || ps.vendido_em > pendAgg[key].ultima_venda) pendAgg[key].ultima_venda = ps.vendido_em;
  }

  // Agrega reconciliacoes por produto
  const recAgg = {};
  for (const r of (resolvidas || [])) {
    const key = [r.vision_brand, r.vision_model, r.vision_flavor_en].filter(Boolean).join(' ') || '(sem nome)';
    if (!recAgg[key]) recAgg[key] = { qty: 0, count: 0 };
    recAgg[key].qty += (r.qty || 1);
    recAgg[key].count++;
  }

  // Monta mensagem
  const lines = ['🛡️ *Sistema Imune — Relatório Semanal*', ''];
  if (Object.keys(pendAgg).length === 0 && Object.keys(recAgg).length === 0) {
    lines.push('✅ tudo zerado: nenhuma venda pendente, nenhuma reconciliação na semana.');
  } else {
    if (Object.keys(pendAgg).length > 0) {
      lines.push(`⏳ *${Object.keys(pendAgg).length} produto${Object.keys(pendAgg).length>1?'s':''} ainda não cadastrado${Object.keys(pendAgg).length>1?'s':''}*`);
      lines.push('(Yasmin/Pai/Tia já venderam — cadastra via lote pra reconciliar)');
      lines.push('');
      const sorted = Object.entries(pendAgg).sort((a, b) => b[1].qty - a[1].qty).slice(0, 15);
      for (const [name, data] of sorted) {
        const dataPrim = data.primeira_venda ? new Date(data.primeira_venda).toLocaleDateString('pt-BR') : '?';
        lines.push(`• ${name}: ${data.qty} venda${data.qty>1?'s':''} (desde ${dataPrim})`);
      }
      if (Object.keys(pendAgg).length > 15) lines.push(`... +${Object.keys(pendAgg).length - 15} outros`);
      lines.push('');
    }
    if (Object.keys(recAgg).length > 0) {
      lines.push(`✅ *${Object.keys(recAgg).length} reconciliação${Object.keys(recAgg).length>1?'ões':''} essa semana*`);
      lines.push('(produtos cadastrados que tinham vendas pendentes — baixa retroativa aplicada)');
      lines.push('');
      for (const [name, data] of Object.entries(recAgg)) {
        lines.push(`• ${name}: ${data.qty} unidade${data.qty>1?'s':''} reconciliada${data.qty>1?'s':''}`);
      }
      lines.push('');
    }
  }
  lines.push('🦎 (relatório roda toda semana — domingo 10h)');

  const msg = lines.join('\n');
  try { await sendText(ADMIN_LUCAS, msg, {}); } catch (e) { console.warn('[imune-report] send err:', e.message); }
  try { await logSystemEvent('weekly_imune_report', { pendentes: Object.keys(pendAgg).length, reconciliadas: Object.keys(recAgg).length }, ADMIN_LUCAS); } catch (_) {}
  return res.status(200).json({ ok: true, pendentes: Object.keys(pendAgg).length, reconciliadas: Object.keys(recAgg).length });
}

// ============ PAINEL ADMIN DO BALANÇO (07/05/2026 - Andrade) ============
// GET /api/webhook?action=balance_panel&token=ADMIN_TOKEN
// Mostra: estoque atual com qty | balanços recentes | divergências históricas | taxa de acerto
async function handleBalancePanel(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let queryTok = '';
  try {
    const qs = (req.url || '').split('?')[1] || '';
    const m = qs.split('&').find(x => x.startsWith('token='));
    if (m) queryTok = decodeURIComponent(m.slice(6));
  } catch (e) {}
  if (!ADMIN_TOKEN || queryTok !== ADMIN_TOKEN) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).send('unauthorized');
  }

  // 1) Estoque atual
  const stock = await sbGet('drope_products',
    'select=id,name,qty_available,total_sold,updated_at&hidden=eq.false&order=name.asc&limit=500');

  // 2) Eventos de balanço aplicado (últimos 10) do system_log
  const events = await sbGet('drope_system_log',
    `select=detail,created_at&action=eq.inventory_applied&order=created_at.desc&limit=10`);

  // 3) Contagens recentes de balanço (status applied) por batch_id
  const countsHist = await sbGet('drope_inventory_count',
    'select=batch_id,product_id,qty_counted,status,created_at&status=eq.applied&order=created_at.desc&limit=200');

  // Agrega por batch_id
  const batches = {};
  for (const c of (countsHist || [])) {
    if (!batches[c.batch_id]) batches[c.batch_id] = { batch_id: c.batch_id, total_items: 0, total_qty: 0, first_created: c.created_at, last_created: c.created_at };
    batches[c.batch_id].total_items++;
    batches[c.batch_id].total_qty += (c.qty_counted || 0);
    if (c.created_at < batches[c.batch_id].first_created) batches[c.batch_id].first_created = c.created_at;
    if (c.created_at > batches[c.batch_id].last_created) batches[c.batch_id].last_created = c.created_at;
  }
  const batchList = Object.values(batches).sort((a, b) => b.last_created.localeCompare(a.last_created));

  // 4) Pendências (balanços em andamento que não foram aplicados nem descartados)
  const pending = await sbGet('drope_inventory_count',
    'select=batch_id,phone&status=eq.pending&order=created_at.desc&limit=200');
  const pendingBatches = {};
  for (const p of (pending || [])) {
    if (!pendingBatches[p.batch_id]) pendingBatches[p.batch_id] = { phone: p.phone, count: 0 };
    pendingBatches[p.batch_id].count++;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rowsStock = (stock || []).map(p => {
    const qty = p.qty_available || 0;
    const cls = qty === 0 ? 'zero' : (qty <= 2 ? 'low' : 'ok');
    return `<tr class="${cls}"><td>${esc(p.id)}</td><td>${esc(p.name)}</td><td class="num">${qty}</td><td class="num">${p.total_sold || 0}</td><td class="dim">${esc((p.updated_at||'').slice(0,16).replace('T',' '))}</td></tr>`;
  }).join('');

  const rowsBatches = batchList.map(b => `<tr><td><code>${esc(b.batch_id.slice(0, 8))}</code></td><td class="num">${b.total_items}</td><td class="num">${b.total_qty}</td><td class="dim">${esc(b.first_created.slice(0,16).replace('T',' '))} → ${esc(b.last_created.slice(11,16))}</td></tr>`).join('');

  const rowsPending = Object.entries(pendingBatches).map(([bid, info]) => `<tr><td><code>${esc(bid.slice(0, 8))}</code></td><td>${esc(info.phone.slice(0,6) + '***')}</td><td class="num">${info.count}</td></tr>`).join('');

  const html = `<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drope ✦ Painel Balanço</title>
<style>
:root { --bg:#0a0a14; --neon:#b026ff; --lime:#c0ff33; --pink:#ff2d95; --txt:#eaeaf2; --dim:#888; --card:#13131e; --border:#2a2a3e; }
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,system-ui,sans-serif;padding:16px}
h1{color:var(--neon);margin:0 0 6px;font-size:22px}
.sub{color:var(--dim);font-size:13px;margin-bottom:24px}
.section{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:18px}
.section h2{color:var(--lime);margin:0 0 12px;font-size:14px;text-transform:uppercase;letter-spacing:1px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase}
td{padding:8px;border-bottom:1px solid #1a1a2a}
.num{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:var(--dim);font-size:12px}
tr.zero td{color:#ff6b6b}
tr.low td{color:#ffa500}
code{background:#1a1a2a;padding:2px 6px;border-radius:4px;font-size:11px;color:var(--lime)}
.empty{color:var(--dim);font-style:italic;padding:12px 0;text-align:center}
.kpis{display:flex;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.kpi{flex:1;min-width:140px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px}
.kpi .v{font-size:24px;font-weight:700;color:var(--lime)}
.kpi .l{font-size:11px;color:var(--dim);text-transform:uppercase;margin-top:4px}
.kpi.warn .v{color:#ffa500}
.kpi.zero .v{color:#ff6b6b}
.actions{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:8px 14px;border-radius:6px;border:1px solid var(--neon);background:transparent;color:var(--neon);font-size:12px;text-decoration:none;cursor:pointer}
.btn:hover{background:var(--neon);color:#0a0a14}
</style>
</head><body>
<h1>📊 painel balanço — drope</h1>
<div class="sub">conferência fisica vs digital — historico e estado atual</div>

<div class="kpis">
  <div class="kpi"><div class="v">${(stock||[]).length}</div><div class="l">produtos visíveis</div></div>
  <div class="kpi warn"><div class="v">${(stock||[]).filter(p => (p.qty_available||0) > 0 && (p.qty_available||0) <= 2).length}</div><div class="l">estoque baixo (≤2)</div></div>
  <div class="kpi zero"><div class="v">${(stock||[]).filter(p => (p.qty_available||0) === 0).length}</div><div class="l">zerados</div></div>
  <div class="kpi"><div class="v">${batchList.length}</div><div class="l">balanços aplicados</div></div>
  <div class="kpi warn"><div class="v">${Object.keys(pendingBatches).length}</div><div class="l">balanços em aberto</div></div>
</div>

${Object.keys(pendingBatches).length > 0 ? `
<div class="section">
  <h2>⏳ balanços em andamento</h2>
  <table><thead><tr><th>batch</th><th>phone</th><th>contagens</th></tr></thead>
  <tbody>${rowsPending}</tbody></table>
</div>` : ''}

<div class="section">
  <h2>📦 estoque atual</h2>
  <table><thead><tr><th>id</th><th>nome</th><th>qty</th><th>vendidos</th><th>atualizado</th></tr></thead>
  <tbody>${rowsStock || '<tr><td colspan="5" class="empty">sem produtos</td></tr>'}</tbody></table>
</div>

<div class="section">
  <h2>🗂️ histórico de balanços aplicados</h2>
  ${batchList.length ? `<table><thead><tr><th>batch</th><th>itens</th><th>qty total</th><th>quando</th></tr></thead><tbody>${rowsBatches}</tbody></table>` : '<div class="empty">nenhum balanço aplicado ainda. manda \'balanço\' no whats pra começar.</div>'}
</div>

<div class="actions">
  <a class="btn" href="/api/webhook?action=admin_hub&token=${esc(queryTok)}">← admin hub</a>
  <a class="btn" href="/api/webhook?action=admin_diag&token=${esc(queryTok)}">diag</a>
</div>
</body></html>`;
  return res.status(200).send(html);
}

// TIER 1.4 (08/05/2026 - Andrade) — Recovery de produtos travados em "generating".
// Cenário: Grok demora >60s, Vercel mata invocação, image_status fica 'generating'
// permanente. Antes: produto morto pra sempre. Agora: cron diário detecta e re-dispara.
async function handleArtStuckRecovery(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const stuck = await sbGet('drope_products',
    `select=id,name,updated_at&image_status=eq.generating&updated_at=lt.${encodeURIComponent(new Date(Date.now() - 5*60*1000).toISOString())}&limit=20`);
  const arr = Array.isArray(stuck) ? stuck : [];
  if (arr.length === 0) {
    return res.status(200).json({ ok: true, found: 0 });
  }
  console.log(`[art-stuck-recovery] found ${arr.length} produtos travados em 'generating'`);
  let recovered = 0;
  for (const p of arr) {
    try {
      await sbUpdate('drope_products', `id=eq.${p.id}`, {
        image_status: 'pending_art',
        art_status: 'reference_approved',
      });
      // Re-dispara em invocacao Vercel separada (nao bloqueia esse cron)
      await fireBackgroundArtGeneration(p.id, ADMIN_LUCAS, 1);
      recovered++;
      console.log(`[art-stuck-recovery] re-disparado productId=${p.id} ${p.name}`);
    } catch (e) { console.warn('[art-stuck-recovery]', p.id, e.message); }
  }
  try { await logSystemEvent('art_stuck_recovered', { found: arr.length, recovered }, ADMIN_LUCAS); } catch (_) {}
  if (recovered > 0) {
    try {
      await sendText(ADMIN_LUCAS,
        `🔧 *Recovery automático*\n\n${recovered} produtos travados em 'generating' foram destravados e re-disparados pra Grok.`,
        {});
    } catch (_) {}
  }
  return res.status(200).json({ ok: true, found: arr.length, recovered });
}

// Painel HTML pra Andrade ver fotos do batch que ficaram sem sabor identificavel
// (Vision viu marca/modelo mas nao leu o sabor) e completar via formulario web.
async function handleUnidentifiedPhotos(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  let queryTok = '';
  try {
    const qs = (req.url || '').split('?')[1] || '';
    const m = qs.split('&').find(x => x.startsWith('token='));
    if (m) queryTok = decodeURIComponent(m.slice(6));
  } catch (e) {}
  if (!ADMIN_TOKEN || queryTok !== ADMIN_TOKEN) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).send('unauthorized');
  }

  const rows = await sbGet('drope_batch_queue',
    `select=id,batch_id,photo_index,photo_url,vision_response,error_message,created_at&decision=eq.unidentified_flavor&order=created_at.desc&limit=200`);
  const arr = Array.isArray(rows) ? rows : [];

  // Agrupa por batch_id e dedupa por photo_index
  const seen = new Set();
  const unique = [];
  for (const r of arr) {
    const k = `${r.batch_id}:${r.photo_index}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (r.photo_url) unique.push(r);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const cards = unique.map(r => {
    let brand = '?', model = '';
    try {
      const vis = typeof r.vision_response === 'string' ? JSON.parse(r.vision_response) : r.vision_response;
      const p = vis?.products?.[0] || {};
      brand = p.brand || '?';
      model = p.model || '';
    } catch (_) {}
    return `
      <div class="card" data-batch-id="${esc(r.batch_id)}" data-photo-idx="${esc(r.photo_index)}">
        <div class="thumb"><img src="${esc(r.photo_url)}" loading="lazy" alt="foto"/></div>
        <div class="meta">
          <div class="info">
            <span class="brand">${esc(brand)}</span>
            <span class="model">${esc(model)}</span>
            <span class="idx">foto #${esc(r.photo_index)}</span>
          </div>
          <input type="text" class="flavor-input" placeholder="digita o sabor (ex: Strawberry Kiwi)" />
          <div class="actions">
            <button class="btn complete">✅ cadastrar</button>
            <button class="btn discard">🗑️ descartar</button>
          </div>
          <div class="status"></div>
        </div>
      </div>`;
  }).join('');

  const html = `<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drope ✦ Fotos sem sabor</title>
<style>
:root { --bg:#0a0a14; --neon:#b026ff; --lime:#c0ff33; --pink:#ff2d95; --txt:#eaeaf2; --dim:#888; --card:#13131e; --border:#2a2a3e; }
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,system-ui,sans-serif;padding:16px}
h1{color:var(--neon);margin:0 0 6px;font-size:20px}
.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.thumb{aspect-ratio:1/1;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover}
.meta{padding:12px;display:flex;flex-direction:column;gap:8px}
.info{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--dim)}
.brand{color:var(--lime);font-weight:600}
.model{color:var(--neon)}
.idx{margin-left:auto;color:var(--dim)}
.flavor-input{padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:#1a1a2a;color:var(--txt);font-size:13px}
.flavor-input:focus{outline:none;border-color:var(--neon)}
.actions{display:flex;gap:6px}
.btn{flex:1;padding:7px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--txt);font-size:12px;cursor:pointer}
.btn.complete{border-color:var(--lime);color:var(--lime)}
.btn.complete:hover{background:var(--lime);color:#0a0a14}
.btn.discard{border-color:#ff6b6b;color:#ff6b6b}
.btn.discard:hover{background:#ff6b6b;color:#0a0a14}
.status{font-size:11px;min-height:14px}
.status.ok{color:var(--lime)}
.status.err{color:#ff6b6b}
.empty{color:var(--dim);text-align:center;padding:40px;font-style:italic}
.actions-top{margin:0 0 14px;display:flex;gap:8px}
.actions-top a{padding:7px 12px;border-radius:6px;border:1px solid var(--neon);background:transparent;color:var(--neon);font-size:12px;text-decoration:none}
</style>
</head><body>
<h1>📸 Fotos sem sabor identificável</h1>
<div class="sub">Vision viu marca/modelo mas não leu o sabor. Digita o sabor e cadastra direto pelo navegador.</div>
<div class="actions-top">
  <a href="/api/webhook?action=admin_hub&token=${esc(queryTok)}">← admin hub</a>
  <a href="/api/webhook?action=gallery&token=${esc(queryTok)}">🎨 gallery</a>
</div>
${unique.length === 0 ? '<div class="empty">✅ Nada pendente. Quando uma foto cair sem sabor, aparece aqui.</div>' : `<div class="grid">${cards}</div>`}
<script>
const TOKEN = ${JSON.stringify(queryTok)};
document.querySelectorAll('.card').forEach(card => {
  const batchId = card.dataset.batchId;
  const photoIdx = parseInt(card.dataset.photoIdx);
  const input = card.querySelector('.flavor-input');
  const status = card.querySelector('.status');
  const btnOK = card.querySelector('.complete');
  const btnNo = card.querySelector('.discard');
  btnOK.onclick = async () => {
    const flavor = input.value.trim();
    if (flavor.length < 2) { status.textContent = '⚠️ digita o sabor'; status.className = 'status err'; return; }
    status.textContent = 'cadastrando...';
    status.className = 'status';
    try {
      const r = await fetch('/api/webhook?action=complete_unidentified', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
        body: JSON.stringify({ batch_id: batchId, photo_index: photoIdx, flavor }),
      });
      const data = await r.json();
      if (data.ok) {
        status.textContent = '✅ ' + (data.product_name || 'cadastrado');
        status.className = 'status ok';
        setTimeout(() => card.style.display='none', 2000);
      } else {
        status.textContent = '❌ ' + (data.error || 'erro');
        status.className = 'status err';
      }
    } catch (e) { status.textContent = '❌ ' + e.message; status.className = 'status err'; }
  };
  btnNo.onclick = async () => {
    if (!confirm('Descartar essa foto sem cadastrar?')) return;
    try {
      const r = await fetch('/api/webhook?action=complete_unidentified', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
        body: JSON.stringify({ batch_id: batchId, photo_index: photoIdx, discard: true }),
      });
      const data = await r.json();
      if (data.ok) { card.style.display='none'; }
    } catch (_) {}
  };
});
</script>
</body></html>`;
  return res.status(200).send(html);
}

// POST: completa flavor de uma foto unidentified ou descarta
// REANALYZE UNIDENTIFIED (08/05/2026) — Andrade pediu:
// "não tem sentido digitar sabor manual se eu vou mandar foto melhor"
// Aceita nova foto da caixa, sobe pro storage, re-roda Vision, e se identificar
// tudo (brand+model+flavor), cria o produto direto sem input manual.
async function handleReanalyzeUnidentified(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const provided = (req.headers && req.headers['x-admin-token']) || '';
  if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: 'invalid body' }); }
  const { batch_id, photo_index, newPhotoBase64 } = body;
  if (!batch_id || photo_index == null || !newPhotoBase64) {
    return res.status(400).json({ error: 'batch_id, photo_index, newPhotoBase64 obrigatórios' });
  }

  // Pega entry
  const rows = await sbGet('drope_batch_queue',
    `select=id,phone,photo_url,vision_response&batch_id=eq.${encodeURIComponent(batch_id)}&photo_index=eq.${parseInt(photo_index)}&decision=eq.unidentified_flavor&limit=1`);
  const candidate = Array.isArray(rows) ? rows[0] : null;
  if (!candidate) return res.status(404).json({ error: 'not found or already processed' });

  // 1) Sobe a nova foto
  let newPhotoUrl = null;
  try {
    const cleanB64 = newPhotoBase64.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(cleanB64, 'base64');
    const path = `box-photos/reanalyze-${batch_id}-${photo_index}-${Date.now()}.jpg`;
    newPhotoUrl = await uploadToStorage(path, buf, 'image/jpeg');
  } catch (e) {
    return res.status(500).json({ error: 'upload falhou: ' + e.message });
  }
  if (!newPhotoUrl) return res.status(500).json({ error: 'upload retornou null' });

  // 2) Roda Vision na nova foto (sem podPhoto, só box)
  let visionData = null;
  try {
    visionData = await analyzeProductImage(newPhotoUrl, null);
  } catch (e) {
    return res.status(500).json({ error: 'vision falhou: ' + e.message });
  }

  const visProduct = visionData?.products?.[0] || {};
  const cBrand = _flcCanonBrand(visProduct.brand) || visProduct.brand || '';
  const cModel = _flcCanonModel(visProduct.model) || visProduct.model || '';
  const cFlavor = _flcCanonFlavor(visProduct.flavor_pt || visProduct.flavor_en || visProduct.flavor) || (visProduct.flavor_pt || visProduct.flavor_en || visProduct.flavor || '');

  // 3) Atualiza batch_queue com nova foto + vision (mesmo se ainda sem flavor)
  await sbUpdate('drope_batch_queue', `id=eq.${candidate.id}`, {
    photo_url: newPhotoUrl,
    vision_response: typeof visionData === 'string' ? visionData : JSON.stringify(visionData || {}),
  });

  // 4) Se Vision não identificou brand → erro
  if (!cBrand) {
    return res.status(200).json({
      ok: false,
      identified: false,
      reason: 'vision não conseguiu ler a marca nem na foto nova — coloca o sabor manual ou tenta outra foto',
      newPhotoUrl,
    });
  }

  // 5) Se identificou brand+model mas SEM flavor → ainda fica em unidentified_flavor (mas com foto+meta melhores)
  if (!cFlavor) {
    return res.status(200).json({
      ok: false,
      identified_partial: true,
      brand: cBrand, model: cModel,
      reason: `Vision leu ${cBrand} ${cModel} mas não o sabor — coloca manual`,
      newPhotoUrl,
    });
  }

  // 6) Vision identificou tudo → cria produto via mesmo flow do complete_unidentified
  const name = [cBrand, cModel, cFlavor].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const slug = slugify(cBrand, cModel || '', cFlavor) + '-' + Date.now().toString(36);
  const qty = Math.max(1, parseInt(visProduct.qty) || 1);

  // Dedup
  const safe = encodeURIComponent('%' + name + '%');
  const dupes = await sbGet('drope_products', `name=ilike.${safe}&hidden=eq.false&select=id,name,qty_available,status&limit=1`);
  if (Array.isArray(dupes) && dupes.length > 0) {
    const dup = dupes[0];
    const newQty = (dup.qty_available || 0) + qty;
    await sbUpdate('drope_products', `id=eq.${dup.id}`, {
      qty_available: newQty, hidden: false,
      status: dup.status === 'inactive' ? 'pending' : (dup.status || 'active'),
      updated_at: new Date().toISOString(),
    });
    await sbUpdate('drope_batch_queue', `id=eq.${candidate.id}`, {
      decision: 'matched_existing', matched_product_id: dup.id, qty_added: qty, matched_score: 100,
    });
    return res.status(200).json({ ok: true, identified: true, action: 'matched_existing', product_id: dup.id, product_name: dup.name, brand: cBrand, model: cModel, flavor: cFlavor });
  }

  const reconcil = await _findPendingSalesMatching(cBrand, cModel, cFlavor);
  const qtyFinal = Math.max(0, qty - reconcil.qty_total);

  try {
    const inserted = await sbInsert('drope_products', {
      slug, name,
      qty_available: qtyFinal,
      total_sold: reconcil.qty_total,
      status: 'pending', hidden: true, price_cents: 0,
      metadata: {
        brand: cBrand, model: cModel, flavor: cFlavor,
        flavor_en: cFlavor, flavor_pt: cFlavor,
        created_via: 'reanalyze_unidentified_web',
        created_at: new Date().toISOString(),
        box_photo_url: newPhotoUrl,
        device_visual: visProduct.device_visual,
        device_visual_detailed: visProduct.device_visual_detailed,
        device_color: visProduct.device_color,
      },
      box_photo_url: newPhotoUrl,
    });
    const newId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
    if (newId && reconcil.sales.length > 0) {
      await _resolvePendingSales(reconcil.sales.map(s => s.id), newId);
    }
    await sbUpdate('drope_batch_queue', `id=eq.${candidate.id}`, {
      decision: 'created_new', created_product_id: newId, qty_added: qtyFinal,
    });
    if (newId) fireBackgroundEnrich(newId).catch(() => {});
    return res.status(200).json({ ok: true, identified: true, action: 'created_new', product_id: newId, product_name: name, brand: cBrand, model: cModel, flavor: cFlavor });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleCompleteUnidentified(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const provided = (req.headers && req.headers['x-admin-token']) || '';
  if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: 'invalid body' }); }
  const { batch_id, photo_index, flavor, discard } = body;
  if (!batch_id || photo_index == null) return res.status(400).json({ error: 'missing batch_id or photo_index' });

  // Pega entry
  const rows = await sbGet('drope_batch_queue',
    `select=id,phone,photo_url,vision_response&batch_id=eq.${encodeURIComponent(batch_id)}&photo_index=eq.${parseInt(photo_index)}&decision=eq.unidentified_flavor&limit=1`);
  const candidate = Array.isArray(rows) ? rows[0] : null;
  if (!candidate) return res.status(404).json({ error: 'not found or already processed' });

  if (discard) {
    await sbUpdate('drope_batch_queue', `id=eq.${candidate.id}`, { decision: 'discarded' });
    return res.status(200).json({ ok: true, discarded: true });
  }

  if (!flavor || flavor.trim().length < 2) return res.status(400).json({ error: 'flavor required' });

  // Reusa logica do tryHandleManualFlavor
  let visProduct = {};
  try {
    const vis = typeof candidate.vision_response === 'string' ? JSON.parse(candidate.vision_response) : candidate.vision_response;
    visProduct = vis?.products?.[0] || {};
  } catch (e) {}
  const cBrand = _flcCanonBrand(visProduct.brand) || visProduct.brand || '';
  const cModel = _flcCanonModel(visProduct.model) || visProduct.model || '';
  const cFlavor = _flcCanonFlavor(flavor) || flavor.trim();
  if (!cBrand) return res.status(400).json({ error: 'sem marca identificavel — refaz a foto' });
  const name = [cBrand, cModel, cFlavor].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const slug = slugify(cBrand, cModel || '', cFlavor) + '-' + Date.now().toString(36);
  const qty = Math.max(1, parseInt(visProduct.qty) || 1);

  // Dedup pre-insert (TIER 1.2)
  const safe = encodeURIComponent('%' + name + '%');
  const dupes = await sbGet('drope_products', `name=ilike.${safe}&hidden=eq.false&select=id,name,qty_available,status&limit=1`);
  if (Array.isArray(dupes) && dupes.length > 0) {
    const dup = dupes[0];
    const newQty = (dup.qty_available || 0) + qty;
    await sbUpdate('drope_products', `id=eq.${dup.id}`, {
      qty_available: newQty,
      hidden: false,
      status: dup.status === 'inactive' ? 'pending' : (dup.status || 'active'),
      updated_at: new Date().toISOString(),
    });
    await sbUpdate('drope_batch_queue', `id=eq.${candidate.id}`, {
      decision: 'matched_existing', matched_product_id: dup.id, qty_added: qty, matched_score: 100,
    });
    return res.status(200).json({ ok: true, product_id: dup.id, product_name: dup.name, action: 'matched_existing' });
  }

  const reconcil = await _findPendingSalesMatching(cBrand, cModel, cFlavor);
  const qtyFinal = Math.max(0, qty - reconcil.qty_total);

  try {
    const inserted = await sbInsert('drope_products', {
      slug, name,
      qty_available: qtyFinal,
      total_sold: reconcil.qty_total,
      status: 'pending',
      hidden: true,
      price_cents: 0,
      metadata: {
        brand: cBrand, model: cModel, flavor: cFlavor,
        flavor_en: cFlavor, flavor_pt: cFlavor,
        created_via: 'manual_flavor_web',
        created_at: new Date().toISOString(),
        box_photo_url: candidate.photo_url,
      },
      box_photo_url: candidate.photo_url,
    });
    const newId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
    if (newId && reconcil.sales.length > 0) {
      await _resolvePendingSales(reconcil.sales.map(s => s.id), newId);
    }
    await sbUpdate('drope_batch_queue', `id=eq.${candidate.id}`, {
      decision: 'created_new', created_product_id: newId, qty_added: qtyFinal,
    });
    if (newId) fireBackgroundEnrich(newId).catch(() => {});
    return res.status(200).json({ ok: true, product_id: newId, product_name: name, action: 'created_new' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleSystemHealth(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const checks = [];
  const t0 = Date.now();

  // 1. Supabase alive
  try {
    const ts = Date.now();
    const rows = await sbGet('drope_products', 'select=id&limit=1');
    checks.push({
      name: 'supabase',
      ok: Array.isArray(rows) && rows.length >= 0,
      ms: Date.now() - ts,
    });
  } catch (e) {
    checks.push({ name: 'supabase', ok: false, error: e.message });
  }

  // 2. UazAPI alive
  try {
    const ts = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(`${UAZAPI_SERVER}/instance/status`, {
      headers: { token: UAZAPI_TOKEN || '' },
      signal: ac.signal,
    });
    clearTimeout(timer);
    checks.push({ name: 'uazapi', ok: r.ok, status: r.status, ms: Date.now() - ts });
  } catch (e) {
    checks.push({ name: 'uazapi', ok: false, error: e.message });
  }

  // 3. Frescor dos crons existentes — usa drope_system_log.cron_run
  try {
    const cronAges = await sbGet('drope_system_log',
      `action=eq.cron_run&select=detail,created_at&order=created_at.desc&limit=80`);
    const now = Date.now();
    const cronChecks = {
      run_followups:   25 * 60 * 60 * 1000, // diário 14h UTC, alerta se >25h
      run_reorder:     25 * 60 * 60 * 1000,
      daily_dashboard: 25 * 60 * 60 * 1000,
      run_drop_notifications: 8 * 24 * 60 * 60 * 1000, // semanal, alerta se >8d
    };
    for (const [cron, maxAge] of Object.entries(cronChecks)) {
      const last = (cronAges || []).find(d => (d.detail || {}).cron === cron);
      const age = last ? now - new Date(last.created_at).getTime() : Infinity;
      // Tolerante: primeira semana sem registro NÃO é erro (sistema novo)
      const tolerance = !last ? true : age < maxAge;
      checks.push({
        name: `cron_${cron}`,
        ok: tolerance,
        last_run: last?.created_at || 'never',
        age_hours: last ? Math.round(age / 3600000) : null,
      });
    }
  } catch (e) {
    checks.push({ name: 'cron_check', ok: false, error: e.message });
  }

  // 4. Estoque zerado (auto-hide se houver) — cura ativa, não só observação
  try {
    const result = await checkAndAutoHideZeroStock();
    checks.push({
      name: 'stock_zero',
      ok: true, // auto-hide é cura, não falha
      auto_hidden: result.hidden,
      products: result.products || [],
    });
  } catch (e) {
    checks.push({ name: 'stock_zero', ok: false, error: e.message });
  }

  // Avaliação
  const failed = checks.filter(c => !c.ok);
  const status =
    failed.length === 0 ? 'healthy' :
    failed.length <= 2 ? 'degraded' :
    'unhealthy';

  const totalMs = Date.now() - t0;
  await logSystemEvent('system_health', { status, checks, total_ms: totalMs });

  // Alerta WhatsApp se algo quebrado. Cooldown: só avisa 1x por hora pro mesmo
  // padrão de falha (evita spam quando degraded persiste).
  if (status !== 'healthy') {
    try {
      const recent = await sbGet('drope_system_log',
        `action=eq.system_alert_sent&created_at=gte.${encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())}&select=id&limit=1`);
      const onCooldown = Array.isArray(recent) && recent.length > 0;
      if (!onCooldown && ADMIN_LUCAS) {
        const failedNames = failed.map(f => `❌ ${f.name}: ${f.error || f.detail || 'falhou'}`).join('\n');
        const okNames = checks.filter(c => c.ok).map(c => c.name).join(', ');
        const msg =
          `⚠️ SISTEMA IMUNE — ${status.toUpperCase()}\n\n` +
          failedNames +
          `\n\n✅ OK: ${okNames}`;
        await sendText(ADMIN_LUCAS, msg, {});
        await logSystemEvent('system_alert_sent', { status, failed_count: failed.length });
      }
    } catch (e) { /* alerta best-effort */ }
  }

  return res.status(200).json({
    status,
    checks,
    total_ms: totalMs,
    timestamp: new Date().toISOString(),
  });
}

// GET /api/webhook?action=cost_report&token=ADMIN_TOKEN&days=7
async function handleCostReport(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const qs = (req.url && req.url.includes('?')) ? req.url.split('?')[1] : '';
  const params = {};
  qs.split('&').forEach(p => {
    const [k, v] = p.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  const days = Math.max(1, Math.min(90, parseInt(params.days) || 7));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = await sbGet('drope_system_log',
    `action=eq.api_cost&created_at=gte.${encodeURIComponent(since)}&select=detail&limit=10000`);
  const data = Array.isArray(rows) ? rows : [];
  const totals = {};
  for (const r of data) {
    const d = r.detail || {};
    const api = d.api || 'unknown';
    totals[api] = (totals[api] || 0) + (d.estimated_cost_brl || 0);
  }
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  return res.status(200).json({
    period_days: days,
    totals,
    total_brl: total.toFixed(4),
    calls: data.length,
    since,
  });
}

// GET/POST /api/webhook?action=weekly_health  — cron segunda 9h SP (12h UTC)
async function handleWeeklyHealth(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const days = 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [errors, rateLimitsLog, autoHides, healthChecks, costRows] = await Promise.all([
    sbGet('drope_system_log', `action=eq.error&created_at=gte.${encodeURIComponent(since)}&select=detail,created_at&limit=200`),
    sbGet('drope_system_log', `action=eq.rate_limited&created_at=gte.${encodeURIComponent(since)}&select=id&limit=2000`),
    sbGet('drope_system_log', `action=eq.auto_hide&created_at=gte.${encodeURIComponent(since)}&select=detail&limit=200`),
    sbGet('drope_system_log', `action=eq.system_health&created_at=gte.${encodeURIComponent(since)}&select=detail,created_at&limit=2000`),
    sbGet('drope_system_log', `action=eq.api_cost&created_at=gte.${encodeURIComponent(since)}&select=detail&limit=10000`),
  ]);

  const totalChecks = (healthChecks || []).length;
  const unhealthyCount = (healthChecks || []).filter(h => (h.detail || {}).status !== 'healthy').length;
  const uptimePercent = totalChecks > 0
    ? (((totalChecks - unhealthyCount) / totalChecks) * 100).toFixed(1)
    : 'N/A';

  const totals = {};
  for (const r of (costRows || [])) {
    const d = r.detail || {};
    const api = d.api || 'unknown';
    totals[api] = (totals[api] || 0) + (d.estimated_cost_brl || 0);
  }
  const totalCost = Object.values(totals).reduce((a, b) => a + b, 0);

  const errorsCount = (errors || []).length;
  const status = errorsCount === 0 && unhealthyCount === 0 ? '✅' :
                 errorsCount <= 2 ? '⚠️' : '🔴';

  const lines = [
    `${status} RELATÓRIO SEMANAL — Sistema Imune`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Uptime: ${uptimePercent}% (${totalChecks} checks)`,
    `Erros: ${errorsCount}`,
    `Rate limits: ${(rateLimitsLog || []).length} bloqueios`,
    `Auto-hide estoque: ${(autoHides || []).length}`,
    `Custo estimado: R$ ${totalCost.toFixed(2)}`,
  ];
  for (const [k, v] of Object.entries(totals)) {
    lines.push(`  • ${k}: R$ ${v.toFixed(3)}`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🦎 sistema rodando`);

  const msg = lines.join('\n');
  if (ADMIN_LUCAS) {
    try { await sendText(ADMIN_LUCAS, msg, {}); }
    catch (e) { console.warn('[weekly_health] sendText fail:', e.message); }
  }
  await logSystemEvent('weekly_health', { uptime_percent: uptimePercent, errors: errorsCount, total_cost: totalCost });
  return res.status(200).json({
    status: status === '✅' ? 'healthy' : 'issues',
    uptime_percent: uptimePercent,
    errors: errorsCount,
    rate_limits: (rateLimitsLog || []).length,
    auto_hides: (autoHides || []).length,
    cost_brl: totalCost.toFixed(2),
    cost_breakdown: totals,
  });
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

// Match mais robusto pra fluxo de stock_entry (BLOCO 3): busca por campos
// jsonb individuais em metadata. Aguenta diferenças de formatação no name.
async function findStockMatchByMetadata(brand, model, flavor) {
  if (!brand) return null;
  const parts = [`metadata->>brand=ilike.*${encodeURIComponent(brand)}*`];
  if (model) parts.push(`metadata->>model=ilike.*${encodeURIComponent(model)}*`);
  if (flavor) parts.push(`metadata->>flavor_en=ilike.*${encodeURIComponent(flavor)}*`);
  parts.push('select=id,name,slug,qty_available,price_cents,image_url');
  parts.push('limit=1');
  const rows = await sbGet('drope_products', parts.join('&'));
  return rows[0] || null;
}

// Lookup de regra de preço por marca+modelo (case-insensitive). Retorna price_cents ou null.
async function getPriceRule(brand, model) {
  if (!brand) return null;
  // PostgREST não suporta lower() direto em filtros — usa ilike pra comparação case-insensitive.
  // Como brand+model são short, ilike sem wildcards = match exato case-insensitive.
  const brandFilter = `brand=ilike.${encodeURIComponent(brand)}`;
  const modelFilter = model ? `&model=ilike.${encodeURIComponent(model)}` : '&model=is.null';
  const rows = await sbGet('drope_price_rules', `${brandFilter}${modelFilter}&limit=1`);
  return rows[0] || null;
}

// Salva (ou atualiza) a regra de preço pra (brand, model). Idempotente via index único.
async function setPriceRule(brand, model, priceCents) {
  if (!brand || !priceCents || priceCents <= 0) return null;
  // Tenta INSERT; se conflitar com unique index, faz UPDATE
  const inserted = await sbInsert('drope_price_rules', {
    brand,
    model: model || '',
    price_cents: priceCents,
  });
  if (inserted) return inserted;
  // 409 → atualiza
  const existing = await getPriceRule(brand, model);
  if (existing) {
    return await sbUpdate('drope_price_rules', `id=eq.${existing.id}`, { price_cents: priceCents });
  }
  return null;
}

// (removido em 2026-04-29: extractBarcode via Vision OCR foi descontinuado.
// Lucas agora digita o barcode no fluxo cadastro — mais confiável que LLM lendo dígitos.)

// Valida checksum GS1 (EAN-8, UPC-A, EAN-13, ITF-14). Esses 4 formatos têm
// dígito verificador no final calculado por pesos alternados 3/1 da direita
// pra esquerda. Se Vision leu um dígito errado, o checksum quase sempre não bate
// → defesa contra "barcode quase certo" virar lixo no banco.
// Pra outros tamanhos (não-padrão), retorna true (não rejeita).
function validateBarcodeChecksum(code) {
  if (!/^\d+$/.test(code)) return false;
  const len = code.length;
  if (![8, 12, 13, 14].includes(len)) return true; // formato sem checksum conhecido — passa
  const digits = code.split('').map(Number);
  const checkDigit = digits.pop();
  const reversed = digits.reverse();
  let sum = 0;
  reversed.forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 3 : 1);
  });
  const expected = (10 - (sum % 10)) % 10;
  return checkDigit === expected;
}

// Normaliza campo string vindo do Vision: trata "unknown"/"desconhecido"/etc como null.
// Vision às vezes ignora a regra "use null" e retorna placeholder textual — esse helper limpa.
function cleanVisionField(v) {
  if (!v || typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const placeholders = ['unknown', 'desconhecido', 'none', 'null', 'undefined', 'n/a', 'na', '?', '-', 'nao identificado', 'não identificado', 'ilegivel', 'ilegível'];
  if (placeholders.includes(lower)) return null;
  return trimmed;
}

// OSSO 35 — Levenshtein distance pra fuzzy match Vision -> drope_products.
// Usado pra calcular similaridade entre o que o Vision leu e os produtos cadastrados.
function _levenshtein(a, b) {
  if (!a) return (b || '').length;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    }
  }
  return d[m][n];
}

// Similaridade 0-1 entre 2 strings (1 = idênticas, 0 = totalmente diferentes).
function _stringSim(a, b) {
  if (!a || !b) return 0;
  const aL = String(a).toLowerCase().trim();
  const bL = String(b).toLowerCase().trim();
  if (!aL || !bL) return 0;
  if (aL === bL) return 1;
  const dist = _levenshtein(aL, bL);
  const maxLen = Math.max(aL.length, bL.length);
  return Math.max(0, 1 - dist / maxLen);
}

// Score 0-100 de match entre o que Vision leu (visionTerms) e um produto do banco.
// Pesos: marca 30, modelo 25, sabor 35, bonus de nome completo 10.
function _matchScore(visionTerms, prod) {
  const meta = prod.metadata || {};
  const productName = String(prod.name || '').toLowerCase();
  let score = 0;

  // Marca: 30 pontos
  if (visionTerms.brand) {
    const sim = Math.max(
      _stringSim(visionTerms.brand, meta.brand),
      _stringSim(visionTerms.brand, productName) * 0.5,
    );
    score += sim * 30;
  }

  // Modelo: 25 pontos
  if (visionTerms.model) {
    const sim = Math.max(
      _stringSim(visionTerms.model, meta.model),
      _stringSim(visionTerms.model, productName) * 0.5,
    );
    score += sim * 25;
  }

  // Sabor: 35 pontos (mais peso pq é o que diferencia produtos da mesma linha)
  // ATENCAO: maioria dos produtos no banco usa metadata.flavor (sem sufixo).
  // GH23000 e alguns outros usam flavor_en. Lemos os 3 campos pra cobrir tudo.
  const visionFlavor = visionTerms.flavor_en || visionTerms.flavor_pt || '';
  let flavorSim = null;
  if (visionFlavor) {
    const vfLower = String(visionFlavor).toLowerCase();
    // Substring exato no nome do produto vale 1.0 (caso "Blue Razz Ice" em "ELFBAR Ice King Blue Razz Ice")
    const inName = productName.includes(vfLower) ? 1 : _stringSim(visionFlavor, productName) * 0.7;
    flavorSim = Math.max(
      _stringSim(visionFlavor, meta.flavor),       // <-- bug: faltava esse campo
      _stringSim(visionFlavor, meta.flavor_en),
      _stringSim(visionFlavor, meta.flavor_pt),
      inName,
    );
    score += flavorSim * 35;
  }

  // Bônus: nome completo do banco contém todos os termos lidos
  const fullSearch = [visionTerms.brand, visionTerms.model, visionFlavor]
    .filter(Boolean).map(s => String(s).toLowerCase()).join(' ');
  if (fullSearch && productName.includes(fullSearch)) score += 10;

  // Penalidade: se Vision leu um sabor mas ele NAO bate com o do produto,
  // sabor é o discriminador principal — score colapsa proporcional.
  // Sem essa penalidade, "Banana Ice" matcha 76% com "Mango Ice" só por dividirem
  // marca/modelo/"Ice", e o handler chuta o produto errado.
  if (flavorSim !== null && flavorSim < 0.7) {
    score *= flavorSim;
  }

  return Math.min(100, score);
}

// FLUXO LOTE COMPLETO (FASE 1) — Comando "zerar estoque" pra reset antes do recadastro em massa.
// Soft delete: marca produtos como hidden+inactive+qty=0, NAO deleta (preserva pedidos antigos via FK).
// Fluxo: "zerar estoque" -> aviso + pending. "CONFIRMO" maiusculo -> executa. "cancela" -> aborta.
async function tryHandleZeroStock(phone, msg, body, text, pending) {
  if (!text) return false;
  const lower = String(text).toLowerCase().trim();
  const trimmed = String(text).trim();

  // Trigger
  if (lower === 'zerar estoque' || lower === 'reset estoque' || lower === 'zera estoque') {
    await setPending(phone, { mode: 'awaiting_zero_confirm', startedAt: Date.now() });
    await sendText(phone,
      "⚠️ ATENCAO: vai marcar TODOS os produtos como inactive (qty=0, hidden=true).\n\n" +
      "Produtos NAO serao deletados — pedidos antigos e historico preservados.\n\n" +
      "Digite *CONFIRMO* (em maiusculas) pra continuar ou *cancela* pra desistir.",
      body);
    return true;
  }

  // Confirmação (precisa ter pending na mesma sessao)
  if (pending?.mode === 'awaiting_zero_confirm') {
    if (trimmed === 'CONFIRMO') {
      try {
        // Conta antes pra reportar
        const before = await sbGet('drope_products', 'select=id&hidden=eq.false&limit=1000');
        const count = Array.isArray(before) ? before.length : 0;
        // Soft reset: hidden + qty=0 + status=inactive em todos visiveis
        await sbUpdate('drope_products', 'hidden=eq.false', {
          hidden: true,
          qty_available: 0,
          status: 'inactive',
          updated_at: new Date().toISOString(),
        });
        await clearPending(phone);
        await sendText(phone,
          `🗑️ ${count} produtos zerados (hidden, qty=0, status=inactive).\n\n` +
          `Pedidos antigos e historico preservados. Manda as fotos do lote agora.`,
          body);
        try { await logSystemEvent('stock_zeroed', { count, by: phone.slice(0, 6) + '***' }, phone); } catch (_) {}
      } catch (e) {
        await sendText(phone, `❌ erro ao zerar: ${e.message}`, body);
      }
      return true;
    }
    if (lower === 'cancela' || lower === 'cancelar' || lower === 'sai' || lower === 'desisto') {
      await clearPending(phone);
      await sendText(phone, '✅ Cancelado. Estoque inalterado.', body);
      return true;
    }
    // Resposta invalida — avisa e mantem pending
    await sendText(phone, '⚠️ Nao entendi. Digite *CONFIRMO* (em maiusculas) pra zerar ou *cancela* pra desistir.', body);
    return true;
  }

  return false;
}

// OSSO 35 (FIX 3D) — Detecta padrão de mensagem de correção do admin.
// Aceita: "errado X", "errei X", "não, era X", "ops X", "corrige X", "correção X", "era X", "foi X".
// Retorna o termo do produto correto, ou null.
function _parseCorrection(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase().trim();
  if (lower.length < 3 || lower.length > 200) return null;
  // Trigger + opcional "era/foi" + nome
  let m = lower.match(/^(?:n[ãa]o[,\s!]+|errado[,\s!]*|errei[,\s!]*|ops[,\s!]*|corrige[r]?[,\s!]+|correc[ãa]o[,\s!:]+|corrigir[,\s!]+)(?:n[ãa]o foi[,\s]+|era[,\s]+|foi[,\s]+|e[,\s]+)?(.+)$/);
  if (m && m[1] && m[1].trim().length >= 3) return m[1].trim();
  // "era X" / "foi X" — precisa termo robusto (>=5 chars) pra evitar falso positivo
  m = lower.match(/^(?:era|foi)[,\s!]+(.+)$/);
  if (m && m[1] && m[1].trim().length >= 5) return m[1].trim();
  return null;
}

// Aplica correção de uma baixa errada feita pelo bot.
// Retorna true se processou (resposta enviada), false se não era pattern de correção.
async function tryHandleCorrection(phone, msg, body, text) {
  const correctionTerm = _parseCorrection(text);
  if (!correctionTerm) return false;

  // Busca último log do GRUPO_PDV nos últimos 30 min sem correção
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const logs = await sbGet('drope_vision_log',
    `select=id,decision,predicted_product_id,predicted_product_name,qty_deducted,group_jid&was_corrected=eq.false&group_jid=eq.${encodeURIComponent(GRUPO_PDV_JID)}&created_at=gt.${encodeURIComponent(cutoff)}&order=created_at.desc&limit=1`);
  if (!Array.isArray(logs) || logs.length === 0) return false; // não é correção válida — deixa fluxo normal seguir

  const log = logs[0];

  // Match no termo correto via fuzzy
  const allProducts = await sbGet('drope_products', 'select=id,name,slug,qty_available,total_sold,metadata&hidden=eq.false&limit=500');
  if (!Array.isArray(allProducts) || allProducts.length === 0) {
    await sendText(phone, 'catalogo vazio. nao tem como corrigir.', body);
    return true;
  }

  // Parse termo simples (toUpperCase): primeira palavra=marca, segunda(opcional)=modelo, resto=flavor
  const parts = correctionTerm.toUpperCase().split(/\s+/).filter(Boolean);
  const visionTerms = {
    brand: parts[0] || null,
    model: parts.length >= 3 ? parts[1] : null,
    flavor_en: parts.length >= 3 ? parts.slice(2).join(' ') : (parts.length === 2 ? parts[1] : null),
    flavor_pt: null,
  };
  const ranking = allProducts
    .map(prod => ({ prod, score: _matchScore(visionTerms, prod) }))
    .sort((a, b) => b.score - a.score);
  const top1 = ranking[0] || { prod: null, score: 0 };
  if (!top1.prod || top1.score < 50) {
    await sendText(phone, `🤔 Nao achei "${correctionTerm}" no catalogo (melhor match: ${Math.round(top1.score)}%). Tenta outro nome.`, body);
    return true;
  }
  const correctProduct = top1.prod;
  const wrongProductId = log.predicted_product_id;
  const qty = log.qty_deducted || 1;

  // Reverte baixa do produto errado (só se houve baixa)
  if (log.decision === 'baixa' && wrongProductId) {
    const wrong = allProducts.find(p => p.id === wrongProductId);
    if (wrong) {
      await sbUpdate('drope_products', `id=eq.${wrongProductId}`, {
        qty_available: (wrong.qty_available || 0) + qty,
        total_sold: Math.max(0, (wrong.total_sold || 0) - qty),
        updated_at: new Date().toISOString(),
      });
    }
  }

  // Aplica baixa no produto correto (se tem estoque)
  const correctQty = correctProduct.qty_available || 0;
  if (correctQty < qty) {
    await sendText(phone,
      `⚠️ "${correctProduct.name}" so tem ${correctQty} em estoque, nao posso baixar ${qty}.\nDevolvi a baixa errada.`, body);
    await sbUpdate('drope_vision_log', `id=eq.${log.id}`, {
      was_corrected: true,
      corrected_to_id: correctProduct.id,
      corrected_to_name: correctProduct.name,
      corrected_at: new Date().toISOString(),
      corrected_by: phone.replace(/[^0-9]/g, ''),
    });
    return true;
  }

  await sbUpdate('drope_products', `id=eq.${correctProduct.id}`, {
    qty_available: correctQty - qty,
    total_sold: (correctProduct.total_sold || 0) + qty,
    updated_at: new Date().toISOString(),
  });

  await sbUpdate('drope_vision_log', `id=eq.${log.id}`, {
    was_corrected: true,
    corrected_to_id: correctProduct.id,
    corrected_to_name: correctProduct.name,
    corrected_at: new Date().toISOString(),
    corrected_by: phone.replace(/[^0-9]/g, ''),
  });

  const wrongName = log.predicted_product_name || '?';
  const confirmMsg = log.decision === 'baixa'
    ? `✅ Corrigido!\n\nDevolvi: ${qty}x ${wrongName}\nBaixei: ${qty}x ${correctProduct.name} (restam ${correctQty - qty})`
    : `✅ Registrado!\nBaixei: ${qty}x ${correctProduct.name} (restam ${correctQty - qty})`;
  await sendText(phone, confirmMsg, body);
  return true;
}

// ============ FLUXO LOTE COMPLETO (FASE 2) — MODO LOTE ============
// Lucas manda "lote" no privado -> ativa modo batch -> manda fotos -> bot enfileira
// e processa cada uma. Quando ele manda "fechar lote", bot envia resumo + pergunta precos.

function _flcUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Padroniza marca/modelo/sabor pro formato canonico do Drope
const _FLC_BRAND_SYNONYMS = {
  'ELF BAR': 'ELFBAR', 'ELFBAR': 'ELFBAR', 'elfbar': 'ELFBAR',
  'OX BAR': 'OXBAR', 'OXBAR': 'OXBAR', 'oxbar': 'OXBAR',
  'LOST MARY': 'LOST MARY', 'LOSTMARY': 'LOST MARY',
  'IGNITE': 'IGNITE', 'GEEK BAR': 'GEEK BAR', 'GEEKBAR': 'GEEK BAR',
  'BLACK SHEEP': 'BLACK SHEEP', 'BLACKSHEEP': 'BLACK SHEEP',
  'NIKBAR': 'NIKBAR', 'HQD': 'HQD', 'RABBEATS': 'RABBEATS',
  'EBCREATE': 'EBCREATE', 'WAKA': 'WAKA',
};
const _FLC_MODEL_SYNONYMS = {
  'BC15K': 'BC15K', 'BC15000': 'BC15K', 'BC 15K': 'BC15K', 'BC-15K': 'BC15K',
  'BC PRO': 'BC PRO', 'BCPRO': 'BC PRO',
  'GH23000': 'GH23000', 'GH 23000': 'GH23000', 'GH23K': 'GH23000',
  'V55': 'V55', 'V 55': 'V55', 'V80': 'V80', 'V300': 'V300 Slim', 'V300 SLIM': 'V300 Slim',
  'ICE KING': 'Ice King', 'ICEKING': 'Ice King', 'ICE_KING': 'Ice King',
  'ICE BOOST': 'Ice Boost', 'ICEBOOST': 'Ice Boost',
  'TRIO': 'TRIO', 'Z35': 'Z35',
};
function _flcCanonBrand(brand) {
  if (!brand) return null;
  const up = String(brand).trim().toUpperCase();
  return _FLC_BRAND_SYNONYMS[up] || up;
}
function _flcCanonModel(model) {
  if (!model) return null;
  const up = String(model).trim().toUpperCase();
  return _FLC_MODEL_SYNONYMS[up] || String(model).trim();
}
function _flcCanonFlavor(flavor) {
  if (!flavor) return null;
  const f = String(flavor).trim().toLowerCase();
  return f.replace(/\b\w/g, c => c.toUpperCase()); // Title Case
}

// FLC FASE 2 — Salva foto da caixa no Storage quando UazAPI manda base64.
// UazAPI as vezes manda data:image/jpeg;base64,... em vez de URL publica.
// Sem upload, box_photo_url fica null e perdemos a foto da caixa pra exibir no admin.
async function _flcUploadBoxPhoto(imageUrl, batchId, idx) {
  if (!imageUrl) return null;
  if (!imageUrl.startsWith('data:')) return imageUrl; // já é URL publica
  try {
    const m = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    const mime = m[1] || 'image/jpeg';
    const base64 = m[2];
    const ext = mime.includes('png') ? 'png' : 'jpg';
    const path = `box-photos/batch-${batchId}-${idx}-${Date.now()}.${ext}`;
    const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY,
        'Content-Type': mime, 'x-upsert': 'true',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
      body: Buffer.from(base64, 'base64'),
    });
    if (!r.ok) {
      console.warn('[FLC box upload]', r.status, await r.text().catch(() => ''));
      return null;
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
  } catch (e) { console.warn('[FLC box upload]', e.message); return null; }
}

// SISTEMA IMUNE 07/05/2026 — Busca pending_sales matching pra um produto novo
// que ta sendo cadastrado. Faz fuzzy match por brand+model+flavor (canonicalizados).
// Retorna { qty_total, sales: [...] } pra reconciliacao retroativa.
async function _findPendingSalesMatching(cBrand, cModel, cFlavor) {
  if (!cBrand) return { qty_total: 0, sales: [] };
  try {
    // Carrega todas as pending_sales status='pending' (geralmente <50 em volume real)
    const all = await sbGet('drope_pending_sales',
      'select=id,qty,vision_brand,vision_model,vision_flavor_en,vision_flavor_pt,vision_search_terms,vendido_em,vendedor_phone,group_jid&status=eq.pending&order=vendido_em.desc&limit=200');
    if (!Array.isArray(all) || all.length === 0) return { qty_total: 0, sales: [] };
    const matching = [];
    for (const ps of all) {
      const visTerms = {
        brand: ps.vision_brand,
        model: ps.vision_model,
        flavor_en: ps.vision_flavor_en,
        flavor_pt: ps.vision_flavor_pt,
      };
      // Reusa _matchScore mas com produto fake feito do produto sendo cadastrado
      const fakeProduct = {
        name: [cBrand, cModel, cFlavor].filter(Boolean).join(' '),
        metadata: { brand: cBrand, model: cModel, flavor: cFlavor, flavor_en: cFlavor },
      };
      const score = _matchScore(visTerms, fakeProduct);
      if (score >= 75) { // threshold conservador pra evitar reconciliar coisa errada
        matching.push({ ...ps, score });
      }
    }
    const qty_total = matching.reduce((s, m) => s + (m.qty || 1), 0);
    return { qty_total, sales: matching };
  } catch (e) {
    console.warn('[pending_sales find]', e.message);
    return { qty_total: 0, sales: [] };
  }
}

async function _resolvePendingSales(salesIds, productId) {
  if (!Array.isArray(salesIds) || salesIds.length === 0) return;
  try {
    await sbUpdate('drope_pending_sales', `id=in.(${salesIds.join(',')})`, {
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_product_id: productId,
      resolved_method: 'auto_match',
    });
  } catch (e) { console.warn('[pending_sales resolve]', e.message); }
}

async function tryHandleBatchPhoto(phone, msg, body, pending) {
  if (!pending || pending.mode !== 'batch_active') return false;

  // FIX BATCH 1 (07/05/2026) — Auto-close inline pra batches abandonados.
  // Caso: Andrade abre lote, manda fotos, esquece de "fechar lote", e no dia seguinte
  // manda foto. Antes ela caia no batch antigo (zumbi). Agora fecha o antigo e abre novo.
  // Threshold 1h: tempo morto razoavel (cadastro normal demora 5-15min do inicio ao fim).
  const STALE_BATCH_MS = 60 * 60 * 1000; // 1h
  const lastTouch = pending.lastPhotoAt || pending.startedAt || 0;
  if (lastTouch && (Date.now() - lastTouch) > STALE_BATCH_MS) {
    console.log('[FLC stale-batch] fechando batch zumbi de', Math.round((Date.now()-lastTouch)/60000), 'min');
    try {
      await closeBatch(phone, pending, body);
      try { await logSystemEvent('batch_auto_closed_inline', { phone, fotoCount: pending.fotoCount || 0, idle_min: Math.round((Date.now()-lastTouch)/60000) }, phone); } catch (_) {}
    } catch (e) { console.warn('[FLC stale-batch] closeBatch err:', e.message); }
    // closeBatch deixa pending=batch_pricing (se tinha novos) ou clearPending.
    // Pra continuar com a foto nova, criamos batch novo limpo.
    const newPending = {
      mode: 'batch_active',
      batch_id: _flcUuid(),
      startedAt: Date.now(),
      lastPhotoAt: Date.now(),
      fotoCount: 0,
      errorCount: 0,
      matched: [],
      novos: [],
    };
    await setPending(phone, newPending);
    pending = newPending;
    await sendText(phone, `⏰ Lote anterior fechei automaticamente (>1h sem foto). Lote novo iniciado — pode mandar.`, body).catch(() => {});
  }

  const imageUrl = await getMediaUrl(msg, body).catch(() => null);
  const fotoIndex = (pending.fotoCount || 0) + 1;
  // Se UazAPI mandou base64, sobe pro Storage pra ter URL persistente
  const boxPhotoStored = imageUrl ? await _flcUploadBoxPhoto(imageUrl, pending.batch_id, fotoIndex) : null;

  // Insere na queue
  let queueId = null;
  try {
    const inserted = await sbInsert('drope_batch_queue', {
      batch_id: pending.batch_id,
      phone,
      msg_id: msg.id || msg.messageId || null,
      photo_url: boxPhotoStored,
      photo_index: fotoIndex,
      status: 'processing',
    });
    queueId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
  } catch (e) { console.warn('[FLC] insert queue:', e.message); }

  if (!imageUrl) {
    if (queueId) await sbUpdate('drope_batch_queue', `id=eq.${queueId}`, {
      status: 'error', error_message: 'media nao baixou', processed_at: new Date().toISOString(),
    }).catch(() => {});
    pending.fotoCount = fotoIndex;
    pending.errorCount = (pending.errorCount || 0) + 1;
    pending.lastPhotoAt = Date.now();
    await setPending(phone, pending);
    return true;
  }

  // Vision
  let vis = null;
  try { vis = await analyzeMixPhoto(imageUrl); } catch (e) { console.warn('[FLC] vision:', e.message); }

  if (!vis || !Array.isArray(vis.products) || vis.products.length === 0) {
    if (queueId) await sbUpdate('drope_batch_queue', `id=eq.${queueId}`, {
      status: 'error', error_message: 'vision sem produto', vision_response: vis,
      processed_at: new Date().toISOString(),
    }).catch(() => {});
    pending.fotoCount = fotoIndex;
    pending.errorCount = (pending.errorCount || 0) + 1;
    pending.lastPhotoAt = Date.now();
    await setPending(phone, pending);
    return true;
  }

  // Pra cada produto identificado: match no banco e cadastra/atualiza
  const allProducts = await sbGet('drope_products', 'select=id,name,slug,qty_available,total_sold,metadata,status,hidden&limit=1000');
  const productsArr = Array.isArray(allProducts) ? allProducts : [];

  pending.matched = pending.matched || [];
  pending.novos = pending.novos || [];

  for (const p of vis.products) {
    const cBrand = _flcCanonBrand(p.brand);
    const cModel = _flcCanonModel(p.model);
    const cFlavor = _flcCanonFlavor(p.flavor_en || p.flavor_pt);
    const visionTerms = { brand: cBrand, model: cModel, flavor_en: cFlavor || p.flavor_en, flavor_pt: p.flavor_pt };
    const ranking = productsArr.map(prod => ({ prod, score: _matchScore(visionTerms, prod) })).sort((a, b) => b.score - a.score);
    const top1 = ranking[0] || { prod: null, score: 0 };
    const qty = Math.max(1, parseInt(p.qty) || 1);

    if (top1.prod && top1.score >= 80) {
      const newQty = (top1.prod.qty_available || 0) + qty;
      try {
        await sbUpdate('drope_products', `id=eq.${top1.prod.id}`, {
          qty_available: newQty,
          hidden: false,
          status: top1.prod.status === 'inactive' ? 'pending' : (top1.prod.status || 'active'),
          updated_at: new Date().toISOString(),
        });
        // FLC FASE 2.1 — Registra match na QUEUE (fonte de verdade, evita race)
        if (queueId) await sbUpdate('drope_batch_queue', `id=eq.${queueId}`, {
          matched_product_id: top1.prod.id,
          matched_score: top1.score,
          decision: 'matched_existing',
          qty_added: qty,
        }).catch(() => {});
      } catch (e) { console.warn('[FLC] update qty:', e.message); }
    } else {
      // Cadastra novo com status='pending'
      const name = [cBrand, cModel, cFlavor].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      // FIX 10A (07/05/2026 - Andrade) — Antes ignorava silenciosamente quando
      // flavor=null. 55 de 65 fotos do batch caiam aqui = perdidos sem aviso.
      // Agora salva como decision='unidentified_flavor' com info parcial pra
      // Andrade revisar depois via 'revisa lote' ou completar manualmente.
      if (!cBrand || !cFlavor || name.length < 4 || /undefined/i.test(name)) {
        if (queueId) {
          const motivo = !cBrand ? 'sem_marca'
                       : !cFlavor ? 'sem_sabor'
                       : 'nome_invalido';
          const alertas = (vis.alertas || []).concat(p.alertas || []).slice(0, 5);
          await sbUpdate('drope_batch_queue', `id=eq.${queueId}`, {
            decision: 'unidentified_flavor',
            qty_added: qty,
            error_message: motivo + (alertas.length ? ': ' + alertas.join(' | ').slice(0, 400) : ''),
          }).catch(() => {});
        }
        continue;
      }
      const slug = slugify(cBrand, cModel || '', cFlavor) + '-' + Date.now().toString(36);

      // FIX TIER 1.2 (08/05/2026 - Andrade) — Detecção de duplicata cross-sessão.
      // _matchScore busca por similaridade mas pode ter passado threshold 80 sem ser
      // exato. Antes de criar produto novo, faz check final por nome canonical:
      // se ja existe produto com mesmo (cBrand + cModel + cFlavor), trata como
      // matched_existing (incrementa qty no existente em vez de duplicar).
      try {
        const namePattern = encodeURIComponent(`${cBrand} ${cModel || ''} ${cFlavor}`.replace(/\s+/g, ' ').trim());
        const dupes = await sbGet('drope_products',
          `name=ilike.${namePattern}&hidden=eq.false&select=id,name,qty_available,total_sold,status&limit=3`);
        if (Array.isArray(dupes) && dupes.length > 0) {
          // Achou duplicata — matched_existing em vez de criar
          const dup = dupes[0];
          const newQty = (dup.qty_available || 0) + qty;
          await sbUpdate('drope_products', `id=eq.${dup.id}`, {
            qty_available: newQty,
            hidden: false,
            status: dup.status === 'inactive' ? 'pending' : (dup.status || 'active'),
            updated_at: new Date().toISOString(),
          });
          if (queueId) await sbUpdate('drope_batch_queue', `id=eq.${queueId}`, {
            matched_product_id: dup.id,
            matched_score: 100, // exact name match
            decision: 'matched_existing',
            qty_added: qty,
          }).catch(() => {});
          // Adiciona no productsArr in-memory pra dedup live no resto do loop
          productsArr.push({ ...dup, qty_available: newQty });
          console.log(`[FLC dup-check] productId=${dup.id} matched by name "${dup.name}", +${qty} qty`);
          continue;
        }
      } catch (e) { console.warn('[FLC dup-check]', e.message); }

      // SISTEMA IMUNE 07/05/2026: busca pending_sales matching (Yasmin vendeu antes
      // de cadastrar). Aplica baixa retroativa no qty inicial.
      const reconcil = await _findPendingSalesMatching(cBrand, cModel, cFlavor);
      const qtyInicial = qty;
      const qtyFinal = Math.max(0, qtyInicial - reconcil.qty_total);

      try {
        const inserted = await sbInsert('drope_products', {
          slug,
          name,
          qty_available: qtyFinal,
          total_sold: reconcil.qty_total, // vendas pendentes ja contam como total_sold
          status: 'pending',
          hidden: true,
          price_cents: 0,
          metadata: {
            brand: cBrand, model: cModel, flavor: cFlavor,
            flavor_en: p.flavor_en, flavor_pt: p.flavor_pt,
            puffs: p.puffs || null,
            created_via: 'batch_photo', created_at: new Date().toISOString(),
            box_photo_url: boxPhotoStored,
            reconciled_pending_sales: reconcil.qty_total > 0 ? {
              qty_inicial: qtyInicial,
              qty_pendentes: reconcil.qty_total,
              qty_final: qtyFinal,
              sales_resolved: reconcil.sales.map(s => ({ id: s.id, qty: s.qty, vendido_em: s.vendido_em, vendedor: (s.vendedor_phone || '').slice(0,6) + '***' })),
            } : null,
          },
          box_photo_url: boxPhotoStored,
        });
        const newId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;

        // SISTEMA IMUNE: marca pendencias como resolvidas com vinculo pro produto novo
        if (newId && reconcil.sales.length > 0) {
          await _resolvePendingSales(reconcil.sales.map(s => s.id), newId);
          try { await logSystemEvent('pending_sales_reconciled', { product_id: newId, product_name: name, qty_inicial: qtyInicial, qty_pendentes: reconcil.qty_total, qty_final: qtyFinal, sales_count: reconcil.sales.length }, phone); } catch (_) {}
        }

        // FLC FASE 2.1 — Registra novo na QUEUE (fonte de verdade)
        if (queueId && newId) await sbUpdate('drope_batch_queue', `id=eq.${queueId}`, {
          created_product_id: newId,
          decision: 'created_new',
          qty_added: qtyFinal,
          matched_score: top1.score || 0,
        }).catch(() => {});
        // FIX BATCH 2 (07/05/2026) — Dedup live: adiciona o produto recem criado ao
        // productsArr in-memory pra que outras fotos do mesmo lote (e da mesma invocacao
        // OU em invocacoes paralelas) achem match em vez de criar duplicado.
        // Caso real: Andrade manda 4 fotos da mesma marca+modelo+sabor em sequencia.
        // Sem isso: 4 produtos duplicados criados, todos com qty=1.
        // Com isso: 1 produto criado, +3 incrementos de qty.
        if (newId) {
          productsArr.push({
            id: newId, name, slug,
            qty_available: qty, total_sold: 0, status: 'pending', hidden: true,
            metadata: { brand: cBrand, model: cModel, flavor: cFlavor, flavor_en: p.flavor_en, flavor_pt: p.flavor_pt },
          });
        }
        // FLC FASE 3 + FIX BATCH 3 (07/05/2026): enrich em invocacao Vercel propria via fetch.
        // Cada produto tem 60s pra rodar Serper + Vision rank + autoFindRef + dispatch arte.
        // Antes era fire-and-forget na mesma invocacao do batch -> morria em lote grande.
        if (newId) {
          fireBackgroundEnrich(newId).catch((e) => console.warn('[FLC enrich bg]', e.message));
        }
      } catch (e) { console.warn('[FLC] insert novo:', e.message); }
    }
  }

  if (queueId) await sbUpdate('drope_batch_queue', `id=eq.${queueId}`, {
    status: 'done', vision_response: vis, processed_at: new Date().toISOString(),
  }).catch(() => {});

  pending.fotoCount = fotoIndex;
  pending.lastPhotoAt = Date.now();
  await setPending(phone, pending);

  // FIX 10D (07/05/2026 - Andrade) — Progresso silencioso a cada 10 fotos com
  // contador detalhado pra Andrade saber em tempo real o que tá rolando.
  if (fotoIndex % 10 === 0) {
    try {
      const counts = await sbGet('drope_batch_queue',
        `select=decision&phone=eq.${encodeURIComponent(phone)}&batch_id=eq.${encodeURIComponent(pending.batch_id)}&limit=500`);
      const arr = Array.isArray(counts) ? counts : [];
      const matched = arr.filter(r => r.decision === 'matched_existing').length;
      const novos = arr.filter(r => r.decision === 'created_new').length;
      const semSabor = arr.filter(r => r.decision === 'unidentified_flavor').length;
      sendText(phone,
        `⏳ *Progresso: ${fotoIndex} fotos*\n` +
        `✅ ${matched} atualizados\n` +
        `📦 ${novos} novos\n` +
        (semSabor > 0 ? `⚠️ ${semSabor} sem sabor (revisar depois)\n` : '') +
        `\nManda mais ou *fechar lote*`,
        body).catch(() => {});
    } catch (_) {
      sendText(phone, `⏳ Processando... ${fotoIndex} fotos analisadas`, body).catch(() => {});
    }
  }
  return true;
}

async function closeBatch(phone, pending, body) {
  // FLC FASE 2.1 — Le QUEUE como fonte de verdade (resolve race condition entre invocacoes paralelas).
  // pending.matched/novos podem estar incompletos por race; queue é persistido linha-a-linha.
  const batchId = pending.batch_id;
  let queueRows = [];
  try {
    queueRows = await sbGet('drope_batch_queue',
      `select=*&phone=eq.${encodeURIComponent(phone)}&batch_id=eq.${encodeURIComponent(batchId)}&order=photo_index.asc&limit=500`);
  } catch (e) { console.warn('[FLC closeBatch] read queue:', e.message); }
  if (!Array.isArray(queueRows)) queueRows = [];

  const fotoCount = queueRows.length;
  const errorCount = queueRows.filter(r => r.status === 'error').length;
  const matchedRows = queueRows.filter(r => r.decision === 'matched_existing' && r.matched_product_id);
  const novoRows = queueRows.filter(r => r.decision === 'created_new' && r.created_product_id);
  // FIX 10B (07/05/2026 - Andrade): identifica fotos onde Vision falhou em ler sabor
  const unidentifiedRows = queueRows.filter(r => r.decision === 'unidentified_flavor');

  // Busca dados dos produtos referenciados pra montar nomes/modelos
  const allRefIds = [...new Set([...matchedRows.map(r => r.matched_product_id), ...novoRows.map(r => r.created_product_id)])];
  let prodById = {};
  if (allRefIds.length > 0) {
    try {
      const prodsResp = await sbGet('drope_products',
        `select=id,name,metadata,qty_available&id=in.(${allRefIds.join(',')})&limit=500`);
      if (Array.isArray(prodsResp)) {
        for (const p of prodsResp) prodById[p.id] = p;
      }
    } catch (_) {}
  }

  // Agrega matched por nome+id (soma qty_added)
  const matchedAgg = {};
  for (const r of matchedRows) {
    const p = prodById[r.matched_product_id];
    if (!p) continue;
    matchedAgg[p.name] = (matchedAgg[p.name] || 0) + (r.qty_added || 1);
  }

  // Agrega novos por modelo
  const novosByModel = {};
  for (const r of novoRows) {
    const p = prodById[r.created_product_id];
    if (!p) continue;
    const meta = p.metadata || {};
    const key = [meta.brand, meta.model].filter(Boolean).join(' ') || p.name;
    if (!novosByModel[key]) novosByModel[key] = [];
    novosByModel[key].push({ id: p.id, name: p.name, qty: r.qty_added || 1, brand: meta.brand, model: meta.model });
  }

  const novos = novoRows.map(r => ({ id: r.created_product_id }));

  let resumo = `📦 LOTE PROCESSADO — ${fotoCount} fotos\n\n`;
  if (Object.keys(matchedAgg).length) {
    resumo += `✅ ATUALIZADOS:\n`;
    for (const [name, qty] of Object.entries(matchedAgg)) resumo += `• ${name}: +${qty}\n`;
    resumo += `\n`;
  }
  if (Object.keys(novosByModel).length) {
    resumo += `📦 NOVOS CADASTRADOS (${novos.length} produtos, ${Object.keys(novosByModel).length} modelos):\n`;
    let i = 1;
    for (const [model, items] of Object.entries(novosByModel)) {
      resumo += `${i}. ${model} (${items.length} sabores)\n`;
      i++;
    }
    resumo += `\n`;
  }
  // SISTEMA IMUNE 07/05/2026: lista produtos novos que tiveram baixa retroativa
  // de vendas pendentes (Yasmin vendeu antes do cadastro).
  const reconciledList = [];
  for (const r of novoRows) {
    const p = prodById[r.created_product_id];
    const recon = p?.metadata?.reconciled_pending_sales;
    if (recon && recon.qty_pendentes > 0) {
      reconciledList.push({ name: p.name, ...recon });
    }
  }
  if (reconciledList.length) {
    resumo += `⏪ BAIXA RETROATIVA (vendas que aconteceram antes do cadastro):\n`;
    for (const r of reconciledList) {
      resumo += `• ${r.name}: ${r.qty_inicial} - ${r.qty_pendentes} venda${r.qty_pendentes>1?'s':''} = ${r.qty_final}\n`;
    }
    resumo += `\n`;
  }
  if (errorCount) resumo += `❌ ${errorCount} fotos com erro de download\n\n`;

  // FIX 10B (07/05/2026 - Andrade): mostra fotos sem sabor agrupadas por marca/modelo.
  // Andrade pode rever no admin ou refazer fotos com mais luz/angulo melhor.
  if (unidentifiedRows.length > 0) {
    // Agrega por brand+model extraido do error_message ou vision_response
    const semSaborAgg = {};
    for (const r of unidentifiedRows) {
      let key = '?';
      try {
        const vis = typeof r.vision_response === 'string' ? JSON.parse(r.vision_response) : r.vision_response;
        const p = vis?.products?.[0] || {};
        key = [p.brand || '?', p.model || ''].filter(Boolean).join(' ').trim() || '?';
      } catch (_) {}
      semSaborAgg[key] = (semSaborAgg[key] || 0) + 1;
    }
    resumo += `⚠️ *${unidentifiedRows.length} fotos sem sabor identificável*\n`;
    resumo += `(Vision viu marca/modelo mas não leu o sabor — foto borrada/ângulo)\n`;
    for (const [key, n] of Object.entries(semSaborAgg)) {
      resumo += `• ${key}: ${n} foto${n > 1 ? 's' : ''}\n`;
    }
    resumo += `\nPra resolver:\n`;
    resumo += `📸 Refaz essas fotos com luz/ângulo melhor\n`;
    resumo += `📋 Ou abre o painel \\'pendentes\\' pra completar manual\n\n`;
  }

  // FLC FASE 4 — Pipeline arte é disparado por _flcEnrichProduct (apos ter referencia).
  // Aqui só informa o usuário no resumo.
  if (novos.length > 0) {
    resumo += `🎨 ARTE: pipelines de busca referência+geração disparados em background pros ${novos.length} novos.\n`;
    resumo += `Quando todas as artes ficarem prontas, voce ve no Admin Hub.\n\n`;
  }

  if (novos.length > 0) {
    // FLC FASE 2.2 (07/05/2026) — usa ARRAY ordenado em vez de Object pra preservar
    // ordem das chaves no JSONB do Postgres (que reordena alfabeticamente keys de obj).
    const novosOrdered = Object.entries(novosByModel).map(([modelKey, items]) => ({ modelKey, items }));

    resumo += `💰 PREÇOS PENDENTES — ${novosOrdered.length} modelos\n\n`;
    resumo += `Manda preço de cada modelo (em R$):\n`;
    novosOrdered.forEach((entry, i) => {
      resumo += `${i + 1}. ${entry.modelKey} (${entry.items.length} sabores)\n`;
    });
    resumo += `\nFormato: "1. 89.90, 2. 79.90, 3. 99.00"`;

    await setPending(phone, {
      mode: 'batch_pricing',
      novosOrdered,
      startedAt: Date.now(),
    });
  } else {
    await clearPending(phone);
  }

  await sendText(phone, resumo, body);
}

async function tryHandleBatchPricing(phone, msg, body, text, pending) {
  if (!pending || pending.mode !== 'batch_pricing') return false;
  const lower = String(text || '').toLowerCase().trim();

  if (lower === 'cancela' || lower === 'cancelar' || lower === 'depois') {
    await clearPending(phone);
    await sendText(phone, '✅ Cancelado. Os produtos novos ficaram em status pending. Pode setar precos no Admin Hub.', body);
    return true;
  }

  // Parse "1. 89.90, 2. 79.90" ou "1. 89.90\n2. 79.90"
  const matches = [...String(text).matchAll(/(\d+)\.?\s*(\d+(?:[,.]\d+)?)/g)];
  if (matches.length === 0) {
    await sendText(phone, 'Nao entendi. Formato: "1. 89.90, 2. 79.90". Ou "cancela" pra deixar pendente.', body);
    return true;
  }

  // FIX TIER 1.1 (08/05/2026 - Andrade) — Validação rigorosa de preço.
  // Antes: aceitava price > 0 mas sem ceiling. Agora: rejeita preços fora de
  // (0.50, 9999.99) — protege contra erro digitação tipo '1. 0' (gratis) ou '1. 89999' (zero extra).
  const PRICE_MIN = 0.50;
  const PRICE_MAX = 9999.99;
  const allParsed = matches.map(m => ({ idx: parseInt(m[1]), price: parseFloat(m[2].replace(',', '.')) }));
  const invalid = allParsed.filter(u => u.idx > 0 && (u.price < PRICE_MIN || u.price > PRICE_MAX));
  if (invalid.length > 0) {
    const lista = invalid.map(u => `${u.idx}. R$ ${u.price.toFixed(2)}`).join(', ');
    await sendText(phone,
      `⚠️ *Preço fora do permitido* (entre R$ ${PRICE_MIN.toFixed(2)} e R$ ${PRICE_MAX.toFixed(2)}):\n${lista}\n\nDigite de novo o lote inteiro de preços.`,
      body);
    return true;
  }
  const updates = allParsed.filter(u => u.idx > 0 && u.price >= PRICE_MIN && u.price <= PRICE_MAX);
  // FLC FASE 2.2 — Le array ordenado (resiliente a reorder de jsonb).
  // Backwards-compat: se for pending velho com novosByModel obj, converte na hora.
  const novosOrdered = Array.isArray(pending.novosOrdered)
    ? pending.novosOrdered
    : Object.entries(pending.novosByModel || {}).map(([modelKey, items]) => ({ modelKey, items }));
  let countOk = 0, countMod = 0;
  const aplicados = [];
  for (const upd of updates) {
    if (upd.idx > novosOrdered.length) continue;
    const entry = novosOrdered[upd.idx - 1];
    if (!entry) continue;
    countMod++;
    for (const item of (entry.items || [])) {
      try {
        await sbUpdate('drope_products', `id=eq.${item.id}`, {
          price_cents: Math.round(upd.price * 100),
          status: 'active',
          hidden: false,
          updated_at: new Date().toISOString(),
        });
        countOk++;
      } catch (e) { console.warn('[FLC pricing] update:', e.message); }
    }
    aplicados.push(`${entry.modelKey}: R$ ${upd.price.toFixed(2)}`);
  }

  await clearPending(phone);
  await sendText(phone,
    `✅ ${countMod} modelos / ${countOk} produtos com preço atualizado e ATIVADOS!\n\n` +
    aplicados.map(a => `• ${a}`).join('\n'),
    body);
  return true;
}

// FLC FASE 3 — PESQUISA SERPER (specs + termometro sabor + descricao + ref-visual)
// SERPER_API_KEY ja existe nas envs (CLAUDE.md confirma).
async function _serperSearch(query, type = 'search', num = 8) {
  const key = process.env.SERPER_API_KEY || '';
  if (!key) return null;
  const endpoint = type === 'images' ? 'https://google.serper.dev/images' : 'https://google.serper.dev/search';
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { console.warn('[serper]', e.message); return null; }
}

// Specs do modelo (com cache em drope_model_specs_cache pra evitar repesquisar)
async function _flcFetchModelSpecs(brand, model) {
  if (!brand || !model) return null;
  // Cache primeiro
  try {
    const cached = await sbGet('drope_model_specs_cache',
      `select=*&brand=eq.${encodeURIComponent(brand)}&model=eq.${encodeURIComponent(model)}&limit=1`);
    if (Array.isArray(cached) && cached[0]) return cached[0];
  } catch (_) {}

  const data = await _serperSearch(`"${brand} ${model}" specifications puffs battery ml nicotine`, 'search', 6);
  if (!data) return null;
  const blob = (data.organic || []).map(o => `${o.title || ''}. ${o.snippet || ''}`).join('\n');
  const blobL = blob.toLowerCase();

  // Puffs: aceita "15000 puffs", "15k puffs"
  let puffsNum = null;
  const m1 = blobL.match(/(\d+(?:[.,]\d+)?)\s*k\s*puffs?/);
  const m2 = blobL.match(/(\d+(?:[.,]\d+)?)\s*puffs?/);
  if (m1) puffsNum = Math.round(parseFloat(m1[1].replace(',', '.')) * 1000);
  else if (m2) puffsNum = Math.round(parseFloat(m2[1].replace(',', '.')));

  const batMatch = blobL.match(/(\d+)\s*mah/);
  const liqMatch = blobL.match(/(\d+(?:\.\d+)?)\s*ml/);
  const nicMatch = blobL.match(/(\d+(?:\.\d+)?)\s*%\s*(?:nic|nicotin)/) || blobL.match(/(\d+(?:\.\d+)?)\s*%/);

  const specs = {
    brand, model,
    puffs: puffsNum,
    battery: batMatch ? `${batMatch[1]}mAh` : null,
    liquid_ml: liqMatch ? `${liqMatch[1]}ml` : null,
    nicotine: nicMatch ? `${nicMatch[1]}%` : null,
    description: ((data.organic || [])[0]?.snippet || '').slice(0, 500),
    raw_serper_results: data,
  };

  try { await sbInsert('drope_model_specs_cache', specs); } catch (e) { /* unique violation = race, ignore */ }
  return specs;
}

// Termometro de sabor (sweet/ice/sour 0-5) baseado em Serper reviews + fallback heuristico
async function _flcFetchFlavorThermometer(brand, model, flavor) {
  if (!flavor) return null;
  const fl = String(flavor).toLowerCase();

  // Fallback heuristico pelo nome (sempre rola, mesmo se Serper falhar)
  const inferFromName = () => {
    let sweet = 3, ice = 0, sour = 0;
    if (/ice|iced|gelad|menta|mint|cold|frozen|frio|chill/.test(fl)) ice = 4;
    if (/extreme|max|hyper|frozen/.test(fl)) ice = Math.max(ice, 5);
    if (/menthol|mint/.test(fl) && !/banana|grape|berry|cherry|peach/.test(fl)) { sweet = 1; ice = 5; }
    if (/sour|azed|tangy/.test(fl)) sour = 4;
    if (/banana|mango|peach|caramel|vanilla|cream|donut|honey/.test(fl)) sweet = 4;
    if (/strawberry|cherry|berry|grape|watermelon|melon|raspberry|blue razz|razz|fruit/.test(fl)) sweet = 4;
    if (/chocolate|brownie|cake|sirup|sugar/.test(fl)) sweet = 5;
    if (/lemon|lime|grapefruit|citrus/.test(fl)) sour = 3;
    return { flavor_sweet: sweet, flavor_ice: ice, flavor_sour: sour };
  };

  const data = await _serperSearch(`"${brand} ${model} ${flavor}" review flavor profile sweet ice sour`, 'search', 6);
  if (!data) return inferFromName();
  const blob = (data.organic || []).map(o => `${o.title || ''}. ${o.snippet || ''}`).join(' ').toLowerCase();

  const cnt = (rx) => (blob.match(rx) || []).length;
  const sweetWords = cnt(/\b(sweet|sugary|candy|honey|syrup|sirup|saboroso|doce|adocicado|dessert)\b/g);
  const iceWords = cnt(/\b(ice|iced|cold|cool|menthol|mint|frosty|chill|gelad|menta|frosty)\b/g);
  const sourWords = cnt(/\b(sour|tart|tangy|acidic|acid|sharp|azed|citrus|zest)\b/g);

  const score = (n) => Math.max(0, Math.min(5, Math.round(n / 1.5)));
  const fromSerper = {
    flavor_sweet: score(sweetWords),
    flavor_ice: score(iceWords),
    flavor_sour: score(sourWords),
  };
  // Se Serper deu 0 em tudo, usa fallback
  if (fromSerper.flavor_sweet + fromSerper.flavor_ice + fromSerper.flavor_sour === 0) return inferFromName();
  return fromSerper;
}

// Descricao curta e gen-z friendly (Lacuna 5)
function _flcGenerateDescription(flavor) {
  if (!flavor) return null;
  const fl = String(flavor).toLowerCase();
  const main = {
    banana: 'banana doce', grape: 'uva intensa', mango: 'manga tropical',
    strawberry: 'morango fresco', watermelon: 'melancia suculenta', peach: 'pêssego maduro',
    cherry: 'cereja vermelha', blueberry: 'mirtilo profundo', raspberry: 'framboesa azeda',
    apple: 'maçã crocante', lemon: 'limão cítrico', lime: 'lima refrescante',
    pineapple: 'abacaxi tropical', coconut: 'coco cremoso', mint: 'menta intensa',
    'blue razz': 'framboesa azul', 'mixed berry': 'mix de berries',
    pomegranate: 'romã profunda', kiwi: 'kiwi verde', orange: 'laranja vibrante',
  };
  let foundMain = null;
  for (const [k, v] of Object.entries(main)) {
    if (fl.includes(k)) { foundMain = v; break; }
  }
  if (!foundMain) foundMain = String(flavor).toLowerCase();

  let modifier;
  if (/ice|iced|frozen|gelad/.test(fl)) modifier = 'gelado refrescante';
  else if (/sour|tangy/.test(fl)) modifier = 'toque azedo';
  else if (/cream|creamy|cremoso/.test(fl)) modifier = 'cremoso e suave';
  else if (/sweet|doce/.test(fl)) modifier = 'super doce';
  else modifier = 'sabor marcante';

  return `${foundMain} ✦ ${modifier}`.slice(0, 60);
}

// Enriquece um produto novo com specs + termometro + descricao + foto referencia + dispara arte.
// Best-effort: erros nao quebram o flow principal.
// FIX BATCH 3 (07/05/2026) — Dispara enrichment em invocacao Vercel separada (60s proprios).
// Antes: tryHandleBatchPhoto chamava _flcEnrichProduct fire-and-forget na MESMA invocacao.
// Quando o lote era grande (5+ fotos), a invocacao morria por timeout antes do enrichment
// terminar — produtos ficavam sem reference_candidates e Andrade tinha que clicar
// "buscar de novo" manualmente. Agora cada produto tem 60s proprios pra enrich.
async function fireBackgroundEnrich(productId) {
  if (!ADMIN_TOKEN) {
    console.error('[fireEnrich] ADMIN_TOKEN not configured');
    return false;
  }
  const host = process.env.VERCEL_URL || 'drope-app.vercel.app';
  const url = `https://${host}/api/webhook?action=enrich_product&product_id=${encodeURIComponent(productId)}`;
  console.log(`[fireEnrich] dispatching productId=${productId} via ${host}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      signal: controller.signal,
    });
    return true;
  } catch (e) {
    // AbortError esperado (1.5s timeout do cliente, invocacao destino segue rodando)
    return e.name === 'AbortError';
  } finally { clearTimeout(timeoutId); }
}

async function _flcEnrichProduct(productId, brand, model, flavor) {
  if (!productId) return;
  try {
    const [specs, thermometer] = await Promise.all([
      _flcFetchModelSpecs(brand, model).catch(() => null),
      _flcFetchFlavorThermometer(brand, model, flavor).catch(() => null),
    ]);
    const desc = _flcGenerateDescription(flavor);

    const update = { updated_at: new Date().toISOString() };
    if (specs?.puffs) update.puffs = specs.puffs;
    if (specs?.battery) update.battery = specs.battery;
    if (specs?.liquid_ml) update.liquid_ml = specs.liquid_ml;
    if (specs?.nicotine) update.nicotine = specs.nicotine;
    if (thermometer?.flavor_sweet != null) update.flavor_sweet = thermometer.flavor_sweet;
    if (thermometer?.flavor_ice != null) update.flavor_ice = thermometer.flavor_ice;
    if (thermometer?.flavor_sour != null) update.flavor_sour = thermometer.flavor_sour;
    if (desc) update.description = desc;

    if (Object.keys(update).length > 1) {
      await sbUpdate('drope_products', `id=eq.${productId}`, update);
    }

    // FLC FASE 4 — Busca referência visual via autoFindReference (Serper + Vision rank)
    try {
      const prods = await sbGet('drope_products', `id=eq.${productId}&select=*&limit=1`);
      const product = prods?.[0];
      if (product) {
        await autoFindReference(product).catch((e) => console.warn('[FLC autoFindRef]', e.message));
      }
    } catch (e) { console.warn('[FLC ref]', e.message); }

    // FLC FASE 4 — Depois de ter referência, dispara pipeline arte Grok+VisionQA
    try {
      await fireBackgroundArtGeneration(productId, 'admin', 1).catch(() => {});
    } catch (_) {}
  } catch (e) {
    console.warn('[FLC enrich]', e.message);
  }
}

// ============ MOTOBOY V2 (07/05/2026) — handler de grupo + whitelist + lifecycle ============

// Calcula valor justo da corrida proporcional à distância.
// Base: R$ 5 + R$ 1.50/km, mínimo R$ 7. Sem dist informada, default 4km (média Vila Prudente).
function _motoboyCalcValorCents(distKm) {
  const km = (typeof distKm === 'number' && distKm > 0) ? distKm : 4;
  const valor = Math.max(7, Math.round((5 + 1.5 * km) * 100) / 100);
  return Math.round(valor * 100); // cents
}

// Detecta intenção de aceitar corrida (flex — não exige palavra exata)
function _motoboyDetectAceite(text) {
  if (!text) return false;
  const t = String(text).toLowerCase().trim();
  if (t.length > 80) return false; // mensagens longas dificilmente são aceite
  // Palavras-chave + emojis que indicam aceite
  const patterns = [
    /\bpego\b/i, /\bpegou?\b/i, /\bpeguei\b/i,
    /\bvou\b/i, /\bminha\b/i, /\beu\b.*\bpego\b/i,
    /\bdeixa comigo\b/i, /\bcomigo\b/i,
    /\bto indo\b/i, /\btô indo\b/i, /\bto\s*indo\b/i, /\bja vou\b/i,
    /\bvou levar\b/i, /\bvou fazer\b/i,
    /^🤚/u, /^🏃/u, /^🏍/u, /^✋/u, /^👋/u,
    /\b(eu|me)\b.*\b(pego|vou|aceito|levo)\b/i,
  ];
  return patterns.some(rx => rx.test(t));
}

// Detecta comando de lifecycle pós-aceite
function _motoboyDetectComando(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();
  if (t.length > 50) return null;
  // SAIU (motoboy iniciou)
  if (/^(sai|saí|saiu|to indo|tô indo|peguei|coletei|peguei o pedido)\b/.test(t) || /^🛵|^🏍|^🚀/u.test(t)) return 'saiu';
  // ENTREGUE
  if (/^(entreguei|entregue|entreguou|finalizei|✅|fim)\b/.test(t) || /^✅|^🏁|^👍/u.test(t)) return 'entregue';
  // CANCELO
  if (/^(cancelo|cancela|desisto|desisti|nao vou|não vou|ñ vou|problema)\b/.test(t) || /^❌|^🚫/u.test(t)) return 'cancelo';
  return null;
}

// Helper: pega motoboy whitelistado por phone
async function _motoboyGetByPhone(senderPhone) {
  if (!senderPhone) return null;
  const clean = String(senderPhone).replace(/[^0-9]/g, '');
  if (!clean) return null;
  // Busca exato OU sem 55 prefix
  const variants = [clean, clean.startsWith('55') ? clean.slice(2) : '55' + clean];
  for (const p of variants) {
    const rows = await sbGet('drope_motoboys', `phone=eq.${encodeURIComponent(p)}&ativo=eq.true&limit=1`);
    if (Array.isArray(rows) && rows[0]) return rows[0];
  }
  return null;
}

// Comandos admin de motoboy no privado do Lucas
async function tryHandleMotoboyAdminCommand(phone, msg, body, text, pending) {
  if (!text) return false;
  const t = String(text).trim();
  const lower = t.toLowerCase();
  console.log('[motoboy-admin] check:', JSON.stringify(lower.slice(0, 40)), 'GRUPO_MOTOBOY_JID set:', !!GRUPO_MOTOBOY_JID);

  // motoboys briefing → posta orientação no grupo motoboy
  if (lower === 'motoboys briefing' || lower === 'briefing motoboys' || lower === 'orienta motoboys') {
    if (!GRUPO_MOTOBOY_JID) {
      await sendText(phone, '⚠️ GRUPO_MOTOBOY_JID nao configurado.', body);
      return true;
    }
    const briefingMsg = `🦎 *DROPE — COMO PEGAR CORRIDA*

Quando aparecer card *🏍️ CORRIDA DISPONÍVEL* aqui no grupo:
✅ Manda *PEGO* (ou "vou", "minha", "deixa comigo", 🤚)
✅ Primeiro a responder ganha (sistema race-safe)
✅ Bot manda detalhes no seu privado: endereço completo, tel cliente, Maps

*Depois que pegar, manda no GRUPO ou no PRIVADO do bot:*
🛵 *saí* — quando coletar o pedido na loja
🏁 *entreguei* — quando finalizar a entrega
❌ *cancelo* — se algo deu errado (recoloca corrida pra outros)

*Score:* todo motoboy começa com 100 pontos.
• -5 cada cancelamento
• Quem mantém score alto pega corridas mais valiosas

Dúvida? Manda no privado do Andrade.`;
    await sendText(GRUPO_MOTOBOY_JID, briefingMsg, body);
    await sendText(phone, '✅ Briefing postado no grupo motoboy.', body);
    return true;
  }

  // motoboys → lista whitelist
  if (lower === 'motoboys' || lower === 'lista motoboys') {
    const list = await sbGet('drope_motoboys', 'select=phone,nome,ativo,score,corridas_entregues,corridas_canceladas&order=score.desc&limit=50');
    if (!Array.isArray(list) || list.length === 0) {
      await sendText(phone, '🏍️ Nenhum motoboy cadastrado.\n\nAdiciona com: motoboy add 5511XXXXXXXX Nome', body);
      return true;
    }
    const lines = list.map(m => `• ${m.ativo ? '✅' : '❌'} ${m.nome} (${m.phone}) — score ${m.score} | ${m.corridas_entregues}🏁 ${m.corridas_canceladas}❌`);
    await sendText(phone, `🏍️ MOTOBOYS (${list.length}):\n\n${lines.join('\n')}\n\nComandos:\n• motoboy add 5511XXX Nome\n• motoboy remove 5511XXX\n• motoboy off/on 5511XXX`, body);
    return true;
  }

  // motoboy add 5511... Nome Sobrenome
  const addMatch = t.match(/^motoboy\s+add\s+(\d{10,13})\s+(.{1,80})$/i);
  if (addMatch) {
    const motoPhone = addMatch[1].replace(/[^0-9]/g, '');
    const nome = addMatch[2].trim();
    try {
      await sbInsert('drope_motoboys', { phone: motoPhone, nome, ativo: true });
      await sendText(phone, `✅ Motoboy adicionado: ${nome} (${motoPhone}).`, body);
    } catch (e) {
      // pode ser duplicate — atualiza
      await sbUpdate('drope_motoboys', `phone=eq.${motoPhone}`, { nome, ativo: true, updated_at: new Date().toISOString() });
      await sendText(phone, `✅ Motoboy atualizado: ${nome} (${motoPhone}).`, body);
    }
    return true;
  }

  // motoboy remove 5511...
  const rmMatch = lower.match(/^motoboy\s+(remove|delete|del)\s+(\d{10,13})$/);
  if (rmMatch) {
    const motoPhone = rmMatch[2];
    await sbUpdate('drope_motoboys', `phone=eq.${motoPhone}`, { ativo: false, updated_at: new Date().toISOString() });
    await sendText(phone, `✅ Motoboy ${motoPhone} desativado.`, body);
    return true;
  }

  // motoboy off/on 5511...
  const togMatch = lower.match(/^motoboy\s+(on|off|ativa|desativa)\s+(\d{10,13})$/);
  if (togMatch) {
    const ativo = ['on', 'ativa'].includes(togMatch[1]);
    await sbUpdate('drope_motoboys', `phone=eq.${togMatch[2]}`, { ativo, updated_at: new Date().toISOString() });
    await sendText(phone, `${ativo ? '✅' : '❌'} Motoboy ${togMatch[2]} ${ativo ? 'ativado' : 'desativado'}.`, body);
    return true;
  }

  // corrida #N [dist=X] [valor=Y] — posta corrida no grupo
  const corridaMatch = lower.match(/^(?:corrida|envia corrida|enviar corrida)\s+#?(\d+)(?:\s+dist=([\d.,]+))?(?:\s+(?:valor|r\$)\s*=?\s*([\d.,]+))?/);
  if (corridaMatch) {
    const orderId = parseInt(corridaMatch[1]);
    const distKm = corridaMatch[2] ? parseFloat(corridaMatch[2].replace(',', '.')) : null;
    const valorOverride = corridaMatch[3] ? parseFloat(corridaMatch[3].replace(',', '.')) : null;
    return await _motoboyPostCorrida(phone, body, orderId, distKm, valorOverride);
  }

  // corridas — lista corridas abertas
  if (lower === 'corridas' || lower === 'corridas abertas') {
    const list = await sbGet('drope_corridas', 'select=id,order_id,status,motoboy_nome,valor_motoboy_cents,posted_at&status=in.(aberta,aceita)&order=posted_at.desc&limit=20');
    if (!Array.isArray(list) || list.length === 0) {
      await sendText(phone, '🏍️ Nenhuma corrida aberta/em andamento.', body);
      return true;
    }
    const lines = list.map(c => `• ${c.status === 'aberta' ? '🟡 ABERTA' : '🟢 ' + (c.motoboy_nome || '?')} #${c.order_id} — R$ ${(c.valor_motoboy_cents/100).toFixed(2)}`);
    await sendText(phone, `🏍️ CORRIDAS:\n\n${lines.join('\n')}`, body);
    return true;
  }

  return false;
}

// Posta corrida no grupo motoboy + cria row drope_corridas
async function _motoboyPostCorrida(adminPhone, body, orderId, distKm, valorOverride) {
  if (!GRUPO_MOTOBOY_JID) {
    await sendText(adminPhone, '⚠️ GRUPO_MOTOBOY_JID nao configurado. Adiciona o bot no grupo de motoboys primeiro.', body);
    return true;
  }
  // Busca pedido
  const orders = await sbGet('drope_orders', `or=(id.eq.${orderId},order_nsu.eq.${orderId})&limit=1`);
  const order = Array.isArray(orders) && orders[0];
  if (!order) {
    await sendText(adminPhone, `⚠️ Pedido #${orderId} nao encontrado.`, body);
    return true;
  }
  // Verifica se ja tem corrida ativa pra esse pedido
  const exist = await sbGet('drope_corridas', `order_id=eq.${order.id}&status=in.(aberta,aceita)&limit=1`);
  if (Array.isArray(exist) && exist[0]) {
    await sendText(adminPhone, `⚠️ Pedido #${orderId} ja tem corrida ${exist[0].status} (id ${exist[0].id}).`, body);
    return true;
  }

  // Extrai endereço destino
  const addr = order.address || {};
  const enderecoDest = [addr.rua, addr.numero, addr.bairro, addr.complemento]
    .filter(Boolean).join(', ') || addr.endereco || addr.full_address || '(sem endereço cadastrado)';
  const clientePhone = order.customer_snapshot?.phone || addr.phone || null;
  const valorCents = valorOverride ? Math.round(valorOverride * 100) : _motoboyCalcValorCents(distKm);
  const itensDesc = Array.isArray(order.items)
    ? order.items.map(i => `${i.qty || 1}x ${i.name || i.slug}`).join(', ').slice(0, 200)
    : '(itens nao listados)';

  // Cria corrida
  const inserted = await sbInsert('drope_corridas', {
    order_id: order.id,
    status: 'aberta',
    valor_motoboy_cents: valorCents,
    distancia_km: distKm,
    endereco_destino: enderecoDest,
    cliente_phone: clientePhone,
  });
  const corrida = Array.isArray(inserted) ? inserted[0] : inserted;

  // Monta mensagem do grupo
  const distLabel = distKm ? `📏 Dist: ${distKm}km` : '📏 Dist: ~4km (estimado)';
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(enderecoDest)}`;
  const grupoMsg = `🏍️ *CORRIDA DISPONÍVEL*

📦 Pedido #${order.order_nsu || order.id}
🛒 Itens: ${itensDesc}
📍 Destino: ${enderecoDest}
${distLabel}
💰 *R$ ${(valorCents/100).toFixed(2)}*
🗺️ ${mapsUrl}

Pra pegar, manda *PEGO* aqui no grupo.`;

  await sendText(GRUPO_MOTOBOY_JID, grupoMsg, body);
  await sbUpdate('drope_corridas', `id=eq.${corrida.id}`, { posted_at: new Date().toISOString() });
  await sendText(adminPhone, `✅ Corrida ${corrida.id} postada no grupo. R$ ${(valorCents/100).toFixed(2)}${distKm ? ` (${distKm}km)` : ''}.`, body);
  return true;
}

// Handler principal do grupo motoboy
async function handleMotoboyGroup(phone, msg, body) {
  // phone aqui é o JID do grupo (já vem do roteamento)
  const text = asString(msg.text) || asString(msg.content) || asString(msg.caption);
  // Phone do remetente (motoboy individual)
  const senderPhone = msg.sender_pn?.replace(/[^0-9]/g, '') || msg.sender?.replace(/[^0-9]/g, '');
  if (!senderPhone) return;

  // Ignora msgs do próprio bot (evita loop)
  if (msg.fromMe || msg.wasSentByApi) return;

  // Verifica whitelist
  const motoboy = await _motoboyGetByPhone(senderPhone);
  if (!motoboy) {
    console.log(`[motoboy] phone ${senderPhone.slice(0,6)}*** nao está na whitelist`);
    return; // silencioso — nao polui grupo com erro
  }

  // Detecta comando de lifecycle (sai/entreguei/cancelo)
  const cmd = _motoboyDetectComando(text);
  if (cmd) {
    return await _motoboyHandleLifecycle(phone, body, motoboy, cmd, text);
  }

  // Detecta aceite ("PEGO" + variações)
  const aceitou = _motoboyDetectAceite(text);
  if (aceitou) {
    return await _motoboyHandleAceite(phone, body, motoboy);
  }

  // Outras mensagens: ignora silenciosamente
}

// Aceite de corrida — UPDATE atômico race-safe
async function _motoboyHandleAceite(grupoJid, body, motoboy) {
  // FIX MAIO/2026 — Antes de qualquer coisa, checa se há corrida aceita HÁ POUCO (60s).
  // Se sim, ignora silenciosamente PEGOs tardios pra não poluir o grupo.
  const aceitaRecente = await sbGet('drope_corridas',
    `select=id,motoboy_nome,accepted_at&status=in.(aceita,em_rota)&accepted_at=gt.${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}&order=accepted_at.desc&limit=1`);
  if (Array.isArray(aceitaRecente) && aceitaRecente[0]) {
    console.log(`[motoboy] PEGO tardio de ${motoboy.nome} ignorado — ${aceitaRecente[0].motoboy_nome} aceitou ha menos de 60s`);
    return; // silencioso
  }

  // UPDATE atômico: só pega corridas com status='aberta', se 0 rows = perdeu race
  const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/drope_corridas?status=eq.aberta&order=posted_at.asc&limit=1`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify({
      status: 'aceita',
      motoboy_phone: motoboy.phone,
      motoboy_nome: motoboy.nome,
      accepted_at: new Date().toISOString(),
    }),
  });
  const updated = await updateRes.json();
  if (!Array.isArray(updated) || updated.length === 0) {
    // Nenhuma corrida aberta — silencioso (evita poluir grupo)
    return;
  }
  const corrida = updated[0];

  // Confirma no grupo
  const valorTxt = `R$ ${(corrida.valor_motoboy_cents/100).toFixed(2)}`;
  await sendText(grupoJid, `✅ *${motoboy.nome}* pegou a corrida #${corrida.order_id} 🏍️\nValor: ${valorTxt}`, body);

  // Manda detalhes no PRIVADO do motoboy
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(corrida.endereco_destino || '')}`;
  const detalhes = `🏍️ *Corrida ${corrida.id} — Pedido #${corrida.order_id}*

📍 Destino: ${corrida.endereco_destino || '?'}
📞 Cliente: ${corrida.cliente_phone || '(sem telefone)'}
💰 Valor: ${valorTxt}
🗺️ ${mapsUrl}

*Comandos:*
• "saí" — quando coletar e iniciar viagem
• "entreguei" — quando finalizar
• "cancelo" — se nao puder ir`;
  await sendText(motoboy.phone, detalhes, body).catch(() => {});

  // Avisa cliente
  if (corrida.cliente_phone) {
    await sendText(corrida.cliente_phone,
      `🏍️ Seu pedido #${corrida.order_id} saiu pra entrega com *${motoboy.nome}*.\nQualquer coisa, fala com a gente.`,
      body).catch(() => {});
  }

  // Atualiza contador do motoboy
  await sbUpdate('drope_motoboys', `phone=eq.${motoboy.phone}`, {
    corridas_total: (motoboy.corridas_total || 0) + 1,
    updated_at: new Date().toISOString(),
  }).catch(() => {});
}

// Lifecycle: saiu / entregue / cancelo
// FIX MAIO/2026 — Race-safe via UPDATE atomico com filter de transicao valida.
// Se 2 invocacoes simultaneas chegam (UazAPI duplica webhook), so a 1a UPDATE retorna >=1
// row; a 2a retorna 0 (filtro nao bate mais) e sai silenciosamente. Antes ambas
// chegavam no sendText e geravam mensagem duplicada no grupo.
async function _motoboyHandleLifecycle(grupoJid, body, motoboy, cmd, text) {
  if (cmd === 'saiu') {
    // Transicao valida: aceita -> em_rota. Filter no UPDATE = atomico.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/drope_corridas?motoboy_phone=eq.${encodeURIComponent(motoboy.phone)}&status=eq.aceita&order=accepted_at.desc&limit=1`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'em_rota', updated_at: new Date().toISOString() }),
    });
    const updated = await r.json();
    if (!Array.isArray(updated) || updated.length === 0) {
      console.log(`[motoboy lifecycle] saiu race-lost para ${motoboy.nome}`);
      return; // perdeu race ou nao tem corrida aceita
    }
    const corrida = updated[0];
    await sendText(grupoJid, `🛵 ${motoboy.nome} saiu com pedido #${corrida.order_id}.`, body);
    if (corrida.cliente_phone) {
      await sendText(corrida.cliente_phone, `🛵 ${motoboy.nome} saiu com seu pedido. Chega aí em uns minutos!`, body).catch(() => {});
    }
    return;
  }

  if (cmd === 'entregue') {
    // Transicao valida: aceita|em_rota -> entregue. Filter atomico.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/drope_corridas?motoboy_phone=eq.${encodeURIComponent(motoboy.phone)}&status=in.(aceita,em_rota)&order=accepted_at.desc&limit=1`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'entregue', delivered_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    const updated = await r.json();
    if (!Array.isArray(updated) || updated.length === 0) {
      console.log(`[motoboy lifecycle] entregue race-lost para ${motoboy.nome}`);
      return;
    }
    const corrida = updated[0];
    await sbUpdate('drope_motoboys', `phone=eq.${motoboy.phone}`, {
      corridas_entregues: (motoboy.corridas_entregues || 0) + 1,
      updated_at: new Date().toISOString(),
    });
    await sendText(grupoJid, `🏁 ${motoboy.nome} entregou pedido #${corrida.order_id}. R$ ${(corrida.valor_motoboy_cents/100).toFixed(2)}`, body);
    if (corrida.cliente_phone) {
      await sendText(corrida.cliente_phone, `✅ Pedido #${corrida.order_id} entregue!\n\nValeu pela compra 🦎`, body).catch(() => {});
    }
    return;
  }

  if (cmd === 'cancelo') {
    // Transicao valida: aceita|em_rota -> aberta (reabre).
    const r = await fetch(`${SUPABASE_URL}/rest/v1/drope_corridas?motoboy_phone=eq.${encodeURIComponent(motoboy.phone)}&status=in.(aceita,em_rota)&order=accepted_at.desc&limit=1`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        status: 'aberta',
        motoboy_phone: null, motoboy_nome: null, accepted_at: null,
        cancel_reason: `cancelado por ${motoboy.nome}: ${text || ''}`.slice(0, 200),
        updated_at: new Date().toISOString(),
      }),
    });
    const updated = await r.json();
    if (!Array.isArray(updated) || updated.length === 0) {
      console.log(`[motoboy lifecycle] cancelo race-lost para ${motoboy.nome}`);
      return;
    }
    const corrida = updated[0];
    await sbUpdate('drope_motoboys', `phone=eq.${motoboy.phone}`, {
      corridas_canceladas: (motoboy.corridas_canceladas || 0) + 1,
      score: Math.max(0, (motoboy.score || 100) - 5),
      updated_at: new Date().toISOString(),
    });
    await sendText(grupoJid, `❌ ${motoboy.nome} cancelou corrida #${corrida.order_id}. Quem pega? Manda *PEGO*.`, body);
    return;
  }
}

// TIER 2 (08/05/2026 - Andrade) — Comandos admin pra editar produtos via WhatsApp.
// Resolve o cenário comum: Andrade quer mudar preço de produto cadastrado, ajustar
// qty, renomear, etc — sem ir no Admin Hub web.

// Helper: busca produto por nome fuzzy (último cadastrado se múltiplos)
async function _findProductByFuzzyName(query) {
  const q = String(query || '').trim();
  if (q.length < 3) return null;
  // Tenta ilike primeiro (mais permissivo)
  const safe = encodeURIComponent('%' + q + '%');
  const rows = await sbGet('drope_products',
    `name=ilike.${safe}&hidden=eq.false&select=id,name,price_cents,qty_available,status,metadata,slug,description&order=updated_at.desc&limit=5`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows;
}

// TIER 2.1 — comando 'preço NOME 89.90' / 'preco NOME 89.90'
async function tryHandlePriceCommand(phone, msg, body, text) {
  const t = String(text || '').trim();
  // Match: 'preço/preco/price NOME PRECO' (preço pode ter , ou .)
  const m = t.match(/^pre[çc]o?\s+(.+?)\s+(\d+(?:[,.]\d+)?)\s*$/i) || t.match(/^price\s+(.+?)\s+(\d+(?:[,.]\d+)?)\s*$/i);
  if (!m) return false;
  const nameQuery = m[1].trim();
  const priceReais = parseFloat(m[2].replace(',', '.'));
  if (priceReais < 0.50 || priceReais > 9999.99) {
    await sendText(phone, `⚠️ Preço fora do permitido (R$ 0.50 — R$ 9999.99).`, body);
    return true;
  }
  const rows = await _findProductByFuzzyName(nameQuery);
  if (!rows || rows.length === 0) {
    await sendText(phone, `⚠️ Não achei produto com "${nameQuery}".`, body);
    return true;
  }
  if (rows.length > 1) {
    const lista = rows.slice(0, 5).map((p, i) => `${i+1}. ${p.name} (R$ ${(p.price_cents/100).toFixed(2)})`).join('\n');
    await sendText(phone,
      `⚠️ Mais de um produto bate com "${nameQuery}":\n\n${lista}\n\nDigita mais específico.`, body);
    return true;
  }
  const p = rows[0];
  const oldPrice = p.price_cents || 0;
  const newPriceCents = Math.round(priceReais * 100);
  const newMeta = { ...(p.metadata || {}), last_changed_by: phone, price_change_source: 'whatsapp_command' };
  await sbUpdate('drope_products', `id=eq.${p.id}`, {
    price_cents: newPriceCents,
    status: 'active',
    hidden: false,
    metadata: newMeta,
    updated_at: new Date().toISOString(),
  });
  await sendText(phone,
    `✅ *${p.name}*\n\n` +
    `R$ ${(oldPrice/100).toFixed(2)} → R$ ${priceReais.toFixed(2)}\n` +
    `Status: active`,
    body);
  return true;
}

// TIER 2.2 — comando 'editar NOME campo valor'
async function tryHandleEditCommand(phone, msg, body, text) {
  const t = String(text || '').trim();
  // Match: 'editar/edita NOME CAMPO VALOR' onde CAMPO é qty/nome/sabor/modelo/marca/descricao
  const m = t.match(/^edit(?:ar|a)?\s+(.+?)\s+(qty|estoque|nome|name|sabor|flavor|modelo|model|marca|brand|descricao|descrição|description)\s+(.+)$/i);
  if (!m) return false;
  const nameQuery = m[1].trim();
  const field = m[2].toLowerCase();
  const valueRaw = m[3].trim();
  const rows = await _findProductByFuzzyName(nameQuery);
  if (!rows || rows.length === 0) {
    await sendText(phone, `⚠️ Não achei produto com "${nameQuery}".`, body);
    return true;
  }
  if (rows.length > 1) {
    const lista = rows.slice(0, 5).map((p, i) => `${i+1}. ${p.name}`).join('\n');
    await sendText(phone, `⚠️ Mais de um produto bate:\n\n${lista}\n\nDigita mais específico.`, body);
    return true;
  }
  const p = rows[0];
  const update = { updated_at: new Date().toISOString() };
  const meta = p.metadata || {};
  let humanField = field;

  if (field === 'qty' || field === 'estoque') {
    const n = parseInt(valueRaw);
    if (isNaN(n) || n < 0 || n > 9999) {
      await sendText(phone, '⚠️ Qty inválida (0-9999).', body); return true;
    }
    update.qty_available = n;
    humanField = 'qty';
  } else if (field === 'nome' || field === 'name') {
    if (valueRaw.length < 4) { await sendText(phone, '⚠️ Nome muito curto.', body); return true; }
    update.name = valueRaw.slice(0, 200);
    humanField = 'nome';
  } else if (field === 'sabor' || field === 'flavor') {
    update.metadata = { ...meta, flavor: valueRaw, flavor_en: valueRaw, flavor_pt: valueRaw, last_changed_by: phone };
    humanField = 'sabor';
  } else if (field === 'modelo' || field === 'model') {
    update.metadata = { ...meta, model: valueRaw, last_changed_by: phone };
    humanField = 'modelo';
  } else if (field === 'marca' || field === 'brand') {
    update.metadata = { ...meta, brand: valueRaw.toUpperCase(), last_changed_by: phone };
    humanField = 'marca';
  } else if (field === 'descricao' || field === 'descrição' || field === 'description') {
    update.description = valueRaw.slice(0, 500);
    humanField = 'descrição';
  }

  await sbUpdate('drope_products', `id=eq.${p.id}`, update);
  try { await logSystemEvent('product_edited', { product_id: p.id, name: p.name, field: humanField, new_value: valueRaw.slice(0, 100) }, phone); } catch (_) {}
  await sendText(phone, `✅ *${p.name}*\n\n${humanField}: ${valueRaw}`, body);
  return true;
}

// TIER 2.3 — comando 'desfaz lote' / 'desfazer lote'
async function tryHandleUndoBatch(phone, msg, body, text) {
  const lower = String(text || '').toLowerCase().trim();
  if (lower !== 'desfaz lote' && lower !== 'desfazer lote' && lower !== 'undo lote' && lower !== 'rollback lote') return false;

  // Pega último batch finalizado do phone (último 'created_new' do drope_batch_queue)
  const recent = await sbGet('drope_batch_queue',
    `select=batch_id,created_product_id,created_at&phone=eq.${encodeURIComponent(phone)}&decision=eq.created_new&created_product_id=not.is.null&order=created_at.desc&limit=200`);
  if (!Array.isArray(recent) || recent.length === 0) {
    await sendText(phone, '⚠️ Nenhum lote recente pra desfazer.', body);
    return true;
  }
  const lastBatchId = recent[0].batch_id;
  const productIds = [...new Set(recent.filter(r => r.batch_id === lastBatchId).map(r => r.created_product_id))];
  if (productIds.length === 0) {
    await sendText(phone, '⚠️ Lote sem produtos cadastrados pra desfazer.', body);
    return true;
  }

  // Busca nomes pra mostrar
  const prods = await sbGet('drope_products',
    `select=id,name&id=in.(${productIds.join(',')})&limit=200`);
  const arr = Array.isArray(prods) ? prods : [];

  // Marca todos como hidden=true + status=inactive (não deleta — preserva histórico)
  await sbUpdate('drope_products', `id=in.(${productIds.join(',')})`, {
    hidden: true,
    status: 'inactive',
    updated_at: new Date().toISOString(),
  });
  try { await logSystemEvent('batch_undo', { batch_id: lastBatchId, product_count: productIds.length, product_ids: productIds }, phone); } catch (_) {}
  await sendText(phone,
    `🔄 *Lote desfeito*\n\n` +
    `${arr.length} produtos marcados como inativos:\n` +
    arr.slice(0, 10).map(p => `• ${p.name}`).join('\n') +
    (arr.length > 10 ? `\n... +${arr.length - 10} outros` : '') +
    `\n\nProdutos preservados (não deletados). Pra restaurar: contata o admin.`,
    body);
  return true;
}

// FIX 10C (07/05/2026 - Andrade) — Completa manualmente o sabor de uma foto que
// Vision identificou marca+modelo mas falhou em ler sabor. Cadastra o produto novo
// com brand/model do Vision + flavor que Andrade digitou via WhatsApp.
async function tryHandleManualFlavor(phone, msg, body, photoIdx, flavorText) {
  // Pega LAST batch do phone (independente de status — pode estar fechado)
  const recentBatches = await sbGet('drope_batch_queue',
    `select=batch_id,photo_index,vision_response,decision,photo_url&phone=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=200`);
  if (!Array.isArray(recentBatches) || recentBatches.length === 0) {
    await sendText(phone, '⚠️ Nao encontrei lote recente.', body);
    return true;
  }
  // Pega o batch_id mais recente
  const lastBatchId = recentBatches[0].batch_id;
  // Filtra fotos do ultimo batch, photo_index match, decision='unidentified_flavor'
  const candidate = recentBatches.find(r =>
    r.batch_id === lastBatchId && r.photo_index === photoIdx && r.decision === 'unidentified_flavor');
  if (!candidate) {
    await sendText(phone,
      `⚠️ Foto ${photoIdx} nao encontrada no ultimo lote (ou ja foi cadastrada).\n\n` +
      `Use *fechar lote* primeiro pra ver as fotos sem sabor.`,
      body);
    return true;
  }

  // Extrai brand/model do vision_response
  let cBrand = '', cModel = '', visProduct = {};
  try {
    const vis = typeof candidate.vision_response === 'string' ? JSON.parse(candidate.vision_response) : candidate.vision_response;
    visProduct = vis?.products?.[0] || {};
    cBrand = _flcCanonBrand(visProduct.brand) || visProduct.brand || '';
    cModel = _flcCanonModel(visProduct.model) || visProduct.model || '';
  } catch (e) { console.warn('[manual-flavor] parse vis:', e.message); }
  if (!cBrand) {
    await sendText(phone, `⚠️ Foto ${photoIdx} sem marca identificavel. Refaz a foto melhor.`, body);
    return true;
  }
  const cFlavor = _flcCanonFlavor(flavorText) || flavorText.trim();
  const name = [cBrand, cModel, cFlavor].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const slug = slugify(cBrand, cModel || '', cFlavor) + '-' + Date.now().toString(36);
  const qty = Math.max(1, parseInt(visProduct.qty) || 1);

  // Reconciliação retroativa (sistema imune)
  const reconcil = await _findPendingSalesMatching(cBrand, cModel, cFlavor);
  const qtyFinal = Math.max(0, qty - reconcil.qty_total);

  try {
    const inserted = await sbInsert('drope_products', {
      slug, name,
      qty_available: qtyFinal,
      total_sold: reconcil.qty_total,
      status: 'pending',
      hidden: true,
      price_cents: 0,
      metadata: {
        brand: cBrand, model: cModel, flavor: cFlavor,
        flavor_en: cFlavor, flavor_pt: cFlavor,
        created_via: 'manual_flavor_completion',
        created_at: new Date().toISOString(),
        box_photo_url: candidate.photo_url,
        manual_flavor_input: flavorText,
      },
      box_photo_url: candidate.photo_url,
    });
    const newId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
    // Marca queue como resolvida
    await sbUpdate('drope_batch_queue', `id=eq.${candidate.id || photoIdx}&batch_id=eq.${lastBatchId}`, {
      decision: 'created_new',
      created_product_id: newId,
      qty_added: qtyFinal,
    }).catch(() => {});
    if (reconcil.sales.length > 0 && newId) {
      await _resolvePendingSales(reconcil.sales.map(s => s.id), newId);
    }
    if (newId) {
      fireBackgroundEnrich(newId).catch((e) => console.warn('[manual-flavor enrich]', e.message));
    }
    const reconLine = reconcil.qty_total > 0
      ? `\n⏪ Baixa retroativa: ${qty} - ${reconcil.qty_total} venda${reconcil.qty_total>1?'s':''} = ${qtyFinal}`
      : '';
    await sendText(phone,
      `✅ Cadastrado: *${name}*\n` +
      `qty=${qtyFinal}${reconLine}\n\n` +
      `🎨 Pipeline arte rodando em background.\n\n` +
      `Pra completar mais: *sabor N: <texto>*`,
      body);
  } catch (e) {
    console.error('[manual-flavor] insert err:', e.message);
    await sendText(phone, `⚠️ Erro ao cadastrar: ${e.message}`, body);
  }
  return true;
}

// Detecta comandos de lote (ativar / fechar)
async function tryHandleBatchCommand(phone, msg, body, text, pending) {
  const lower = String(text || '').toLowerCase().trim();

  // FIX 12 (08/05/2026 - Andrade) — comando 'status' / 'quanto' / '?' mostra
  // quantas fotos foram processadas no batch atual + breakdown de decision.
  // Antes Andrade tinha que adivinhar se sistema parou de processar ou ainda tá rodando.
  if (pending?.mode === 'batch_active' && (lower === 'status' || lower === 'quanto' || lower === 'quantas' || lower === '?' || lower === 'pronto?' || lower === 'progresso')) {
    try {
      const counts = await sbGet('drope_batch_queue',
        `select=decision,status&phone=eq.${encodeURIComponent(phone)}&batch_id=eq.${encodeURIComponent(pending.batch_id)}&limit=1000`);
      const arr = Array.isArray(counts) ? counts : [];
      const matched = arr.filter(r => r.decision === 'matched_existing').length;
      const novos = arr.filter(r => r.decision === 'created_new').length;
      const semSabor = arr.filter(r => r.decision === 'unidentified_flavor').length;
      const erros = arr.filter(r => r.status === 'error').length;
      const processing = arr.filter(r => r.status === 'processing').length;
      const fotoCount = pending.fotoCount || 0;
      let msgStatus = `📊 *Status do lote*\n\n` +
        `📸 ${fotoCount} fotos enviadas\n` +
        `✅ ${matched} atualizados\n` +
        `📦 ${novos} novos\n` +
        (semSabor > 0 ? `⚠️ ${semSabor} sem sabor (revisar depois)\n` : '') +
        (erros > 0 ? `❌ ${erros} erros\n` : '');
      if (processing > 0) {
        msgStatus += `\n⏳ ${processing} ainda processando, aguarda uns segs`;
      } else {
        msgStatus += `\n✅ Tudo processado.\n\n*fechar lote* — finaliza`;
      }
      await sendText(phone, msgStatus, body);
      return true;
    } catch (e) { console.warn('[batch status]', e.message); }
  }

  if (lower === 'lote' || lower === 'iniciar lote' || lower === 'comeca lote' || lower === 'começa lote' || lower === 'modo lote') {
    if (pending?.mode === 'batch_active') {
      await sendText(phone,
        `📸 *Lote ativo*\n` +
        `${pending.fotoCount || 0} fotos processadas\n\n` +
        `Manda mais fotos\n` +
        `*fechar lote* — finaliza`,
        body);
      return true;
    }
    await setPending(phone, {
      mode: 'batch_active',
      batch_id: _flcUuid(),
      startedAt: Date.now(),
      lastPhotoAt: Date.now(),
      fotoCount: 0,
      errorCount: 0,
      matched: [],
      novos: [],
    });
    await sendText(phone,
      '📸 *Modo lote ativado*\n\n' +
      'Manda todas as fotos\n' +
      'Vou processar e te respondo no final\n\n' +
      'Quando terminar:\n' +
      '✅ *fechar lote* — finaliza\n' +
      '❌ *cancela lote* — descarta',
      body);
    return true;
  }
  if (pending?.mode === 'batch_active' && (lower === 'fechar lote' || lower === 'fechar' || lower === 'pronto' || lower === 'acabei' || lower === 'fim')) {
    await closeBatch(phone, pending, body);
    return true;
  }
  if (pending?.mode === 'batch_active' && (lower === 'cancela lote' || lower === 'cancelar lote')) {
    await clearPending(phone);
    await sendText(phone,
      '✅ *Lote cancelado*\n\n' +
      'Os produtos ja processados ficaram cadastrados (status=pending)\n' +
      'Use o Admin Hub pra revisar',
      body);
    return true;
  }
  return false;
}

// ============ MODO BALANÇO (07/05/2026 - Andrade) ============
// Andrade manda fotos do estoque FISICO (uma por uma ou caixas com multiples).
// Vision conta cada produto. Sistema compara com qty_available digital.
// Comando 'fechar balanço' mostra divergencias. 'aplica' atualiza qty.
// 'edita N qty' ajusta um item especifico. 'cancela' descarta tudo.

async function tryHandleInventoryCommand(phone, msg, body, text, pending) {
  const lower = String(text || '').toLowerCase().trim();

  // Trigger: ativar modo balanço
  if (lower === 'balanço' || lower === 'balanco' || lower === 'conferencia' || lower === 'conferência' || lower === 'inventario' || lower === 'inventário') {
    if (pending && (pending.mode === 'inventory_active' || pending.mode === 'inventory_review')) {
      const fc = pending.fotoCount || 0;
      await sendText(phone,
        `📊 *Balanço ativo*\n` +
        `${fc} foto${fc !== 1 ? 's' : ''} processadas\n\n` +
        `Manda mais fotos\n` +
        `✅ *fechar balanço* — vê divergências`,
        body);
      return true;
    }
    await setPending(phone, {
      mode: 'inventory_active',
      batch_id: _flcUuid(),
      startedAt: Date.now(),
      lastPhotoAt: Date.now(),
      fotoCount: 0,
      errorCount: 0,
    });
    await sendText(phone,
      '📊 *Modo balanço ativado*\n\n' +
      'Manda fotos do que tem em estoque físico\n' +
      '(1 ou várias com vários pods em cada)\n\n' +
      'Quando terminar:\n' +
      '✅ *fechar balanço* — vê divergências\n' +
      '❌ *cancela* — descarta',
      body);
    return true;
  }

  // Fechar balanço (modo active)
  if (pending?.mode === 'inventory_active' && (lower === 'fechar balanço' || lower === 'fechar balanco' || lower === 'fechar conferencia' || lower === 'fechar conferência' || lower === 'fechar inventario' || lower === 'fechar inventário')) {
    await closeInventory(phone, pending, body);
    return true;
  }

  // Cancela balanço (modo active ou review)
  if ((pending?.mode === 'inventory_active' || pending?.mode === 'inventory_review') &&
      (lower === 'cancela' || lower === 'cancelar' || lower === 'cancela balanço' || lower === 'cancela balanco')) {
    // Marca todas as contagens desse batch como discarded
    await sbUpdate('drope_inventory_count', `phone=eq.${phone}&batch_id=eq.${pending.batch_id}&status=eq.pending`, { status: 'discarded' }).catch(() => {});
    await clearPending(phone);
    await sendText(phone, '✅ Balanço cancelado. Estoque digital permanece como estava.', body);
    return true;
  }

  // Aplica balanço (modo review)
  if (pending?.mode === 'inventory_review' && (lower === 'aplica' || lower === 'aplicar' || lower === 'aplica balanço' || lower === 'sim' || lower === 'confirma' || lower === 'confirmar')) {
    await applyInventory(phone, pending, body);
    return true;
  }

  // Edita item específico: 'edita N qty' ou 'edita N: qty' ou 'corrige N qty'
  if (pending?.mode === 'inventory_review') {
    const m = lower.match(/^(?:edita|edit|corrige|corrigir|ajusta|ajustar|set)\s+(\d+)\s*[:=]?\s*(\d+)$/);
    if (m) {
      const idx = parseInt(m[1]);
      const newQty = parseInt(m[2]);
      await editInventoryItem(phone, pending, body, idx, newQty);
      return true;
    }
  }

  return false;
}

// Processa foto no modo balanço — Vision identifica + qty, salva em drope_inventory_count
async function tryHandleInventoryPhoto(phone, msg, body, pending) {
  if (!pending || pending.mode !== 'inventory_active') return false;

  const fotoIndex = (pending.fotoCount || 0) + 1;
  const imageUrl = await getMediaUrl(msg, body).catch(() => null);
  if (!imageUrl) {
    pending.fotoCount = fotoIndex;
    pending.errorCount = (pending.errorCount || 0) + 1;
    await setPending(phone, pending);
    await sendText(phone, `⚠️ Foto ${fotoIndex}: não consegui baixar. Tenta de novo.`, body).catch(() => {});
    return true;
  }

  // Vision analyzeMixPhoto identifica multiplos produtos + qty por foto
  let vis = null;
  try { vis = await analyzeMixPhoto(imageUrl); } catch (e) { console.warn('[inventory] vision:', e.message); }
  if (!vis || !Array.isArray(vis.products) || vis.products.length === 0) {
    pending.fotoCount = fotoIndex;
    pending.errorCount = (pending.errorCount || 0) + 1;
    await setPending(phone, pending);
    return true;
  }

  // Match cada produto identificado contra catalogo
  const allProducts = await sbGet('drope_products', 'select=id,name,slug,qty_available,metadata,status,hidden&hidden=eq.false&limit=1000');
  const productsArr = Array.isArray(allProducts) ? allProducts : [];

  let counted = 0, notFound = 0;
  const msgId = msg.id || msg.messageId || msg.key?.id || null;
  for (const p of vis.products) {
    const cBrand = _flcCanonBrand(p.brand);
    const cModel = _flcCanonModel(p.model);
    const cFlavor = _flcCanonFlavor(p.flavor_en || p.flavor_pt);
    const visionTerms = { brand: cBrand, model: cModel, flavor_en: cFlavor || p.flavor_en, flavor_pt: p.flavor_pt };
    const ranking = productsArr.map(prod => ({ prod, score: _matchScore(visionTerms, prod) })).sort((a, b) => b.score - a.score);
    const top1 = ranking[0] || { prod: null, score: 0 };
    const qty = Math.max(1, parseInt(p.qty) || 1);

    if (top1.prod && top1.score >= 70) {
      // Match: insere contagem
      try {
        await sbInsert('drope_inventory_count', {
          phone, batch_id: pending.batch_id,
          product_id: top1.prod.id,
          qty_counted: qty,
          vision_terms: visionTerms,
          match_score: top1.score,
          photo_index: fotoIndex,
          msg_id: msgId,
          status: 'pending',
        });
        counted++;
      } catch (e) { console.warn('[inventory insert]', e.message); }
    } else {
      // Sem match: regista pra debug mas nao conta (poderia entrar em pending_sales mas evita confusao)
      notFound++;
    }
  }

  pending.fotoCount = fotoIndex;
  pending.lastPhotoAt = Date.now();
  pending.totalCounted = (pending.totalCounted || 0) + counted;
  pending.totalNotFound = (pending.totalNotFound || 0) + notFound;
  await setPending(phone, pending);

  // A cada 5 fotos manda update silencioso
  if (fotoIndex % 5 === 0) {
    sendText(phone, `📊 ${fotoIndex} fotos | ${pending.totalCounted} contadas | ${pending.totalNotFound} sem match`, body).catch(() => {});
  }
  return true;
}

// Fecha balanço — agrega contagens, compara com digital, mostra divergencias
async function closeInventory(phone, pending, body) {
  // Le todas as contagens pendentes do batch
  const counts = await sbGet('drope_inventory_count',
    `select=product_id,qty_counted&phone=eq.${phone}&batch_id=eq.${pending.batch_id}&status=eq.pending&limit=2000`);
  const arr = Array.isArray(counts) ? counts : [];

  // Agrega qty por product_id
  const counted = {};
  for (const r of arr) {
    if (!r.product_id) continue;
    counted[r.product_id] = (counted[r.product_id] || 0) + (r.qty_counted || 1);
  }

  if (Object.keys(counted).length === 0) {
    await clearPending(phone);
    await sendText(phone, '⚠️ Balanço sem produtos contados. Manda fotos primeiro ou *cancela*.', body);
    return;
  }

  // Busca produtos pra comparar
  const productIds = Object.keys(counted);
  const products = await sbGet('drope_products', `select=id,name,qty_available&id=in.(${productIds.join(',')})&limit=500`);
  const prodById = {};
  for (const p of (products || [])) prodById[p.id] = p;

  // Calcula divergencias
  const divergences = [];
  for (const pid of productIds) {
    const p = prodById[pid];
    if (!p) continue;
    const digital = p.qty_available || 0;
    const fisico = counted[pid];
    const diff = fisico - digital;
    divergences.push({ id: p.id, name: p.name, digital, fisico, diff });
  }
  // Ordena: maior delta absoluto primeiro
  divergences.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // Detecta produtos NÃO contados (digital > 0 mas zerado no físico)
  const allActive = await sbGet('drope_products', 'select=id,name,qty_available&hidden=eq.false&qty_available=gt.0&limit=500');
  const notCounted = (allActive || []).filter(p => !counted[p.id] && p.qty_available > 0)
    .map(p => ({ id: p.id, name: p.name, digital: p.qty_available, fisico: 0, diff: -p.qty_available }));

  let resumo = `📊 *BALANÇO* — ${pending.fotoCount} fotos\n\n`;
  if (divergences.length === 0 && notCounted.length === 0) {
    resumo += '✅ Tudo bate. Estoque digital == físico.\n';
    await sbUpdate('drope_inventory_count', `phone=eq.${phone}&batch_id=eq.${pending.batch_id}&status=eq.pending`, { status: 'applied' }).catch(() => {});
    await clearPending(phone);
    await sendText(phone, resumo, body);
    return;
  }

  // Lista numerada pra Andrade poder editar item N
  const items = [...divergences, ...notCounted];
  resumo += `Achei ${items.length} ${items.length > 1 ? 'divergências' : 'divergência'}:\n\n`;
  items.slice(0, 30).forEach((it, i) => {
    const sign = it.diff > 0 ? `+${it.diff}` : (it.diff < 0 ? `${it.diff}` : '0');
    const emoji = it.diff > 0 ? '⬆️' : (it.diff < 0 ? '⬇️' : '✅');
    resumo += `${i + 1}. ${emoji} ${it.name}: digital=${it.digital} | físico=${it.fisico} (${sign})\n`;
  });
  if (items.length > 30) resumo += `... +${items.length - 30} outras\n`;
  resumo += '\n*Responde aqui:*\n' +
    '✅ *aplica* — atualiza tudo (digital = físico)\n' +
    '✏️ *edita N qty* — ajusta item N pra qty (ex: edita 3 12)\n' +
    '❌ *cancela* — descarta tudo';

  await setPending(phone, {
    mode: 'inventory_review',
    batch_id: pending.batch_id,
    startedAt: pending.startedAt,
    fotoCount: pending.fotoCount,
    items, // lista pra editar por índice
  });
  await sendText(phone, resumo, body);
}

// Aplica todas as divergencias do balanço
async function applyInventory(phone, pending, body) {
  const items = pending.items || [];
  if (items.length === 0) {
    await clearPending(phone);
    await sendText(phone, '⚠️ Nada pra aplicar.', body);
    return;
  }
  let ok = 0, err = 0;
  for (const it of items) {
    try {
      await sbUpdate('drope_products', `id=eq.${it.id}`, {
        qty_available: it.fisico,
        updated_at: new Date().toISOString(),
      });
      ok++;
    } catch (e) { console.warn('[inventory apply]', e.message); err++; }
  }
  // Marca contagens como aplicadas
  await sbUpdate('drope_inventory_count', `phone=eq.${phone}&batch_id=eq.${pending.batch_id}&status=eq.pending`, {
    status: 'applied',
  }).catch(() => {});
  try { await logSystemEvent('inventory_applied', { phone, items_count: items.length, ok, err }, phone); } catch (_) {}
  await clearPending(phone);
  await sendText(phone, `✅ Balanço aplicado.\n\n${ok} produtos atualizados${err > 0 ? `, ${err} erros` : ''}.\n\n• 'estoque' — ver tudo`, body);
}

// Edita 1 item específico do balanço
async function editInventoryItem(phone, pending, body, idx, newQty) {
  const items = pending.items || [];
  if (idx < 1 || idx > items.length) {
    await sendText(phone, `⚠️ Item ${idx} não existe (1-${items.length}).`, body);
    return;
  }
  if (newQty < 0 || newQty > 9999) {
    await sendText(phone, '⚠️ Qty inválida (0-9999).', body);
    return;
  }
  const it = items[idx - 1];
  it.fisico = newQty;
  it.diff = newQty - it.digital;
  await setPending(phone, pending);
  const sign = it.diff > 0 ? `+${it.diff}` : (it.diff < 0 ? `${it.diff}` : '0');
  await sendText(phone, `✏️ Item ${idx} atualizado: ${it.name} = ${newQty} (${sign}).\n\n• *aplica* pra publicar tudo\n• *edita N qty* pra ajustar mais`, body);
}

// ============ STORAGE HELPERS ============
function slugify(brand, model, flavor) {
  const raw = `${brand}-${model}-${flavor}`.toLowerCase();
  return raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // tira acentos (combining marks, ASCII-safe)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Upload base64 ou Buffer pro Supabase Storage. Retorna URL pública.
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

  // Upload com upsert (sobrescreve se já existir)
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
  // URL pública (bucket precisa ser public)
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

async function downloadImage(url) {
  if (url.startsWith('data:')) {
    return url; // já é base64 inline
  }
  const r = await fetch(url);
  if (!r.ok) {
    console.error('[Download] error:', r.status);
    return null;
  }
  const buf = await r.arrayBuffer();
  return Buffer.from(buf);
}

// ============ SELO CAMALEÃO ============
// Aplica o avatar do camaleão Drope no canto inferior direito de toda arte gerada.
// Selo NÃO é gerado pela IA (logos sempre saem distorcidos) — overlay programático com sharp.
// Cache do PNG sobrevive entre requests da mesma instance (cold start re-fetch).
let _sealBufferCache = null;
async function loadSealBuffer() {
  if (_sealBufferCache) return _sealBufferCache;
  const host = process.env.VERCEL_URL || 'drope-app.vercel.app';
  const url = `https://${host}/icons/drope-avatar.png`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.error('[loadSealBuffer] fetch failed:', r.status, url);
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    _sealBufferCache = buf;
    console.log('[loadSealBuffer] cached, bytes:', buf.length);
    return buf;
  } catch (e) {
    console.error('[loadSealBuffer] error:', e.message);
    return null;
  }
}

// imageData: Buffer (Node) ou string base64 ("data:image/...;base64,...")
// retorna Buffer com o selo composto (PNG). Se sharp/asset indisponível, retorna o original
// como Buffer (nunca quebra o fluxo de geração de arte por causa do selo).
async function applyDropeSeal(imageData) {
  let imgBuffer;
  if (typeof imageData === 'string') {
    const cleanB64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    imgBuffer = Buffer.from(cleanB64, 'base64');
  } else {
    imgBuffer = imageData;
  }

  let sharp;
  try { sharp = require('sharp'); }
  catch (e) {
    console.warn('[applyDropeSeal] sharp não disponível, retornando original:', e.message);
    return imgBuffer;
  }

  try {
    const sealBuf = await loadSealBuffer();
    if (!sealBuf) return imgBuffer;

    const meta = await sharp(imgBuffer).metadata();
    const W = meta.width || 1024;
    const H = meta.height || 1024;
    const sealSize = Math.round(W * 0.12);
    const margin = Math.round(W * 0.03);

    const sealResized = await sharp(sealBuf)
      .resize(sealSize, sealSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .png()
      .toBuffer();

    // Aplica opacidade 85% via composite com pixel alpha 217/255
    const sealWithOpacity = await sharp(sealResized)
      .composite([{
        input: Buffer.from([255, 255, 255, Math.round(255 * 0.85)]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: 'dest-in'
      }])
      .toBuffer();

    const left = Math.max(0, W - sealSize - margin);
    const top = Math.max(0, H - sealSize - margin);

    const sealed = await sharp(imgBuffer)
      .composite([{ input: sealWithOpacity, left, top }])
      .png()
      .toBuffer();

    return sealed;
  } catch (e) {
    console.error('[applyDropeSeal] error:', e.message);
    return imgBuffer;
  }
}

// ============ AUTO-BUSCA REFERÊNCIA (OSSO 34.7) ============
// Função reutilizável: busca foto de referência via Serper + Vision ranking.
// Retorna URL pública da referência no Supabase Storage, ou null se não encontrou.
function _detectMediaType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
  return 'image/jpeg';
}

// FLC FASE 4 (07/05/2026 — refatorado):
// 1. Query Serper inclui SABOR entre aspas (era so brand+model+puffs antes — pegava sabor errado)
// 2. Vision compara candidatos com a foto da CAIXA (box_photo_url) como GROUND TRUTH
// 3. Threshold 0.7 (era 0.35 — passava lixo)
// 4. Se nenhum >= 0.7 → ref_status='needs_manual' (era 'auto_failed' generico)
async function autoFindReference(product) {
  const meta = product.metadata || {};
  const brand = meta.brand || '';
  const model = meta.model || '';
  const flavor = meta.flavor || meta.flavor_en || meta.flavor_pt || '';
  const boxPhotoUrl = product.box_photo_url || meta.box_photo_url || null;

  // FIX 1: Query inclui SABOR entre aspas (tira ambiguidade Serper)
  const qParts = [];
  if (brand && model) qParts.push(`"${brand} ${model}"`);
  else if (brand) qParts.push(`"${brand}"`);
  if (flavor) qParts.push(`"${flavor}"`);
  qParts.push('pod vape device');
  const searchQ = qParts.join(' ').replace(/\s+/g, ' ').trim();
  console.log(`[autoFindRef] #${product.id} query: "${searchQ}" boxPhoto=${!!boxPhotoUrl}`);

  // 1. Serper image search
  const serperRes = await fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: searchQ, num: 10 })
  });
  const serperData = await serperRes.json();
  const imgs = (serperData.images || []).slice(0, 10);
  if (imgs.length === 0) {
    await sbUpdate('drope_products', `id=eq.${product.id}`, { ref_status: 'auto_failed' });
    return null;
  }

  // 2. Download candidates (até 6, pra dar mais opção)
  const cands = [];
  for (const img of imgs) {
    if (cands.length >= 6) break;
    try {
      const imgR = await fetch(img.imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'image/*' },
        signal: AbortSignal.timeout(8000),
      });
      if (!imgR.ok) continue;
      const buf = Buffer.from(await imgR.arrayBuffer());
      if (buf.length < 5000) continue;
      cands.push({ buffer: buf, url: img.imageUrl, title: img.title || '' });
    } catch (_) { continue; }
  }
  if (cands.length === 0) {
    await sbUpdate('drope_products', `id=eq.${product.id}`, { ref_status: 'auto_failed' });
    return null;
  }

  // FIX 2: Baixa a foto da CAIXA pra usar como ground truth no Vision
  let boxBuffer = null;
  let boxMime = null;
  if (boxPhotoUrl) {
    try {
      const r = await fetch(boxPhotoUrl, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        boxBuffer = Buffer.from(await r.arrayBuffer());
        if (boxBuffer.length < 1000) boxBuffer = null;
        else boxMime = _detectMediaType(boxBuffer);
      }
    } catch (e) { console.warn('[autoFindRef] download box:', e.message); }
  }

  // 3. Vision ranking COM GROUND TRUTH
  const vContent = [];
  if (boxBuffer) {
    vContent.push({ type: 'image', source: { type: 'base64', media_type: boxMime, data: boxBuffer.toString('base64') } });
    vContent.push({ type: 'text', text: `📦 GROUND TRUTH: foto OFICIAL da caixa do produto (${brand} ${model} ${flavor}). Use pra comparar cor, formato, bocal e identificar o sabor real.` });
  }
  for (let i = 0; i < cands.length; i++) {
    const mType = _detectMediaType(cands[i].buffer);
    vContent.push({ type: 'image', source: { type: 'base64', media_type: mType, data: cands[i].buffer.toString('base64') } });
    vContent.push({ type: 'text', text: `Candidato ${i + 1}` });
  }

  const evalP = `Voce escolhe a MELHOR foto de REFERENCIA do dispositivo (pod descartavel) entre ${cands.length} candidatos.

Produto: ${brand} ${model} ${flavor || '(sem sabor)'}.

${boxBuffer ? `A PRIMEIRA imagem é a foto OFICIAL da CAIXA (ground truth). Use ela pra confirmar:
- O dispositivo na candidata é o MESMO MODELO da caixa? (forma, proporcao, bocal)
- A COR predominante BATE com a caixa? (caixa amarela = pod amarelo, caixa azul = pod azul, caixa rosa = pod rosa)
- Eh o MESMO SABOR? (cor + design batem com o sabor "${flavor}")` :
`Sem foto da caixa de referência. Avalie pelo nome do sabor "${flavor}":
- Cor predominante condiz com o sabor?
- Banana/manga = amarelo. Uva = roxo. Morango/cherry = vermelho. Mint = verde/branco. Blue Razz = azul. Etc.`}

REGRAS DE QUALIDADE (TODAS obrigatorias):
1. ${boxBuffer ? 'Bate com o produto da caixa (modelo + sabor)' : 'Cor condiz com o sabor'}
2. Mostra DISPOSITIVO real (nao caixa, nao render 3D, nao banner, nao lifestyle, nao mockup)
3. Fundo limpo (branco/transparente/neutro), sem watermark, sem logo de loja
4. Foco no produto, alta resolucao, dispositivo de frente ou levemente angulado

Score 0.0-1.0 pra cada. APROVA SO se score >= 0.7. Se NENHUM passar, retorna melhor=null.

Output APENAS JSON:
{
  "ranking": [{"candidato": 1, "score": 0.85, "motivo": "breve - bate com sabor X, fundo limpo"}, ...],
  "melhor": numero (1-${cands.length}) ou null,
  "confianca": 0.0-1.0,
  "motivo_rejeicao": "se melhor=null, explica por que (max 50 chars)"
}`;
  vContent.push({ type: 'text', text: evalP });

  const vRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: vContent }] })
  });
  const vData = await vRes.json();
  if (vData.error) {
    console.error('[autoFindRef] Vision API error:', JSON.stringify(vData.error));
    await sbUpdate('drope_products', `id=eq.${product.id}`, { ref_status: 'auto_failed' });
    return null;
  }

  const vText = (vData.content && vData.content[0] && vData.content[0].text) || '';
  let cleanJ = vText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const jsonMatch = cleanJ.match(/\{[\s\S]*\}/);
  cleanJ = jsonMatch ? jsonMatch[0] : cleanJ;

  let ranking;
  try { ranking = JSON.parse(cleanJ); } catch (parseErr) {
    console.error('[autoFindRef] JSON parse failed:', parseErr.message, 'raw:', vText.slice(0, 200));
    await sbUpdate('drope_products', `id=eq.${product.id}`, { ref_status: 'auto_failed' });
    return null;
  }

  // FIX 3: Threshold 0.7 (era 0.35). Se nao bater, vira needs_manual_photo.
  const conf = ranking.confianca || 0;
  const melhor = ranking.melhor;
  console.log(`[autoFindRef] #${product.id} ranking:`, JSON.stringify(ranking).slice(0, 300));

  if (!melhor || conf < 0.7) {
    await sbUpdate('drope_products', `id=eq.${product.id}`, {
      ref_status: 'auto_failed',
      art_status: 'needs_manual_photo',
      metadata: { ...meta, ref_rejection_reason: ranking.motivo_rejeicao || `conf=${conf}, melhor=${melhor}` },
    });
    console.log(`[autoFindRef] ❌ #${product.id} REJEITADO (conf=${conf}). Marcado needs_manual_photo.`);
    return null;
  }

  // 4. Upload winner
  const winner = cands[melhor - 1];
  if (!winner) {
    await sbUpdate('drope_products', `id=eq.${product.id}`, { ref_status: 'auto_failed' });
    return null;
  }
  const winnerType = _detectMediaType(winner.buffer);
  const ext = winnerType === 'image/png' ? 'png' : 'jpg';
  const fName = `references/ref-${product.id}.${ext}`;
  const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/drope-product-images/${fName}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Content-Type': winnerType,
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: winner.buffer,
  });
  if (!upRes.ok) {
    await sbUpdate('drope_products', `id=eq.${product.id}`, { ref_status: 'auto_failed' });
    return null;
  }

  const pubUrl = `${SUPABASE_URL}/storage/v1/object/public/drope-product-images/${fName}`;
  await sbUpdate('drope_products', `id=eq.${product.id}`, { ref_status: 'auto_found', reference_image_url: pubUrl });
  console.log(`[autoFindRef] ✅ #${product.id} → ${pubUrl} (conf=${conf})`);
  return pubUrl;
}

// ============ PIPELINE DE IMAGEM (busca + qualidade + arte) ============
// Avalia qualidade de imagem candidata pra referência (0-100, maior = melhor)
function calculateQualityScore(meta, bufferLength) {
  let score = 0;
  const w = meta.width || 0, h = meta.height || 0;
  const minDim = Math.min(w, h);
  if (minDim >= 800) score += 40;
  else if (minDim >= 600) score += 30;
  else if (minDim >= 400) score += 20;
  else score += 10;
  const ratio = w && h ? (w / h) : 1;
  if (ratio >= 0.7 && ratio <= 1.3) score += 20;
  else if (ratio >= 0.4 && ratio <= 0.7) score += 15;
  else score += 5;
  if (meta.format === 'png') score += 10;
  else if (meta.format === 'webp') score += 8;
  else score += 5;
  const sizeKB = (bufferLength || 0) / 1024;
  if (sizeKB >= 50 && sizeKB <= 2000) score += 15;
  else if (sizeKB >= 20 && sizeKB <= 5000) score += 10;
  else score += 3;
  if (meta.format === 'png' && meta.channels === 4) score += 15;
  return Math.min(score, 100);
}

// Busca imagens de referência via Serper Google Images, filtra por qualidade,
// faz upload das boas pro Storage e salva no produto. Async — não bloqueia caller.
// FIX REF QA (07/05/2026 - Andrade) — Compara candidato com a foto real da caixa
// FOCANDO NO PRODUTO CENTRAL (ignora caixas/produtos secundarios do fundo).
// Caso real: foto da caixa de ELFBAR BC15K Strawberry Kiwi tinha varias caixas
// ELFBAR ao redor; Serper retornava refs corretas (Strawberry Kiwi) mas tambem
// errados (modelos diferentes que pareciam com produtos secundarios). Sem essa
// comparacao, ranking era so por resolucao = ref errada ganhava facil.
// Retorna 0-100 ou null em erro. 0=totalmente diferente, 100=mesmo produto.
async function _visionScoreCandidate(boxPhotoUrl, candidateUrl, brand, model, flavor) {
  if (!CLAUDE_KEY || !boxPhotoUrl || !candidateUrl) return null;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': CLAUDE_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: boxPhotoUrl.startsWith('data:')
              ? { type: 'base64', media_type: boxPhotoUrl.match(/^data:([^;]+);/)?.[1] || 'image/jpeg', data: boxPhotoUrl.split(',', 2)[1] }
              : { type: 'url', url: boxPhotoUrl } },
            { type: 'image', source: candidateUrl.startsWith('data:')
              ? { type: 'base64', media_type: candidateUrl.match(/^data:([^;]+);/)?.[1] || 'image/jpeg', data: candidateUrl.split(',', 2)[1] }
              : { type: 'url', url: candidateUrl } },
            { type: 'text', text: `Imagem 1: foto de caixas de pod (pode ter VARIAS caixas/produtos visiveis). O produto PRINCIPAL/CENTRAL e: ${brand} ${model} ${flavor}.\n\nImagem 2: candidato a referencia visual.\n\nQuao semelhante visualmente a Imagem 2 e ao produto CENTRAL da Imagem 1?\nIGNORE COMPLETAMENTE outros produtos do fundo/laterais da Imagem 1 — foque APENAS no produto que tem o sabor "${flavor}" no rotulo.\n\nCriterios:\n- Mesmo modelo de dispositivo (formato, tamanho, padrao do bocal)?\n- Mesma cor predominante e gradiente do sabor?\n- Mesmas estampas/grafismos do rotulo?\n- 100 = mesmo produto exato\n- 70-99 = mesmo modelo+sabor mas angulo/qualidade diferente\n- 40-69 = mesma marca+modelo mas sabor diferente\n- 10-39 = mesma marca apenas\n- 0-9 = totalmente diferente\n\nResponda APENAS um numero inteiro 0-100. SEM explicacao.` }
          ]
        }]
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const text = (data?.content?.[0]?.text || '').trim();
    const match = text.match(/\d+/);
    if (!match) return null;
    const score = parseInt(match[0]);
    return Math.max(0, Math.min(100, score));
  } catch (e) {
    console.warn('[visionScoreCandidate]', e.name === 'AbortError' ? 'timeout' : e.message);
    return null;
  } finally { clearTimeout(tid); }
}

async function searchProductReferences(productId, brand, model, flavor) {
  // OSSO 28 — logging detalhado pra diagnosticar Serper
  console.log(`[searchRefs] START productId=${productId} brand=${brand} model=${model} flavor=${flavor}`);
  if (!SERPER_API_KEY) {
    console.warn('[searchRefs] SERPER_API_KEY VAZIA — configurar no Vercel env vars');
    await sbUpdate('drope_products', `id=eq.${productId}`, { art_status: 'needs_manual_photo' });
    return [];
  }

  // FIX REF QA v2 (07/05/2026 - Andrade) — 3 queries em paralelo pra pescar
  // pack-shot puro (fundo branco, foto oficial). Antes 1 query só pegava muita
  // foto de loja/mosaico que confundia Grok img2img depois.
  const baseTerms = [brand, model, flavor].filter(Boolean).join(' ');
  const queries = [
    `"${baseTerms}" official product photo white background`,
    `"${baseTerms}" pod disposable vape`,
    `${brand || ''} ${flavor || ''} pack shot`.trim(),
  ].filter(q => q.replace(/[^a-z0-9]/gi, '').length > 5);
  console.log(`[searchRefs] queries=${JSON.stringify(queries)}`);

  // Roda paralelo, junta resultados, dedupa por URL
  const responses = await Promise.allSettled(queries.map(q => fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, num: 6 }),
  }).then(r => r.ok ? r.json() : null)));

  const allImagesMap = new Map(); // url -> img (dedupa por URL)
  for (const resp of responses) {
    if (resp.status !== 'fulfilled' || !resp.value) continue;
    for (const img of (resp.value.images || [])) {
      if (img.imageUrl && !allImagesMap.has(img.imageUrl)) allImagesMap.set(img.imageUrl, img);
    }
  }
  const serperData = { images: Array.from(allImagesMap.values()).slice(0, 12) };
  console.log(`[searchRefs] Serper merged ${serperData.images.length} unique images from ${queries.length} queries`);
  if (serperData.images.length === 0) {
    await sbUpdate('drope_products', `id=eq.${productId}`, { art_status: 'needs_manual_photo' });
    return [];
  }

  let sharp;
  try { sharp = require('sharp'); } catch (e) { sharp = null; }

  const candidates = [];
  const images = (serperData.images || []).slice(0, 8);
  // OSSO 28 — thresholds mais generosos: produtos de nicho têm fotos pequenas no Google
  const MIN_DIM = 200;   // era 400
  const MAX_DIM = 4000;
  const MIN_SCORE = 15;  // era 30
  const skipReasons = []; // pra debug
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img.imageUrl) { skipReasons.push(`#${i}: no imageUrl`); continue; }
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000);
      const imgRes = await fetch(img.imageUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!imgRes.ok) { skipReasons.push(`#${i}: download http=${imgRes.status}`); continue; }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length < 5 * 1024) { skipReasons.push(`#${i}: too small ${buffer.length}b`); continue; }
      if (buffer.length > 6 * 1024 * 1024) { skipReasons.push(`#${i}: too big ${buffer.length}b`); continue; }
      let meta = { width: 0, height: 0, format: 'jpeg', channels: 3 };
      if (sharp) {
        try { meta = await sharp(buffer).metadata(); }
        catch (e) { skipReasons.push(`#${i}: sharp failed ${e.message}`); continue; }
      }
      if ((meta.width || 0) < MIN_DIM || (meta.height || 0) < MIN_DIM) {
        skipReasons.push(`#${i}: too small ${meta.width}x${meta.height}`); continue;
      }
      if ((meta.width || 0) > MAX_DIM || (meta.height || 0) > MAX_DIM) {
        skipReasons.push(`#${i}: too big ${meta.width}x${meta.height}`); continue;
      }
      const score = calculateQualityScore(meta, buffer.length);
      if (score < MIN_SCORE) { skipReasons.push(`#${i}: score=${score} (min ${MIN_SCORE})`); continue; }
      const ext = (meta.format === 'png' ? 'png' : (meta.format === 'webp' ? 'webp' : 'jpg'));
      const path = `reference-candidates/ref_${productId}_${i}.${ext}`;
      const upUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
      const upR = await fetch(upUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY,
          'Content-Type': `image/${ext}`, 'x-upsert': 'true',
        },
        body: buffer,
      });
      if (!upR.ok) { skipReasons.push(`#${i}: upload http=${upR.status}`); continue; }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
      candidates.push({
        url: publicUrl,
        source_url: img.imageUrl,
        source_title: (img.title || '').slice(0, 120),
        width: meta.width, height: meta.height,
        quality_score: score,
        format: meta.format || ext,
      });
    } catch (e) { skipReasons.push(`#${i}: exception ${e.message}`); }
  }
  console.log(`[searchRefs] RESULT productId=${productId}: ${candidates.length}/${images.length} accepted. Skipped: ${skipReasons.join(' | ')}`);

  // FIX REF QA (07/05/2026): Vision compara cada candidato com a foto real da caixa
  // FOCANDO no produto CENTRAL. Score combinado: vision_score (peso 70) + quality (30).
  if (candidates.length > 0) {
    try {
      const prods = await sbGet('drope_products', `id=eq.${productId}&select=box_photo_url&limit=1`);
      const boxUrl = prods?.[0]?.box_photo_url;
      if (boxUrl) {
        // Limita a 6 pra economizar tempo/Anthropic. Top quality_score primeiro.
        candidates.sort((a, b) => b.quality_score - a.quality_score);
        const top = candidates.slice(0, 6);
        console.log(`[searchRefs] visionScore productId=${productId}: comparando ${top.length} candidatos com box_photo`);
        const results = await Promise.allSettled(
          top.map(c => _visionScoreCandidate(boxUrl, c.url, brand, model, flavor))
        );
        results.forEach((r, i) => {
          const score = r.status === 'fulfilled' ? r.value : null;
          if (score != null) top[i].vision_score = score;
        });
        // Score combinado (peso vision 70, quality 30)
        candidates.forEach(c => {
          const v = (typeof c.vision_score === 'number') ? c.vision_score : null;
          c.combined_score = v != null
            ? Math.round(v * 0.7 + c.quality_score * 0.3)
            : c.quality_score;
        });
        candidates.sort((a, b) => b.combined_score - a.combined_score);
        const summary = candidates.slice(0, 4).map(c => `vision=${c.vision_score ?? '?'} qty=${c.quality_score} comb=${c.combined_score}`).join(' | ');
        console.log(`[searchRefs] visionScore productId=${productId} top4: ${summary}`);
      } else {
        console.log(`[searchRefs] sem box_photo_url productId=${productId} — pula visionScore`);
        candidates.sort((a, b) => b.quality_score - a.quality_score);
      }
    } catch (e) {
      console.warn('[searchRefs] visionScore err:', e.message);
      candidates.sort((a, b) => b.quality_score - a.quality_score);
    }
  }

  // FIX REF QA v2 (07/05/2026 - Andrade) — Auto-select com 3 niveis de decisao:
  // FIX 15 (08/05/2026 - Andrade) — sem painel de revisao manual.
  // Andrade questionou: "se a propria IA vai decidir se a foto do Grok fica ou nao,
  // e ja lança, nao é? nao vejo sentido nesse painel".
  // Antes: pending_review aparecia no admin web pra Andrade escolher manualmente.
  // Agora: TUDO dispara Grok auto. Vision QA da arte gerada eh o gatekeeper final
  // (compara arte vs reference vs box_photo, score 0-10). Se QC reject 2x → notifica.
  // Threshold rebaixado: combined >= 40 = aceita ref. Abaixo disso, dispara TEXT-ONLY.
  const AUTO_SELECT_THRESHOLD = 40;
  let referenceImageUrl = null;
  if (candidates.length > 0) {
    const top = candidates[0];
    const topScore = (typeof top.combined_score === 'number') ? top.combined_score : top.quality_score;
    if (topScore >= AUTO_SELECT_THRESHOLD) {
      referenceImageUrl = top.url;
      console.log(`[searchRefs] AUTO-SELECT productId=${productId} top.combined=${topScore} url=${top.url}`);
    } else {
      console.log(`[searchRefs] sem ref boa productId=${productId} top.combined=${topScore} — vai TEXT-ONLY`);
    }
  } else {
    console.log(`[searchRefs] zero candidates productId=${productId} — vai TEXT-ONLY`);
  }

  // SEMPRE dispara art generation: com ref (img2img) ou sem ref (text-only)
  // Vision QA da arte filtra qualidade depois. Se ruim, retry interno; se reincide, manda WhatsApp.
  const updateData = {
    reference_candidates: candidates,
    art_status: 'reference_approved', // sempre aprova pra disparar Grok
  };
  if (referenceImageUrl) updateData.reference_image_url = referenceImageUrl;
  await sbUpdate('drope_products', `id=eq.${productId}`, updateData);
  console.log(`[searchRefs] productId=${productId} → ${candidates.length} candidatas, ref=${referenceImageUrl ? 'sim' : 'TEXT-ONLY'}, disparando Grok`);

  try {
    await fireBackgroundArtGeneration(productId, ADMIN_LUCAS, 1);
  } catch (e) { console.warn('[searchRefs] fireArt err:', e.message); }
  return candidates;
}

// Vision do Claude descreve dispositivo da imagem em detalhe pro Grok recriar fielmente
async function analyzeReferenceImage(imageUrl) {
  if (!CLAUDE_KEY) return '';
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': CLAUDE_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text', text: 'Descreva este dispositivo de pod/vape em detalhe visual pra um artista recriar fielmente:\n- Formato (retangular, cilíndrico, ergonômico)\n- Cores e padrões (metalizado, fosco, gradiente, estampa)\n- Posição e conteúdo de rótulos/logos\n- Textura (liso, grip, transparente)\n- Bocal (cor, formato)\n- LEDs/indicadores\n- Proporções (altura x largura)\nResponde só a descrição em inglês, 60-100 palavras, sem cabeçalhos.' }
          ]
        }]
      }),
    });
    if (!r.ok) { console.warn('[analyzeRef] status:', r.status); return ''; }
    const data = await r.json();
    return data?.content?.[0]?.text || '';
  } catch (e) {
    console.warn('[analyzeRef] error:', e.name === 'AbortError' ? 'timeout 15s' : e.message);
    return '';
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============ CLAUDE VISION ============
async function callClaude(messages, systemPrompt, maxTokens = 600) {
  const t0 = Date.now();
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
  // OSSO 23 — log custo. Vision (>1 imagem) custa mais que texto.
  const isVision = Array.isArray(messages) && messages.some(m =>
    Array.isArray(m.content) && m.content.some(c => c?.type === 'image')
  );
  // OSSO 30-debug: persiste tipo/mensagem do erro pra diagnóstico via endpoint debug_claude
  const errKind = r.status >= 400 ? (data?.error?.type || 'unknown') : null;
  const errMsg = r.status >= 400 ? (data?.error?.message || '').slice(0, 240) : null;
  logApiCost(isVision ? 'claude_vision' : 'claude_haiku', {
    status: r.status,
    max_tokens: maxTokens,
    ms: Date.now() - t0,
    input_tokens: data?.usage?.input_tokens || null,
    output_tokens: data?.usage?.output_tokens || null,
    error_type: errKind,
    error_msg: errMsg,
  }).catch(() => {});
  return data.content?.[0]?.text || null;
}

// Extrai dados do pod a partir da foto da CAIXA (obrigatoria) e opcionalmente da foto do POD.
async function analyzeProductImage(caixaUrl, podUrl = null) {
  const systemPrompt = `${IA_SERVO_PREAMBULO}Voce e o catalogador da Drope, loja Gen Z de pods em Vila Prudente-SP.
Analise a foto e extraia em JSON valido (sem markdown). Se nao identificar campo, deixa null:

{
  "barcode": "OCR dos NUMEROS IMPRESSOS embaixo (ou ao lado) do codigo de barras. NAO decodifica as listras pretas/brancas — LE o numero em TEXTO que esta escrito ali, igual OCR comum. Le digito por digito EXATO, da esquerda pra direita. Se 1 unico digito estiver duvidoso/embacado/cortado, retorna null (nunca chuta). Atencao a 2/5/7, 0/8, 3/8, 1/7, 6/9 quando o texto for pequeno. EAN-13=13 digitos, UPC-A=12, EAN-8=8. Se nao ver os numeros claramente impressos, retorna null.",
  "brand": "marca em maiusculo (IGNITE, ELFBAR, BLACKSHEEP, DOJO, LOSTMARY, GEEKBAR, ADALYA, VANTHER, LOST MARY=LOSTMARY)",
  "model": "linha/modelo. SE NAO LER, USA null. NUNCA escreve 'unknown', 'desconhecido', '?'. Catalogo de modelos por marca:\n  - IGNITE: 'V155', 'V250', 'V300', 'V55', 'Boost'\n  - ELFBAR: 'BC15K', 'BC Pro', 'Trio', 'Iceking', 'TE 30K', 'GH 23K'\n  - BLACKSHEEP: 'Cyber Tank Pro', 'Cybertank', 'Spherex', 'Spherex Plus'\n  - LOSTMARY: 'MO5000', 'MO10000', 'MO20000', 'MT15000', 'OS5000', 'BM6000', 'PSYBER', 'Cosmic Edition', 'Tappo'\n  - DOJO: 'Fresh', 'Frosty', 'Splash'\n  - GEEKBAR: 'Frozen', 'White Peach', 'Stone Freeze', 'Pulse'\n  - ADALYA: 'AD5000', 'AD40K'\n  - VANTHER: '30K', 'Cool Mint Edition'\nSe a foto mostrar marca mas modelo ilegivel/cortado, preenche brand e deixa model=null. Procura na CAIXA texto pequeno tipo 'MO20000', 'V300', 'BC15K' (frequentemente perto do logo ou no canto).",
  "flavor_en": "sabor em ingles (ex 'Menthol', 'Mango Magic', 'Strawberry Ice')",
  "flavor_pt": "sabor em portugues (ex 'Menta', 'Manga', 'Morango Gelado')",
  "puffs": numero inteiro (ex 30000) ou null. INFERE do nome se nao tiver explicito: BC15K=15000, V155=15500, 30K=30000, 40K=40000, 45K=45000, 55K=55000. Se ver 'Ultra Slim' sozinho sem numero, usa null.
  "ml": float (ex 18, 20, 25). INFERE do contexto: pods 30k+ tipicamente 18-22ml; pods <20k tipicamente 12-15ml. Se incerto, usa null.
  "mg_nicotina": float. Padrao Brasil = 5 (5%). Se a caixa nao mostrar, usa 5. Se mostrar 50mg ou 5%, usa 5. Se 20mg, usa 2. Se 30mg, usa 3.
  "device_color": "cor do device em ingles curto (ex 'matte black', 'green and silver', 'pink purple gradient')",
  "device_visual": "descricao visual COMPLETA do pod em ingles, 30-60 palavras, pra usar como prompt de geracao de arte. Inclui: SHAPE (tall slim rectangular / boxy square / rounded cylinder / curved organic), PROPORCOES (height/width ratio approx, ex '3:1 tall slim'), DISPLAY (has small LED screen at front / no screen), CONTROLS (boost/eco button on side / power button on bottom / no buttons), MOUTHPIECE (tapered black / wide rounded / square flat), LOGO (centered front / on side / on top), TEXTURE (matte / glossy / soft-touch / metallic / translucent), FEATURES ESPECIAIS (light strip on side / transparent tank visible / dual mesh visible). Ex: 'Tall slim rectangular vape pod, 3:1 ratio, small LED screen on lower front showing puff count, side boost/eco toggle button, tapered black mouthpiece, matte orange body with bull-skull logo centered front, white IV BR badge on lower right corner'",
  "device_visual_detailed": "descricao ULTRA especifica do device em ingles, 60-80 palavras, pra prompt de arte que NAO tem foto de referencia. Cobre OBRIGATORIAMENTE: (1) SHAPE+PROPORTIONS (ex 'tall rectangular box shape with rounded corners, ~3:1 ratio'), (2) BODY COLOR exato (ex 'translucent lime green body' ou 'matte orange-red gradient'), (3) MOUTHPIECE (cor + formato + posicao, ex 'black tapered mouthpiece on top'), (4) LED/DISPLAY (ex 'small white LED indicator strip at bottom front' ou 'no display visible'), (5) CONTROLS (ex 'side boost/eco toggle button on right side' ou 'no buttons'), (6) BRANDING (texto exato + posicao + orientacao, ex 'ELFBAR text printed vertically on front center, GH33000 PRO model name below in smaller font, white text on body'), (7) TEXTURE (ex 'matte finish' / 'glossy with metallic highlights' / 'translucent showing internal tank'), (8) FEATURES especiais visiveis. Diferente do device_visual (mais curto), aqui detalha CADA elemento que distingue ESSE device especifico. Ex: 'A tall rectangular box-shaped vape pod, ~3:1 height-to-width ratio, with rounded corners and a translucent lime green body that reveals an internal liquid tank. A short black tapered mouthpiece sits on top. A thin white LED indicator strip runs along the bottom front edge. A side boost/eco toggle button is on the right edge. The brand ELFBAR is printed in white block letters running vertically on the front center, with GH33000 PRO in smaller white text below. Matte finish on the body, glossy black mouthpiece.'",
  "cores_predominantes": "cores da caixa em portugues (ex 'verde escuro com prata e detalhes lima', 'preto matte e neon azul')",
  "flavor_elements": "elementos visuais do sabor pra prompt de arte em ingles (ex 'mint leaves and ice crystals', 'mango slices and frost', 'watermelon dragonfruit')",
  "descricao_quebrada": "max 80 caracteres, vibe lo-fi authentic Gen Z favela Vila Prudente, minusculas, max 1 emoji, sensacao real do sabor. NUNCA usar 'delicioso, incrivel, experimente, o melhor'. Exemplos certos: 'menta gelada que escorre na garganta 🧊', 'manga doce escorrendo no calor', 'frutas vermelhas com soco de gelo'",
  "flavor_category": "OBRIGATORIO. Classifique em UMA dessas categorias EXATAS: 'fruity' (sabores de fruta: mango, grape, strawberry, watermelon, peach, apple, berry, etc.), 'sweet' (doces/sobremesa: candy, caramel, vanilla, chocolate, bubblegum), 'icy' (gelado: ice, freeze, cold, frost, cooling — qualquer sabor com 'ice' no nome), 'menthol' (mint, menthol, spearmint, peppermint, eucalyptus), 'tobacco' (tobacco, cigar, classic, wood), 'other' (se nada encaixar). REGRA CRITICA: se o sabor TEM fruta E gelo (ex 'Mango Ice', 'Grape Freeze', 'Strawberry Cool'), classifique como 'icy' — o gelado/cooling e a experiencia dominante. Sour Apple Ice = icy. Aloe Grape Sour Apple (sem ice) = fruity.",
  "alertas": ["lista de strings com qualquer ambiguidade. ex: 'sabor pode ser Menthol ou Icy Mint', 'nao consegui ler mg de nicotina'"]
}

NAO invente dado. Se a foto nao for de pod, retorna {"alertas":["nao parece pod"]} e o resto null.`;

  // Helper pra montar source aceitando HTTP URL ou data: URL (base64 inline)
  const makeSource = (url) => {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) return { type: "base64", media_type: m[1], data: m[2] };
      return null;
    }
    return { type: "url", url };
  };

  const caixaSource = makeSource(caixaUrl);
  if (!caixaSource) { console.error("[Vision] caixa URL invalida"); return null; }

  const content = [{ type: "image", source: caixaSource }];
  let userText;
  if (podUrl) {
    const podSource = makeSource(podUrl);
    if (podSource) {
      content.push({ type: "image", source: podSource });
      userText = "2 fotos: a 1ª eh a CAIXA do pod (info textual de marca/modelo/sabor/specs). A 2ª eh o POD ao vivo. Use texto da CAIXA pra brand/model/flavor/puffs/ml/mg. Use o POD ao vivo pra `device_color` (cor real) E `device_visual` (formato/proporcoes/display/botoes/mouthpiece/textura/features especiais — observa TUDO no pod fisico, nao na caixa). Responde SO o JSON.";
    } else {
      userText = "Extrai os dados desse pod. Responde SO o JSON, sem texto antes ou depois.";
    }
  } else {
    userText = "Extrai os dados desse pod. Responde SO o JSON, sem texto antes ou depois.";
  }
  content.push({ type: "text", text: userText });

  const messages = [{ role: "user", content }];

  const result = await callClaude(messages, systemPrompt, 1500);
  if (!result) return null;

  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error("[Vision] JSON parse error:", e.message, "raw:", result.slice(0, 300));
    return null;
  }
}

// VISION READ EAN (08/05/2026) — Le APENAS o codigo de barras de uma foto.
// Mais focado/barato que analyzeProductImage. Retorna { ean, confidence, raw_text }.
// Usa Haiku — OCR de numeros impressos sob barras eh tarefa simples.
async function _visionReadEan(imageBase64OrUrl) {
  const systemPrompt = `Voce eh um OCR especialista em codigos de barras EAN/UPC.
Olha a foto e extrai APENAS os numeros impressos sob/ao lado do codigo de barras (linhas pretas/brancas).
NAO decodifica as listras — LE o numero TEXTUAL impresso ali, igual OCR comum.

Le digito por digito, esquerda pra direita. EAN-13=13 digitos, UPC-A=12, EAN-8=8.

ATENCAO em digitos parecidos: 2/5/7, 0/8, 3/8, 1/7, 6/9. Se UM SO digito for ambíguo, retorna null pra esse e marca confidence baixa.

Responde SO em JSON valido (sem markdown):
{
  "ean": "13 digitos como string OU null se ilegivel/borrado/cortado",
  "confidence": "high" | "medium" | "low",
  "raw_text": "texto bruto que voce viu na foto, pra debug",
  "alertas": ["lista de strings com qualquer ambiguidade"]
}

Se a foto NAO tem codigo de barras visivel, retorna {"ean": null, "confidence": "low", "raw_text": "sem codigo"}.`;

  const makeSource = (url) => {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) return { type: "base64", media_type: m[1], data: m[2] };
      return null;
    }
    return { type: "url", url };
  };

  const source = makeSource(imageBase64OrUrl);
  if (!source) return null;

  const messages = [{
    role: "user",
    content: [
      { type: "image", source },
      { type: "text", text: "Le o codigo de barras da foto e responde SO o JSON." },
    ],
  }];

  const result = await callClaude(messages, systemPrompt, 400);
  if (!result) return null;
  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    // Valida EAN: deve ter 12-13 digitos numericos
    if (parsed.ean && /^\d{12,13}$/.test(parsed.ean)) return parsed;
    return { ean: null, confidence: 'low', raw_text: parsed.raw_text || '', alertas: parsed.alertas || ['ean invalido ou null'] };
  } catch (e) {
    console.error('[_visionReadEan] parse err:', e.message, 'raw:', result.slice(0, 200));
    return null;
  }
}

// COLLECT EAN CANDIDATES (08/05/2026) — cascade OFF + UPCitemDB + Serper pra UM produto
// Reusa logica do handler auto_search_ean. Retorna array de candidatos { ean, source, confidence }.
async function _collectEanCandidates(brand, model, flavor) {
  const isValidEan = (ean) => {
    if (!/^\d{12,13}$/.test(ean)) return false;
    if (/^(19|20)\d{2}$/.test(ean)) return false;
    if (/^0{8,}/.test(ean)) return false;
    if (/^(\d)\1{10,}$/.test(ean)) return false;
    return true;
  };
  const candidates = [];
  const query = `${brand} ${model} ${flavor}`.trim();
  if (!query) return candidates;

  // Tier 1: Open Food Facts
  try {
    const offUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10`;
    const r = await fetch(offUrl, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      for (const p of (d.products || [])) {
        if (p.code && isValidEan(p.code)) {
          candidates.push({ ean: p.code, source: 'open_food_facts', confidence: 'medium' });
        }
      }
    }
  } catch (e) { /* skip */ }

  // Tier 2: UPCitemDB trial
  try {
    const upcUrl = `https://api.upcitemdb.com/prod/trial/search?s=${encodeURIComponent(query)}&match_mode=0&type=product`;
    const r = await fetch(upcUrl, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      for (const it of (d.items || [])) {
        if (it.ean && isValidEan(it.ean)) {
          candidates.push({ ean: it.ean, source: 'upcitemdb', confidence: 'medium' });
        }
      }
    }
  } catch (e) { /* skip */ }

  // Tier 3: Serper Google
  if (SERPER_API_KEY) {
    const queries = [
      `"${brand} ${model} ${flavor}" EAN barcode`,
      `${brand} ${model} ${flavor} barcode`,
    ];
    for (const q of queries) {
      const data = await _serperSearch(q, 'search', 6);
      if (!data) continue;
      for (const o of (data.organic || [])) {
        const text = `${o.title || ''}. ${o.snippet || ''}`;
        const norm = text.replace(/[\s\-\.]/g, '');
        const matches = norm.match(/\b\d{12,13}\b/g) || [];
        for (const ean of matches) {
          if (isValidEan(ean)) {
            candidates.push({ ean, source: 'serper_google', confidence: 'low', snippet: text.slice(0, 100) });
          }
        }
      }
      if (candidates.filter(c => c.source === 'serper_google').length > 0) break;
    }
  }

  // Dedup por EAN — mantem o de maior confidence
  const seen = new Map();
  for (const c of candidates) {
    if (!seen.has(c.ean)) seen.set(c.ean, c);
  }
  return Array.from(seen.values());
}

// Analisa foto de mix (múltiplos produtos na bancada) pro fluxo de abastecimento.
// Retorna array de produtos identificados com qty visível na foto.
// FIX 13 (08/05/2026 - Andrade) — Crop central + upscale antes do Vision.
// Padrão das fotos do Andrade: várias caixas no chão, central em foco mas TEXTO
// pequeno demais pra OCR. 28 fotos do lote anterior caíram aqui — Vision viu marca/
// modelo mas falhou em ler sabor (flavor_confidence=0).
// Solução: sharp.extract crop 60% central + resize 1.6x → texto do rótulo fica grande
// o suficiente pra Haiku ler.
async function _preprocessForVision(imageUrl) {
  let sharp;
  try { sharp = require('sharp'); } catch (e) { return imageUrl; } // fallback: original

  let buffer;
  try {
    if (imageUrl.startsWith('data:')) {
      const m = imageUrl.match(/^data:[^;]+;base64,(.+)$/);
      if (!m) return imageUrl;
      buffer = Buffer.from(m[1], 'base64');
    } else {
      const r = await fetch(imageUrl);
      if (!r.ok) return imageUrl;
      buffer = Buffer.from(await r.arrayBuffer());
    }
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return imageUrl;

    // Crop central 65% (deixa um pouco de margem pra Vision ainda ver bordas)
    const cropW = Math.round(meta.width * 0.65);
    const cropH = Math.round(meta.height * 0.65);
    const left = Math.round((meta.width - cropW) / 2);
    const top = Math.round((meta.height - cropH) / 2);

    // Upscale pra 1.6x do crop (final fica ~104% da original, mas só com central + detalhes maiores)
    const targetW = Math.round(cropW * 1.6);
    const processed = await sharp(buffer)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(targetW, null, { kernel: 'lanczos3', fit: 'inside' })
      .jpeg({ quality: 90 })
      .toBuffer();
    const b64 = processed.toString('base64');
    console.log(`[preprocess] crop+upscale ${meta.width}x${meta.height} → ${targetW}px (central 65%)`);
    return `data:image/jpeg;base64,${b64}`;
  } catch (e) {
    console.warn('[preprocess] err:', e.message);
    return imageUrl; // fallback: foto original
  }
}

async function analyzeMixPhoto(imageUrl) {
  // FIX 11 (07/05/2026 - Andrade) — FOCO NO POD CENTRAL.
  // Antes o prompt pedia pra Vision identificar TODOS os pods da foto. Resultado:
  // em fotos com 4-5 caixas (forma como Andrade fotografa — coloca todas no chao
  // e tira foto), Vision se confundia, lia sabores cruzados, ou retornava null em
  // muitas porque tentava ler o texto de TODAS ao mesmo tempo.
  // Agora: foca APENAS no pod CENTRAL/PRINCIPAL da foto. Ignora os demais como ruido.
  // Andrade tira UMA FOTO POR PRODUTO e o que importa eh o que esta na frente/centro.
  const systemPrompt = `${IA_SERVO_PREAMBULO}Voce identifica UM pod descartavel — APENAS o produto CENTRAL/PRINCIPAL da foto.

CONTEXTO: Lucas (Andrade) tira foto da caixa do pod pra cadastrar no sistema. As vezes tem outras caixas no fundo/lado da foto (estoque empilhado), mas o que importa eh APENAS o produto que esta na frente/centro/em foco.

REGRA CRUCIAL — IGNORE PRODUTOS DO FUNDO:
Foque 100% na caixa CENTRAL/PRINCIPAL da foto (a que esta mais em destaque, em foco, na frente). As outras caixas atras/laterais sao APENAS ruido — nao tente identificar elas. Se a foto tem 5 caixas, voce identifica APENAS 1 (a central).

REGRA #2 — LER TEXTO IMPRESSO:
LEIA literalmente o texto/rotulo escrito na embalagem CENTRAL. NAO adivinhe pela cor. O nome do sabor esta IMPRESSO em texto (ex: "Banana Ice", "Strawberry Kiwi", "Watermelon Ice"). LEIA esse texto.

Responde JSON valido (sem markdown):
{
  "products": [
    {
      "barcode": "OCR dos digitos IMPRESSOS embaixo do codigo de barras da caixa central. null se nao ler.",
      "brand": "marca em maiusculo (IGNITE, ELFBAR, BLACKSHEEP, DOJO, LOSTMARY, GEEKBAR, ADALYA, VANTHER, OXBAR, NIKBAR). LOST MARY=LOSTMARY",
      "model": "linha/modelo da caixa central. Se nao ler, null. NUNCA 'unknown'. Catalogo:\\n        IGNITE: V155/V250/V300/V55/Boost\\n        ELFBAR: BC15K/BC Pro/Trio/Iceking/TE 30K/GH 23K\\n        BLACKSHEEP: Cyber Tank Pro/Cybertank/Spherex/Spherex Plus\\n        LOSTMARY: MO5000/MO10000/MO20000/MT15000/OS5000/BM6000/PSYBER/Cosmic Edition/Tappo\\n        DOJO: Fresh/Frosty/Splash\\n        GEEKBAR: Frozen/White Peach/Stone Freeze/Pulse\\n        ADALYA: AD5000/AD40K\\n        VANTHER: 30K/Cool Mint Edition\\n        OXBAR: Magic Maze\\n        NIKBAR: 50K",
      "flavor_en": "sabor LIDO no texto da embalagem CENTRAL em ingles, ou null se nao conseguiu ler.",
      "flavor_pt": "traducao do sabor pra portugues, ou null",
      "flavor_confidence": "0.0 a 1.0 — quao confiante voce esta de que LEU corretamente o sabor no texto da CAIXA CENTRAL.",
      "qty": "1 (sempre 1 — uma foto, um produto identificado)"
    }
  ],
  "alertas": ["lista de strings se algo confuso (texto borrado, angulo, etc)"]
}

REGRAS:
- SEMPRE retorna no maximo 1 produto (o central). Se nao ver pod nenhum, retorna products vazio.
- Ignore caixas do fundo, laterais, em segundo plano.
- LEIA o sabor no texto da CAIXA CENTRAL. Se nao conseguir ler, flavor_en=null, flavor_confidence=0.
- NUNCA inventa barcode.
- qty sempre 1 (uma foto = um produto).`;

  const makeSource = (url) => {
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) return { type: "base64", media_type: m[1], data: m[2] };
      return null;
    }
    return { type: "url", url };
  };

  // FIX 13: pré-processa imagem (crop central + upscale) antes do Vision pra
  // melhorar legibilidade do texto do rótulo da caixa central.
  const processedUrl = await _preprocessForVision(imageUrl);
  const source = makeSource(processedUrl);
  if (!source) return null;

  const userMsg = [{ role: "user", content: [
    { type: "image", source },
    { type: "text", text: "Identifica APENAS o pod CENTRAL/PRINCIPAL da foto (o que esta em foco/destaque). Ignore caixas do fundo. LEIA o sabor escrito na embalagem central. Retorna 1 produto so. Responde SO o JSON." }
  ]}];

  // 1ª passada: Haiku (rápido + barato)
  let result = await callClaude(userMsg, systemPrompt, 1500);
  let parsed = null;
  try {
    if (result) {
      const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(clean);
    }
  } catch (e) { console.error('[analyzeMixPhoto] parse Haiku err:', e.message); }

  // FIX 14 (08/05/2026 - Andrade) — fallback Sonnet 4.5 quando Haiku falha em ler sabor.
  // Sonnet tem visão mais detalhada — pega texto pequeno/em ângulo que Haiku não pega.
  // Custa 5x mais por chamada mas só roda se Haiku falhou (~28% das fotos do batch passado).
  const haikuFailed = !parsed || !Array.isArray(parsed.products) || parsed.products.length === 0 ||
    parsed.products.every(p => !p.flavor_en && !p.flavor_pt);
  if (haikuFailed && CLAUDE_KEY) {
    console.log('[analyzeMixPhoto] Haiku falhou em sabor, retry com Sonnet 4.5');
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1500,
          system: systemPrompt,
          messages: userMsg,
        }),
      });
      if (r.ok) {
        const data = await r.json();
        const sonnetResult = data?.content?.[0]?.text || '';
        const clean = sonnetResult.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const sonnetParsed = JSON.parse(clean);
        // Aceita Sonnet só se ele AGREGOU info (sabor onde Haiku faltou)
        if (sonnetParsed?.products?.some(p => p.flavor_en || p.flavor_pt)) {
          console.log('[analyzeMixPhoto] Sonnet 4.5 SUCESSO — leu sabor que Haiku falhou');
          parsed = sonnetParsed;
        }
      } else {
        console.warn('[analyzeMixPhoto] Sonnet status:', r.status);
      }
    } catch (e) { console.warn('[analyzeMixPhoto] Sonnet retry err:', e.message); }
  }

  if (!parsed) return null;
  try {
    if (!Array.isArray(parsed.products)) return { products: [], alertas: parsed.alertas || [] };
    // Limpa placeholders textuais em cada produto
    parsed.products = parsed.products.map(p => ({
      ...p,
      brand: cleanVisionField(p.brand),
      model: cleanVisionField(p.model),
      flavor_en: cleanVisionField(p.flavor_en),
      flavor_pt: cleanVisionField(p.flavor_pt),
      flavor_confidence: typeof p.flavor_confidence === 'number' ? p.flavor_confidence : null,
      qty: Math.max(1, parseInt(p.qty) || 1),
    }));
    return parsed;
  } catch (e) {
    console.error('[analyzeMixPhoto] post-process error:', e.message);
    return null;
  }
}

// (removido em 2026-04-29: searchPodImages via Serper foi descontinuado.
// Lucas agora manda foto do pod direto, mais simples e melhor pra device_visual real.)

// Busca produto no banco por barcode (preferencial) ou por marca+modelo+sabor (fallback).
async function findProductByBarcodeOrName(barcode, brand, model, flavor) {
  // 1. Tenta barcode (match exato — mais confiável)
  if (barcode) {
    const rows = await sbGet('drope_products', `barcode=eq.${encodeURIComponent(barcode)}&limit=1`);
    if (rows[0]) return rows[0];
  }
  // 2. Fallback: nome composto via ilike
  if (brand && flavor) {
    const fullName = `${brand} ${model || ''} ${flavor}`.replace(/\s+/g, ' ').trim();
    const rows = await sbGet('drope_products', `name=ilike.*${encodeURIComponent(fullName)}*&limit=1`);
    if (rows[0]) return rows[0];
  }
  return null;
}

// Sufixo de variação pra "outra" tentativa (Lucas rejeitou a arte anterior).
// OpenAI gpt-image-1 não tem seed determinístico, mas mudar o prompt traz
// composições diferentes a cada attempt.
function getArtVariationSuffix(attempt) {
  if (attempt <= 1) return '';
  const variations = [
    '. Shot from a slightly higher angle, dramatic side lighting from the left.',
    '. Shot from below at 15 degrees, with soft volumetric purple haze rising behind the pod.',
    '. Extreme close-up perspective, high-contrast cinematic lighting, deeper shadows.',
    '. Three-quarter view rotation showing more depth, accent of pink rim light on top edge.',
    '. Symmetrical front view with prominent reflection on the floor, magenta glow underneath.',
  ];
  return variations[(attempt - 2) % variations.length];
}

// Deriva flavor_elements de flavor_en quando o Vision não capturou o campo
// (produtos cadastrados antes do enriquecimento Vision-side ficam sem ele).
// OSSO 28 (01/05/2026) — Map enriquecido pra arte ficar visual e apetitosa.
// Antes era "mango slices" (genérico). Agora "ripe mango halves with tropical
// juice dripping, golden flesh visible". Cada sabor tem texto cinematográfico.
function deriveFlavorElements(flavorEn) {
  if (!flavorEn) return 'fresh fruit slices with frost';
  const lower = flavorEn.toLowerCase();
  const map = [
    // Combinações específicas (vão antes pra ter prioridade)
    ['cool mint',     'fresh mint leaves with ice crystals and cool mist'],
    ['ice cream',     'cream scoops with frost and chocolate drizzle'],
    ['miami mint',    'fresh mint leaves with sharp ice crystals'],
    ['green apple',   'crisp green apple slices with frost and visible juice'],
    ['double apple',  'red and green apple halves with juice and condensation'],
    ['sour apple',    'crisp green apple slices with frost and visible juice'],
    ['cherry blast',  'fresh cherries split open showing dark red juice'],
    ['fresh splash',  'splashing water droplets with lime wedges and crushed ice'],
    ['cotton candy',  'pink cotton candy clouds with sugar crystals'],
    ['amor elf',      'mixed berries and rose petals with soft pink haze'],
    ['elf love',      'mixed berries and rose petals with soft pink haze'],
    // Frutas individuais (com descrições ricas)
    ['strawberry',    'fresh strawberries with tiny seeds visible and juice'],
    ['raspberry',     'fresh raspberries with visible texture and frost'],
    ['blueberry',     'plump blueberries with indigo frost'],
    ['blackberry',    'glossy blackberries with juice droplets'],
    ['grapefruit',    'pink grapefruit wedges with citrus spray'],
    ['pineapple',     'pineapple chunks with tropical juice and ice'],
    ['watermelon',    'watermelon wedges with seeds and juice splashing'],
    ['banana',        'ripe banana slices with golden flesh'],
    ['mango',         'ripe mango halves with golden flesh and tropical juice'],
    ['peach',         'ripe peach halves with fuzzy skin and juice'],
    ['lemon',         'lemon slices with water droplets and zest'],
    ['lime',          'lime wedges with juice splashing'],
    ['orange',        'orange slices with bright zest and juice'],
    ['cherry',        'fresh cherries split open showing red juice'],
    ['grape',         'purple grapes with condensation and frost'],
    ['aloe',          'fresh aloe leaves with translucent gel'],
    ['cherries',      'fresh cherries with red juice'],
    ['raspberries',   'fresh raspberries with visible seeds'],
    ['toranja',       'pink grapefruit wedges with citrus spray'],
    ['framboesa',     'fresh raspberries with frost'],
    ['limao',         'lemon and lime slices with juice'],
    ['limão',         'lemon and lime slices with juice'],
    ['cereja',        'fresh cherries split open with red juice'],
    ['manga',         'ripe mango halves with tropical juice'],
    ['morango',       'fresh strawberries with seeds visible'],
    // Tabaco e variantes
    ['tobacco',       'dried tobacco leaves with amber honey glow'],
    ['tabaco',        'dried tobacco leaves with amber honey glow'],
    ['coffee',        'roasted coffee beans with steam rising'],
    ['vanilla',       'vanilla pods split open showing seeds with cream'],
    ['baunilha',      'vanilla pods with cream and warm caramel'],
    ['caramel',       'caramel sauce dripping with golden glow'],
    ['chocolate',     'dark chocolate shards with cocoa powder'],
    ['coconut',       'coconut halves with white flesh and water splashing'],
    ['coco',          'coconut halves with white flesh splashing water'],
    ['passion',       'passion fruit halves showing seeds with tropical juice'],
    ['maracuja',      'passion fruit halves with seeds and juice'],
    ['maracujá',      'passion fruit halves with seeds and juice'],
    ['guava',         'pink guava halves with seeds visible'],
    ['goiaba',        'pink guava halves with seeds'],
    ['lychee',        'lychee fruit with translucent flesh'],
    ['kiwi',          'kiwi slices with green flesh and tiny seeds'],
    ['pitaya',        'dragon fruit halves with white flesh and black seeds'],
    ['pessego',       'ripe peach halves with fuzzy skin'],
    ['pêssego',       'ripe peach halves with fuzzy skin'],
    // Mentol / gelado base
    ['mint',          'fresh mint leaves with cool mist'],
    ['menthol',       'menthol crystals with eucalyptus leaves and frost'],
    ['menta',         'fresh mint leaves with cool mist'],
    ['ice',           'sharp ice crystals and frozen mist with blue tint'],
    ['gelo',          'sharp ice crystals and frozen mist'],
    ['frost',         'crystalline frost with cool blue glow'],
    ['fresco',        'cool mist and crushed ice with water droplets'],
    ['fresh',         'splashing water with crushed ice'],
    ['cool',          'cool mist with ice crystals'],
  ];
  const hits = [];
  const claimedRanges = []; // evita matching duplicado de palavras compostas
  for (const [key, val] of map) {
    // Word boundary evita falso-positivo tipo 'grape' dentro de 'grapefruit'.
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const m = lower.match(re);
    if (m) {
      const start = m.index;
      const end = start + key.length;
      // Evita matches sobrepostos (ex: já matchou "cherry blast", não match "cherry")
      const overlap = claimedRanges.some(([s, e]) => !(end <= s || start >= e));
      if (!overlap) {
        hits.push(val);
        claimedRanges.push([start, end]);
      }
    }
  }
  if (hits.length === 0) return `${flavorEn.toLowerCase()} elements with frost and ice`;
  return [...new Set(hits)].join(', ');
}

// ============ OSSO 28B — DEVICE_BANK + REGRAS DE QUALIDADE DA ARTE ============
// Banco local de descrições visuais precisas por marca+modelo. Ajuda o Grok a
// não chutar proporção/formato quando não tem foto de referência.
const DEVICE_BANK = {
  // ELFBAR
  'elfbar|bc15k': {
    shape: 'rectangular with softly rounded corners',
    height: '105mm tall, 48mm wide, 22mm deep',
    finish: 'translucent frosted polycarbonate shell with visible internal coil',
    mouthpiece: 'integrated flat duck-bill mouthpiece, same color as body',
    details: 'LED indicator strip at bottom, subtle branding on front face',
    typical_colors: 'varies by flavor — usually gradient or solid pastel',
  },
  'elfbar|gh33000 pro': {
    shape: 'tall rectangular with angular edges and bold design',
    height: '120mm tall, 50mm wide, 25mm deep — larger than average',
    finish: 'smooth matte plastic with metallic accents and printed artwork wrapping the body',
    mouthpiece: 'wide flat mouthpiece at top, contrasting color',
    details: 'digital screen showing puff count and battery, aggressive graphic design on shell',
    typical_colors: 'dark base with vibrant artwork — space themes, neon patterns',
  },
  'elfbar|gh3000 pro': {
    shape: 'compact rectangular pod with rounded edges',
    height: '90mm tall, 42mm wide, 20mm deep',
    finish: 'matte plastic with printed flavor artwork',
    mouthpiece: 'integrated narrow mouthpiece at top',
    details: 'small LED indicator, clean modern design',
    typical_colors: 'flavor-themed gradient',
  },
  // LOSTMARY
  'lostmary|mixer+': {
    shape: 'rounded ergonomic rectangle, very smooth curves',
    height: '95mm tall, 42mm wide, 20mm deep — compact',
    finish: 'soft-touch matte coating, feels velvety',
    mouthpiece: 'small round mouthpiece integrated at top',
    details: 'minimal branding, clean design, gradient color body',
    typical_colors: 'pastel gradients — pink-purple, blue-green, orange-yellow',
  },
  // DOJO
  'dojo|spherex': {
    shape: 'cylindrical-rectangular hybrid with rounded edges',
    height: '100mm tall, 35mm diameter — slim pen-style',
    finish: 'metallic brushed aluminum look',
    mouthpiece: 'narrow round mouthpiece',
    details: 'LED ring at base, minimal clean design',
    typical_colors: 'metallic silver, black, or colored aluminum',
  },
  // BLACKSHEEP
  'blacksheep|cyber tank pro': {
    shape: 'bulky rectangular box mod style, aggressive angular design',
    height: '110mm tall, 55mm wide, 30mm deep — chunky',
    finish: 'rubberized matte coating with geometric patterns',
    mouthpiece: 'wide flat mouthpiece with airflow control',
    details: 'large digital display, adjustment buttons on side, tank-style look',
    typical_colors: 'dark colors — black, gunmetal, dark green, with neon accent lines',
  },
  // POD T.H.C
  'pod t.h.c|sweet treatz': {
    shape: 'compact square-ish rounded rectangle',
    height: '90mm tall, 40mm wide, 18mm deep — pocket-friendly',
    finish: 'glossy plastic with candy-themed artwork',
    mouthpiece: 'small integrated mouthpiece',
    details: 'colorful label wrapping body, playful design aesthetic',
    typical_colors: 'bright candy colors matching flavor theme',
  },
  // GEEKBAR
  'geekbar|z35': {
    shape: 'slim rectangular with beveled edges',
    height: '100mm tall, 45mm wide, 20mm deep',
    finish: 'semi-transparent frosted shell showing internal structure',
    mouthpiece: 'flat integrated mouthpiece',
    details: 'LED indicator, visible juice level through translucent body',
    typical_colors: 'translucent with colored tint matching flavor',
  },
};

function getDeviceBankDescription(brand, model) {
  if (!brand || !model) return null;
  const key = `${String(brand).toLowerCase().trim()}|${String(model).toLowerCase().trim()}`;
  const entry = DEVICE_BANK[key];
  if (!entry) return null;
  return `${entry.shape}, approximately ${entry.height}. ${entry.finish}. ${entry.mouthpiece}. ${entry.details}. Body color: ${entry.typical_colors}`;
}

// OSSO 34.3: QC com Vision — Rutem (ministra da Qualidade) avalia arte gerada pelo Grok.
// Checa: texto parasita, proporção do device, frutas corretas pro sabor, atmosfera dark neon.
// Retorna: { approved: bool, score: 0-1, issues: string[] }
async function evaluateArtQuality(imgBuffer, productName, flavor, deviceDescription, referenceUrl, boxPhotoUrl) {
  if (!CLAUDE_KEY) return { approved: true, score: 0.5, issues: ['QC skipped: no CLAUDE_KEY'] };

  try {
    function detectMT(buf) {
      if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
      if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
      return 'image/png';
    }
    const mt = detectMT(imgBuffer);
    const b64 = imgBuffer.toString('base64');

    // FIX REF QA v3 (07/05/2026 - Andrade) — Vision QA compara arte gerada com
    // reference visual (foto Serper aprovada) ALEM da descricao textual.
    // Antes: so olhava arte + descricao texto. Resultado: aprovava artes com
    // device parecido em forma mas cor/sabor errado. Agora compara visualmente:
    // arte gerada vs ref aprovada vs box_photo (ground truth real). Mais rigoroso.
    const hasVisualRef = !!(referenceUrl && referenceUrl.startsWith('http'));
    const hasBoxPhoto = !!(boxPhotoUrl && boxPhotoUrl.startsWith('http'));

    const visualCriterion = hasVisualRef ? `
7. VISUAL FIDELITY (peso ALTO, ref nas Imagens 2 ${hasBoxPhoto ? 'e 3' : ''}): Quao FIEL a arte (Imagem 1) e ao produto REAL?
   - Mesmo formato/proporcoes do dispositivo?
   - Mesma cor predominante e gradientes?
   - Mesmas estampas/grafismos do rotulo?
   - Mesmo tipo de bocal e LEDs?
   ${hasBoxPhoto ? 'A IMAGEM 3 e a foto da caixa real (ground truth absoluto).' : ''}
   A IMAGEM 2 e a referencia aprovada. Score abaixo de 6 = arte ficou diferente do produto = REJEITAR.` : '';

    const qcPrompt = `You are Rutem, a strict Quality Control inspector for Drope (premium vape e-commerce).
Evaluate the product art (IMAGEM 1) for "${productName}" (flavor: ${flavor || 'unknown'}).
${hasVisualRef ? `IMAGEM 2 = referencia visual aprovada (foto real do produto).` : ''}
${hasBoxPhoto ? `IMAGEM 3 = foto da caixa real do produto (ground truth).` : ''}

CRITERIA (score each 0-10):
1. NO ADDED TEXT: The device may show its real brand markings (e.g. "EBCREATE" printed on the physical pod) — that is OK. But NO added text, banners, watermarks, floating titles, prices, or decorative typography anywhere else in the scene. Invented text (words not on the real product) = fail.
2. DEVICE ACCURACY: Device matches this description: "${(deviceDescription || '').substring(0, 200)}". Correct shape, proportions, realistic materials.
3. FLAVOR MATCH: Fruit/ingredient elements match the "${flavor}" flavor. Wrong fruits = fail.
4. DARK NEON ATMOSPHERE: Deep dark background, neon pink/lime as subtle rim lights and reflections (not overwhelming floods), atmospheric vapor/smoke present.
5. COMPOSITION: Device centered, occupies ~35-45% of frame, ingredients around base not covering device. Clean layout.
6. OVERALL QUALITY: Professional e-commerce quality, no artifacts, no distortion, hyper-detailed.${visualCriterion}

APPROVAL THRESHOLD: Average score >= 7 AND no criterion below 4. ${hasVisualRef ? 'visual_fidelity below 6 = auto-reject (arte nao corresponde ao produto real).' : ''} Invented/added text = auto-reject. Real brand text on the device body is acceptable.

Respond ONLY JSON:
{
  "scores": {"no_text": N, "device_accuracy": N, "flavor_match": N, "atmosphere": N, "composition": N, "quality": N${hasVisualRef ? ', "visual_fidelity": N' : ''}},
  "average": N.N,
  "approved": true/false,
  "issues": ["issue1", "issue2"],
  "feedback_for_next_attempt": "one sentence correction if rejected"
}`;

    // Monta content array com 1, 2 ou 3 imagens
    const content = [
      { type: 'image', source: { type: 'base64', media_type: mt, data: b64 } },
    ];
    if (hasVisualRef) {
      content.push({ type: 'image', source: { type: 'url', url: referenceUrl } });
    }
    if (hasBoxPhoto) {
      content.push({ type: 'image', source: { type: 'url', url: boxPhotoUrl } });
    }
    content.push({ type: 'text', text: qcPrompt });

    const vRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content }]
      })
    });

    const vData = await vRes.json();
    if (vData.error) {
      console.error('[QC] Vision API error:', JSON.stringify(vData.error));
      return { approved: false, score: 0, issues: ['QC Vision API error — manda pra retry/manual'], _api_error: true };
    }

    const vText = (vData.content && vData.content[0] && vData.content[0].text) || '';
    const jsonMatch = vText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[QC] parse failed, raw:', vText.substring(0, 200));
      return { approved: false, score: 0, issues: ['QC parse failed — manda pra retry/manual'], _api_error: true };
    }

    const result = JSON.parse(jsonMatch[0]);
    console.log(`[QC] ${productName}: avg=${result.average}, approved=${result.approved}, issues=${(result.issues||[]).join('; ')}`);
    return {
      approved: !!result.approved,
      score: result.average || 0,
      issues: result.issues || [],
      feedback: result.feedback_for_next_attempt || '',
    };
  } catch (e) {
    console.error('[QC] exception:', e.message);
    return { approved: false, score: 0, issues: [`QC exception: ${e.message}`], _api_error: true };
  }
}

// Cascata de 4 fontes pra descrição visual do device:
//   1. reference_image_url (Serper aprovado) → analyzeReferenceImage
//   2. box_photo_url (foto que o Andrade mandou) → analyzeReferenceImage
//   3. DEVICE_BANK (descrição local pré-cadastrada por brand+model)
//   4. Fallback genérico
async function getDeviceDescription(productCtx) {
  if (!productCtx) {
    return 'compact rectangular pod device with rounded edges, matte finish, approximately 100mm tall and 45mm wide';
  }
  const meta = productCtx.metadata || {};
  // 1. Ref aprovada do Serper
  if (productCtx.reference_image_url) {
    try {
      const desc = await analyzeReferenceImage(productCtx.reference_image_url);
      if (desc && desc.length > 20) {
        console.log(`[deviceDesc] productId=${productCtx.id || '?'} usando approved reference (${desc.length}c)`);
        return desc;
      }
    } catch (e) { console.warn('[deviceDesc] ref analyze failed:', e.message); }
  }
  // 2. Foto da caixa
  const boxUrl = productCtx.box_photo_url || meta.box_photo_url;
  if (boxUrl) {
    try {
      const desc = await analyzeReferenceImage(boxUrl);
      if (desc && desc.length > 20) {
        console.log(`[deviceDesc] productId=${productCtx.id || '?'} usando box photo (${desc.length}c)`);
        return desc;
      }
    } catch (e) { console.warn('[deviceDesc] box analyze failed:', e.message); }
  }
  // 3. Banco local
  const brand = meta.brand || productCtx.brand;
  const model = meta.model || productCtx.model;
  const bankDesc = getDeviceBankDescription(brand, model);
  if (bankDesc) {
    console.log(`[deviceDesc] productId=${productCtx.id || '?'} usando DEVICE_BANK ${brand}|${model}`);
    return bankDesc;
  }
  // 4. Fallback genérico
  console.log(`[deviceDesc] productId=${productCtx.id || '?'} usando fallback genérico`);
  return 'compact rectangular pod device with rounded edges, matte finish, approximately 100mm tall and 45mm wide';
}

// Regras absolutas que o prompt deve sempre carregar.
// OSSO 34.3 (05/05/2026) — Prompt reescrito com base em pesquisa de melhores práticas:
//   - Estrutura 5 camadas (subject → style → environment → lighting → camera)
//   - Linguagem técnica fotográfica (Grok Aurora responde melhor a termos de câmera)
//   - Fumaça/vapor como elemento atmosférico central
//   - Neon como REFLEXO sutil, nunca inundação
//   - Zero texto (reforço triplo)
const ART_QUALITY_RULES = {
  deviceMaxSize: 'The device occupies 35-45% of frame height — hero subject, prominent but with breathing room',
  noDistortion: 'Device has perfectly straight edges, symmetrical proportions, realistic materials with surface imperfections (subtle scratches, fingerprint-free matte). No warping, melting, or impossible geometry',
  position: 'Device standing upright, dead center, tilted 3-5 degrees for dynamism. Base touching the reflective surface with a crisp shadow',
  ingredientPlacement: 'Flavor ingredients arranged at the BASE and SIDES only — never covering the front face. Ingredients are SUPPORTING cast, not competing with the device',
  noText: 'CRITICAL: No ADDED text, watermarks, labels, banners, or floating text anywhere in the image. The device itself may show its real brand markings as they appear on the physical product — that is acceptable. But do NOT add any text, titles, prices, or decorative typography to the scene',
  lighting: 'Low-key three-point cinematic lighting. Key light: soft cool white from upper-left. Fill: faint ultraviolet (#7B2FBE) from right. Accent: neon pink (#FF2D6F) and acid lime (#D4FF2E) as thin rim lights and surface reflections — NOT colored floods. Ratio: 70% dark shadows, 20% midtones, 10% neon highlights',
  background: 'Deep dark background gradient (#0A0C1B to #12091F), clean negative space, no patterns, no extra objects. Matte black reflective surface below device creating a subtle mirror reflection',
  vapor: 'Atmospheric vapor/smoke drifting lazily behind and around the device — wispy, translucent, catching the neon rim lights with subtle pink and green tints. NOT thick fog — ethereal, like hookah smoke in slow motion. Vapor rises from behind the device and curls gently at the edges',
};

// ============ COMPOSITE PIPELINE (OSSO 34.5) — pod real + cenário gerado ============
// Fluxo: referência → recorta fundo → gera cenário dark neon (SEM device) → cola o pod real.
// O pod NUNCA é alterado — só o ambiente ao redor muda.
//
// 1. removeBackground(imageUrl) → PNG com fundo transparente (via remove.bg API)
// 2. generateBackgroundScene(flavor, flavorElements) → cenário Grok (text-to-image, sem device)
// 3. compositeProductArt(background, deviceCutout) → arte final via sharp

// Remove background da foto de referência usando remove.bg API
// Retorna Buffer PNG com alpha channel (fundo transparente)
async function removeBackground(imageUrl) {
  if (!REMOVEBG_API_KEY) {
    console.warn('[removeBackground] REMOVEBG_API_KEY not configured — falling back to sharp threshold');
    return removeBackgroundSharp(imageUrl);
  }

  console.log('[removeBackground] calling remove.bg API...');
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': REMOVEBG_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        image_url: imageUrl,
        size: 'regular', // até 625x400 (free tier)
        format: 'png',
        type: 'product',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[removeBackground] remove.bg error ${res.status}:`, errText.substring(0, 300));
      // Fallback pra sharp
      return removeBackgroundSharp(imageUrl);
    }

    // remove.bg retorna JSON com base64 quando Accept: application/json
    const data = await res.json();
    const b64 = data.data?.result_b64;
    if (!b64) {
      console.error('[removeBackground] remove.bg no b64 in response');
      return removeBackgroundSharp(imageUrl);
    }

    const buf = Buffer.from(b64, 'base64');
    console.log(`[removeBackground] remove.bg OK — ${buf.length} bytes, ${Date.now() - t0}ms`);
    logApiCost('removebg', { status: res.status, ms: Date.now() - t0, bytes: buf.length }).catch(() => {});
    return buf;
  } catch (e) {
    console.error('[removeBackground] exception:', e.message);
    return removeBackgroundSharp(imageUrl);
  }
}

// Fallback: remoção de fundo simples com sharp (threshold-based).
// Funciona bem pra fotos de produto com fundo branco/claro.
async function removeBackgroundSharp(imageUrl) {
  console.log('[removeBackgroundSharp] usando fallback sharp threshold...');
  const sharp = require('sharp');

  // Download da imagem
  const imgBuf = await downloadImage(imageUrl);
  if (!imgBuf) return null;

  const { data, info } = await sharp(imgBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;

  // Amostra das bordas pra detectar cor de fundo dominante
  const edgeSamples = [];
  const sampleEdge = (x, y) => {
    const idx = (y * width + x) * 4;
    edgeSamples.push([data[idx], data[idx + 1], data[idx + 2]]);
  };
  for (let x = 0; x < width; x += 2) { sampleEdge(x, 0); sampleEdge(x, height - 1); }
  for (let y = 0; y < height; y += 2) { sampleEdge(0, y); sampleEdge(width - 1, y); }

  const avgR = edgeSamples.reduce((s, p) => s + p[0], 0) / edgeSamples.length;
  const avgG = edgeSamples.reduce((s, p) => s + p[1], 0) / edgeSamples.length;
  const avgB = edgeSamples.reduce((s, p) => s + p[2], 0) / edgeSamples.length;

  console.log(`[removeBackgroundSharp] detected bg color: rgb(${Math.round(avgR)},${Math.round(avgG)},${Math.round(avgB)})`);

  // Pixels próximos da cor de fundo → transparente
  const threshold = 60;
  const newData = Buffer.from(data);
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - avgR;
    const dg = data[i + 1] - avgG;
    const db = data[i + 2] - avgB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < threshold) {
      newData[i + 3] = 0; // alpha = 0 (transparente)
    }
  }

  const result = await sharp(newData, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

  console.log(`[removeBackgroundSharp] done — ${result.length} bytes`);
  return result;
}

// Gera APENAS o cenário dark neon (frutas, vapor, iluminação) SEM NENHUM device.
// O centro fica vazio pro pod ser colado depois.
async function generateBackgroundScene(flavor, flavorElements, qcFeedback) {
  const flavorEls = (flavorElements && flavorElements.length > 2)
    ? flavorElements
    : deriveFlavorElements(flavor);

  const prompt = [
    `Dark cinematic product photography BACKGROUND SCENE. This is ONLY the environment — NO device, NO product, NO pod, NO vape in the image.`,
    `The CENTER of the image is EMPTY — reserved for a product to be composited later.`,

    // Superfície
    `A matte black reflective surface occupies the bottom third of the frame, creating subtle mirror reflections.`,
    `Deep dark background gradient (#0A0C1B to #12091F), clean negative space above.`,

    // Ingredientes de sabor
    `Fresh ${flavorEls} placed naturally on the reflective surface in the LOWER portion — real organic texture, visible juice, tiny ice crystals, natural imperfections. The fruits are arranged at the sides and base, leaving the center clear.`,

    // Atmosfera
    `Atmospheric vapor/smoke drifting across the scene — wispy, translucent, catching neon rim lights with subtle pink (#FF2D6F) and green (#D4FF2E) tints. NOT thick fog — ethereal, like hookah smoke in slow motion.`,
    `Low-key cinematic lighting. Key light: soft cool white from upper-left. Fill: faint ultraviolet (#7B2FBE). Accent: neon pink and acid lime as thin rim highlights on surfaces.`,
    `70% dark shadows, 20% midtones, 10% neon highlights.`,

    // Regras duras
    `CRITICAL: NO device, NO product, NO pod, NO vape, NO electronic device anywhere in the image. ONLY the dark atmospheric scene with fruits and vapor.`,
    `NO text, NO watermarks, NO labels.`,
    `Square format 1024x1024.`,
    qcFeedback ? `CORRECTIONS: ${qcFeedback}` : '',
  ].filter(Boolean).join(' ');

  if (!XAI_API_KEY) {
    console.error('[generateBackgroundScene] XAI_API_KEY not configured');
    return null;
  }

  console.log('[generateBackgroundScene] generating dark neon scene, flavor:', flavorEls.slice(0, 60));
  const t0 = Date.now();
  const r = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify({ model: 'grok-imagine-image', prompt, n: 1 }),
  });

  const data = await r.json();
  console.log(`[generateBackgroundScene] status: ${r.status}, ${Date.now() - t0}ms`);
  logApiCost('grok_background', { status: r.status, ms: Date.now() - t0 }).catch(() => {});

  if (r.status >= 400) {
    console.error('[generateBackgroundScene] error:', JSON.stringify(data).slice(0, 400));
    return null;
  }

  return data.data?.[0]?.url || null;
}

// Composite: cola o pod recortado (com alpha) no cenário gerado.
// Pod fica centralizado, ocupando ~45% da altura do frame.
async function compositeProductArt(backgroundBuffer, deviceCutoutBuffer) {
  const sharp = require('sharp');

  // Background: resize pra 1024x1024
  const bg = await sharp(backgroundBuffer)
    .resize(1024, 1024, { fit: 'cover' })
    .png()
    .toBuffer();

  // Device: pegar dimensões originais
  const deviceMeta = await sharp(deviceCutoutBuffer).metadata();
  const targetHeight = Math.round(1024 * 0.50); // 50% do frame
  const scale = targetHeight / deviceMeta.height;
  const targetWidth = Math.min(Math.round(deviceMeta.width * scale), 900); // max 900px largura

  const device = await sharp(deviceCutoutBuffer)
    .resize(targetWidth, targetHeight, { fit: 'inside' })
    .png()
    .toBuffer();

  // Pegar dimensões finais do device redimensionado
  const resizedMeta = await sharp(device).metadata();
  const left = Math.round((1024 - resizedMeta.width) / 2);
  const top = Math.round((1024 - resizedMeta.height) / 2 - 40); // levemente acima do centro

  console.log(`[compositeProductArt] device ${resizedMeta.width}x${resizedMeta.height} at (${left},${top}) on 1024x1024 bg`);

  const result = await sharp(bg)
    .composite([{ input: device, left, top }])
    .png()
    .toBuffer();

  console.log(`[compositeProductArt] done — ${result.length} bytes`);
  return result;
}

// Pipeline completo de composite: recorta → gera cenário → cola
// Retorna Buffer da arte final ou null se falhar
async function runCompositeArt(referenceImageUrl, flavor, flavorElements, qcFeedback) {
  console.log('[runCompositeArt] starting composite pipeline...');

  // Passo 1: Recortar fundo da referência
  const deviceCutout = await removeBackground(referenceImageUrl);
  if (!deviceCutout) {
    console.error('[runCompositeArt] background removal failed');
    return null;
  }

  // Passo 2: Gerar cenário dark neon (SEM device)
  const bgUrl = await generateBackgroundScene(flavor, flavorElements, qcFeedback);
  if (!bgUrl) {
    console.error('[runCompositeArt] background scene generation failed');
    return null;
  }

  // Passo 3: Download do cenário
  const bgBuffer = await downloadImage(bgUrl);
  if (!bgBuffer) {
    console.error('[runCompositeArt] background download failed');
    return null;
  }

  // Passo 4: Composite
  const finalArt = await compositeProductArt(bgBuffer, deviceCutout);
  if (!finalArt) {
    console.error('[runCompositeArt] composite failed');
    return null;
  }

  console.log(`[runCompositeArt] composite complete — ${finalArt.length} bytes`);
  return finalArt;
}

// ============ xAI GROK IMAGE — geração de arte do pod ============
// OSSO 34.5 (05/05/2026) — COMPOSITE: quando existe reference_image_url, usa pipeline
// de composite (recorte + cenário + colagem). Pod real NUNCA é alterado.
// Quando NÃO tem referência, cai no modo antigo /v1/images/generations (text-only).
//
// Grok retorna URL (não base64). Caller faz downloadImage(url) → uploadToStorage.
async function generatePadraoAPlus(brand, model, flavor, coresPredominantes, deviceVisual, attempt = 1, flavorElements = '', deviceVisualDetailed = '', productCtx = null, qcFeedback = '') {
  const fullName = `${brand} ${model || ''} ${flavor}`.replace(/\s+/g, ' ').trim();

  // OSSO 34.6: IMG2IMG comprovado (gerou arte perfeita 05/05/2026).
  // Com reference_image_url → /v1/images/edits (Grok transforma cenário, preserva pod)
  // Sem referência → /v1/images/generations (text-only, gera tudo do zero)
  const referenceImageUrl = productCtx?.reference_image_url || null;
  const useImg2Img = !!referenceImageUrl;

  let deviceDescription = '';
  if (!useImg2Img) {
    // Text-only precisa descrever o device
    try {
      const ctx = productCtx || { metadata: { brand, model } };
      deviceDescription = await getDeviceDescription(ctx);
    } catch (e) {
      deviceDescription = getDeviceBankDescription(brand, model)
        || 'compact rectangular pod device with rounded edges, matte finish, approximately 100mm tall and 45mm wide';
    }
  }

  // Variáveis do template (legacy, ainda usadas como fallback dentro do prompt):
  const deviceColor = (coresPredominantes && coresPredominantes.length > 2)
    ? coresPredominantes
    : 'matte black';
  const flavorEls = (flavorElements && flavorElements.length > 2)
    ? flavorElements
    : deriveFlavorElements(flavor);

  const variationSuffix = getArtVariationSuffix(attempt);

  // OSSO 34.6: Dois modos de prompt comprovados.
  let prompt;

  if (useImg2Img) {
    // ═══ IMG2IMG: Grok recebe a foto real → transforma CENÁRIO, preserva DEVICE ═══
    prompt = [
      `Transform this product photo into a cinematic dark premium e-commerce hero shot.`,
      `KEEP THE DEVICE EXACTLY AS IT IS — same shape, same proportions, same colors, same brand markings. Do NOT change the product itself.`,

      `${ART_QUALITY_RULES.position}.`,
      `${ART_QUALITY_RULES.deviceMaxSize}.`,
      `${ART_QUALITY_RULES.background}.`,

      `Add fresh ${flavorEls} placed naturally around the base — real organic texture, visible juice, tiny ice crystals, natural imperfections.`,
      `${ART_QUALITY_RULES.ingredientPlacement}.`,

      `${ART_QUALITY_RULES.vapor}.`,
      `${ART_QUALITY_RULES.lighting}.`,
      `Tiny water droplets on the device surface catching neon rim light. Frost condensation near the base.`,

      `Color grade: deep shadows, desaturated midtones, selective neon highlights. Dark moody atmosphere — premium Gen Z aesthetic.`,
      `Hyper-detailed 8K texture. Commercial product photography.`,

      `${ART_QUALITY_RULES.noText}.`,
      `Square format 1024x1024.`,
      qcFeedback ? `IMPORTANT CORRECTIONS: ${qcFeedback}` : '',
      variationSuffix,
    ].filter(Boolean).join(' ');
  } else {
    // ═══ TEXT-ONLY: descreve device + cenário (fallback sem referência) ═══
    prompt = [
      `Cinematic product photography of a single vape pod device.`,
      `Device: ${deviceDescription}. Body color: ${deviceColor}.`,
      `${ART_QUALITY_RULES.position}.`,
      `${ART_QUALITY_RULES.deviceMaxSize}.`,
      `${ART_QUALITY_RULES.noDistortion}.`,

      `${ART_QUALITY_RULES.background}.`,

      `Fresh ${flavorEls} placed naturally around the base — real organic texture, visible juice, tiny ice crystals.`,
      `${ART_QUALITY_RULES.ingredientPlacement}.`,

      `${ART_QUALITY_RULES.vapor}.`,
      `${ART_QUALITY_RULES.lighting}.`,
      `Tiny water droplets on the device surface catching neon rim light. Frost condensation near the base.`,

      `Shot on Hasselblad X2D 100C, 90mm f/3.2 lens, f/5.6 aperture for deep focus.`,
      `Color grade: deep shadows, desaturated midtones, selective neon highlights. Dark moody atmosphere — premium Gen Z vape culture aesthetic.`,
      `Hyper-detailed 8K texture. Commercial e-commerce hero shot.`,

      `${ART_QUALITY_RULES.noText}.`,
      `Square format 1024x1024.`,
      qcFeedback ? `IMPORTANT CORRECTIONS: ${qcFeedback}` : '',
      variationSuffix,
    ].filter(Boolean).join(' ');
  }

  if (!XAI_API_KEY) {
    console.error("[Grok image] XAI_API_KEY not configured");
    return null;
  }

  console.log("[Grok image] generating for:", fullName, "attempt:", attempt, "mode:", useImg2Img ? 'IMG2IMG' : 'TEXT-ONLY', "flavorEls:", flavorEls.slice(0, 60));

  // OSSO 34.6: IMG2IMG usa /v1/images/edits, TEXT-ONLY usa /v1/images/generations
  const t0 = Date.now();
  let apiUrl, bodyPayload;

  if (useImg2Img) {
    apiUrl = "https://api.x.ai/v1/images/edits";
    bodyPayload = {
      model: "grok-imagine-image",
      prompt,
      image: { url: referenceImageUrl, type: "image_url" },
      n: 1
    };
    console.log(`[Grok image] IMG2IMG ref: ${referenceImageUrl.substring(0, 80)}...`);
  } else {
    apiUrl = "https://api.x.ai/v1/images/generations";
    bodyPayload = { model: "grok-imagine-image", prompt, n: 1 };
  }

  const r = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${XAI_API_KEY}`
    },
    body: JSON.stringify(bodyPayload)
  });

  const data = await r.json();
  console.log("[Grok image] status:", r.status);
  logApiCost('grok_image', {
    status: r.status,
    attempt,
    mode: useImg2Img ? 'img2img' : 'text2img',
    ms: Date.now() - t0,
    full_name: fullName,
  }).catch(() => {});

  if (r.status >= 400) {
    console.error(`[Grok image] error (${useImg2Img ? 'img2img' : 'text2img'}):`, JSON.stringify(data).slice(0, 500));
    // Se img2img falhou, tenta text-only como fallback
    if (useImg2Img) {
      console.warn('[Grok image] img2img failed, falling back to text-only');
      let fallbackDesc;
      try { fallbackDesc = await getDeviceDescription(productCtx || { metadata: { brand, model } }); }
      catch (e) { fallbackDesc = getDeviceBankDescription(brand, model) || 'compact rectangular pod device'; }
      const fallbackPrompt = [
        `Cinematic product photography of a single vape pod device.`,
        `Device: ${fallbackDesc}. Body color: ${deviceColor}.`,
        `${ART_QUALITY_RULES.position}.`, `${ART_QUALITY_RULES.deviceMaxSize}.`,
        `${ART_QUALITY_RULES.background}.`,
        `Fresh ${flavorEls} placed naturally around the base.`,
        `${ART_QUALITY_RULES.vapor}.`, `${ART_QUALITY_RULES.lighting}.`,
        `${ART_QUALITY_RULES.noText}.`, `Square format 1024x1024.`,
      ].filter(Boolean).join(' ');
      const rFb = await fetch("https://api.x.ai/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${XAI_API_KEY}` },
        body: JSON.stringify({ model: "grok-imagine-image", prompt: fallbackPrompt, n: 1 })
      });
      const dFb = await rFb.json();
      if (rFb.status >= 400) return null;
      return dFb.data?.[0]?.url || null;
    }
    return null;
  }

  // Grok retorna URL pública temporária. Caller faz downloadImage(url) e upload pro Supabase Storage.
  const url = data.data?.[0]?.url;
  if (url) return url;
  // Fallback: caso Grok mude de comportamento e mande b64
  const b64 = data.data?.[0]?.b64_json;
  if (b64) return `data:image/png;base64,${b64}`;
  return null;
}

// ============ xAI GROK VIDEO — geração de vídeo curto a partir da arte aprovada ============
// IMPLEMENTADO MAS NÃO CHAMADO AINDA (Andrade 2026-04-30 — Lucas vai testar depois).
// Fluxo: arte aprovada → generateVideoFromArt(artUrl, slug) → vídeo no Supabase
// Storage em pods/videos/{slug}.mp4 → metadata.video_url do produto atualizado.
// Usa grok-imagine-video com a arte estática como base. Movimento sutil (vapor,
// luzes pulsando, frutas leves). 4-5s, smooth loop.
const VIDEO_PROMPT = `Subtle cinematic motion: vapor mist slowly rising, neon lights gently pulsing, slight camera drift. The vape device stays perfectly still and centered. Ambient particles floating. 4 seconds, smooth loop.`;

async function uploadVideoToStorage(slug, videoBuf) {
  const path = `pods/videos/${slug}.mp4`;
  const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: videoBuf,
  });
  if (!r.ok) {
    console.error('[Storage video] upload error:', r.status, await r.text());
    return null;
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

async function setProductVideoUrl(slug, videoUrl) {
  // PATCH metadata->video_url. Como metadata é jsonb, faz merge via array de
  // operações: lê, mergeia, escreve. Caller passa slug exato.
  const rGet = await fetch(
    `${SUPABASE_URL}/rest/v1/drope_products?slug=eq.${encodeURIComponent(slug)}&select=metadata`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!rGet.ok) return false;
  const rows = await rGet.json();
  const current = (Array.isArray(rows) && rows[0]?.metadata) || {};
  const merged = { ...current, video_url: videoUrl };
  const rPatch = await fetch(
    `${SUPABASE_URL}/rest/v1/drope_products?slug=eq.${encodeURIComponent(slug)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ metadata: merged }),
    }
  );
  return rPatch.ok;
}

// Fire-and-forget pra não bloquear webhook (Grok video pode levar >30s).
// Quando vídeo termina, generateVideoFromArt já atualiza metadata.video_url.
// Manda também notificação leve pro Lucas — só se phone fornecido.
function fireBackgroundVideoGeneration(artUrl, slug, phone, msgBody, fullName) {
  if (phone) {
    sendText(phone, `🎬 gerando vídeo: *${fullName || slug}*\n\naguenta ~30s...`, msgBody || {})
      .catch(e => console.error('[fireVideo] sendText error:', e.message));
  }
  // Não awaitamos — fire-and-forget. Errors logados dentro de generateVideoFromArt.
  generateVideoFromArt(artUrl, slug)
    .then(url => {
      if (url) console.log('[fireVideo] OK slug:', slug, 'url:', url);
      else console.warn('[fireVideo] retornou null pra slug:', slug);
    })
    .catch(e => console.error('[fireVideo] error slug:', slug, e.message));
}

// Dispara geração de arte em invocation Vercel separada (60s timeout próprio configurado
// em vercel.json/maxDuration), pra não bloquear o webhook UazAPI (que só tem janela de 10s).
//
// FIX 30/04/2026 (tarde 6): a versão anterior fazia fire-and-forget sem await. Em Vercel
// Node serverless o handler congela depois de `res.send()`, e o fetch que ainda não fez
// TCP send fica órfão — request nunca sai, runArtGeneration nunca roda. Bug recorrente
// (Americano Ice id=26 ficou pending_art sem last_art_attempt).
//
// Solução: AbortController com timeout curto (1.5s). Caller AWAITA a função, garantindo
// que o request HTTP sai antes do handler retornar. AbortError após 1.5s só cancela o
// CLIENTE — a invocation destino já foi criada pelo proxy Vercel e roda independente.
async function fireBackgroundArtGeneration(productId, phone, attempt = 1) {
  if (!ADMIN_TOKEN) {
    console.error('[fireArt] ADMIN_TOKEN not configured — cannot trigger background art');
    return false;
  }
  // VERCEL_URL vem do runtime (sem protocolo). Fallback pro alias de produção.
  const host = process.env.VERCEL_URL || 'drope-app.vercel.app';
  const url = `https://${host}/api/webhook?action=generate_art&product_id=${encodeURIComponent(productId)}&phone=${encodeURIComponent(phone)}&attempt=${attempt}`;
  console.log(`[fireArt] dispatching productId=${productId} attempt=${attempt} via ${host}`);

  const controller = new AbortController();
  const ABORT_AFTER_MS = 1500;
  const timeoutId = setTimeout(() => controller.abort(), ABORT_AFTER_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': ADMIN_TOKEN,
      },
      signal: controller.signal,
    });
    console.log(`[fireArt] dispatched OK productId=${productId} status=${r.status}`);
    return true;
  } catch (e) {
    if (e.name === 'AbortError') {
      // Comportamento esperado: TCP send completou (request foi enviada), só não esperamos
      // a resposta — runArtGeneration tá rodando na invocation destino.
      console.log(`[fireArt] dispatched (timeout wait) productId=${productId}`);
      return true;
    }
    console.error(`[fireArt] dispatch error productId=${productId}:`, e.message);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generateVideoFromArt(artUrl, slug) {
  if (!XAI_API_KEY) {
    console.error('[Grok video] XAI_API_KEY not configured');
    return null;
  }
  if (!artUrl || !slug) {
    console.error('[Grok video] artUrl e slug obrigatórios');
    return null;
  }
  console.log('[Grok video] generating for slug:', slug);
  const r = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'grok-imagine-video',
      prompt: VIDEO_PROMPT,
      image_url: artUrl,
      n: 1,
    }),
  });
  console.log('[Grok video] status:', r.status);
  const data = await r.json();
  if (r.status >= 400) {
    console.error('[Grok video] error:', JSON.stringify(data).slice(0, 400));
    return null;
  }
  const videoUrl = data.data?.[0]?.url;
  if (!videoUrl) {
    console.error('[Grok video] sem URL na resposta');
    return null;
  }
  // Baixa o vídeo
  const vResp = await fetch(videoUrl);
  if (!vResp.ok) {
    console.error('[Grok video] download HTTP', vResp.status);
    return null;
  }
  const buf = Buffer.from(await vResp.arrayBuffer());
  // Sobe pro Storage
  const publicUrl = await uploadVideoToStorage(slug, buf);
  if (!publicUrl) return null;
  // Atualiza metadata.video_url
  await setProductVideoUrl(slug, publicUrl);
  console.log('[Grok video] OK:', publicUrl);
  return publicUrl;
}

// ============ UAZAPI SEND ============
async function sendText(phone, text, body = {}) {
  const serverUrl = body.BaseUrl || UAZAPI_SERVER;
  const token = body.token || UAZAPI_TOKEN;
  const t0 = Date.now();
  const r = await fetch(`${serverUrl}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": token },
    body: JSON.stringify({ number: phone, text })
  });
  console.log("[Send] text to", phone.slice(0, 6) + "***", "status:", r.status);
  // OSSO 23 — log custo
  logApiCost('uazapi_msg', {
    type: 'text',
    status: r.status,
    ms: Date.now() - t0,
    chars: text ? text.length : 0,
  }).catch(() => {});
  return r;
}

async function sendImage(phone, imageUrl, caption, body = {}) {
  const serverUrl = body.BaseUrl || UAZAPI_SERVER;
  const token = body.token || UAZAPI_TOKEN;

  // UazAPI: endpoint correto é /send/media (NÃO /send/image — esse retorna 405).
  // Payload: { number, type: 'image', file: <url|base64>, caption }
  // O campo 'file' aceita URL pública ou base64 puro (sem prefixo data:).
  let filePayload = imageUrl;
  if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
    filePayload = imageUrl.replace(/^data:image\/\w+;base64,/, '');
  }

  const t0 = Date.now();
  const r = await fetch(`${serverUrl}/send/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": token },
    body: JSON.stringify({
      number: phone,
      type: 'image',
      file: filePayload,
      caption: caption || "",
    })
  });
  const respText = await r.text();
  console.log("[Send] image status:", r.status, "body:", respText.slice(0, 300));
  // OSSO 23 — log custo
  logApiCost('uazapi_msg', {
    type: 'image',
    status: r.status,
    ms: Date.now() - t0,
  }).catch(() => {});
  return r;
}

// ============ WHATSAPP MEDIA DECRYPT ============
// Algoritmo publico do whatsapp/signal: HKDF-SHA256(mediaKey) -> iv+cipherKey+macKey,
// depois AES-256-CBC decrypt do payload (ultimos 10 bytes sao MAC, descartados).
async function downloadAndDecryptWhatsappMedia(url, mediaKeyB64, infoString = 'WhatsApp Image Keys') {
  const r = await fetch(url);
  if (!r.ok) {
    console.error('[WA Decrypt] download status:', r.status);
    return null;
  }
  const encrypted = Buffer.from(await r.arrayBuffer());
  const mediaKey = Buffer.from(mediaKeyB64, 'base64');
  const expanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(infoString), 112));
  const iv = expanded.slice(0, 16);
  const cipherKey = expanded.slice(16, 48);
  const ciphertext = encrypted.slice(0, -10); // ultimos 10 bytes = MAC, descartados
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ============ MEDIA DOWNLOAD ============
async function getMediaUrl(msg, body) {
  // Tenta varios paths comuns onde diferentes APIs colocam a URL da imagem
  if (msg.mediaUrl) return msg.mediaUrl;
  if (msg.media?.url) return msg.media.url;
  if (msg.image?.url) return msg.image.url;
  if (msg.imageMessage?.url) return msg.imageMessage.url;
  if (msg.message?.imageMessage?.url) return msg.message.imageMessage.url;
  if (typeof msg.image === 'string' && msg.image.startsWith('http')) return msg.image;
  if (typeof msg.media === 'string' && msg.media.startsWith('http')) return msg.media;
  if (msg.url && typeof msg.url === 'string' && msg.url.startsWith('http')) return msg.url;

  // FIX 07/05/2026 (Andrade) — UazAPI dropepod (servidor dedicado pago) tem endpoint
  // proprio: POST /message/download {id: msgId} retorna {fileURL, mimetype}.
  // Resolve o caso do bad decrypt local: descriptografia AES-256-CBC falha em fotos
  // com metadata de forward. Como o servidor UazAPI ja tem a foto descriptografada
  // (pra UI/UX deles), basta pedir o fileURL direto. Mais rapido e confiavel.
  // Retry ate 2x com backoff em caso de 500 (servidor UazAPI as vezes responde
  // 500 em fotos novas que ainda nao processou).
  const msgIdEarly = msg.id || msg.messageId || msg.key?.id;
  if (msgIdEarly) {
    const serverUrl = body.BaseUrl || UAZAPI_SERVER;
    const token = body.token || UAZAPI_TOKEN;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch(`${serverUrl}/message/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', token },
          body: JSON.stringify({ id: msgIdEarly }),
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        if (r.ok) {
          const data = await r.json();
          if (data.fileURL) {
            console.log(`[Media] /message/download OK (attempt ${attempt})`, data.cached ? '(cached)' : '(fresh)');
            return data.fileURL;
          }
          break; // 200 mas sem fileURL — algo errado, nao adianta retry
        }
        if (r.status === 500 && attempt < 3) {
          // Backoff: 500ms, 1500ms
          console.log(`[Media] /message/download 500 attempt ${attempt}/3, retry...`);
          await new Promise(r2 => setTimeout(r2, 500 * attempt));
          continue;
        }
        console.log("[Media] /message/download status:", r.status, "(after attempt", attempt + ")");
        break;
      } catch (e) {
        console.warn(`[Media] /message/download err attempt ${attempt}:`, e.message);
        if (attempt < 3) await new Promise(r2 => setTimeout(r2, 500 * attempt));
      }
    }
  }

  // UazAPI/dropepod format: msg.content.URL eh encriptada com mediaKey.
  // Tenta desencriptar pra alta resolucao (1000x1000 typical).
  // Nota: pode falhar (bad decrypt) em fotos forward — fallback continua pra thumbnail.
  if (msg.content?.URL && msg.content?.mediaKey) {
    try {
      const decrypted = await downloadAndDecryptWhatsappMedia(msg.content.URL, msg.content.mediaKey);
      if (decrypted && decrypted.length > 100) {
        const mt = msg.content.mimetype || 'image/jpeg';
        console.log("[WA Decrypt] OK", decrypted.length, "bytes");
        return `data:${mt};base64,${decrypted.toString('base64')}`;
      }
    } catch (e) {
      console.error("[WA Decrypt] error:", e.message);
    }
  }

  // Fallback: JPEGThumbnail vem ja descriptografado mas eh low-res (~100x100).
  if (msg.content?.JPEGThumbnail) {
    const mt = msg.content.mimetype || 'image/jpeg';
    console.log("[WA Decrypt] usando thumbnail (low-res fallback)");
    return `data:${mt};base64,${msg.content.JPEGThumbnail}`;
  }

  // base64 inline (varios paths possiveis)
  if (msg.base64) return `data:${msg.mimetype || 'image/jpeg'};base64,${msg.base64}`;
  if (msg.image?.base64) return `data:${msg.image.mimetype || 'image/jpeg'};base64,${msg.image.base64}`;
  if (msg.imageMessage?.base64) return `data:${msg.imageMessage.mimetype || 'image/jpeg'};base64,${msg.imageMessage.base64}`;
  if (msg.body && typeof msg.body === 'string' && msg.mimetype?.startsWith('image/')) {
    return `data:${msg.mimetype};base64,${msg.body}`;
  }

  // Tenta baixar via API UazAPI usando o msg ID (varios endpoints possiveis)
  const msgId = msg.id || msg.messageId || msg.key?.id;
  if (msgId) {
    const serverUrl = body.BaseUrl || UAZAPI_SERVER;
    const token = body.token || UAZAPI_TOKEN;
    const endpoints = [
      `${serverUrl}/message/download-media`,           // UazAPI moderna
      `${serverUrl}/message/getMedia/${msgId}`,
      `${serverUrl}/getMessageMedia/${msgId}`,
      `${serverUrl}/download/media/${msgId}`,
    ];
    for (const url of endpoints) {
      try {
        const isPost = url.endsWith('/download-media');
        const opts = isPost
          ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'token': token }, body: JSON.stringify({ id: msgId }) }
          : { headers: { 'token': token } };
        const r = await fetch(url, opts);
        if (r.ok) {
          const ctype = r.headers.get('content-type') || '';
          if (ctype.includes('application/json')) {
            const data = await r.json();
            if (data.url) return data.url;
            if (data.fileURL) return data.fileURL;
            if (data.mediaUrl) return data.mediaUrl;
            if (data.base64) return `data:${data.mimetype || msg.mimetype || 'image/jpeg'};base64,${data.base64}`;
            if (data.data) return `data:${data.mimetype || msg.mimetype || 'image/jpeg'};base64,${data.data}`;
            console.log("[Media] endpoint", url, "ok mas resposta sem url/base64. keys:", Object.keys(data).join(','));
          } else if (ctype.startsWith('image/')) {
            // Resposta binaria direta
            const buf = await r.arrayBuffer();
            const b64 = Buffer.from(buf).toString('base64');
            return `data:${ctype};base64,${b64}`;
          }
        } else {
          console.log("[Media] endpoint", url, "status:", r.status);
        }
      } catch (e) {
        console.error("[Media] endpoint", url, "error:", e.message);
      }
    }
  }

  console.log("[Media] todos paths falharam. msg keys:", Object.keys(msg || {}).join(','));
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
         (msg.media && typeof msg.media === 'object' && !!msg.media.url) ||
         // UazAPI/dropepod format: msg.content.{mimetype,URL,JPEGThumbnail}
         (typeof msg.content?.mimetype === 'string' && msg.content.mimetype.startsWith('image/')) ||
         !!msg.content?.JPEGThumbnail ||
         (typeof msg.content?.URL === 'string' && msg.content.URL.startsWith('http'));
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

// Recovery best-effort do pending in-memory após cold-start Vercel.
// Quando Lucas responde com sim/outra/depois/foto e o Map zerou, busca produto
// recente em awaiting_approval ou error desse phone pra restaurar o contexto.
async function tryRecoverPending(phone) {
  const filter = `image_status=in.(awaiting_approval,error)&metadata->>created_by_phone=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=1&select=id,name,image_status,created_at,metadata`;
  const rows = await sbGet('drope_products', filter);
  const product = rows[0];
  if (!product) return null;
  const meta = product.metadata || {};
  const mode = product.image_status === 'error' ? 'art_review_failed' : 'art_review';
  return {
    mode,
    productId: product.id,
    fullName: product.name,
    attempts: meta.last_art_attempt || 1,
    brand: meta.brand,
    model: meta.model || '',
    flavor: meta.flavor_en || meta.flavor_pt,
    cores: meta.cores_predominantes,
    deviceVisual: meta.device_visual,
    productCreatedAt: product.created_at, // pra getPending decidir se override é válido
  };
}

// ============ FLUXO CADASTRO (LUCAS) — 2 fotos: caixa + pod ============
async function handleAdminLucas(phone, msg, body) {
  const msgId = msg.id || msg.messageId || msg.key?.id;
  console.log("[handleAdminLucas] phone:", phone.slice(0, 6) + "***", "msgId:", msgId, "type:", msg.type || 'text');

  // FIX MAIO/2026 — REMOVIDO o dedup primário por msgId aqui. O dedup global top-level
  // (no entry do webhook, linha ~10660) já marca msgId no Map seenMessageIds via alreadySeen().
  // Quando handleAdminLucas chamava alreadySeen(msgId) DE NOVO, o ID ja estava marcado pela
  // chamada anterior, retornava true e MATAVA todas as mensagens reais do Andrade.
  // Sintoma: "Motoboys briefing" e qualquer texto novo do admin nunca chegavam aos handlers.

  const hasImage = isImageMessage(msg);
  const text = asString(msg.text) || asString(msg.content) || asString(msg.caption);

  // Dedup secundário por conteúdo (10s window). Pega casos onde UazAPI manda
  // 2 eventos com msgIds diferentes pro mesmo input do Lucas.
  // FIX TARDE 9 BUG 1: incluir fingerprints do formato UazAPI (msg.content.mediaKey,
  // msg.content.URL, msg.content.JPEGThumbnail.slice). Antes só lia formato Baileys
  // (msg.imageMessage.fileSha256) que UazAPI não usa → sig de foto era sempre `img:` ou
  // `img:${msgId}`, e quando UazAPI duplicava com msgId diferente, dedup falhava.
  const imgFingerprint = hasImage
    ? (msg.content?.mediaKey?.slice(0, 24) ||
       msg.content?.URL?.slice(-40) ||
       (typeof msg.content?.JPEGThumbnail === 'string' ? msg.content.JPEGThumbnail.slice(0, 32) : '') ||
       msg.imageMessage?.fileSha256 ||
       msg.imageMessage?.mediaKey ||
       '')
    : '';
  const contentSig = hasImage
    ? `img:${imgFingerprint || msgId || ''}`
    : `txt:${(text || '').trim().slice(0, 60).toLowerCase()}`;
  // FIX 07/05/2026 (Andrade) — Skip dedup pra comandos de art_review.
  // Andrade aprova varias artes em sequencia mandando "aprova" varias vezes em <15s.
  // Dedup TTL 15s estava bloqueando do 2o em diante. Cada "aprova" precisa ser unica
  // pra avançar pro proximo produto pendente.
  const _isArtReviewCmd = !hasImage && (text || '').trim().length > 0 &&
    /^(aprova|aprovar|aprovo|aprova\s+todos|aprova\s+tudo|sim|ok|publica|manda|outra|proxima|próxima|de\s+novo|gera\s+de\s+novo|depois|mais\s+tarde|pra\s+depois|cancela|sai|rejeita|rejeitar|descarta|lixo|ruim)$/i.test((text || '').trim());
  if (!_isArtReviewCmd && alreadySeenContent(phone, contentSig)) {
    console.log("[handleAdminLucas] ignored duplicate content (in-mem):", contentSig);
    return;
  }
  // Dedup terciário (cross-instance Vercel). Custa ~50-150ms mas pega o caso
  // de cold-start onde 2 invocações simultâneas pegam instances diferentes.
  // FIX TARDE 7 BUG 2: TTL 5→15s. UazAPI às vezes reenvia evento >5s depois, passando pelo
  // dedup persistente antigo e gerando preview duplicado (sintoma reportado pelo Andrade).
  if (!_isArtReviewCmd && await alreadySeenContentPersistent(phone, contentSig, 15)) {
    console.log("[handleAdminLucas] ignored duplicate content (db):", contentSig);
    return;
  }

  // ========== COMANDOS DE TEXTO ==========
  if (!hasImage) {
    console.log('[admin-router] text:', JSON.stringify((text || '').slice(0, 80)));

    // FLC FASE 2 — Pricing do batch tem prioridade absoluta (user tá no flow de preço).
    try {
      const _pendingP = await getPending(phone);
      const consumed = text && await tryHandleBatchPricing(phone, msg, body, text, _pendingP);
      if (consumed) { console.log('[admin-router] consumed by tryHandleBatchPricing'); return; }
    } catch (e) { console.warn('[FLC] tryHandleBatchPricing:', e.message); }

    // FLC FASE 2 — Comandos de lote (lote / fechar lote / cancela lote).
    try {
      const _pendingB = await getPending(phone);
      const consumed = text && await tryHandleBatchCommand(phone, msg, body, text, _pendingB);
      if (consumed) { console.log('[admin-router] consumed by tryHandleBatchCommand'); return; }
    } catch (e) { console.warn('[FLC] tryHandleBatchCommand:', e.message); }

    // BALANÇO 07/05/2026 — Comandos de balanço (balanço / fechar balanço / aplica / edita N qty / cancela).
    try {
      const _pendingI = await getPending(phone);
      const consumed = text && await tryHandleInventoryCommand(phone, msg, body, text, _pendingI);
      if (consumed) { console.log('[admin-router] consumed by tryHandleInventoryCommand'); return; }
    } catch (e) { console.warn('[BAL] tryHandleInventoryCommand:', e.message); }

    // FIX 10C (07/05/2026 - Andrade) — comando 'sabor N: <texto>' completa foto sem sabor.
    // Quando Vision detecta marca+modelo mas falha no sabor (foto borrada), salva como
    // unidentified_flavor. Andrade pode completar com 'sabor 5: Strawberry Kiwi' que cria
    // o produto com brand/model do Vision + flavor que ele digitou.
    try {
      const sm = (text || '').trim().match(/^sabor\s+(\d+)\s*[:=]?\s*(.+)$/i);
      if (sm) {
        const photoIdx = parseInt(sm[1]);
        const flavorText = sm[2].trim();
        if (await tryHandleManualFlavor(phone, msg, body, photoIdx, flavorText)) {
          console.log('[admin-router] consumed by tryHandleManualFlavor');
          return;
        }
      }
    } catch (e) { console.warn('[FIX10C] manual flavor:', e.message); }

    // TIER 2 (08/05/2026 - Andrade) — comandos de edição de produto via WhatsApp:
    // 'preço NOME 89.90', 'editar NOME campo valor', 'desfaz lote'.
    try {
      if (text && await tryHandlePriceCommand(phone, msg, body, text)) {
        console.log('[admin-router] consumed by tryHandlePriceCommand');
        return;
      }
    } catch (e) { console.warn('[TIER2] price:', e.message); }
    try {
      if (text && await tryHandleEditCommand(phone, msg, body, text)) {
        console.log('[admin-router] consumed by tryHandleEditCommand');
        return;
      }
    } catch (e) { console.warn('[TIER2] edit:', e.message); }
    try {
      if (text && await tryHandleUndoBatch(phone, msg, body, text)) {
        console.log('[admin-router] consumed by tryHandleUndoBatch');
        return;
      }
    } catch (e) { console.warn('[TIER2] undo:', e.message); }

    // FLC FASE 1 — Comando "zerar estoque" tem PRIORIDADE absoluta entre os handlers de texto.
    // Comando claro do admin nunca pode ser confundido com correção/briefing/cadastro.
    try {
      const _pendingZ = await getPending(phone);
      const consumed = text && await tryHandleZeroStock(phone, msg, body, text, _pendingZ);
      if (consumed) { console.log('[admin-router] consumed by tryHandleZeroStock'); return; }
    } catch (e) { console.warn('[FLC] tryHandleZeroStock:', e.message); }

    // MOTOBOY V2 — Comandos admin: motoboy add/remove/list, corrida #N, corridas
    try {
      const _pendingM = await getPending(phone);
      console.log('[admin-router] entering tryHandleMotoboyAdminCommand. GRUPO_MOTOBOY_JID set:', !!GRUPO_MOTOBOY_JID);
      const consumed = text && await tryHandleMotoboyAdminCommand(phone, msg, body, text, _pendingM);
      if (consumed) { console.log('[admin-router] consumed by tryHandleMotoboyAdminCommand'); return; }
    } catch (e) { console.warn('[motoboy admin]', e.message); }

    // MOTOBOY V2 — Lifecycle no PRIVADO (motoboy manda "saí"/"entreguei"/"cancelo" direto pro bot,
    // sem precisar ir no grupo). Funciona se phone do remetente tem corrida ativa como motoboy.
    try {
      if (text) {
        const cmdLifecycle = _motoboyDetectComando(text);
        if (cmdLifecycle) {
          const moto = await _motoboyGetByPhone(phone);
          if (moto) {
            await _motoboyHandleLifecycle(GRUPO_MOTOBOY_JID || phone, body, moto, cmdLifecycle, text);
            return;
          }
        }
      }
    } catch (e) { console.warn('[motoboy lifecycle priv]', e.message); }

    // OSSO 35 (FIX 3D) — Detecta correção de baixa errada do PDV.
    // Aciona ANTES de qualquer outro fluxo: se Andrade manda "errado, era X" / "não, era X",
    // bot reverte a baixa errada (do log) e aplica baixa no produto correto.
    // Só ativa se houver log recente (30min) sem correção. Senão, deixa fluxo normal.
    try {
      if (text && await tryHandleCorrection(phone, msg, body, text)) return;
    } catch (e) { console.warn('[FIX 3D] tryHandleCorrection:', e.message); }

    // OSSO 33 — Resposta a briefing pendente tem prioridade quando NÃO é comando admin claro.
    // tryHandleBriefingResponse retorna true se consumiu (já mandou resposta).
    try {
      if (text && await tryHandleBriefingResponse(phone, text, body)) return;
    } catch (e) { console.warn('[osso33] tryHandleBriefingResponse:', e.message); }

    let pending = await getPending(phone);
    const lower = text.toLowerCase().trim();

    // Recovery: se não tem pending in-mem mas Lucas tá respondendo comando típico
    // de art_review (sim/outra/depois) ou /aprova/etc, busca no banco pra restaurar.
    if (!pending && (lower === 'sim' || lower === 'outra' || lower === 'depois' || lower === 'aprova' || lower === 'aprovar' || lower === 'mais tarde' || lower === 'pra depois')) {
      const recovered = await tryRecoverPending(phone);
      if (recovered) {
        await setPending(phone, recovered);
        pending = recovered;
        console.log('[recovery] restored pending for productId:', recovered.productId, 'mode:', recovered.mode);
      }
    }

    // CANCELA — funciona em qualquer pending. FIX 07/05/2026: mensagem contextual por modo.
    if (pending && (lower.includes('cancela') || lower.includes('desisto') || lower === 'sai')) {
      await clearPending(phone);
      let cancelMsg = '✅ cancelado.';
      if (pending.mode === 'batch_active') {
        cancelMsg = `✅ Lote cancelado. ${pending.fotoCount || 0} fotos já processadas ficaram cadastradas (status=pending). Use o Admin Hub pra revisar.`;
      } else if (pending.mode === 'batch_pricing') {
        cancelMsg = '✅ Cancelado. Os novos ficaram em pending no Admin Hub.';
      } else if (pending.mode === 'stock_entry') {
        cancelMsg = `✅ Cancelado. ${pending.fullName || 'estoque'} não foi mexido.`;
      } else if (pending.mode === 'awaiting_zero_confirm') {
        cancelMsg = '✅ Cancelado. Estoque inalterado.';
      }
      await sendText(phone, cancelMsg, body);
      return;
    }

    // FLUXO STOCK_ENTRY (OSSO 24, 01/05/2026) — 2 etapas:
    //   step='awaiting_confirm'  → "é esse mesmo?" sim/não
    //   step='awaiting_qty'      → "quantos chegaram?" número (1-999)
    // Backwards-compat: pendings antigos sem step seguem como awaiting_qty.
    if (pending?.mode === 'stock_entry') {
      // Sair do fluxo
      if (lower === 'novo' || lower === 'diferente' || lower === 'outro' || lower === 'nao' || lower === 'não' || lower === 'n') {
        // Quem responde "não" volta a poder mandar foto que cadastra como NOVO.
        // Limpamos pending e a próxima foto cai no flow de cadastro normal.
        await clearPending(phone);
        const reason = (lower === 'nao' || lower === 'não' || lower === 'n')
          ? `não é esse. *${pending.fullName}* não foi mexido.`
          : `sem entrada no *${pending.fullName}*.`;
        await sendText(phone, `✅ ${reason}\n\n• manda foto de novo — cadastra como novo produto\n• 'cadastra' — flow formal`, body);
        return;
      }

      const step = pending.step || 'awaiting_qty'; // pendings antigos pulavam direto pra qty

      // STEP 1 — confirmação SIM/NÃO
      if (step === 'awaiting_confirm') {
        const isYes = ['sim', 'si', 's', 'isso', 'isso mesmo', 'eh isso', 'é isso', 'é esse', 'eh esse', 'esse mesmo', 'beleza', 'ok', 'fechado', 'positivo', 'aham', '1', 'y', 'yes'].includes(lower);
        if (isYes) {
          pending.step = 'awaiting_qty';
          await setPending(phone, pending);
          await sendText(phone, `📦 *${pending.fullName}* — quantos chegaram?\n\n• digita só o número (ex: 10)\n• 'cancela' — para`, body);
          return;
        }
        // Resposta inesperada → reforça opções (não trata como qty na confirmação)
        await sendText(phone,
          `🦎 esse é o *${pending.fullName}* que tá no estoque (${pending.currentStock || 0} un). é esse mesmo?\n\n• 'sim' — confirma\n• 'não' — outro produto\n• 'cancela' — para`,
          body);
        return;
      }

      // STEP 2 — quantidade
      const qtyMatch = lower.match(/^(\d{1,4})$/);
      if (qtyMatch) {
        const qty = parseInt(qtyMatch[1], 10);
        if (qty <= 0 || qty > 999) {
          await sendText(phone, "⚠️ quantidade precisa ser entre 1 e 999.\n\n• digita a qtd\n• 'novo' — outro produto\n• 'cancela' — para", body);
          return;
        }
        const oldQty = pending.currentStock || 0;
        const newQty = oldQty + qty;
        await sbUpdate('drope_products', `id=eq.${pending.productId}`, { qty_available: newQty });
        await clearPending(phone);
        await sendText(phone,
          `✅ +${qty} *${pending.fullName}*\n\nestoque: ${oldQty} → ${newQty}\n\n• manda outra foto — outro produto\n• 'estoque' — ver tudo`,
          body);
        return;
      }
      // Resposta inesperada na qty
      await sendText(phone, `💬 quantos chegaram de *${pending.fullName}*?\n\n• digita só o número (ex: 10)\n• 'novo' — outro produto\n• 'cancela' — para`, body);
      return;
    }

    // FIX 07/05/2026 (Andrade) — 'aprova todos' aprova TODAS as awaiting_approval em loop.
    // Atalho pra quando Andrade tem fila de artes e nao quer aprovar uma a uma.
    if (pending?.mode === 'art_review' && (lower === 'aprova todos' || lower === 'aprova tudo' || lower === 'aprovar todos' || lower === 'aprovar tudo' || lower === 'todas')) {
      const allPending = await sbGet('drope_products',
        `image_status=eq.awaiting_approval&hidden=eq.false&select=id,name,metadata&order=id.asc&limit=50`);
      if (!Array.isArray(allPending) || allPending.length === 0) {
        await clearPending(phone);
        await sendText(phone, '✅ nenhuma arte aguardando aprovacao.', body);
        return;
      }
      let ok = 0, err = 0;
      for (const p of allPending) {
        const artUrl = (p.metadata || {}).pending_art_url;
        if (!artUrl) { err++; continue; }
        try {
          await sbUpdate('drope_products', `id=eq.${p.id}`, { image_url: artUrl, image_status: 'ok' });
          ok++;
        } catch (e) { err++; console.warn('[aprova-todos]', p.id, e.message); }
      }
      await clearPending(phone);
      await sendText(phone, `✅ *${ok} artes aprovadas* de uma vez 🦎${err > 0 ? `\n⚠️ ${err} com erro` : ''}\n\nJa aparecem no app.`, body);
      return;
    }

    // FLUXO APROVAÇÃO DE ARTE — comandos texto durante mode 'art_review' / 'art_review_failed'
    if (pending?.mode === 'art_review' || pending?.mode === 'art_review_failed') {
      // 'depois' funciona em ambos os modes — Lucas resolve no /admin
      if (lower === 'depois' || lower === 'mais tarde' || lower === 'pra depois') {
        await sbUpdate('drope_products', `id=eq.${pending.productId}`, { image_status: 'pending_regeneration' });
        await clearPending(phone);
        await sendText(phone, `✅ arte de *${pending.fullName}* fica pendente.\n\nresolve no Admin Hub quando puder.\n\n• 'pendentes' — ver lista`, body);
        return;
      }
      // 'cancela' = mesmo que 'depois' (não desfaz cadastro, só sai do flow de arte)
      if (lower === 'cancela' || lower === 'sai') {
        await sbUpdate('drope_products', `id=eq.${pending.productId}`, { image_status: 'pending_regeneration' });
        await clearPending(phone);
        await sendText(phone, `✅ pendente: arte de *${pending.fullName}*\n\n• 'pendentes' — lista`, body);
        return;
      }
      // FIX 07/05/2026: 'rejeita' descarta a arte atual e marca needs_manual_photo
      // (Andrade vai mandar foto manual depois). Diferente de 'depois' (que so adia).
      if (lower === 'rejeita' || lower === 'rejeitar' || lower === 'descarta' || lower === 'lixo' || lower === 'ruim') {
        await sbUpdate('drope_products', `id=eq.${pending.productId}`, {
          image_status: 'needs_manual_photo',
          art_status: 'needs_manual_photo',
          metadata: { ...(pending.metadata || {}), pending_art_url: null },
        });
        await clearPending(phone);
        await sendText(phone, `❌ arte de *${pending.fullName}* descartada.\n\nManda uma foto da caixa que eu uso direto, ou:\n• 'pendentes' — ver lista`, body);
        return;
      }

      // Comandos exclusivos do mode 'art_review' (arte foi gerada com sucesso)
      if (pending.mode === 'art_review') {
        // 'sim' → aprova: arte vira oficial
        if (lower === 'sim' || lower === 'ok' || lower === 'aprova' || lower === 'aprovar' || lower === 'beleza' || lower === 'boa' || lower === 'aprovo' || lower === 'publica' || lower === 'manda') {
          // Lê pending_art_url do banco (mais confiável que do pending em-memória)
          const rows = await sbGet('drope_products', `id=eq.${pending.productId}&select=metadata&limit=1`);
          const artUrl = rows[0]?.metadata?.pending_art_url;
          if (!artUrl) {
            await sendText(phone, "⚠️ arte não foi salva.\n\n• 'outra' — tenta de novo\n• manda uma foto", body);
            return;
          }
          await sbUpdate('drope_products', `id=eq.${pending.productId}`, {
            image_url: artUrl,
            image_status: 'ok',
          });
          // Vídeo em background — não bloqueia resposta
          const videoSlug = slugify(pending.brand || 'pod', pending.model || '', pending.flavor || pending.fullName || 'video');
          fireBackgroundVideoGeneration(artUrl, videoSlug, phone, body, pending.fullName);

          // FIX 07/05/2026 (Andrade) — Avança automaticamente pra próxima arte pendente.
          // Antes: clearPending + msg "outras pendencias". Agora: se tem mais artes
          // awaiting_approval, mostra a próxima sem precisar Andrade abrir admin.
          const restantes = await sbGet('drope_products',
            `image_status=eq.awaiting_approval&hidden=eq.false&id=neq.${pending.productId}&select=id,name,metadata&order=id.asc&limit=20`);
          if (Array.isArray(restantes) && restantes.length > 0) {
            const next = restantes[0];
            const nextMeta = next.metadata || {};
            const nextArtUrl = nextMeta.pending_art_url;
            if (nextArtUrl) {
              await setPending(phone, {
                mode: 'art_review',
                productId: next.id,
                fullName: next.name,
                attempts: 1,
                brand: nextMeta.brand,
                model: nextMeta.model,
                flavor: nextMeta.flavor_en || nextMeta.flavor_pt,
              });
              const qcScore = nextMeta.qc_score;
              const qcLine = qcScore != null ? `🎯 QC=${Math.round(qcScore*10)/10}/10` : '';
              const restantesCount = restantes.length;
              // FIX 07/05/2026 (Andrade) — manda nome do produto NO TEXTO antes da imagem.
              // Antes mandava imagem com caption mas WhatsApp Web nao renderiza bem
              // → Andrade ficava sem saber qual produto estava aprovando.
              await sendText(phone,
                `✅ *${pending.fullName}* aprovado 🦎\n\n` +
                `📦 *Próxima (${restantesCount} na fila):*\n` +
                `🎨 ${next.name}${qcLine ? '\n' + qcLine : ''}`,
                body);
              await sendImage(phone, nextArtUrl, '', body);
              await sendText(phone,
                "*Responde:*\n" +
                "✅ *aprova* — publica no catálogo\n" +
                "🔄 *outra* — gera de novo\n" +
                "📸 *manda foto* — uso a tua imagem\n" +
                "⏰ *depois* — fica pendente\n" +
                "❌ *rejeita* — descarta\n\n" +
                "🚀 *aprova todos* — publica tudo de uma vez",
                body);
              return;
            }
          }
          // Sem mais pendentes
          await clearPending(phone);
          await sendText(phone, `✅ *${pending.fullName}* aprovado 🦎\n\n🎉 Sem mais artes na fila.\n\n• 'pendentes' — outras pendencias\n• 'estoque' — ver tudo`, body);
          return;
        }
        // 'outra' → gera nova arte INLINE (FIX TARDE 7 — antes era fire-and-forget que falhava)
        if (lower === 'outra' || lower === 'proxima' || lower === 'próxima' || lower === 'de novo' || lower === 'gera de novo') {
          const nextAttempt = (pending.attempts || 1) + 1;
          if (nextAttempt > 6) {
            await sendText(phone, "⚠️ vários erros de geração.\n\n• 'sim' — usa última versão\n• manda uma foto\n• 'depois' — resolve depois", body);
            return;
          }
          await sbUpdate('drope_products', `id=eq.${pending.productId}`, { image_status: 'generating' });
          await sendText(phone, `🎬 tentativa ${nextAttempt}\n\naguenta ~30s...`, body);
          // Roda inline — try/catch garante feedback mesmo se Grok/Storage falhar
          try {
            await runArtGeneration(pending.productId, phone, nextAttempt);
          } catch (e) {
            console.error('[art_review outra] runArtGeneration EXCEPTION productId=' + pending.productId + ':', e.message, e.stack);
            await sbUpdate('drope_products', `id=eq.${pending.productId}`, { image_status: 'error' });
            await sendText(phone,
              `⚠️ *erro na tentativa ${nextAttempt}*\n\n` +
              "🔄 *outra* — tenta de novo\n" +
              "📸 *manda foto* — uso a tua\n" +
              "⏰ *depois* — resolve depois",
              body);
          }
          return;
        }
      }

      // Default em ambos os modes: instrução
      const helpMsg = pending.mode === 'art_review'
        ? "*Responde:*\n" +
          "✅ *aprova* — publica no app\n" +
          "🔄 *outra* — gera de novo\n" +
          "📸 *manda foto* — uso a tua\n" +
          "⏰ *depois* — fica pendente\n" +
          "❌ *rejeita* — descarta\n\n" +
          "🚀 *aprova todos* — publica tudo de uma vez"
        : "*Arte falhou.* Responde:\n" +
          "📸 *manda foto* — uso a tua\n" +
          "⏰ *depois* — resolvo no Admin Hub";
      await sendText(phone, helpMsg, body);
      return;
    }

    // GATILHO CADASTRO LEGACY — DEPRECATED 07/05/2026.
    // Handler "continua_recomeca" tambem foi removido (era do fluxo cadastro_3photos legacy).
    // Antes iniciava fluxo cadastro_3photos (1 produto por vez via state machine).
    // Hoje: batch (lote) processa tudo de uma vez. Redireciona o usuario.
    if (lower === 'cadastra' || lower === 'cadastrar' || lower === 'novo') {
      await sendText(phone, "📸 cadastro 1-by-1 foi descontinuado. Usa *lote* agora:\n\n• manda 'lote' pra começar\n• manda quantas fotos quiser\n• manda 'fechar lote' quando terminar", body);
      return;
    }

    // GATILHO GERAR ARTE — Recovery manual quando arte não chegou (BUG 1 fix tarde 7).
    // Pega o produto mais recente em pending_art|pending_regeneration|error|generating e
    // dispara runArtGeneration inline. Pode ser usado pra reprocessar produtos travados sem
    // precisar bater em /api/webhook?action=generate_pending pelo curl.
    if (!pending && (lower === 'gerar arte' || lower === 'gera arte' || lower === 'gerar' ||
                     lower === 'gera' || lower === 'arte' || lower === 'gerar pendente')) {
      const pendingArt = await sbGet('drope_products',
        `image_status=in.(pending_art,pending_regeneration,error,generating)&order=created_at.desc&limit=1`);
      if (!pendingArt.length) {
        await sendText(phone, "✅ nenhum produto pendente 🦎\n\n• 'lote' — cadastra novos\n• 'estoque' — ver tudo", body);
        return;
      }
      const product = pendingArt[0];
      const meta = product.metadata || {};
      const nextAttempt = (meta.last_art_attempt || 0) + 1;
      await sbUpdate('drope_products', `id=eq.${product.id}`, { image_status: 'generating' });
      await sendText(phone, `🎬 gerando arte: *${product.name}*\n\ntentativa ${nextAttempt} ✦ aguenta ~30s...`, body);
      try {
        await runArtGeneration(product.id, phone, nextAttempt);
      } catch (e) {
        console.error('[gerar-arte cmd] runArtGeneration EXCEPTION productId=' + product.id + ':', e.message, e.stack);
        await sbUpdate('drope_products', `id=eq.${product.id}`, { image_status: 'error' }).catch(() => {});
        await sendText(phone, `⚠️ erro na geração: ${e.message}\n\n• 'gerar arte' — tenta de novo\n• 'depois' — resolve mais tarde\n• ou usa /admin gallery`, body);
      }
      return;
    }

    // GATILHO DIVULGAR — Lucas pede mensagem pronta pra copiar/colar (FEATURE 2)
    // Variações: 'divulgar', 'divulga', 'divulgação' → v1; 'divulgar 2', 'divulga 2' → v2
    if (!pending && (lower === 'divulgar' || lower === 'divulga' || lower === 'divulgacao' || lower === 'divulgação' ||
                     lower === 'divulgar 1' || lower === 'divulga 1')) {
      const okProducts = await sbGet('drope_products', 'hidden=eq.false&image_status=eq.ok&select=id&limit=200');
      const count = okProducts.length;
      const countLine = count > 0 ? `${count} drops disponíveis no app agora.` : `pede pelo app, chega na sua mão:`;
      await sendText(phone, `🦎 *Drope — tabacaria com entrega*\n\nos melhores pods com o melhor preço de SP.\n${countLine}\n\n👉 drope-app.vercel.app\n\nou manda um oi que a gente te atende`, body);
      // 2ª msg só com o link puro (clicável e fácil de encaminhar isolado)
      await sendText(phone, "drope-app.vercel.app", body);
      return;
    }
    if (!pending && (lower === 'divulgar 2' || lower === 'divulga 2')) {
      await sendText(phone, "fala, tô vendendo pod com preço bom e entrega rápida.\n\nda uma olhada: drope-app.vercel.app 🦎", body);
      await sendText(phone, "drope-app.vercel.app", body);
      return;
    }
    // Lucas tentou começar novo cadastro mas tem arte pendente — avisa
    if ((pending?.mode === 'art_review' || pending?.mode === 'art_review_failed') &&
        (lower === 'cadastra' || lower === 'cadastrar' || lower === 'novo' || lower === 'chegou' || lower === 'entrada' || lower === 'abasteci')) {
      await sendText(phone,
        `⚠️ tem arte de *${pending.fullName}* esperando aprovação\n\nresolve essa primeiro:\n• 'sim' — aprova\n• 'outra' — gera de novo\n• manda foto — uso a tua\n• 'depois' — resolve no /admin`,
        body);
      return;
    }

    // GATILHO ABASTECIMENTO LEGACY — DEPRECATED 07/05/2026.
    // O fluxo de abastecimento (state machine separada) foi unificado no batch.
    // Hoje: 'lote' faz cadastro novo E reposicao (matched_existing soma qty).
    if (!pending && (
      lower === 'chegou' ||
      lower === 'chegou estoque' ||
      lower === 'chegou:' ||
      lower === 'entrada' ||
      lower === 'entrada:' ||
      lower === 'abasteci' ||
      lower === 'abastecer' ||
      lower === 'reabastecer' ||
      lower === 'repor' ||
      lower === 'reposicao' ||
      lower === 'reposição'
    )) {
      await sendText(phone, "📦 abastecimento agora é *lote* — mesmo fluxo:\n\n• manda 'lote'\n• manda fotos do que chegou (produtos cadastrados somam estoque automatico, novos viram cadastro)\n• 'fechar lote' quando terminar", body);
      return;
    }

    // FLUXO ABASTECIMENTO — comandos durante reposição
    if (pending?.mode === 'abastecimento') {
      // Mostrar preview ("pronto" / "fim" / "terminei")
      if (pending.step === 'awaiting_photos' && (lower === 'pronto' || lower === 'fim' || lower === 'terminei' || lower === 'preview' || lower === 'mostra')) {
        if (pending.identified.length === 0 && pending.unrecognized.length === 0) {
          await sendText(phone, "⚠️ nenhum produto identificado.\n\n• manda foto de algum pod\n• 'cancela' — para", body);
          return;
        }
        await buildAbastecimentoPreview(phone, pending, body);
        return;
      }

      // FASE DE CONFIRMAÇÃO — comandos avançados (MELHORIA 30/04 tarde 5)
      if (pending.step === 'awaiting_confirm') {
        // 'só entrada' / 'só estoque' — pula desconhecidos, aplica só os cadastrados
        if (lower === 'só entrada' || lower === 'so entrada' || lower === 'só estoque' || lower === 'so estoque' || lower === 'só os cadastrados' || lower === 'so os cadastrados') {
          await applyAbastecimento(phone, pending, body);
          return;
        }

        // 'sim N' / 'cadastra N' / 'cadastrar N' — cadastra desconhecido específico
        const cadastraMatch = lower.match(/^(?:sim|cadastra|cadastrar|cadastro)\s+(\d+)$/);
        if (cadastraMatch) {
          const n = parseInt(cadastraMatch[1]);
          if (pending.unrecognized.length === 0) {
            await sendText(phone, "✅ sem produtos novos.\n\n• 'sim' — aplica entrada no estoque\n• 'cancela' — para", body);
            return;
          }
          if (n < 1 || n > pending.unrecognized.length) {
            await sendText(phone, `⚠️ linha ${n} não existe (tem ${pending.unrecognized.length} produtos).\n\n• 'sim N' — N entre 1 e ${pending.unrecognized.length}\n• 'cancela' — para`, body);
            return;
          }
          await registerUnrecognizedFromAbastecimento(phone, pending, n - 1, body);
          // Após cadastrar 1, volta ao preview pra Lucas decidir os outros / aplicar entrada
          if (pending.unrecognized.length > 0 || pending.identified.length > 0) {
            await buildAbastecimentoPreview(phone, pending, body);
          } else {
            await clearPending(phone);
          }
          return;
        }

        // 'sim' / 'ok' / 'confirma' — cadastra TODOS os desconhecidos (se houver) + aplica entrada
        if (lower === 'sim' || lower === 'ok' || lower === 'confirma' || lower === 'confirmar' || lower === 'sim todos' || lower === 'cadastra todos' || lower === 'cadastrar todos') {
          if (pending.unrecognized.length > 0) {
            await registerUnrecognizedFromAbastecimento(phone, pending, 'all', body);
          }
          if (pending.identified.length > 0) {
            await applyAbastecimento(phone, pending, body);
          } else {
            await clearPending(phone);
          }
          return;
        }

        // Ajuste de quantidade: "1 +3" / "2=5" / "linha 1: +3" — só cadastrados (identified)
        const adjMatch = lower.match(/^(?:linha\s+)?(\d+)\s*(?:[:=\s]\s*\+?|\+)\s*(\d+)$/);
        if (adjMatch) {
          const lineNum = parseInt(adjMatch[1]);
          const newQty = parseInt(adjMatch[2]);
          if (lineNum < 1 || lineNum > pending.identified.length) {
            await sendText(phone, `⚠️ linha ${lineNum} não existe (tem ${pending.identified.length} cadastrados).\n\n• 'sim N' — cadastrar novo\n• 'cancela' — para`, body);
            return;
          }
          if (newQty < 1 || newQty > 200) {
            await sendText(phone, "⚠️ quantidade inválida (1 a 200).\n\n• manda um número válido\n• 'cancela' — para", body);
            return;
          }
          pending.identified[lineNum - 1].qty = newQty;
          await setPending(phone, pending);
          await sendText(phone, `✅ linha ${lineNum}: +${newQty}`, body);
          await buildAbastecimentoPreview(phone, pending, body);
          return;
        }

        // Default em awaiting_confirm — orienta opções
        const opts = [];
        if (pending.unrecognized.length > 0) {
          opts.push("'sim' (cadastra novos + entrada)", "'sim N' (cadastra só o novo N)", "'só entrada' (pula novos)");
        } else {
          opts.push("'sim' pra aplicar");
        }
        if (pending.identified.length > 0) opts.push("'N +M' pra ajustar qtd");
        opts.push("'cancela'");
        await sendText(phone, "responde: " + opts.join(' / '), body);
        return;
      }

      // Default em awaiting_photos
      await sendText(phone, "📸 esperando fotos do que chegou.\n\nmanda quantas precisar.\n\n• 'pronto' — vai pro preview\n• 'cancela' — para", body);
      return;
    }

    // FLUXO CADASTRO — comandos durante o cadastro
    if (pending?.mode === 'cadastro_3photos') {
      // 'só essa' no awaiting_pod → pula pod, pede barcode digitado
      if (pending.step === 'awaiting_pod' && (lower.includes('só essa') || lower.includes('so essa') || lower.includes('só isso') || lower.includes('so isso') || lower === 'finaliza' || lower === 'pula')) {
        pending.photos.pod = null;
        pending.step = 'awaiting_barcode_text';
        await setPending(phone, pending);
        await sendText(phone, "✅ só caixa ok\n\n*código de barras*\n\ndigita o código (só números, 8 a 13 dígitos).\n\n• 'pula' — cadastra sem\n• 'cancela' — para", body);
        return;
      }

      // awaiting_barcode_text — Lucas digita o número do código de barras
      if (pending.step === 'awaiting_barcode_text') {
        if (lower === 'pula' || lower === 'sem' || lower === 'sem barcode' || lower === 'sem código' || lower === 'sem codigo') {
          pending.barcode = null;
          await setPending(phone, pending);
          await sendText(phone, "✅ sem barcode\n\n📦 processando...", body);
          await processCadastro3Photos(phone, pending, body);
          return;
        }
        // Aceita: dígitos puros, ou "codigo XXX", ou "barcode XXX", etc
        const trimmed = text.trim();
        let digits = null;
        const kwMatch = trimmed.match(/(?:c[óo]digo|barcode|ean|c[óo]d)\b[^\d]*(\d{8,20})\b/i);
        if (kwMatch) digits = kwMatch[1];
        else {
          const onlyDigits = trimmed.replace(/\D/g, '');
          if (/^\d{8,20}$/.test(onlyDigits) && Math.abs(onlyDigits.length - trimmed.replace(/\s/g, '').length) <= 2) {
            digits = onlyDigits;
          }
        }
        if (!digits) {
          await sendText(phone, "⚠️ código inválido (8 a 13 números).\n\n• digita só os números do código\n• 'pula' — cadastra sem\n• 'cancela' — para", body);
          return;
        }
        pending.barcode = digits;
        await setPending(phone, pending);
        const checksumOk = validateBarcodeChecksum(digits);
        const note = checksumOk
          ? `código ${digits} ✓\nprocessando...`
          : `código ${digits} ⚠️ (checksum não bate, vou aceitar mas confere depois pelo /admin se quiser)\nprocessando...`;
        await sendText(phone, note, body);
        await processCadastro3Photos(phone, pending, body);
        return;
      }
      // Correção de barcode pelo Lucas durante awaiting_confirm.
      // Aceita: "codigo correto X", "código certo X", "barcode X", "ean correto X",
      // "muda o codigo pra X", "novo codigo X" e variações. Também aceita 8-20 dígitos puros.
      if (pending.step === 'awaiting_confirm') {
        const trimmed = text.trim();
        let newBarcode = null;
        // Padrão 1: keyword (codigo|barcode|ean|cod) + dígitos depois
        const kwMatch = trimmed.match(/(?:c[óo]digo|barcode|ean|c[óo]d)\b[^\d]*(\d{8,20})\b/i);
        if (kwMatch) newBarcode = kwMatch[1];
        // Padrão 2: só dígitos puros (Lucas digitou o código direto, sem prefixo)
        else {
          const pureMatch = trimmed.match(/^(\d{8,20})$/);
          if (pureMatch) newBarcode = pureMatch[1];
        }

        if (newBarcode) {
          pending.barcode = newBarcode;
          await setPending(phone, pending);
          const checksumOk = validateBarcodeChecksum(newBarcode);
          const note = checksumOk
            ? `barcode atualizado pra ${newBarcode} ✓`
            : `barcode atualizado pra ${newBarcode} ⚠️ (checksum não bate, confere se digitou os dígitos certos)`;
          await sendText(phone, note, body);
          await buildAndShowPreview(phone, pending, body);
          return;
        }
      }

      // Confirma preview (SIM)
      if (pending.step === 'awaiting_confirm' && (lower === 'sim' || lower === 'ok' || lower === 'confirma' || lower === 'confirmar')) {
        // FIX TARDE 8 (BUG SIM REINICIA): valida confirm_token. Se sumiu ou tá velho (>5min),
        // pending corrompeu entre preview e SIM — mostra preview de novo em vez de avançar
        // pra estado inválido. Antes esse caso virava "SIM reinicia fluxo" silenciosamente.
        const tokenAge = pending.confirm_token_at ? (Date.now() - pending.confirm_token_at) : Infinity;
        if (!pending.confirm_token || tokenAge > 5 * 60 * 1000) {
          console.warn(`[awaiting_confirm SIM] confirm_token ausente ou velho (age=${tokenAge}ms) — re-mostra preview`);
          if (pending.brand && pending.flavor) {
            await sendText(phone, "⚠️ cadastro perdeu o estado.\n\nmostrando preview de novo:", body);
            await buildAndShowPreview(phone, pending, body);
          } else {
            await sendText(phone, "⚠️ cadastro corrompeu.\n\n• 'cadastra' — recomeça", body);
            await clearPending(phone);
          }
          return;
        }
        if (pending.priceFromRule) {
          // Já tem preço da rule, finaliza direto
          await sendText(phone, `✅ usando R$ ${(pending.priceFromRule / 100).toFixed(2).replace('.', ',')}\n\n(regra: ${pending.brand} ${pending.model})\n\n📦 cadastrando...`, body);
          await finalizeCadastro(phone, pending, pending.priceFromRule, body);
          return;
        }
        // Sem rule: pergunta preço
        pending.step = 'awaiting_price';
        delete pending.confirm_token;  // token consumido
        await setPending(phone, pending);
        await sendText(phone, `💰 *preço do ${pending.brand} ${pending.model || ''}*\n\ndigita só o número (ex: 110 ou 110,50).\n\n(vira regra pra todos os sabores deste modelo)\n\n• 'cancela' — para`.trim(), body);
        return;
      }
      // FIX TARDE 7 BUG 3 — step awaiting_brand: Lucas digita a marca quando Vision falhou.
      if (pending.step === 'awaiting_brand') {
        let brandInput;
        if (lower === 'sem marca' || lower === 'generico' || lower === 'genérico') {
          brandInput = 'Genérico';
        } else {
          brandInput = text.trim().slice(0, 50);
          if (brandInput.length < 1) {
            await sendText(phone, "⚠️ marca vazia.\n\ndigita a *marca*.\n\n• ex: Elfbar, Hidden Hills, Ignite\n• 'sem marca' — cadastra sem\n• 'cancela' — para", body);
            return;
          }
        }
        pending.brand = brandInput;
        pending.fullName = `${brandInput} ${pending.model || ''} ${pending.flavor}`.replace(/\s+/g, ' ').trim();
        await setPending(phone, pending);
        // Se ainda não tem modelo, vai pra awaiting_model agora
        if (!pending.model) {
          pending.step = 'awaiting_model';
          await setPending(phone, pending);
          await sendText(phone, `✅ marca: *${brandInput}*\n\nagora o *modelo*\n\n• ex: MO20000, BC15K, One Gram Bar\n• 'sem modelo' — cadastra sem\n• 'cancela' — para`, body);
          return;
        }
        await buildAndShowPreview(phone, pending, body);
        return;
      }

      // Resposta com modelo manual (Vision não conseguiu ler)
      if (pending.step === 'awaiting_model') {
        // FIX TARDE 7 BUG 3: detecta se Lucas tá tentando corrigir a MARCA em vez do modelo.
        // Sintoma original: brand=UNKNOWN + Lucas responde "marca Sweet treatz" tentando corrigir
        // a marca. Antes esse texto virava o model. Agora detecta o prefixo e atualiza brand.
        const marcaMatch = text.match(/^\s*(?:marca|brand)\s+(.+)/i);
        if (marcaMatch) {
          pending.brand = marcaMatch[1].trim().slice(0, 50);
          pending.fullName = `${pending.brand} ${pending.model || ''} ${pending.flavor}`.replace(/\s+/g, ' ').trim();
          await setPending(phone, pending);
          await sendText(phone, `✅ marca: *${pending.brand}*\n\nagora o *modelo*\n\n• ex: MO20000, BC15K, One Gram Bar\n• 'sem modelo' — cadastra sem\n• 'cancela' — para`, body);
          return;
        }
        let modelInput;
        if (lower === 'sem modelo' || lower === 'sem' || lower === 'sem modelo mesmo') {
          modelInput = '';
        } else {
          modelInput = text.trim().slice(0, 50);
          if (modelInput.length < 1) {
            await sendText(phone, "⚠️ modelo vazio.\n\ndigita o *modelo*.\n\n• ex: MO20000, BC15K\n• 'sem modelo' — cadastra sem\n• 'cancela' — para", body);
            return;
          }
        }
        pending.model = modelInput;
        pending.fullName = `${pending.brand} ${modelInput} ${pending.flavor}`.replace(/\s+/g, ' ').trim();
        await buildAndShowPreview(phone, pending, body);
        return;
      }

      // Resposta de preço
      if (pending.step === 'awaiting_price') {
        const priceMatch = lower.match(/(\d{1,5}(?:[.,]\d{1,2})?)/);
        if (!priceMatch) {
          await sendText(phone, "⚠️ não entendi.\n\n• digita só o número (ex: 110 ou 110,50)\n• 'cancela' — para", body);
          return;
        }
        const priceReais = parseFloat(priceMatch[1].replace(',', '.'));
        if (priceReais <= 0 || priceReais > 100000) {
          await sendText(phone, "⚠️ preço fora do intervalo (0 a 100000).\n\n• digita um número válido\n• 'cancela' — para", body);
          return;
        }
        const priceCents = Math.round(priceReais * 100);
        await sendText(phone, `✅ regra salva: R$ ${priceReais.toFixed(2).replace('.', ',')}\n\npra *${pending.brand} ${pending.model || ''}*\n\n📦 cadastrando...`.trim(), body);
        await finalizeCadastro(phone, pending, priceCents, body);
        return;
      }
      // Qualquer outro texto durante cadastro
      const stepMsg = {
        awaiting_caixa:        "📸 1/2 ✦ to esperando a foto da CAIXA",
        awaiting_pod:          "📸 2/2 ✦ to esperando a foto do POD ('só essa' pra cadastrar só com a caixa)",
        awaiting_barcode_text: "digita o CÓDIGO DE BARRAS (só os números, 8 a 13 dígitos) ou 'pula' pra cadastrar sem.",
        awaiting_brand:        "responde a MARCA (ex: 'ELFBAR', 'Hidden Hills', 'Ignite') ou 'sem marca'.",
        awaiting_model:        "responde o MODELO (ex: 'MO20000', 'BC15K') ou 'sem modelo'. (pra corrigir a MARCA: digita 'marca XXX')",
        awaiting_confirm:      "responde 'sim' pra confirmar, 'codigo correto XXXXX' pra arrumar barcode, ou 'cancela'.",
        awaiting_price:        "responde só o preço (ex: 110 ou 110,50), ou 'cancela' pra desistir.",
      }[pending.step] || "to perdido. digita 'cancela' e começa de novo.";
      await sendText(phone, stepMsg, body);
      return;
    }

    // FLUXO LEGACY (2 fotos) — comportamento antigo, atalho mantido
    if (pending) {
      if (lower.includes('só essa') || lower.includes('so essa') || lower.includes('só isso') || lower.includes('so isso') || lower.includes('finaliza')) {
        await clearPending(phone);
        await sendText(phone, "📸 cadastrando só com a caixa...", body);
        await processProductRegistration(phone, pending.caixaUrl, null, pending.preComputedData, body);
        return;
      }
      // qualquer outro texto durante pendente legacy
      await sendText(phone, `📸 esperando foto do POD pra *${pending.fullName}*\n\n• manda a foto do pod\n• 'só essa' — usa só a caixa\n• 'cancela' — para`, body);
      return;
    }

    // Pendentes — TODOS os produtos sem arte oficial.
    // FIX 2 OSSO 27 (01/05/2026): bug "todos cadastrados com arte" era falso positivo.
    // Filtro antigo só pegava `hidden=true` + `image_url=null` → ignorava produtos
    // com arte pendente que estavam visíveis no app (ex: pending_pod_photo,
    // pending_art, awaiting_approval, needs_manual_photo). Agora cobre TODOS.
    if (text && (lower.includes('pendente') || lower.includes('sem foto') || lower.includes('pdv'))) {
      const pending = await sbGet('drope_products',
        'select=name,barcode,qty_available,created_via,image_status,art_status,image_url' +
        '&image_status=neq.ok&order=created_at.desc&limit=200');
      // Inclui também produtos com image_url NULL mesmo se image_status='ok' (defensivo)
      const nullImage = await sbGet('drope_products',
        'select=name,barcode,qty_available,created_via,image_status,art_status,image_url' +
        '&image_url=is.null&image_status=eq.ok&order=created_at.desc&limit=200');
      const all = [...pending, ...nullImage].filter((p, i, arr) =>
        arr.findIndex(x => x.name === p.name) === i
      );
      if (!all.length) {
        await sendText(phone, "✅ tudo certo 🦎\n\ntodos pods têm arte oficial no catálogo.\n\n• 'lote' — cadastra/abastece\n• 'estoque' — ver tudo", body);
        return;
      }
      // Categoriza por status pra Andrade ter clareza do que tá rolando
      const buckets = { awaiting_approval: [], pending_pod_photo: [], pending_art: [], pending_regeneration: [], needs_manual_photo: [], generating: [], error: [], outros: [] };
      for (const p of all) {
        if (p.image_status === 'awaiting_approval') buckets.awaiting_approval.push(p);
        else if (p.image_status === 'pending_pod_photo') buckets.pending_pod_photo.push(p);
        else if (p.image_status === 'generating') buckets.generating.push(p);
        else if (p.image_status === 'error') buckets.error.push(p);
        else if (p.image_status === 'pending_regeneration') buckets.pending_regeneration.push(p);
        else if (p.art_status === 'needs_manual_photo') buckets.needs_manual_photo.push(p);
        else if (p.image_status === 'pending_art') buckets.pending_art.push(p);
        else buckets.outros.push(p);
      }
      const lines = [`⚠️ ${all.length} pod${all.length > 1 ? 's' : ''} pendente${all.length > 1 ? 's' : ''}:`];
      const sectionList = (label, arr) => {
        if (!arr.length) return;
        lines.push('');
        lines.push(`*${label}* (${arr.length}):`);
        arr.slice(0, 8).forEach((p, i) => {
          const tag = p.created_via === 'pdv' ? ' ← pdv' : '';
          lines.push(`${i + 1}. ${p.name} (${p.qty_available || 0} un)${tag}`);
        });
        if (arr.length > 8) lines.push(`… +${arr.length - 8}`);
      };
      sectionList('🎨 esperando aprovação', buckets.awaiting_approval);
      sectionList('📸 esperando foto do pod', buckets.pending_pod_photo);
      sectionList('⚙️ gerando arte agora', buckets.generating);
      sectionList('🔄 regerar arte', buckets.pending_regeneration);
      sectionList('🆘 precisa foto manual', buckets.needs_manual_photo);
      sectionList('⏳ arte pendente', buckets.pending_art);
      sectionList('❌ erro na geração', buckets.error);
      sectionList('❓ outros', buckets.outros);
      lines.push('');
      lines.push("• abre /admin/pendentes pra resolver os com 📸 ou 🆘");
      lines.push("• abre /admin/gallery pra aprovar os com 🎨");
      await sendText(phone, lines.join('\n'), body);
      return;
    }

    // Estoque
    if (text && (lower.includes('estoque') || lower.includes('saldo'))) {
      const products = await sbGet('drope_products', 'select=name,qty_available,hidden,image_url&order=name');
      if (!products.length) {
        await sendText(phone, "📦 estoque vazio\n\n• 'lote' — começa cadastro/abastecimento", body);
        return;
      }
      const list = products.map(p => `${p.name}: ${p.qty_available || 0}${p.hidden ? ' (sem preço)' : ''}`).join('\n');
      await sendText(phone, `📦 *estoque atual*\n\n${list}\n\n• 'lote' — cadastra/abastece\n• 'pendentes' — sem foto`, body);

      // Avisa se tem pendentes do PDV
      const pendingCount = products.filter(p => p.hidden && !p.image_url).length;
      if (pendingCount > 0) {
        await sendText(phone, `⚠️ ${pendingCount} pod${pendingCount > 1 ? 's' : ''} sem foto.\n\n• 'pendentes' — ver lista`, body);
      }
      return;
    }

    await sendText(phone,
      "🦎 *comandos drope*\n\n" +
      "📦 *cadastro/estoque*\n" +
      "• *lote* → cadastrar/abastecer (manda fotos)\n" +
      "• *status* → progresso do lote atual\n" +
      "• *fechar lote* → finaliza\n" +
      "• *estoque* → lista do que tem\n" +
      "• *pendentes* → sem foto/arte\n" +
      "• *zerar estoque* → marca tudo inactive\n\n" +
      "✏️ *editar produto* (NOVO)\n" +
      "• *preço NOME 89.90* → muda preço\n" +
      "• *editar NOME qty 5* → muda qty\n" +
      "• *editar NOME nome XXXX* → renomeia\n" +
      "• *editar NOME sabor XXX* → muda sabor\n" +
      "• *editar NOME marca XXX* → muda marca\n" +
      "• *desfaz lote* → desfaz último cadastro\n\n" +
      "📊 *balanço*\n" +
      "• *balanço* → modo contagem física\n" +
      "• *fechar balanço* → vê divergências\n" +
      "• *aplica* → atualiza estoque\n" +
      "• *edita N qty* → ajusta item\n\n" +
      "🏍️ *motoboys*\n" +
      "• *motoboys* → lista whitelist\n" +
      "• *motoboys briefing* → orienta no grupo\n" +
      "• *motoboy add 5511XXX Nome* → cadastra\n" +
      "• *corrida #N* → posta corrida",
      body);
    return;
  }

  // ========== FOTO RECEBIDA ==========

  // BALANÇO 07/05/2026 — Foto durante mode='inventory_active' = contagem de balanço.
  // Tem prioridade sobre batch porque o user explicitamente entrou nesse modo.
  try {
    const _pendingInv = await getPending(phone);
    if (_pendingInv?.mode === 'inventory_active') {
      if (await tryHandleInventoryPhoto(phone, msg, body, _pendingInv)) return;
    }
  } catch (e) { console.warn('[BAL] tryHandleInventoryPhoto:', e.message); }

  // FLC FASE 2 (07/05/2026 - Andrade) — TODO cadastro de produto e abastecimento via foto
  // passa pelo modo lote. Sem flow legacy de single-photo cadastro_2_fotos.
  // Regras:
  //   - Se já tem batch_active OU não tem pending nenhum → modo lote (cria auto se necessario)
  //   - Se há outro pending especifico (batch_pricing, stock_entry, art_review, inventory) →
  //     respeita o pending atual (Lucas iniciou um fluxo formal)
  {
    let _pendingBatch = await getPending(phone);
    const SPECIFIC_FLOWS = ['cadastro_3photos', 'abastecimento', 'art_review', 'art_review_failed', 'awaiting_zero_confirm', 'batch_pricing', 'stock_entry', 'inventory_active', 'inventory_review'];
    const inSpecificFlow = _pendingBatch && SPECIFIC_FLOWS.includes(_pendingBatch.mode);

    if (!inSpecificFlow) {
      // Se não tem batch ativo, cria silenciosamente e processa a foto como batch
      if (!_pendingBatch || _pendingBatch.mode !== 'batch_active') {
        _pendingBatch = {
          mode: 'batch_active',
          batch_id: _flcUuid(),
          startedAt: Date.now(),
          lastPhotoAt: Date.now(),
          fotoCount: 0,
          errorCount: 0,
          matched: [],
          novos: [],
          autoCreated: true,
        };
        await setPending(phone, _pendingBatch);
        // Aviso curto pra Andrade saber que ativou
        sendText(phone,
          '📸 Modo lote ativado (auto). Pode mandar mais fotos.\n' +
          'Quando terminar, "fechar lote".',
          body).catch(() => {});
      }
      try {
        if (await tryHandleBatchPhoto(phone, msg, body, _pendingBatch)) return;
      } catch (e) { console.warn('[FLC] tryHandleBatchPhoto:', e.message, e.stack); }
    }
  }

  const imageUrl = await getMediaUrl(msg, body);
  if (!imageUrl) {
    await sendText(phone, "⚠️ não consegui ler a imagem.\n\n• manda de novo\n• 'cancela' — para", body);
    return;
  }

  let pending = await getPending(phone);

  // FIX TARDE 8 (BUG SIM REINICIA): foto durante step de TEXTO em cadastro_3photos é
  // ignorada CEDO (antes de qualquer outro processamento), pra evitar que foto resete
  // estado em awaiting_confirm/price/model/brand. Reforço explícito do return — antes a
  // lógica era espalhada e race entre invocations corrompia pending.
  if (pending?.mode === 'cadastro_3photos' &&
      ['awaiting_confirm', 'awaiting_price', 'awaiting_model', 'awaiting_brand'].includes(pending.step)) {
    console.log(`[ignore-photo] step=${pending.step} — esperando texto, não foto`);
    await sendText(phone,
      `⚠️ aguardando texto pro step '${pending.step}'\n\n` +
      `• responde com texto\n• 'cancela' — para`,
      body);
    return;
  }

  // Recovery foto: sem pending in-mem, foto pode ser resposta de art_review
  // (Lucas escolheu mandar foto pra usar como arte oficial).
  if (!pending) {
    const recovered = await tryRecoverPending(phone);
    if (recovered) {
      await setPending(phone, recovered);
      pending = recovered;
      console.log('[recovery photo] restored pending for productId:', recovered.productId);
    }
  }

  // FLUXO APROVAÇÃO DE ARTE — Lucas mandou foto pra usar como oficial
  if (pending?.mode === 'art_review' || pending?.mode === 'art_review_failed') {
    await sendText(phone, "✅ foto aprovada ✦ usando como arte do produto", body);
    try {
      const imgData = await downloadImage(imageUrl);
      if (!imgData) {
        await sendText(phone, "⚠️ erro ao baixar a foto.\n\n• manda de novo", body);
        return;
      }
      const slug = slugify(pending.brand || 'pod', pending.model || '', pending.flavor || pending.fullName || 'photo');
      const lucasPhotoUrl = await uploadToStorage(`${slug}-lucas`, imgData, 'image/jpeg');
      if (!lucasPhotoUrl) {
        await sendText(phone, "⚠️ erro no upload.\n\n• manda a foto de novo", body);
        return;
      }
      await sbUpdate('drope_products', `id=eq.${pending.productId}`, {
        image_url: lucasPhotoUrl,
        image_status: 'ok',
      });
      await clearPending(phone);
      await sendText(phone, `✅ foto aprovada 🦎\n\n*${pending.fullName}* tá usando como arte oficial.\n\n• 'cadastra' — outro produto\n• 'pendentes' — pods sem foto\n• 'estoque' — ver tudo`, body);
    } catch (e) {
      console.error('[art_review photo] error:', e.message);
      await sendText(phone, "⚠️ erro ao processar.\n\n• 'outra' — gera nova arte\n• manda outra foto\n• 'depois' — resolve mais tarde", body);
    }
    return;
  }

  // FLUXO ABASTECIMENTO — analisa cada foto, acumula no pending
  if (pending?.mode === 'abastecimento') {
    if (pending.step !== 'awaiting_photos') {
      await sendText(phone, "⚠️ aguardando texto.\n\n• sim / N +M / cancela\n• não é foto agora\n• 'cancela' — reinicia", body);
      return;
    }
    pending.photoCount = (pending.photoCount || 0) + 1;
    await sendText(phone, `✅ foto ${pending.photoCount} ok\n\n📸 analisando...`, body);
    await processAbastecimentoPhoto(phone, pending, imageUrl, body);
    return;
  }

  // FLUXO CADASTRO — caixa → pod → barcode digitado
  if (pending?.mode === 'cadastro_3photos') {
    if (pending.step === 'awaiting_caixa') {
      pending.photos.caixa = imageUrl;
      pending.step = 'awaiting_pod';
      await setPending(phone, pending);
      await sendText(phone, "✅ caixa ok\n\n📸 *2/2* — foto do POD\n\nmanda a foto do pod agora.\n\n• 'só essa' — usa só a caixa\n• 'cancela' — para", body);
      return;
    }
    if (pending.step === 'awaiting_pod') {
      pending.photos.pod = imageUrl;
      pending.step = 'awaiting_barcode_text';
      await setPending(phone, pending);
      await sendText(phone, "✅ pod ok\n\n*código de barras*\n\ndigita o código (só números, 8 a 13 dígitos).\n\n• 'pula' — cadastra sem\n• 'cancela' — para", body);
      return;
    }
    if (pending.step === 'awaiting_barcode_text') {
      // Recebeu foto, mas espera texto (com os dígitos do código)
      await sendText(phone, "⌨️ digita o *número* do código de barras\n\n(o que tá embaixo das listras: 8 a 13 dígitos, sem espaço)\n\n• 'pula' — cadastra sem\n• 'cancela' — para", body);
      return;
    }
    // Pending em estado avançado (awaiting_confirm/awaiting_price/awaiting_model) recebeu foto inesperada
    await sendText(phone, "⚠️ aguardando texto.\n\n• sim / preço / cancela\n• não é foto agora\n• 'cancela' — reinicia", body);
    return;
  }

  // FLC FASE 2 (07/05/2026) — FLOW LEGACY 1-foto / 2-fotos REMOVIDO.
  // Andrade quer todo cadastro/abastecimento via batch. Se chegou aqui, eh
  // porque tryHandleBatchPhoto deu exception OU ha pending de fluxo desconhecido.
  // Mensagem fallback (sem clearPending — preserva qualquer batch ativo):
  console.warn(`[admin foto fallback] pending mode=${pending?.mode || 'null'} — nao casou em nenhum flow`);
  await sendText(phone,
    "⚠️ erro ao processar foto. Tenta de novo.\n\n" +
    "Se persistir, manda 'cancela' e depois 'lote' antes de mandar fotos.",
    body);
}

// Cadastro completo: 1 ou 2 fotos. Se podUrl preenchido, re-roda Vision com as 2 imagens.
async function processProductRegistration(phone, caixaUrl, podUrl, preComputedData, body) {
  let data = preComputedData;
  // Se tem pod, vale re-rodar Vision com as 2 imagens pra cor real do device
  if (podUrl) {
    const richer = await analyzeProductImage(caixaUrl, podUrl);
    if (richer) data = richer;
  }
  if (!data) {
    data = await analyzeProductImage(caixaUrl);
  }
  if (!data || data.alertas?.includes('nao parece pod') || (!data.brand && !data.flavor_en)) {
    await sendText(phone, "⚠️ não tá parecendo pod.\n\n• confere se é a foto certa e manda de novo\n• 'cancela' — para", body);
    return;
  }

  // Limpa placeholders textuais ("unknown", "desconhecido", etc)
  data.brand     = cleanVisionField(data.brand);
  data.model     = cleanVisionField(data.model);
  data.flavor_en = cleanVisionField(data.flavor_en);
  data.flavor_pt = cleanVisionField(data.flavor_pt);
  console.log("[Vision 2-fotos]", JSON.stringify({ brand: data.brand, model: data.model, flavor_en: data.flavor_en, flavor_pt: data.flavor_pt, puffs: data.puffs }));

  const brand = data.brand || 'UNKNOWN';
  const model = data.model || '';
  const flavor = data.flavor_en || data.flavor_pt || 'unknown';
  const fullName = `${brand} ${model} ${flavor}`.replace(/\s+/g, ' ').trim();
  const slug = slugify(brand, model, flavor);

  // BLOCO 3 (OSSO 24): produto existe? Pergunta SIM/NÃO antes de pedir qty.
  // Sequência: awaiting_confirm → awaiting_qty → incrementa.
  const existing = await findStockMatchByMetadata(brand, model, flavor);
  if (existing) {
    await setPending(phone, {
      mode: 'stock_entry',
      step: 'awaiting_confirm',
      productId: existing.id,
      fullName: existing.name,
      currentStock: existing.qty_available || 0,
    });
    const priceStr = existing.price_cents
      ? `R$ ${(existing.price_cents / 100).toFixed(2).replace('.', ',')}`
      : 'sem preço';
    await sendText(phone,
      `🦎 esse é o *${existing.name}* que já tá no estoque (${existing.qty_available || 0} un ✦ ${priceStr}).\n\né esse mesmo?\n\n• 'sim' — confirma\n• 'não' — produto diferente\n• 'cancela' — para`,
      body);
    return;
  }

  // NOVO → arte + insert
  await sendText(phone, "🎬 novo produto ✦ gerando arte...", body);
  const grokUrl = await generatePadraoAPlus(brand, model, flavor, data.cores_predominantes, data.device_visual, 1, data.flavor_elements, data.device_visual_detailed);
  let publicImageUrl = null;
  let imageStatus = 'pending_regeneration';
  if (grokUrl) {
    const imgData = await downloadImage(grokUrl);
    if (imgData) {
      publicImageUrl = await uploadToStorage(slug, imgData, 'image/png');
      if (publicImageUrl) imageStatus = 'ok';
    }
  }

  // FALLBACK: se Grok falhou (timeout/erro/etc), salva a foto original do Lucas como image_url
  // provisório. Mantém image_status='pending_regeneration' pra sinalizar que a arte A+ ainda
  // precisa rodar via /admin. Melhor mostrar foto real do produto do que placeholder vazio.
  if (!publicImageUrl) {
    const fallbackSrc = podUrl || caixaUrl;
    if (fallbackSrc) {
      try {
        const fallbackData = await downloadImage(fallbackSrc);
        if (fallbackData) {
          const fallbackUrl = await uploadToStorage(`${slug}-original`, fallbackData, 'image/jpeg');
          if (fallbackUrl) {
            publicImageUrl = fallbackUrl;
            console.log("[Grok fallback] using original photo for", slug);
          }
        }
      } catch (e) {
        console.error("[Grok fallback] error:", e.message);
      }
    }
  }

  // Infere categoria do app cliente (frutado/mentolado/gelado) a partir do sabor.
  // O app cliente filtra por essas 3 categorias — usar 'pods' nao bate com filtro.
  const flavorText = `${data.flavor_en || ''} ${data.flavor_pt || ''} ${data.descricao_quebrada || ''}`.toLowerCase();
  let category = 'frutado';
  if (/menta|mint|hortela/.test(flavorText)) category = 'mentolado';
  else if (/ice|gelado|frio|cool|frost|menthol/.test(flavorText)) category = 'gelado';

  // Vision pode ler barcode da caixa — salva também no flow 2-fotos pra PDV bipar depois.
  // Valida checksum GS1 antes de gravar — se Vision errou um dígito, rejeita pra não
  // poluir o banco com barcode "quase certo".
  const barcodeFromVision = data.barcode ? String(data.barcode).replace(/\D/g, '').slice(0, 20) : null;
  let validBarcode = barcodeFromVision && /^[0-9]{8,20}$/.test(barcodeFromVision) ? barcodeFromVision : null;
  if (validBarcode && !validateBarcodeChecksum(validBarcode)) {
    console.warn('[2-fotos] barcode checksum invalid:', validBarcode, '→ saving null');
    validBarcode = null;
  }

  // 02/05 patch — salva a foto da CAIXA original como box_photo_url (mesma
  // foto que Vision usou pra extrair os dados). Aparece no /admin/pendentes
  // sem precisar upload separado.
  let boxPhotoUrl = null;
  if (caixaUrl) {
    try {
      const caixaData = await downloadImage(caixaUrl);
      if (caixaData) boxPhotoUrl = await uploadToStorage(`${slug}-caixa`, caixaData, 'image/jpeg');
    } catch (e) { console.warn('[processProductRegistration] caixa upload err:', e.message); }
  }

  const inserted = await sbInsert('drope_products', {
    slug,
    name: fullName,
    category,
    price_cents: 0,
    qty_available: 1,
    hidden: true,
    image_url: publicImageUrl,
    image_status: imageStatus,
    box_photo_url: boxPhotoUrl,  // 02/05 — mesma foto da caixa enviada pelo Lucas
    descricao_quebrada: data.descricao_quebrada,
    cores_predominantes: data.cores_predominantes,
    barcode: validBarcode,
    created_via: 'whatsapp_agent',
    metadata: {
      brand,
      model,
      flavor_en: data.flavor_en,
      flavor_pt: data.flavor_pt,
      puffs: data.puffs,
      ml: data.ml,
      mg_nicotina: data.mg_nicotina,
      device_color: data.device_color,
      device_visual: data.device_visual,
      device_visual_detailed: data.device_visual_detailed,
      flavor_elements: data.flavor_elements,
      cores_predominantes: data.cores_predominantes,
      box_photo_url: boxPhotoUrl,  // espelho pra cascata getDeviceDescription
      registered_with_2_photos: !!podUrl,
    },
  });

  if (!inserted) {
    if (sbInsert._lastError && sbInsert._lastError.startsWith('409')) {
      const dupRows = await sbGet('drope_products', `slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const dup = dupRows[0];
      if (dup) {
        const newQty = (dup.qty_available || 0) + 1;
        await sbUpdate('drope_products', `id=eq.${dup.id}`, { qty_available: newQty });
        await sendText(phone, `✅ +1 *${fullName}*\n\nestoque: ${dup.qty_available || 0} → ${newQty} (dedup)`, body);
        return;
      }
    }
    await sendText(phone, "⚠️ erro no banco.\n\n• tenta de novo", body);
    return;
  }

  let alertSuffix = '';
  if (data.alertas?.length > 0) alertSuffix = `\n\nobs: ${data.alertas.join(', ')}`;
  if (imageStatus === 'pending_regeneration') {
    alertSuffix += publicImageUrl
      ? `\nobs: geração de arte falhou, salvei a foto original como provisória ✦ regera pelo /admin depois`
      : `\nobs: arte falhou e foto original tbm não rolou ✦ regera pelo /admin`;
  }

  const adminLink = `https://drope-app.vercel.app/admin#products/${inserted.id}`;
  await sendText(phone,
    `✅ *${fullName}* tá no app\n\nfalta só o preço.\n\n${adminLink}${alertSuffix}`,
    body);

  if (publicImageUrl) {
    await sendImage(phone, publicImageUrl, `${fullName} — arte A+`, body);
  }
}

// ============ FLUXO 3 FOTOS — processa após receber barcode + caixa + pod ============
// Roda Vision na caixa+pod, busca regra de preço, monta preview e PEDE confirmação.
// O salvamento real é feito por finalizeCadastro() depois do SIM/preço.
async function processCadastro3Photos(phone, pending, body) {
  // Re-roda Vision com caixa + pod (se tem pod) pra device_visual rico.
  // Se pending.visionData já existe (Vision rodou no awaiting_caixa) e re-run falhar, usa fallback.
  let data = null;
  if (pending.photos.pod) {
    await sendText(phone, "📸 analisando as 2 fotos...", body);
    data = await analyzeProductImage(pending.photos.caixa, pending.photos.pod);
  }
  if (!data) data = pending.visionData || await analyzeProductImage(pending.photos.caixa);

  if (!data || data.alertas?.includes('nao parece pod') || (!data.brand && !data.flavor_en)) {
    await clearPending(phone);
    await sendText(phone, "⚠️ caixa muito desfocada.\n\n• 'cadastra' — recomeça com fotos mais nítidas", body);
    return;
  }

  // Limpa placeholders textuais ("unknown", "desconhecido", etc) que Vision às vezes retorna
  data.brand     = cleanVisionField(data.brand);
  data.model     = cleanVisionField(data.model);
  data.flavor_en = cleanVisionField(data.flavor_en);
  data.flavor_pt = cleanVisionField(data.flavor_pt);
  console.log("[Vision 3-fotos]", JSON.stringify({ brand: data.brand, model: data.model, flavor_en: data.flavor_en, flavor_pt: data.flavor_pt, puffs: data.puffs }));

  const brand = data.brand || 'UNKNOWN';
  const model = data.model || '';
  const flavor = data.flavor_en || data.flavor_pt || 'unknown';
  const fullName = `${brand} ${model} ${flavor}`.replace(/\s+/g, ' ').trim();

  // FIX TARDE 7 BUG 3: se Vision não pegou a MARCA, perguntar primeiro pro Lucas. Antes ia
  // direto pra awaiting_model com brand="UNKNOWN", e Lucas tentava corrigir digitando
  // "marca XXX" mas o texto virava o MODELO (lixo no banco).
  if (brand === 'UNKNOWN') {
    pending.brand = brand;
    pending.model = model;
    pending.flavor = flavor;
    pending.fullName = `${brand} ${model} ${flavor}`.replace(/\s+/g, ' ').trim();
    pending.visionData = data;
    pending.step = 'awaiting_brand';
    await setPending(phone, pending);
    await sendText(phone,
      `⚠️ não consegui ler a *marca* da caixa\n\n${flavor || 'sabor desconhecido'} — preciso da marca pra cadastrar certo.\n\n• digita a marca (ex: Elfbar, Hidden Hills, Ignite)\n• 'sem marca' — cadastra como Genérico\n• 'cancela' — para`,
      body);
    return;
  }

  // Se faltou modelo, avisa o Lucas e pede confirmação extra (modelo é a chave da regra de preço!)
  if (!model) {
    await sendText(phone, `⚠️ não consegui ler o *modelo* da caixa\n\n*${brand} ${flavor}*\n\ndigita o modelo (ex: MO20000, BC15K, V300).\n\n(vira regra de preço pros próximos sabores)\n\n• digita o modelo\n• 'sem modelo' — cadastra assim mesmo\n• 'marca XXX' — corrige a marca\n• 'cancela' — para`, body);
    pending.brand = brand;
    pending.flavor = flavor;
    pending.fullName = `${brand} ${flavor}`.replace(/\s+/g, ' ').trim();
    pending.visionData = data;
    pending.step = 'awaiting_model';
    await setPending(phone, pending);
    return;
  }

  // Salva dados no pending e mostra preview (extraído pra fn separada — reusada quando model
  // vem do step 'awaiting_model' depois de Vision falhar)
  pending.brand = brand;
  pending.model = model;
  pending.flavor = flavor;
  pending.fullName = fullName;
  pending.visionData = data;
  await buildAndShowPreview(phone, pending, body);
}

// Busca duplicata, busca rule de preço, monta e envia o preview com SIM/cancela.
// Reusada após cleanup do model (caso awaiting_model).
async function buildAndShowPreview(phone, pending, body) {
  const { brand, model, flavor, fullName, visionData: data, barcode } = pending;

  // BLOCO 3 (OSSO 24): já existe? Pergunta SIM/NÃO antes de pedir qty.
  const existing = await findStockMatchByMetadata(brand, model, flavor);
  if (existing) {
    await setPending(phone, {
      mode: 'stock_entry',
      step: 'awaiting_confirm',
      productId: existing.id,
      fullName: existing.name,
      currentStock: existing.qty_available || 0,
    });
    const priceStr = existing.price_cents
      ? `R$ ${(existing.price_cents / 100).toFixed(2).replace('.', ',')}`
      : 'sem preço';
    await sendText(phone,
      `🦎 esse é o *${existing.name}* que já tá no estoque (${existing.qty_available || 0} un ✦ ${priceStr}).\n\né esse mesmo?\n\n• 'sim' — confirma\n• 'não' — produto diferente\n• 'cancela' — para`,
      body);
    return;
  }

  // Procura regra de preço pra brand+model
  const rule = model ? await getPriceRule(brand, model) : null;
  const priceFromRule = rule?.price_cents || null;

  pending.priceFromRule = priceFromRule;
  pending.step = 'awaiting_confirm';
  // FIX TARDE 8 (BUG SIM REINICIA): confirm_token detecta corrupção de pending entre
  // preview e o "Sim". Se o handler de awaiting_confirm receber pending sem esse token,
  // sabe que o estado foi corrompido e avisa Lucas em vez de falhar silencioso.
  pending.confirm_token = `tok_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  pending.confirm_token_at = Date.now();
  await setPending(phone, pending);

  const lines = [
    `📋 PREVIEW DO CADASTRO`,
    ``,
    `marca: ${brand}`,
    `modelo: ${model || '(sem modelo)'}`,
    `sabor: ${flavor}`,
    data.puffs ? `puffs: ${data.puffs}` : null,
    barcode ? `barcode: ${barcode}` : '(sem barcode)',
    priceFromRule
      ? `preço: R$ ${(priceFromRule / 100).toFixed(2).replace('.', ',')} (regra de ${brand} ${model})`
      : `preço: vou perguntar depois do SIM`,
    ``,
    `tá certo?`,
    `• 'sim' pra confirmar`,
    `• 'codigo correto XXXXX' se o barcode tiver errado`,
    `• 'cancela' pra desistir`,
  ].filter(Boolean).join('\n');
  await sendText(phone, lines, body);
}

// ============ FINALIZE — INSERT + arte Grok + price rule (se nova) ============
// Chamado depois de SIM + (preço respondido se necessário).
async function finalizeCadastro(phone, pending, priceCents, body) {
  const { brand, model, flavor, fullName, visionData: data, photos } = pending;
  const slug = slugify(brand, model, flavor);

  // 1) Upload da CAIXA pra Storage — vira image_url provisória até a arte ficar pronta.
  //    Lucas vê foto real da caixa no app cliente enquanto a arte é gerada em background.
  let provisionalImageUrl = null;
  try {
    const caixaData = await downloadImage(photos.caixa);
    if (caixaData) provisionalImageUrl = await uploadToStorage(`${slug}-caixa`, caixaData, 'image/jpeg');
  } catch (e) { console.error("[finalizeCadastro] caixa upload err:", e.message); }

  // 2) NÃO roda OpenAI aqui (15-30s, daria timeout no webhook UazAPI de 10s).
  //    Salva produto com image_status='pending_art' + image_url=caixa provisória.
  //    Arte é gerada pelo endpoint separado /api/generate-pending-arts (desacoplado).
  const imageStatus = 'pending_art';
  const finalImageUrl = provisionalImageUrl;

  // Categoria do app cliente (frutado/mentolado/gelado)
  const flavorText = `${data.flavor_en || ''} ${data.flavor_pt || ''} ${data.descricao_quebrada || ''}`.toLowerCase();
  let category = 'frutado';
  if (/menta|mint|hortela/.test(flavorText)) category = 'mentolado';
  else if (/ice|gelado|frio|cool|frost|menthol/.test(flavorText)) category = 'gelado';

  // Salva regra de preço se ainda não existia (priceFromRule indica que veio da rule)
  if (!pending.priceFromRule && priceCents > 0) {
    await setPriceRule(brand, model, priceCents);
  }

  const inserted = await sbInsert('drope_products', {
    slug,
    name: fullName,
    category,
    price_cents: priceCents,
    qty_available: 1,
    hidden: priceCents <= 0,  // só esconde se sem preço; com preço, já aparece no app
    image_url: finalImageUrl,
    image_status: imageStatus,
    // 02/05 patch — foto da caixa enviada pelo Lucas vira box_photo_url já no
    // INSERT (não precisa upload separado). Mesma foto que Vision usou pra
    // extrair dados. /admin/pendentes mostra essa foto direto no card "SUA FOTO DA CAIXA".
    box_photo_url: provisionalImageUrl || null,
    descricao_quebrada: data.descricao_quebrada,
    cores_predominantes: data.cores_predominantes,
    barcode: (() => {
      // pending.barcode foi DIGITADO pelo Lucas (step awaiting_barcode_text) — confiável.
      // data.barcode (Vision tentou ler na caixa) pode estar errado — valida com checksum.
      if (pending.barcode) return pending.barcode;
      if (data.barcode) {
        const digits = String(data.barcode).replace(/\D/g, '');
        if (/^\d{8,20}$/.test(digits) && validateBarcodeChecksum(digits)) return digits;
        console.warn('[finalize] data.barcode checksum invalid:', digits, '→ null');
      }
      return null;
    })(),
    created_via: 'whatsapp_agent',
    metadata: {
      brand,
      model,
      flavor_en: data.flavor_en,
      flavor_pt: data.flavor_pt,
      puffs: data.puffs,
      ml: data.ml,
      mg_nicotina: data.mg_nicotina,
      device_color: data.device_color,
      device_visual: data.device_visual,
      device_visual_detailed: data.device_visual_detailed,
      registered_with_3_photos: !!(photos.barcode && photos.caixa && photos.pod),
      registered_via_flow: 'cadastro_3photos',
      provisional_image_url: provisionalImageUrl, // foto da caixa (image_url enquanto awaiting)
      box_photo_url: provisionalImageUrl,         // espelho pra cascata getDeviceDescription
      cores_predominantes: data.cores_predominantes,
      flavor_elements: data.flavor_elements,      // descritivo visual pro prompt do Grok
      created_by_phone: phone,                    // pra recovery do pending após cold-start
    },
  });

  if (!inserted) {
    if (sbInsert._lastError && sbInsert._lastError.startsWith('409')) {
      const dupRows = await sbGet('drope_products', `slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const dup = dupRows[0];
      if (dup) {
        const newQty = (dup.qty_available || 0) + 1;
        await sbUpdate('drope_products', `id=eq.${dup.id}`, { qty_available: newQty });
        await clearPending(phone);
        await sendText(phone, `✅ +1 *${fullName}*\n\nestoque: ${dup.qty_available || 0} → ${newQty} (dedup)`, body);
        return;
      }
    }
    await clearPending(phone);
    await sendText(phone, "⚠️ erro no banco.\n\n• 'cadastra' — manda as fotos de novo", body);
    return;
  }

  // FIX TARDE 7 (H3): valida que sbInsert retornou objeto com id antes de chamar fireArt.
  // Sem isso, productId vira undefined e runArtGeneration falha silenciosa.
  if (!inserted.id) {
    console.error('[finalizeCadastro] inserted sem id:', JSON.stringify(inserted).slice(0, 300));
    await clearPending(phone);
    await sendText(phone,
      `⚠️ *${fullName}* salvo mas sem ID — arte não vai gerar.\n\n` +
      `• 'gerar arte' — tenta de novo\n• /admin gallery — resolve no admin`,
      body);
    return;
  }

  let alertSuffix = '';
  if (data.alertas?.length > 0) alertSuffix = `\n\nobs: ${data.alertas.join(', ')}`;

  const priceStr = `R$ ${(priceCents / 100).toFixed(2).replace('.', ',')}`;
  await sendText(phone,
    `✅ *${fullName}* cadastrado\n\npreço: ${priceStr}\n\n` +
    `🎬 gerando arte (~30s)... aguenta aí${alertSuffix}`,
    body);

  // FIX TARDE 7 (H1): clearPending UMA VEZ SÓ, ANTES da arte. Antes tinha 2 chamadas
  // (linhas 2034 e 2062) — a segunda rodava DEPOIS do setPending(art_review) feito por
  // runArtGeneration, limpando o pending de aprovação e fazendo Lucas perder a arte.
  await clearPending(phone);

  // FIX TARDE 7: runArtGeneration roda INLINE (mesmo invocation do bot). Antes dependia de
  // fetch fire-and-forget + AbortController pra rota /generate_art interna, que falhou em
  // prod 3x consecutivas (Sour Apple, Americano, Lemon Lime). Bloqueia o handler ~30s mas
  // tem maxDuration 60s no vercel.json. UazAPI pode timeout 10s mas dedup msgId protege.
  // Try/catch global pra GARANTIR feedback ao Lucas mesmo se Grok/Storage/UazAPI falhar.
  try {
    await runArtGeneration(inserted.id, phone, 1);
  } catch (e) {
    console.error('[finalizeCadastro] runArtGeneration EXCEPTION productId=' + inserted.id + ':', e.message, e.stack);
    try {
      await sbUpdate('drope_products', `id=eq.${inserted.id}`, { image_status: 'error' });
    } catch (e2) { console.error('[finalizeCadastro] failed to mark error:', e2.message); }
    await sendText(phone,
      `⚠️ arte de *${fullName}* deu ruim: ${e.message}\n\n` +
      `• 'gerar arte' — tenta de novo\n• /admin gallery — resolve no admin`,
      body);
  }
}

// (removido em 2026-04-29: requestArtApproval substituído por runArtGeneration que
// roda na rota interna /api/webhook?action=generate_art com 60s de timeout próprio.
// Lógica de pending art_review/failed agora é setada lá depois de gerar a arte real.)

// ============ FLUXO ABASTECIMENTO — processa cada foto recebida ============
// Chama Vision pro mix, identifica produtos, acumula em pending.identified/unrecognized.
async function processAbastecimentoPhoto(phone, pending, imageUrl, body) {
  const result = await analyzeMixPhoto(imageUrl);
  if (!result || !result.products || result.products.length === 0) {
    await sendText(phone, "⚠️ nenhum pod identificado nessa foto.\n\n• manda outra foto\n• 'pronto' — preview do que já tem\n• 'cancela' — para", body);
    return;
  }

  console.log("[abastecimento] foto", pending.photoCount, "→", result.products.length, "produtos identificados");

  // Pra cada produto identificado, busca no banco. Se já tá em pending.identified/unrecognized,
  // soma quantidades (Lucas pode ter mandado o mesmo pod em fotos diferentes).
  for (const p of result.products) {
    const dbProduct = await findProductByBarcodeOrName(p.barcode, p.brand, p.model, p.flavor_en || p.flavor_pt);
    const flavor = p.flavor_en || p.flavor_pt || 'unknown';
    const fullName = `${p.brand || '?'} ${p.model || ''} ${flavor}`.replace(/\s+/g, ' ').trim();

    if (dbProduct) {
      // Já cadastrado — agrupa em identified
      const idx = pending.identified.findIndex(i => i.dbProduct.id === dbProduct.id);
      if (idx >= 0) {
        pending.identified[idx].qty += p.qty;
      } else {
        pending.identified.push({
          dbProduct,
          name: dbProduct.name,
          barcode: p.barcode || dbProduct.barcode,
          qty: p.qty,
          qtyBefore: dbProduct.qty_available || 0,
        });
      }
    } else {
      // Não cadastrado — agrupa em unrecognized
      const sigKey = `${(p.brand || '').toLowerCase()}|${(p.model || '').toLowerCase()}|${flavor.toLowerCase()}`;
      const idx = pending.unrecognized.findIndex(u => u.sigKey === sigKey);
      if (idx >= 0) {
        pending.unrecognized[idx].qty += p.qty;
      } else {
        pending.unrecognized.push({
          sigKey,
          name: fullName,
          brand: p.brand,
          model: p.model,
          flavor,
          barcode: p.barcode,
          qty: p.qty,
        });
      }
    }
  }

  await setPending(phone, pending);
  const idCount = pending.identified.length;
  const unCount = pending.unrecognized.length;
  await sendText(phone,
    `✓ ${result.products.length} ${result.products.length === 1 ? 'item identificado' : 'itens identificados'} nessa foto\n` +
    `total acumulado: ${idCount} cadastrado${idCount !== 1 ? 's' : ''} • ${unCount} desconhecido${unCount !== 1 ? 's' : ''}\n\n` +
    `• manda mais fotos\n• 'pronto' — preview\n• 'cancela' — para`,
    body);
}

// Monta e envia preview do abastecimento, marca step pra aguardar SIM ou ajuste.
// MELHORIA 30/04 (tarde 5): desconhecidos agora podem ser cadastrados inline (sem precisar
// abrir flow `cadastra` separado pra cada um). 'sim' cadastra TODOS desconhecidos + aplica
// entrada; 'sim N' cadastra só o N; 'só entrada' pula novos.
async function buildAbastecimentoPreview(phone, pending, body) {
  pending.step = 'awaiting_confirm';
  await setPending(phone, pending);

  const lines = [`📦 PREVIEW DO ABASTECIMENTO`, ``];

  if (pending.identified.length > 0) {
    lines.push(`✅ cadastrados (dar entrada):`);
    pending.identified.forEach((it, i) => {
      const before = it.qtyBefore;
      const after = before + it.qty;
      lines.push(`${i + 1}. ${it.name} → +${it.qty} (${before} → ${after})`);
    });
    lines.push('');
  }

  if (pending.unrecognized.length > 0) {
    lines.push(`❓ não cadastrados (novos):`);
    pending.unrecognized.forEach((it, i) => {
      lines.push(`${i + 1}. ${it.name} (${it.qty} un) — quer cadastrar?`);
    });
    lines.push('');
  }

  if (pending.identified.length === 0 && pending.unrecognized.length === 0) {
    lines.push('vazio. nada pra abastecer.');
  } else {
    lines.push(`responde:`);
    if (pending.unrecognized.length > 0 && pending.identified.length > 0) {
      lines.push(`• 'sim' — cadastra TODOS os novos + aplica entrada dos cadastrados`);
      lines.push(`• 'sim N' — cadastra só o novo N (ex: 'sim 1')`);
      lines.push(`• 'só entrada' — pula novos, aplica só os cadastrados`);
    } else if (pending.unrecognized.length > 0) {
      lines.push(`• 'sim' — cadastra TODOS os novos`);
      lines.push(`• 'sim N' — cadastra só o novo N (ex: 'sim 1')`);
    } else {
      lines.push(`• 'sim' — aplica entrada dos cadastrados`);
    }
    if (pending.identified.length > 0) {
      lines.push(`• 'N +M' — ajusta qtd da linha N (ex: '2 +5')`);
    }
    lines.push(`• 'cancela' — desistir`);
  }

  await sendText(phone, lines.join('\n'), body);
}

// Aplica os incrementos de estoque nos produtos identificados.
async function applyAbastecimento(phone, pending, body) {
  if (pending.identified.length === 0) {
    await clearPending(phone);
    await sendText(phone, "✅ cancelado. nada foi aplicado.\n\n• 'cadastra' — começa de novo\n• 'estoque' — ver estado", body);
    return;
  }

  let success = 0;
  let failed = 0;
  for (const it of pending.identified) {
    const newQty = (it.qtyBefore || 0) + it.qty;
    const result = await sbUpdate('drope_products', `id=eq.${it.dbProduct.id}`, { qty_available: newQty });
    if (result) success++;
    else failed++;
  }

  await clearPending(phone);

  const totalUnits = pending.identified.reduce((s, it) => s + it.qty, 0);
  const lines = [
    failed === 0
      ? `✅ estoque atualizado!`
      : `⚠️ atualizado parcial — ${success} ok, ${failed} falhou`,
    `${success} produto${success !== 1 ? 's' : ''} reabastecido${success !== 1 ? 's' : ''} (+${totalUnits} unidade${totalUnits !== 1 ? 's' : ''})`,
  ];
  if (pending.unrecognized.length > 0) {
    lines.push('');
    lines.push(`obs: ${pending.unrecognized.length} produto${pending.unrecognized.length !== 1 ? 's não foram' : ' não foi'} reconhecido${pending.unrecognized.length !== 1 ? 's' : ''}. cadastra com 'cadastra' quando puder.`);
  }
  await sendText(phone, lines.join('\n'), body);
}

// MELHORIA 30/04 (tarde 5): cadastrar produto desconhecido inline a partir do abastecimento.
// Antes Lucas tinha que sair, mandar 'cadastra', mandar fotos individuais. Agora ele pode
// cadastrar direto do preview com 'sim' (todos) ou 'sim N' (específico).
//
// Compromisso: produto cadastrado aqui NÃO tem `device_visual_detailed` (Vision do mix-photo
// não captura tão fundo quanto o flow formal de 3 fotos). Arte vai usar fallback genérico.
// Lucas pode trocar a arte depois respondendo 'outra' ou mandando foto pelo gallery.
async function registerUnrecognizedFromAbastecimento(phone, pending, indexOrAll, body) {
  if (pending.unrecognized.length === 0) return [];

  const items = (indexOrAll === 'all')
    ? [...pending.unrecognized]
    : [pending.unrecognized[indexOrAll]];

  const created = [];
  const failed = [];
  for (const it of items) {
    const slug = slugify(it.brand || 'pod', it.model || '', it.flavor || 'unknown');
    const category = inferPerfil(null, it.flavor, it.name);
    const inserted = await sbInsert('drope_products', {
      slug,
      name: it.name,
      category,
      price_cents: 0,            // Lucas preenche depois no admin gallery
      qty_available: it.qty,     // já entra com a quantidade vista na foto
      hidden: true,              // só aparece no app quando tiver preço E arte aprovada
      image_url: null,
      image_status: 'pending_art',
      barcode: it.barcode || null,
      created_via: 'whatsapp_agent',
      metadata: {
        brand: it.brand || null,
        model: it.model || null,
        flavor_pt: it.flavor || null,
        flavor_en: it.flavor || null,
        registered_via_flow: 'abastecimento',
        created_by_phone: phone,
      },
    });
    if (inserted && inserted.id) {
      created.push({ id: inserted.id, name: it.name, qty: it.qty });
      // FIX TARDE 7: roda runArtGeneration INLINE (não mais fire-and-forget). Cada produto
      // bloqueia ~30s — pra abastecimento em lote pode ficar pesado, mas dedup msgId protege
      // contra timeout do UazAPI. Try/catch garante que falha em 1 não quebra o lote inteiro.
      try {
        await runArtGeneration(inserted.id, phone, 1);
      } catch (e) {
        console.error('[abastecimento-cadastra] runArtGeneration EXCEPTION productId=' + inserted.id + ':', e.message);
        await sbUpdate('drope_products', `id=eq.${inserted.id}`, { image_status: 'error' }).catch(() => {});
        await sendText(phone, `⚠️ arte de *${it.name}* com erro.\n\n• 'gerar arte' — resolve depois`, body);
      }
    } else {
      failed.push(it.name);
      console.error('[abastecimento-cadastra] insert failed:', it.name, sbInsert._lastError);
    }
  }

  // Remove os cadastrados de pending.unrecognized
  if (indexOrAll === 'all') {
    pending.unrecognized = [];
  } else {
    pending.unrecognized.splice(indexOrAll, 1);
  }
  await setPending(phone, pending);

  // Mensagem de status
  if (created.length > 0) {
    const list = created.map(x => `• ${x.name} (${x.qty} un)`).join('\n');
    let msg = `🆕 cadastrei ${created.length} produto${created.length !== 1 ? 's' : ''}:\n${list}\n\n` +
              `gerando arte em background — vou te mandar pra aprovar quando ficar pronta.\n` +
              `preço/barcode tu coloca depois no admin gallery.`;
    if (failed.length > 0) {
      msg += `\n\n⚠️ falhei em: ${failed.join(', ')}. tenta de novo ou cadastra um por um.`;
    }
    await sendText(phone, msg, body);
  } else if (failed.length > 0) {
    await sendText(phone, `⚠️ erro no cadastro: ${failed.join(', ')}\n\n• tenta de novo\n• 'cadastra' — um por um`, body);
  }
  return created;
}

// ============ FLUXO PDV — BAIXA ESTOQUE POR FOTO (loja + Yasmin) ============
// Foto → Vision identifica → dá baixa automática no estoque.
// Texto "estoque" → mostra saldo atual.
async function handleAdminCaixa(phone, msg, body) {
  const hasImage = isImageMessage(msg);
  const text = asString(msg.text) || asString(msg.content) || asString(msg.caption);
  const lower = (text || '').toLowerCase().trim();

  // FIX MAIO/2026 — REMOVIDO o alreadySeen aqui. Dedup global top-level ja marca msgId.
  // Manter essa chamada redundante matava a 1a request real (mesmo bug do handleAdminLucas).

  // FOTO = baixa de estoque
  if (hasImage) {
    await handleStockPhoto(phone, msg, body);
    return;
  }

  // Comandos de texto simples pro PDV
  if (lower === 'estoque' || lower === 'saldo') {
    const products = await sbGet('drope_products', 'select=name,qty_available,hidden&hidden=eq.false&qty_available=gt.0&order=name&limit=200');
    if (!products || products.length === 0) {
      await sendText(phone, "📦 estoque zerado em tudo.\n\navisa o Andrade", body);
      return;
    }
    const list = products.map(p => `${p.name}: ${p.qty_available}`).join('\n');
    await sendText(phone, `📦 *estoque atual*\n\n${list}`, body);
    return;
  }

  if (lower === 'ajuda' || lower === 'help' || lower === '?') {
    await sendText(phone,
      "🦎 *modo PDV*\n\n" +
      "📸 manda foto do pod vendido → baixa automática\n" +
      "📦 'estoque' → ver saldo\n" +
      "❓ 'ajuda' → esse menu", body);
    return;
  }

  // Qualquer outro texto
  await sendText(phone,
    "🦎 modo PDV ativo\n\n" +
    "📸 foto do pod = baixa estoque\n" +
    "📦 'estoque' = ver saldo\n" +
    "❓ 'ajuda' = comandos", body);
}

// ============ MODO ESTOQUE POR FOTO (TEMPORÁRIO — 02/05/2026) ============
// Andrade vai à loja. Qualquer foto enviada ao bot = identificação Vision +
// match no catálogo + baixa de estoque. Substitui temporariamente o fluxo
// normal de cliente. Reverter quando Andrade pedir (remover o bloco MODO
// ESTOQUE TEMPORÁRIO no roteamento principal lá embaixo).
async function handleStockPhoto(phone, msg, body) {
  const imageUrl = await getMediaUrl(msg, body);
  if (!imageUrl) {
    await sendText(phone, "nao consegui baixar a foto. tenta de novo", body);
    return;
  }

  // Vision identifica os produtos
  const analysis = await analyzeMixPhoto(imageUrl);
  if (!analysis || !Array.isArray(analysis.products) || analysis.products.length === 0) {
    await sendText(phone, "nao reconheci nenhum pod nessa foto. tira outra mais perto da caixa/rotulo", body);
    return;
  }

  const results = [];

  // 02/05 patch: baixa a foto do whats UMA VEZ — usada como box_photo_url pra
  // produtos identificados que ainda não tem (modelos cadastrados via SQL bulk
  // não têm foto da caixa). Vision já identificou — aproveita a foto enviada.
  let cachedBoxBuffer = null;
  let cachedBoxMime = 'image/jpeg';
  try {
    if (imageUrl.startsWith('data:')) {
      const m = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        cachedBoxMime = m[1];
        cachedBoxBuffer = Buffer.from(m[2], 'base64');
      }
    } else {
      const r = await fetch(imageUrl);
      if (r.ok) {
        cachedBoxBuffer = Buffer.from(await r.arrayBuffer());
        cachedBoxMime = r.headers.get('content-type') || 'image/jpeg';
      }
    }
  } catch (e) { console.warn('[handleStockPhoto] download foto pra box_photo_url:', e.message); }

  // Carrega catálogo uma vez (evita N queries)
  const allProducts = await sbGet('drope_products',
    'select=id,name,slug,qty_available,total_sold,metadata,box_photo_url&hidden=eq.false&limit=500');
  if (!Array.isArray(allProducts) || allProducts.length === 0) {
    await sendText(phone, "catalogo vazio no banco. nao tem como dar baixa", body);
    return;
  }

  // OSSO 35 — separa mensagens em 2 buckets:
  //   results = sucessos vão pro grupo (silencioso)
  //   adminAlerts = problemas vão pro ADMIN_LUCAS no privado (não polui grupo)
  // Fluxo Andrade quer: grupo só pra venda confirmada. Erro/ambiguidade resolve por privado dele.
  const isFromGroup = String(phone).endsWith('@g.us');
  const adminAlerts = [];

  // OSSO 35 (FIX 3D) — Logger de toda decisao em drope_vision_log.
  // Guarda predicao + confidence + decisao pra suportar aprendizado por correcao.
  const senderPhone = msg.sender_pn?.replace(/[^0-9]/g, '') || msg.sender?.replace(/[^0-9]/g, '') || phone.replace(/[^0-9]/g, '');
  const senderName = msg.senderName || null;
  const photoUrl = msg.fileURL || (typeof imageUrl === 'string' && !imageUrl.startsWith('data:') ? imageUrl : null);
  async function _logVisionDecision(p, decision, matched, score, qtyDeducted = 0) {
    try {
      await sbInsert('drope_vision_log', {
        photo_url: photoUrl,
        group_jid: isFromGroup ? phone : null,
        sender_phone: senderPhone || null,
        sender_name: senderName,
        vision_response: p,
        predicted_product_id: matched?.id || null,
        predicted_product_name: matched?.name || null,
        predicted_score: typeof score === 'number' ? score : null,
        predicted_confidence: typeof p?.flavor_confidence === 'number' ? p.flavor_confidence : null,
        decision,
        qty_deducted: qtyDeducted,
      });
    } catch (e) { console.warn('[vision_log] erro ao gravar:', e.message); }
  }

  for (const p of analysis.products) {
    const qty = Math.max(1, parseInt(p.qty) || 1);
    const searchTerms = [p.brand, p.model, p.flavor_en, p.flavor_pt].filter(Boolean);

    if (searchTerms.length === 0) {
      adminAlerts.push(`❓ produto nao identificado`);
      await _logVisionDecision(p, 'nao_identificado', null, null, 0);
      continue;
    }

    // OSSO 35 — Gate de confianca no sabor (briefing 06/05/2026)
    // Se Vision nao leu o sabor com confianca, NAO baixa estoque automaticamente.
    // Pergunta pro grupo qual e o produto certo.
    const conf = (typeof p.flavor_confidence === 'number') ? p.flavor_confidence : null;
    const flavorMissing = !p.flavor_en && !p.flavor_pt;
    if (flavorMissing || (conf !== null && conf < 0.7)) {
      const palpite = [p.brand, p.model, p.flavor_en || p.flavor_pt || '?sabor'].filter(Boolean).join(' ');
      const motivo = flavorMissing
        ? "nao consegui ler o sabor na embalagem"
        : `confianca baixa (${Math.round(conf * 100)}%) na leitura do sabor`;
      adminAlerts.push(`🤔 ${palpite} — ${motivo}. NAO dei baixa. Manda foto melhor (mais perto do rotulo) ou me diz o nome exato do sabor.`);
      await _logVisionDecision(p, 'sabor_baixo', null, null, 0);
      continue;
    }

    // OSSO 35 — Match inteligente Levenshtein + decisao tripla
    // Score 0-100 (marca 30, modelo 25, sabor 35, bonus 10).
    // - Score >= 80: match firme, baixa estoque direto
    // - Score 50-79:  ambiguo, pergunta no grupo (NAO baixa)
    // - Score <  50:  nao encontrou, avisa
    const visionTerms = { brand: p.brand, model: p.model, flavor_en: p.flavor_en, flavor_pt: p.flavor_pt };
    const ranking = allProducts
      .map(prod => ({ prod, score: _matchScore(visionTerms, prod) }))
      .sort((a, b) => b.score - a.score);
    const top1 = ranking[0] || { prod: null, score: 0 };
    const top2 = ranking[1] || { prod: null, score: 0 };
    const matched = top1.prod;
    const matchScore = top1.score;

    if (!matched || matchScore < 50) {
      const label = searchTerms.join(' ');
      adminAlerts.push(`❓ ${label} — nao encontrei no catalogo (melhor match: ${Math.round(matchScore)}%)`);
      await _logVisionDecision(p, 'nao_encontrou', matched, matchScore, 0);
      // SISTEMA IMUNE 07/05/2026: registra venda pendente. Quando Andrade cadastrar
      // depois, o tryHandleBatchPhoto busca matching e aplica baixa retroativa.
      try {
        await sbInsert('drope_pending_sales', {
          vendedor_phone: phone,
          group_jid: isFromGroup ? phone : null,
          vision_brand: p.brand || null,
          vision_model: p.model || null,
          vision_flavor_en: p.flavor_en || null,
          vision_flavor_pt: p.flavor_pt || null,
          vision_search_terms: label,
          qty,
          vision_score: matchScore,
          candidate_product_id: matched?.id || null,
          candidate_score: matchScore,
          status: 'pending',
        });
      } catch (e) { console.warn('[pending_sales insert]', e.message); }
      continue;
    }

    // Score 50-79: ambiguo. Manda alerta pro admin privado, NAO baixa.
    if (matchScore < 80) {
      const candidato1 = `${matched.name} (${Math.round(matchScore)}%)`;
      const candidato2 = top2.prod && top2.score >= 50
        ? `\nou: ${top2.prod.name} (${Math.round(top2.score)}%)`
        : '';
      adminAlerts.push(`🤔 ${searchTerms.join(' ')} — match ambiguo. Acho que e: ${candidato1}${candidato2}\nNAO dei baixa. Confirma o nome exato.`);
      await _logVisionDecision(p, 'ambiguo', matched, matchScore, 0);
      continue;
    }

    // Score >= 80: match firme. Se top2 tambem e alto e PROXIMO do top1, ainda e ambiguo.
    if (top2.score >= 75 && (top1.score - top2.score) < 8) {
      adminAlerts.push(`🤔 2 produtos parecidos: "${matched.name}" (${Math.round(top1.score)}%) vs "${top2.prod.name}" (${Math.round(top2.score)}%). NAO dei baixa. Qual e o certo?`);
      await _logVisionDecision(p, 'ambiguo', matched, matchScore, 0);
      continue;
    }

    if ((matched.qty_available || 0) <= 0) {
      adminAlerts.push(`⚠️ ${matched.name} — estoque ja zerado, alguem quis vender o que nao tem.`);
      await _logVisionDecision(p, 'estoque_zerado', matched, matchScore, 0);
      continue;
    }

    // Baixa estoque
    const oldQty = matched.qty_available || 0;
    const newQty = Math.max(0, oldQty - qty);
    const updateData = {
      qty_available: newQty,
      total_sold: (matched.total_sold || 0) + qty,
      updated_at: new Date().toISOString(),
    };

    // 02/05 patch — se produto ainda não tem foto da caixa, salva a foto que
    // Andrade mandou agora (Vision já confirmou que é esse produto). Upload
    // best-effort: se falhar, baixa estoque mesmo assim.
    if (!matched.box_photo_url && cachedBoxBuffer) {
      try {
        const ext = (cachedBoxMime.includes('png') ? 'png' : 'jpg');
        const path = `box-photos/${matched.slug}.${ext}`;
        const upUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
        const upR = await fetch(upUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY,
            'Content-Type': cachedBoxMime, 'x-upsert': 'true',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
          body: cachedBoxBuffer,
        });
        if (upR.ok) {
          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
          updateData.box_photo_url = publicUrl;
          // metadata também atualiza pra próxima Vision pegar
          updateData.metadata = { ...(matched.metadata || {}), box_photo_url: publicUrl };
        }
      } catch (e) { console.warn('[handleStockPhoto] box_photo upload:', e.message); }
    }

    const updated = await sbUpdate('drope_products', `id=eq.${matched.id}`, updateData);

    if (updated) {
      const boxTag = updateData.box_photo_url ? ' 📦+' : '';
      results.push(`✅ -${qty} ${matched.name}${boxTag} | restam: ${newQty}`);
      // OSSO 35 (FIX 3D) — log da decisao pra suporte de aprendizado por correcao
      await _logVisionDecision(p, 'baixa', matched, matchScore, qty);
      // Log auditoria (best-effort)
      logSystemEvent('stock_photo_deduct', {
        product_id: matched.id,
        product_name: matched.name,
        qty_deducted: qty,
        qty_before: oldQty,
        qty_after: newQty,
        box_photo_saved: !!updateData.box_photo_url,
      }, phone).catch(() => {});

      // Alertas adicionais
      if (newQty === 0) {
        results.push(`🔴 ZEROU o estoque de ${matched.name}`);
      } else if (newQty <= 2) {
        results.push(`⚠️ estoque baixo! so restam ${newQty}`);
      }
    } else {
      adminAlerts.push(`❌ erro ao dar baixa em ${matched.name}`);
      await _logVisionDecision(p, 'erro', matched, matchScore, 0);
    }
  }

  // OSSO 35 + FAXINA 07/05/2026 — Envio final em 3 destinos:
  //   1. Grupo (ou privado original): só sucessos (✅ baixa, 🔴 zerou pos-baixa, ⚠️ estoque baixo)
  //   2. ADMIN_LUCAS privado: problemas que precisam intervencao manual
  //   3. Grupo PDV: confirmacao curta pro vendedor saber que o bot processou
  //      (antes Yasmin ficava no escuro quando produto nao tava cadastrado)
  if (results.length > 0) {
    await sendText(phone, results.join('\n'), body);
  }
  if (adminAlerts.length > 0) {
    if (isFromGroup) {
      // Mensagem do grupo: alerta vai pro Andrade no privado
      const header = `🦎 ALERTA PDV (grupo Estoque):`;
      await sendText(ADMIN_LUCAS, [header, ...adminAlerts].join('\n'), body);
      // Feedback CURTO no grupo pra vendedor saber que o bot viu (sem expor specs)
      if (results.length === 0) {
        // Soh alerta, nenhuma baixa: vendedor precisa saber pra entregar mesmo assim
        const naoEncontrei = adminAlerts.filter(a => a.startsWith('❓')).length;
        const ambiguos = adminAlerts.filter(a => a.startsWith('🤔')).length;
        const erros = adminAlerts.filter(a => a.startsWith('❌') || a.startsWith('⚠️')).length;
        let msgGrupo = '';
        if (naoEncontrei > 0) {
          msgGrupo = `❓ ${naoEncontrei === 1 ? 'pod' : naoEncontrei + ' pods'} não cadastrado${naoEncontrei > 1 ? 's' : ''} ainda. Já avisei o Andrade — pode entregar pro cliente, ele cadastra depois.`;
        } else if (ambiguos > 0) {
          msgGrupo = `🤔 ${ambiguos === 1 ? 'pod' : ambiguos + ' pods'} com nome parecido — não dei baixa pra não errar. Andrade vai confirmar.`;
        } else if (erros > 0) {
          msgGrupo = `⚠️ deu ruim no estoque desse pod. Andrade ja foi avisado.`;
        }
        if (msgGrupo) await sendText(phone, msgGrupo, body);
      }
    } else if (phone === ADMIN_LUCAS) {
      // Andrade no privado dele mesmo: junta tudo numa msg
      await sendText(phone, adminAlerts.join('\n'), body);
    } else {
      // Outro PDV no privado (Pai, Tia, Yasmin diretamente): manda problema pra eles + copia pro Andrade
      await sendText(phone, adminAlerts.join('\n'), body);
      await sendText(ADMIN_LUCAS, [`🦎 ALERTA PDV (vindo do privado de ${phone.slice(0,6)}***):`, ...adminAlerts].join('\n'), body);
    }
  }
}

// ============ ATENDIMENTO CLIENTE (Claude Haiku) ============
const SYSTEM_CUSTOMER = `${IA_SERVO_PREAMBULO}Voce e o assistente virtual da Drope, loja de pods descartaveis em Sao Paulo.

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

// OSSO 22 — SOMMELIER. System prompt enriquecido com contexto do cliente
// e produtos REAIS do catálogo. Substitui o SYSTEM_CUSTOMER quando dá pra
// fazer match de produto (busca por sabor/marca/vibe).
const SOMMELIER_SYSTEM_TPL = `${IA_SERVO_PREAMBULO}Voce e o sommelier do Drope 🦎 — tabacaria digital de Vila Prudente, SP.

REGRAS:
1. NUNCA invente produto/preco. So sugira o que aparece em "PRODUTOS ENCONTRADOS".
2. Maximo 3 sugestoes por resposta, ordenadas por relevancia.
3. Formato quando achar produto:
   "🦎 achei N que combinam:
   1. [Nome] — R$ [preco]
   2. [Nome] — R$ [preco]
   qual te interessa?"
4. Se cliente escolher 1: "fechado! pra finalizar: drope-app.vercel.app ou retira na loja Vila Prudente?"
5. Se nao tem nada parecido na lista: "🦎 nao tenho esse agora. quer que eu te avise quando chegar?"
6. Tom: lo-fi authentic, Gen Z favela Vila Prudente. Minusculas. Max 1-2 emojis. Curto (2-4 linhas WhatsApp).
7. Se a primeira mensagem da sessao tiver historico do cliente, USA: "fala {nome}! da ultima vez voce dropou {ultimo}. quer de novo ou algo diferente?"
8. NUNCA usa menu numerado generico, NUNCA "delicioso, incrivel, experimente".
9. Se cliente disser "sim, me avisa" depois de produto esgotado, voce SO confirma: "anotado, te aviso assim que chegar 🦎". O sistema registra automatico.

CONTEXTO DO CLIENTE:
{customer_block}

{products_block}`;

// Busca produtos no catálogo relevantes pra mensagem do cliente. Score:
// +10 por keyword direto no nome/marca/modelo/sabor; +5 por match de vibe;
// +3 se brand match; +2 se modelo match exato.
async function searchProductsForBot(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q || q.length < 2) return [];
  const rows = await sbGet('drope_products',
    'select=id,slug,name,price_cents,qty_available,flavor_category,metadata,descricao_quebrada' +
    '&hidden=eq.false&image_status=eq.ok&qty_available=gt.0&limit=80');
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const words = q.split(/\s+/).filter(w => w.length >= 2);
  const isVibeFruity  = /\b(frut|fruit|mang|manga|grape|uva|strawberry|morango|berry|peach|pessego|pêssego|apple|maca|maçã|melancia|watermelon|aloe|abacaxi|pineapple|coco|coconut|cherry|cereja|maracuja|maracujá|passion|lima|lime|limao|limão|lemon|tropical|fruta)\b/.test(q);
  const isVibeIcy     = /\b(gelad[ao]|ice|frio|refrescante|freeze|frost|cool|frozen)\b/.test(q);
  const isVibeSweet   = /\b(doce|sweet|candy|caramel|baunilha|vanilla|chocolate|sobremesa|gum|bubblegum|cream|creme|cake|cookie)\b/.test(q);
  const isVibeMenthol = /\b(mentol|menthol|mint|menta|hortela|hortelã|spearmint|peppermint)\b/.test(q);
  const isVibeTobacco = /\b(tabaco|tobacco|cigar|cuban|classic)\b/.test(q);

  const scored = rows.map(p => {
    const meta = p.metadata || {};
    const brand = String(meta.brand || '').toLowerCase();
    const model = String(meta.model || '').toLowerCase();
    const flavorPt = String(meta.flavor_pt || '').toLowerCase();
    const flavorEn = String(meta.flavor_en || '').toLowerCase();
    const desc = String(p.descricao_quebrada || '').toLowerCase();
    const haystack = `${p.name} ${brand} ${model} ${flavorPt} ${flavorEn} ${desc} ${p.flavor_category || ''}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (haystack.includes(w)) score += 10;
      if (brand && brand === w) score += 3;
      if (model && model === w) score += 2;
    }
    if (isVibeFruity  && p.flavor_category === 'fruity')  score += 5;
    if (isVibeIcy     && p.flavor_category === 'icy')     score += 5;
    if (isVibeSweet   && p.flavor_category === 'sweet')   score += 5;
    if (isVibeMenthol && p.flavor_category === 'menthol') score += 5;
    if (isVibeTobacco && p.flavor_category === 'tobacco') score += 5;
    return {
      id: p.id, slug: p.slug, name: p.name,
      price: (p.price_cents || 0) / 100,
      brand, model, flavor: flavorPt || flavorEn,
      flavor_category: p.flavor_category || 'other',
      stock: p.qty_available || 0,
      score,
    };
  });
  return scored
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// Busca contexto do cliente (perfil + último produto) pra injetar no prompt.
async function getCustomerContextByPhone(phone) {
  if (!phone) return null;
  const phoneClean = String(phone).replace(/\D/g, '');
  if (!phoneClean) return null;
  const rows = await sbGet('drope_customers',
    `phone=eq.${phoneClean}&select=id,name,flavor_profile,favorite_flavor,favorite_brand,total_orders,last_order_date,last_product_id&limit=1`);
  const c = rows[0];
  if (!c) return null;
  let lastProductName = null;
  if (c.last_product_id) {
    const lp = await sbGet('drope_products', `id=eq.${c.last_product_id}&select=name&limit=1`);
    lastProductName = lp[0]?.name || null;
  }
  const daysAgo = c.last_order_date
    ? Math.floor((Date.now() - new Date(c.last_order_date).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  return {
    id: c.id,
    name: c.name || null,
    flavor_profile: c.flavor_profile || {},
    favorite_flavor: c.favorite_flavor || null,
    favorite_brand: c.favorite_brand || null,
    total_orders: c.total_orders || 0,
    last_product_name: lastProductName,
    days_since_order: daysAgo,
  };
}

function formatCustomerBlock(ctx) {
  if (!ctx) return '- Cliente novo (sem historico). Trate como primeira visita.';
  const lines = [];
  lines.push(`- Nome: ${ctx.name || 'sem nome registrado'}`);
  if (ctx.total_orders > 0) {
    lines.push(`- Total de drops: ${ctx.total_orders}`);
    if (ctx.last_product_name) {
      const days = (typeof ctx.days_since_order === 'number')
        ? (ctx.days_since_order === 0 ? 'hoje' : (ctx.days_since_order === 1 ? 'ontem' : `ha ${ctx.days_since_order} dias`))
        : 'sem data';
      lines.push(`- Ultimo drop: ${ctx.last_product_name} (${days})`);
    }
    if (ctx.favorite_flavor) lines.push(`- Sabor favorito: ${labelFlavor(ctx.favorite_flavor)}`);
    if (ctx.favorite_brand) lines.push(`- Marca favorita: ${ctx.favorite_brand}`);
  } else {
    lines.push('- Cliente capturado mas ainda nao comprou.');
  }
  return lines.join('\n');
}

function formatProductsBlock(matches) {
  if (!matches || matches.length === 0) return '';
  const list = matches.map((p, i) => {
    return `${i + 1}. ${p.name} | R$ ${p.price.toFixed(2).replace('.', ',')} | sabor: ${labelFlavor(p.flavor_category)} | estoque: ${p.stock}`;
  }).join('\n');
  return `PRODUTOS ENCONTRADOS NO CATALOGO (use APENAS estes na resposta):\n${list}`;
}

// Detecção de reorder. Pega só intenção clara (não "tô comprando o de sempre da padaria").
const REORDER_PATTERNS = /\b(quero\s+(de\s+)?novo|de\s+novo|repete|repetir|mesmo\s+de\s+sempre|o\s+de\s+sempre|dropar\s+de\s+novo|mais\s+um|igual\s+(ao\s+)?(ultimo|último)|igual\s+a\s+ultima|ultim[ao]\s+vez)\b/i;

// Registra interesse do cliente em um produto/sabor que não tem em estoque.
// Idempotente via UNIQUE INDEX customer_id + lower(interest) WHERE waiting.
async function registerInterest(customerId, interestText) {
  if (!customerId || !interestText) return null;
  const clean = String(interestText).trim().slice(0, 200);
  if (!clean) return null;
  // Tenta inserir; se já existe (waiting), supabase devolve erro 409 e seguimos.
  const inserted = await sbInsert('drope_customer_interests', {
    customer_id: customerId,
    interest: clean,
    status: 'waiting',
  });
  return inserted;
}

// Cache em memória (5 min) do último termo buscado por cliente — captura
// confirmação "sim" subsequente quando bot ofereceu "te aviso quando chegar".
// É só pra serverless quente; quando esfria, o cliente confirma de outra forma.
const __lastQuery = new Map();
const LAST_QUERY_TTL = 5 * 60 * 1000;
function writeLastQuery(phone, data) {
  if (!phone) return;
  __lastQuery.set(phone, { ...data, at: Date.now() });
  // GC simples
  if (__lastQuery.size > 200) {
    const cutoff = Date.now() - LAST_QUERY_TTL;
    for (const [k, v] of __lastQuery) if (v.at < cutoff) __lastQuery.delete(k);
  }
}
function readLastQuery(phone) {
  const v = __lastQuery.get(phone);
  if (!v) return null;
  if (Date.now() - v.at > LAST_QUERY_TTL) { __lastQuery.delete(phone); return null; }
  return v;
}
function clearLastQuery(phone) {
  __lastQuery.delete(phone);
}

// ============ GERAÇÃO DE ARTE EM BACKGROUND ============
// Lê produto, roda Grok grok-2-image, faz upload, atualiza banco e manda imagem.
// Roda em invocação Vercel separada (acionada por fetch sem await) — tem 60s de
// timeout próprio, não bloqueia o webhook original do UazAPI.
async function runArtGeneration(productId, phone, attempt) {
  console.log(`[runArtGeneration] START productId=${productId} phone=${phone?.slice(0,6)}*** attempt=${attempt}`);
  let rows = await sbGet('drope_products', `id=eq.${productId}&select=id,name,image_url,image_status,metadata,price_cents,reference_image_url,box_photo_url,ref_status&limit=1`);
  let product = rows[0];
  if (!product) {
    console.error('[runArtGeneration] product not found:', productId);
    // FIX TARDE 7: NUNCA falhar silenciosa. Manda msg pro Lucas sempre.
    if (phone) {
      try {
        await sendText(phone, `⚠️ produto id=${productId} sumiu do banco.\n\n• 'gerar arte' — resolve depois`, {});
      } catch (e) { console.error('[runArtGeneration] sendText fail:', e.message); }
    }
    return;
  }

  // FLC FASE 4 (07/05/2026) — Se nao tem reference_image_url, tenta autoFindReference primeiro
  // (Vision compara com box_photo_url como ground truth). Sem referencia, IMG2IMG nao roda
  // e a arte sai genérica em TEXT-ONLY. Auto-discover aqui evita esse problema.
  if (!product.reference_image_url && SERPER_API_KEY) {
    console.log(`[runArtGeneration] sem ref — tentando autoFindReference primeiro`);
    try {
      const refUrl = await autoFindReference(product);
      if (refUrl) {
        // Re-busca product com a nova ref
        rows = await sbGet('drope_products', `id=eq.${productId}&select=id,name,image_url,image_status,metadata,price_cents,reference_image_url,box_photo_url,ref_status&limit=1`);
        product = rows[0] || product;
      }
    } catch (e) { console.warn('[runArtGeneration] autoFindReference:', e.message); }
  }

  const meta = product.metadata || {};
  const brand = meta.brand;
  const model = meta.model || '';
  const flavor = meta.flavor_en || meta.flavor_pt;
  const cores = meta.cores_predominantes;
  let deviceVisual = meta.device_visual;
  let deviceVisualDetailed = meta.device_visual_detailed;
  const flavorElements = meta.flavor_elements;
  const fullName = product.name;
  const slug = slugify(brand || 'pod', model, flavor || 'art');

  console.log(`[runArtGeneration] starting productId=${productId}, attempt=${attempt}, hasRef=${!!product.reference_image_url}`);

  // OSSO 34.6 — IMG2IMG principal, TEXT-ONLY fallback:
  // Com referência → Grok /v1/images/edits (manda foto real, transforma cenário ao redor)
  // Sem referência → Grok /v1/images/generations (gera tudo do zero com texto)
  // IMG2IMG COMPROVADO: gerou arte perfeita do EBCREATE BC PRO 40K (05/05/2026)
  const qcDeviceDesc = deviceVisualDetailed || deviceVisual || `${brand || ''} ${model || ''} pod device`.trim();
  let pendingArtUrl = null;
  const maxQcAttempts = 2;
  let qcAttempt = 0;
  let qcFeedback = '';

  while (qcAttempt < maxQcAttempts && !pendingArtUrl) {
    qcAttempt++;
    const currentAttempt = attempt + qcAttempt - 1;
    const mode = product.reference_image_url ? 'IMG2IMG' : 'TEXT-ONLY';
    console.log(`[runArtGeneration] ${mode} attempt ${qcAttempt}/${maxQcAttempts}, productId=${productId}`);

    // generatePadraoAPlus detecta reference_image_url e escolhe img2img vs text-only
    const grokDataUrl = await generatePadraoAPlus(brand, model, flavor, cores, deviceVisual, currentAttempt, flavorElements, deviceVisualDetailed, product, qcFeedback);
    console.log(`[runArtGeneration] generatePadraoAPlus productId=${productId}: ${grokDataUrl ? 'GOT URL' : 'NULL'}`);

    if (!grokDataUrl) break;

    const imgData = await downloadImage(grokDataUrl);
    console.log(`[runArtGeneration] downloadImage productId=${productId}: ${imgData ? 'OK' : 'FAILED'}`);
    if (!imgData) break;

    // QC com Vision — Rutem avalia (FIX REF QA v3: agora compara visual com ref + box_photo)
    const qcResult = await evaluateArtQuality(imgData, fullName, flavor, qcDeviceDesc, product.reference_image_url, product.box_photo_url);
    console.log(`[runArtGeneration] QC productId=${productId}: approved=${qcResult.approved}, score=${qcResult.score}`);

    // FIX TIER 1.3 (08/05/2026 - Andrade) — QC threshold rigoroso.
    // Antes: qcAttempt >= maxAttempts FORÇAVA aprovação mesmo com score 5.5 (arte
    // ruim entrava no app). Agora: se score < 5 mesmo após maxAttempts, NAO aprova
    // — vira needs_manual_photo e Andrade decide via WhatsApp.
    const QC_HARD_FLOOR = 5; // abaixo disso, nunca aceita
    const shouldAccept = qcResult.approved || (qcAttempt >= maxQcAttempts && qcResult.score >= QC_HARD_FLOOR);
    if (shouldAccept) {
      const uploadName = currentAttempt > 1 ? `${slug}-v${currentAttempt}` : slug;
      const sealedImgData = await applyDropeSeal(imgData);
      pendingArtUrl = await uploadToStorage(uploadName, sealedImgData, 'image/png');
      console.log(`[runArtGeneration] uploadToStorage productId=${productId}: ${pendingArtUrl ? 'OK' : 'FAILED'}`);

      const qcMeta = {
        qc_score: qcResult.score, qc_approved: qcResult.approved, qc_attempts: qcAttempt,
        art_mode: product.reference_image_url ? 'img2img' : 'text_only',
      };
      if (qcResult.issues?.length) qcMeta.qc_issues = qcResult.issues;
      await sbUpdate('drope_products', `id=eq.${productId}`, {
        metadata: { ...meta, ...qcMeta, last_art_attempt: currentAttempt }
      });
    } else if (qcAttempt >= maxQcAttempts) {
      // Score < 5 mesmo apos maxAttempts → arte ruim, nao aceita
      console.warn(`[runArtGeneration] HARD REJECT productId=${productId}: score=${qcResult.score} < ${QC_HARD_FLOOR} apos ${qcAttempt} attempts`);
      const qcMeta = {
        qc_score: qcResult.score, qc_approved: false, qc_attempts: qcAttempt,
        qc_hard_rejected: true,
        qc_issues: qcResult.issues || [],
        art_mode: product.reference_image_url ? 'img2img' : 'text_only',
      };
      await sbUpdate('drope_products', `id=eq.${productId}`, {
        image_status: 'needs_manual_photo',
        art_status: 'needs_manual_photo',
        metadata: { ...meta, ...qcMeta },
      });
      // Notifica Andrade via WhatsApp em vez de apenas log silencioso
      try {
        await sendText(phone || ADMIN_LUCAS,
          `⚠️ *${fullName}*\n\n` +
          `Grok não conseguiu gerar arte boa (QC ${qcResult.score}/10 após ${qcAttempt} tentativas)\n\n` +
          `Issues: ${(qcResult.issues || []).slice(0, 2).join('; ').slice(0, 200)}\n\n` +
          `📸 *Manda foto manual* desse produto que eu uso direto`,
          {});
      } catch (_) {}
      return;
    } else {
      qcFeedback = qcResult.feedback || (qcResult.issues || []).join('. ');
      console.log(`[runArtGeneration] QC REJECTED productId=${productId}, feedback: ${qcFeedback}`);
    }
  }

  console.log(`[runArtGeneration] RESULT productId=${productId}: ${pendingArtUrl ? 'SUCCESS' : 'FAILED'}`);

  if (!pendingArtUrl) {
    console.warn('[runArtGeneration] generation failed for productId:', productId);
    await sbUpdate('drope_products', `id=eq.${productId}`, { image_status: 'error' });
    await setPending(phone, { mode: 'art_review_failed', productId, fullName });
    await sendText(phone,
      `⚠️ arte de *${fullName}* não gerou\n\n(provavelmente xAI/Grok fora ou sem crédito)\n\n` +
      `responde:\n` +
      `• manda uma foto do pod → uso a tua\n` +
      `• 'depois' pra resolver mais tarde no /admin`,
      {});
    return;
  }

  // Sucesso: atualiza banco com pending_art_url + status awaiting_approval
  // FIX 07/05/2026: re-lê metadata atualizado do banco (qcMeta foi escrito dentro
  // do while loop). Antes spread do `meta` ORIGINAL apagava qc_score/qc_approved
  // que tinham acabado de ser gravados.
  const fresh = await sbGet('drope_products', `id=eq.${productId}&select=metadata&limit=1`);
  const freshMeta = fresh?.[0]?.metadata || meta;
  const newMeta = { ...freshMeta, pending_art_url: pendingArtUrl, last_art_attempt: attempt };
  await sbUpdate('drope_products', `id=eq.${productId}`, {
    image_status: 'awaiting_approval',
    art_status: 'complete',
    metadata: newMeta,
  });

  await setPending(phone, {
    mode: 'art_review',
    productId,
    fullName,
    attempts: attempt,
    brand, model, flavor, cores, deviceVisual,
  });

  // Manda mensagem pro WhatsApp em 3 partes: TEXTO (nome+QC) → IMAGEM → TEXTO (opções).
  // FIX 07/05/2026 (Andrade) — antes nome vinha como caption da imagem, mas WhatsApp Web
  // não renderiza caption → Andrade não sabia qual produto aprovar. Agora nome no texto antes.
  const imageToSend = pendingArtUrl;
  const lastQc = (await sbGet('drope_products', `id=eq.${productId}&select=metadata&limit=1`))?.[0]?.metadata || {};
  const qcScore = typeof lastQc.qc_score === 'number' ? Math.round(lastQc.qc_score * 10) / 10 : null;
  const qcLine = qcScore != null ? `🎯 QC=${qcScore}/10${lastQc.qc_approved ? ' (✅ auto-aprovou)' : ' (⚠️ duvidoso)'}` : '';
  const versionLine = attempt > 1 ? `🔄 versão ${attempt}` : '';
  const introMsg = [
    `🎨 *Arte gerada:* ${fullName}`,
    versionLine, qcLine,
  ].filter(Boolean).join('\n');
  await sendText(phone, introMsg, {});
  await sendImage(phone, imageToSend, '', {});
  await sendText(phone,
    "*Responde:*\n" +
    "✅ *aprova* — publica no catálogo\n" +
    "🔄 *outra* — gera de novo (variação)\n" +
    "📸 *manda foto* — uso a tua imagem\n" +
    "⏰ *depois* — fica pendente no Admin\n" +
    "❌ *rejeita* — descarta esta arte\n\n" +
    "🚀 *aprova todos* — publica todas as pendentes de uma vez",
    {});
}

// (recoverArtPending removida — tryRecoverPending acima cobre os 2 casos
// awaiting_approval e error com filtro `image_status=in.(...)`)

// ============ ADMIN GALLERY (BLOCO 1) ============
// Tela web pra Andrade aprovar/rejeitar arte + setar barcode/preço.
// Auth: ?token=ADMIN_TOKEN no GET, header x-admin-token no POST.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function galleryHtml(awaiting, approved, token) {
  const renderCard = (p, isApproved) => {
    const m = p.metadata || {};
    const generatedArt = isApproved ? p.image_url : (m.pending_art_url || p.image_url || '');
    // OSSO-GALLERY-SIDE-BY-SIDE (03/06/2026): pra aprovação, mostra foto da caixa
    // que o Andrade tirou no scanner LADO A LADO com a arte do Grok. Permite
    // validação visual: "essa arte realmente representa o produto que tirei foto?"
    const boxPhoto = p.box_photo_url || m.box_photo_url || '';
    const fullName = escapeHtml(p.name || '');
    const brand = escapeHtml(m.brand || '');
    const model = escapeHtml(m.model || '');
    const flavor = escapeHtml(m.flavor_en || m.flavor_pt || '');
    const priceVal = p.price_cents ? (p.price_cents / 100).toFixed(2) : '';
    const barcode = escapeHtml(p.barcode || '');
    const id = escapeHtml(p.id);
    // Approved: só arte final (histórico). Awaiting: side-by-side pra validação.
    const thumbBlock = isApproved
      ? `<div class="thumb">${generatedArt ? `<img src="${escapeHtml(generatedArt)}" alt="${fullName}">` : '<div class="no-art">sem arte</div>'}</div>`
      : `<div class="compare">
           <div class="compare-side">
             <div class="compare-label">📸 sua foto</div>
             ${boxPhoto ? `<img src="${escapeHtml(boxPhoto)}" alt="foto da caixa">` : '<div class="no-art">sem foto</div>'}
           </div>
           <div class="compare-side">
             <div class="compare-label">✨ arte Grok</div>
             ${generatedArt ? `<img src="${escapeHtml(generatedArt)}" alt="${fullName}">` : '<div class="no-art">sem arte</div>'}
           </div>
         </div>`;
    return `
      <div class="card" data-id="${id}">
        ${thumbBlock}
        <div class="info">
          <div class="name">${fullName}</div>
          <div class="meta">${brand} ${model} ${flavor}</div>
        </div>
        ${isApproved ? '' : `
        <div class="inputs">
          <input type="text" data-field="barcode" placeholder="EAN do produto" value="${barcode}">
          <input type="number" step="0.01" data-field="price" placeholder="Preço em R$" value="${priceVal}">
        </div>
        <div class="actions">
          <button class="btn approve" data-op="approve">aprovar ✓</button>
          <button class="btn regen" data-op="regenerate">regenerar 🔄</button>
          <button class="btn reject" data-op="reject">rejeitar ✕</button>
        </div>
        <div class="status"></div>
        `}
      </div>`;
  };

  return `<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8">
<title>Drope ✦ Admin Gallery</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { --bg: #0a0a0a; --neon: #b026ff; --lime: #c0ff33; --pink: #ff2d95; --txt: #fff; --dim: #888; --card: #111; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--txt); font-family: -apple-system, system-ui, sans-serif; padding: 16px; }
h1 { color: var(--neon); margin: 0 0 8px; font-size: 22px; }
h2 { color: var(--dim); margin: 24px 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
.card { background: var(--card); border: 1px solid var(--neon); border-radius: 12px; overflow: hidden; box-shadow: 0 0 18px rgba(176,38,255,.15); display: flex; flex-direction: column; }
.thumb { aspect-ratio: 1; background: #000; overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.no-art { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--dim); font-size: 13px; padding: 8px; text-align: center; }
/* OSSO-GALLERY-SIDE-BY-SIDE: layout 2 col pra validação foto real vs arte gerada */
.compare { display: grid; grid-template-columns: 1fr 1fr; background: #000; }
.compare-side { aspect-ratio: 1; position: relative; overflow: hidden; border-right: 1px solid rgba(176,38,255,.3); }
.compare-side:last-child { border-right: none; }
.compare-side img { width: 100%; height: 100%; object-fit: cover; display: block; }
.compare-label { position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,.75); color: var(--lime); padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; z-index: 2; letter-spacing: 0.3px; }
.info { padding: 10px 12px; }
.name { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
.meta { color: var(--dim); font-size: 12px; }
.inputs { padding: 0 12px 8px; display: flex; gap: 8px; flex-direction: column; }
.inputs input { background: #000; border: 1px solid #333; color: var(--txt); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.inputs input:focus { outline: none; border-color: var(--neon); }
.actions { padding: 0 12px 12px; display: flex; gap: 6px; flex-wrap: wrap; }
.btn { flex: 1; min-width: 90px; padding: 9px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
.approve { background: var(--lime); color: #000; }
.regen { background: var(--neon); color: #fff; }
.reject { background: #333; color: #fff; }
.btn:hover { filter: brightness(1.1); }
.btn:disabled { opacity: .5; cursor: wait; }
.status { padding: 0 12px 10px; font-size: 12px; min-height: 16px; }
.status.ok { color: var(--lime); }
.status.err { color: var(--pink); }
.empty { color: var(--dim); padding: 24px; text-align: center; font-style: italic; }
.nav-links a { color: var(--neon); margin-right: 12px; text-decoration: none; font-size: 12px; }
.nav-links a:hover { text-decoration: underline; }
</style>
</head><body>
<h1>Drope ✦ Admin Gallery</h1>
<div class="nav-links" style="margin-bottom:8px">
  <a href="?action=gallery&token=${escapeHtml(token || '')}">gallery</a>
  <a href="?action=admin-customers&token=${escapeHtml(token || '')}">clientes →</a>
</div>
<p style="color:var(--dim);font-size:12px;margin:0 0 16px">${awaiting.length} aguardando aprovação · ${approved.length} aprovadas</p>

<h2>Aguardando aprovação</h2>
<div class="grid" id="grid-pending">${awaiting.length ? awaiting.map(p => renderCard(p, false)).join('') : '<div class="empty">nada esperando aprovação ✦</div>'}</div>

<h2>Aprovadas</h2>
<div class="grid" id="grid-approved">${approved.length ? approved.map(p => renderCard(p, true)).join('') : '<div class="empty">nada aprovado ainda</div>'}</div>

<script>
const TOKEN = ${JSON.stringify(token)};
document.querySelectorAll('.card').forEach(card => {
  card.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = card.dataset.id;
      const op = btn.dataset.op;
      const status = card.querySelector('.status');
      const barcode = card.querySelector('input[data-field="barcode"]')?.value.trim() || null;
      const priceReais = card.querySelector('input[data-field="price"]')?.value;
      const price_cents = priceReais ? Math.round(parseFloat(priceReais) * 100) : null;

      card.querySelectorAll('.btn').forEach(b => b.disabled = true);
      status.className = 'status';
      status.textContent = 'processando...';
      try {
        const r = await fetch('/api/webhook?action=gallery_action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
          body: JSON.stringify({ id, op, barcode, price_cents }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
        status.className = 'status ok';
        status.textContent = data.message || 'ok';
        if (op === 'approve') {
          card.style.transition = 'opacity .4s';
          card.style.opacity = '0';
          setTimeout(() => card.remove(), 500);
        }
      } catch (e) {
        status.className = 'status err';
        status.textContent = 'erro: ' + e.message;
        card.querySelectorAll('.btn').forEach(b => b.disabled = false);
      }
    });
  });
});
</script>
</body></html>`;
}

// ===== ESTEIRA (08/05/2026) =====
// Tela única que junta sem-sabor + pendentes + gallery numa esteira contínua.
// Andrade pediu: "podiam ficar todos numa tela só, em apenas uma tela eu faria tudo".
// Reaproveita endpoints POST existentes:
//   - complete_unidentified (sem-sabor → cria produto)
//   - admin-approve-product (pendentes → approve / regenerate / reject)
//   - gallery_action (gallery → approve / regenerate / reject)
async function handleEsteiraView(req, res) {
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
  const params = {};
  qs.split('&').forEach(p => {
    const [k, v] = p.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  if (!ADMIN_TOKEN || params.token !== ADMIN_TOKEN) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send('<h1 style="color:#ff2d95;font-family:sans-serif">unauthorized</h1>');
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).send('supabase not configured');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  try {
    // 4 queries em paralelo (sem-sabor + pendentes + gallery + completar-specs)
    const [unidentifiedRows, pendingRows, awaitingRows, specsRows] = await Promise.all([
      sbGet('drope_batch_queue',
        `select=id,batch_id,photo_index,photo_url,vision_response,error_message,created_at&decision=eq.unidentified_flavor&order=created_at.desc&limit=200`),
      sbGet('drope_products',
        `or=(image_status.eq.pending_pod_photo,art_status.in.(pending_review,needs_manual_photo,pending_reference),image_url.is.null)` +
        `&image_status=neq.removed` +
        `&select=id,name,barcode,box_photo_url,reference_image_url,reference_candidates,image_status,art_status,metadata,updated_at,image_url,price_cents,qty_available` +
        `&order=created_at.desc&limit=200`),
      sbGet('drope_products',
        'or=(image_status.eq.awaiting_approval,and(art_status.eq.complete,image_url.is.null))&order=updated_at.desc&limit=200'),
      // FASE 4 (08/05/2026) — produtos aprovados (image_status=ok + image_url not null) MAS sem preço ou EAN
      sbGet('drope_products',
        `image_status=eq.ok&image_url=not.is.null&or=(price_cents.eq.0,price_cents.is.null,barcode.is.null,barcode.eq.)` +
        `&select=id,name,barcode,box_photo_url,image_url,price_cents,metadata,qty_available,updated_at` +
        `&order=updated_at.desc&limit=200`),
    ]);

    // Dedup sem-sabor por (batch_id, photo_index) e exige photo_url
    const seenK = new Set();
    const unidentified = [];
    for (const r of (unidentifiedRows || [])) {
      const k = `${r.batch_id}:${r.photo_index}`;
      if (seenK.has(k)) continue;
      seenK.add(k);
      if (r.photo_url) unidentified.push(r);
    }

    // Stale ref guard pros pendentes (mesma lógica do pending_pod_photos)
    const STALE_REF_MS = 3 * 60 * 1000;
    const now = Date.now();
    for (const p of (pendingRows || [])) {
      if (p.art_status === 'pending_reference') {
        const refsLen = Array.isArray(p.reference_candidates) ? p.reference_candidates.length : 0;
        const ageMs = p.updated_at ? (now - new Date(p.updated_at).getTime()) : Infinity;
        if (refsLen === 0 && ageMs > STALE_REF_MS) {
          p.art_status = 'needs_manual_photo';
          p._stale_search = true;
        }
      }
    }

    return res.status(200).send(pipelineHtml(unidentified, pendingRows || [], awaitingRows || [], specsRows || [], params.token));
  } catch (e) {
    console.error('[esteira] error:', e.message);
    return res.status(500).send('<h1 style="color:#ff2d95;font-family:sans-serif">erro: ' + (e.message || '') + '</h1>');
  }
}

function esteiraHtml(unidentified, pending, awaiting, specs, token) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // === FASE 1: SEM SABOR (cards do batch_queue) ===
  const semSaborCards = unidentified.map(r => {
    let brand = '?', model = '';
    try {
      const vis = typeof r.vision_response === 'string' ? JSON.parse(r.vision_response) : r.vision_response;
      const p = vis?.products?.[0] || {};
      brand = p.brand || '?';
      model = p.model || '';
    } catch (_) {}
    return `
      <div class="card sem-sabor" data-batch-id="${esc(r.batch_id)}" data-photo-idx="${esc(r.photo_index)}">
        <div class="thumb"><img src="${esc(r.photo_url)}" loading="lazy" alt="foto"/></div>
        <div class="meta">
          <div class="info"><span class="brand">${esc(brand)}</span> <span class="model">${esc(model)}</span></div>
          <input type="text" class="flavor-input" placeholder="digita o sabor (ex: Strawberry Kiwi)" />
          <div class="actions">
            <button class="btn complete" data-op="ss-complete">✅ cadastrar</button>
            <button class="btn discard" data-op="ss-discard">🗑️ descartar</button>
          </div>
          <div class="status"></div>
        </div>
      </div>`;
  }).join('');

  // === FASE 2: PENDENTES (cards de drope_products esperando ref/foto/arte) ===
  const pendentesCards = pending.map(p => {
    const m = p.metadata || {};
    const boxUrl = p.box_photo_url || m.box_photo_url || '';
    const subtitle = [m.brand, m.model, m.flavor_pt || m.flavor_en || m.flavor].filter(Boolean).join(' ✦ ');
    const refs = Array.isArray(p.reference_candidates) ? p.reference_candidates : [];
    const hasApprovedRef = !!p.reference_image_url;
    const isSearching = p.art_status === 'pending_reference';
    const needsManual = p.art_status === 'needs_manual_photo';
    const refsHtml = isSearching
      ? '<div class="refs-loading"><span class="spin"></span> buscando referências…</div>'
      : refs.length === 0
        ? '<div class="empty-refs">⚠️ sem referência boa<br/><span style="opacity:0.7">manda foto manual ou pula ref</span></div>'
        : `<div class="refs">${refs.map((r, i) => `
            <label class="ref-card${hasApprovedRef && p.reference_image_url === r.url ? ' selected' : ''}">
              <input type="radio" name="ref-${esc(p.id)}" value="${esc(r.url)}" data-product-id="${esc(p.id)}" ${hasApprovedRef && p.reference_image_url === r.url ? 'checked' : ''} />
              <img src="${esc(r.url)}" loading="lazy" alt="ref ${i+1}" />
              <span class="score">${typeof r.combined_score === 'number' ? '🎯' + r.combined_score : '⭐' + (r.quality_score || 0)}</span>
            </label>`).join('')}</div>`;
    const statusLabel =
      isSearching ? 'buscando refs' :
      needsManual ? 'sem refs' :
      p.art_status === 'pending_review' ? `${refs.length} refs` :
      p.art_status === 'reference_approved' ? 'ref aprovada' :
      p.image_status === 'pending_pod_photo' ? 'esperando foto' :
                    esc(p.art_status || p.image_status || '');
    return `
      <div class="card pendente" data-id="${esc(p.id)}" data-status="${esc(p.art_status || '')}">
        <div class="hd">
          <div class="name">${esc(p.name)}</div>
          <div class="sub">${esc(subtitle)}</div>
          <div class="status-badge status-${esc(p.art_status || p.image_status || '')}">${esc(statusLabel)}</div>
        </div>
        <div class="card-grid">
          <div class="col">
            <div class="lbl">📦 caixa</div>
            ${boxUrl
              ? `<a href="${esc(boxUrl)}" target="_blank"><img class="box-photo" src="${esc(boxUrl)}" loading="lazy" alt="caixa" /></a>`
              : '<div class="no-photo">sem foto</div>'}
          </div>
          <div class="col">
            <div class="lbl">🔎 referências</div>
            ${refsHtml}
          </div>
        </div>
        <div class="actions">
          ${refs.length > 0 ? `<button type="button" class="btn primary" data-op="p-approve-ref" data-id="${esc(p.id)}">✅ usar ref selecionada</button>` : ''}
          <label class="btn">
            📸 foto manual
            <input type="file" accept="image/*" capture="environment" data-op="p-pod-photo" data-id="${esc(p.id)}" hidden />
          </label>
          ${needsManual ? `<button type="button" class="btn" data-op="p-retry" data-id="${esc(p.id)}">🔄 buscar de novo</button>` : ''}
          <button type="button" class="btn ghost" data-op="p-skip" data-id="${esc(p.id)}">🎬 sem ref</button>
          <button type="button" class="btn ghost danger" data-op="p-remove" data-id="${esc(p.id)}">🗑️ remover</button>
        </div>
        <div class="status" id="st-p-${esc(p.id)}"></div>
      </div>`;
  }).join('');

  // === FASE 4: COMPLETAR SPECS (preço + EAN) — produtos com arte aprovada mas sem dados ===
  const specsCards = specs.map(p => {
    const m = p.metadata || {};
    const fullName = esc(p.name || '');
    const subtitle = [m.brand, m.model, m.flavor_pt || m.flavor_en || m.flavor].filter(Boolean).join(' ✦ ');
    const priceVal = p.price_cents ? (p.price_cents / 100).toFixed(2) : '';
    const barcode = esc(p.barcode || '');
    const arte = esc(p.image_url || '');
    const semPreco = !p.price_cents || p.price_cents === 0;
    const semEan = !p.barcode || p.barcode === '';
    return `
      <div class="card specs-card" data-id="${esc(p.id)}">
        <div class="thumb">${arte ? `<img src="${arte}" alt="${fullName}">` : '<div class="no-photo">sem arte</div>'}</div>
        <div class="meta">
          <div class="name">${fullName}</div>
          <div class="sub">${esc(subtitle)} ${semPreco ? '<span class="missing">⚠️ sem preço</span>' : ''} ${semEan ? '<span class="missing">⚠️ sem EAN</span>' : ''}</div>
          <div class="inputs-stack">
            <div class="input-row">
              <label>R$</label>
              <input type="number" step="0.01" min="0" data-field="price" placeholder="venda" value="${priceVal}">
            </div>
            <div class="input-row">
              <label>EAN</label>
              <input type="text" data-field="barcode" placeholder="13 dígitos" value="${barcode}" maxlength="14">
              <button class="btn ean-search" data-op="ean-search" type="button">🔎 buscar</button>
            </div>
            <div class="ean-result" style="font-size:11px;color:var(--dim);min-height:14px"></div>
          </div>
          <div class="actions">
            <button class="btn primary" data-op="save-finalize">💾 salvar e finalizar</button>
          </div>
          <div class="status"></div>
        </div>
      </div>`;
  }).join('');

  // === FASE 3: GALLERY (artes geradas esperando aprovação) ===
  const galleryCards = awaiting.map(p => {
    const m = p.metadata || {};
    const thumb = m.pending_art_url || p.image_url || '';
    const fullName = esc(p.name || '');
    const subtitle = [m.brand, m.model, m.flavor_pt || m.flavor_en || m.flavor].filter(Boolean).join(' ✦ ');
    const priceVal = p.price_cents ? (p.price_cents / 100).toFixed(2) : '';
    const barcode = esc(p.barcode || '');
    return `
      <div class="card gallery-card" data-id="${esc(p.id)}">
        <div class="thumb">${thumb ? `<img src="${esc(thumb)}" alt="${fullName}">` : '<div class="no-photo">sem arte</div>'}</div>
        <div class="meta">
          <div class="name">${fullName}</div>
          <div class="sub">${esc(subtitle)}</div>
          <div class="inputs">
            <input type="text" data-field="barcode" placeholder="EAN" value="${barcode}">
            <input type="number" step="0.01" data-field="price" placeholder="R$" value="${priceVal}">
          </div>
          <div class="actions">
            <button class="btn primary" data-op="g-approve">✓ aprovar</button>
            <button class="btn" data-op="g-regen">🔄 regerar</button>
            <button class="btn ghost danger" data-op="g-reject">✕ rejeitar</button>
          </div>
          <div class="status"></div>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR" translate="no"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0A0A14">
<meta name="google" content="notranslate">
<title>Esteira ✦ Drope</title>
<style>
:root{--bg:#0A0A14;--bg2:#14141F;--fg:#EAEAF2;--dim:#8A8AA3;--pink:#FF2D6F;--lime:#D4FF2E;--violet:#9D4EDD;--amber:#FFB800;--b:rgba(255,255,255,0.08)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:0 0 80px;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif}
header{padding:14px 16px;border-bottom:1px solid var(--b);position:sticky;top:0;background:rgba(10,10,20,.95);backdrop-filter:blur(8px);z-index:10}
.head-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
h1{margin:0;font-size:18px}h1 em{color:var(--lime);font-style:normal}
.subtitle{font-size:11px;color:var(--dim);margin-top:2px}
.tabs{display:flex;gap:8px;margin-top:12px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.tab{flex:0 0 auto;padding:8px 14px;border-radius:99px;border:1px solid var(--b);background:var(--bg2);color:var(--fg);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:6px;text-decoration:none}
.tab:hover{border-color:var(--lime)}
.tab.active{background:var(--lime);color:#000;border-color:var(--lime)}
.tab .count{background:rgba(0,0,0,.2);padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700}
.tab.active .count{background:rgba(0,0,0,.3)}
.topbtn{padding:6px 10px;border-radius:8px;background:var(--bg2);border:1px solid var(--b);color:var(--dim);font-size:12px;text-decoration:none;cursor:pointer;font-family:inherit}
section{padding:16px;max-width:900px;margin:0 auto}
.section-head{margin:8px 0 12px;display:flex;align-items:center;gap:10px}
.section-head h2{margin:0;font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:700}
.phase-tag{padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.tag-1{background:rgba(255,184,0,.15);color:var(--amber);border:1px solid var(--amber)}
.tag-2{background:rgba(157,78,221,.15);color:var(--violet);border:1px solid var(--violet)}
.tag-3{background:rgba(212,255,46,.15);color:var(--lime);border:1px solid var(--lime)}
.tag-4{background:rgba(255,45,111,.15);color:var(--pink);border:1px solid var(--pink)}
.section-helper{color:var(--dim);font-size:12px;margin-bottom:14px}
.empty{color:var(--dim);text-align:center;padding:30px;font-style:italic;font-size:13px;border:1px dashed var(--b);border-radius:10px}

/* Grids por fase */
.grid-sem-sabor{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.grid-pendentes{display:grid;grid-template-columns:1fr;gap:14px}
.grid-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}

/* Card base */
.card{background:var(--bg2);border:1px solid var(--b);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}

/* Sem-sabor card */
.card.sem-sabor .thumb{aspect-ratio:1;background:#000;overflow:hidden}
.card.sem-sabor .thumb img{width:100%;height:100%;object-fit:cover}
.card.sem-sabor .meta{padding:10px;display:flex;flex-direction:column;gap:8px}
.card.sem-sabor .info{display:flex;gap:8px;font-size:12px;color:var(--dim);flex-wrap:wrap}
.card.sem-sabor .brand{color:var(--lime);font-weight:700}
.card.sem-sabor .model{color:var(--violet)}
.flavor-input{padding:8px 10px;border-radius:8px;border:1px solid var(--b);background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit}
.flavor-input:focus{outline:none;border-color:var(--lime)}

/* Pendente card */
.card.pendente .hd{padding:12px 14px;border-bottom:1px solid var(--b);position:relative}
.card.pendente .name{font-weight:700;font-size:14px;margin-bottom:2px}
.card.pendente .sub{font-size:11px;color:var(--dim)}
.status-badge{position:absolute;top:12px;right:14px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:999px;background:var(--bg);border:1px solid var(--b);color:var(--dim);white-space:nowrap}
.status-pending_review{color:var(--lime);border-color:var(--lime)}
.status-needs_manual_photo{color:var(--amber);border-color:var(--amber)}
.status-pending_reference{color:var(--violet);border-color:var(--violet)}
.status-reference_approved{color:var(--lime);border-color:var(--lime)}
.card-grid{display:grid;grid-template-columns:140px 1fr;gap:12px;padding:12px}
@media(max-width:520px){.card-grid{grid-template-columns:1fr}}
.col .lbl{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.box-photo{width:100%;border-radius:8px;border:1px solid var(--b);max-height:140px;object-fit:cover;display:block}
.no-photo{padding:30px;text-align:center;color:var(--dim);font-size:11px;border:1px dashed var(--b);border-radius:8px;font-style:italic}
.refs{display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:6px}
.ref-card{position:relative;cursor:pointer;border:2px solid transparent;border-radius:6px;overflow:hidden;background:var(--bg)}
.ref-card.selected,.ref-card:has(input:checked){border-color:var(--lime)}
.ref-card input{position:absolute;opacity:0;pointer-events:none}
.ref-card img{width:100%;aspect-ratio:1;object-fit:cover;display:block}
.ref-card .score{position:absolute;bottom:2px;right:2px;background:rgba(0,0,0,.7);color:var(--lime);font-size:9px;padding:1px 4px;border-radius:3px;font-weight:700}
.refs-loading,.empty-refs{padding:14px;text-align:center;color:var(--dim);font-size:11px;border:1px dashed var(--b);border-radius:8px}
.spin{display:inline-block;width:10px;height:10px;border:2px solid var(--violet);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;margin-right:4px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}

/* Gallery card */
.card.gallery-card .thumb{aspect-ratio:1;background:#000;overflow:hidden}
.card.gallery-card .thumb img{width:100%;height:100%;object-fit:cover;display:block}
.card.gallery-card .meta{padding:10px;display:flex;flex-direction:column;gap:8px}
.card.gallery-card .name{font-weight:700;font-size:13px}
.card.gallery-card .sub{font-size:11px;color:var(--dim)}
.card.gallery-card .inputs{display:flex;gap:6px}
.card.gallery-card .inputs input{flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--b);background:var(--bg);color:var(--fg);font-size:12px;font-family:inherit;min-width:0}

/* Specs card (FASE 4) */
.card.specs-card .thumb{aspect-ratio:1;background:#000;overflow:hidden}
.card.specs-card .thumb img{width:100%;height:100%;object-fit:cover;display:block}
.card.specs-card .meta{padding:10px;display:flex;flex-direction:column;gap:8px}
.card.specs-card .name{font-weight:700;font-size:13px}
.card.specs-card .sub{font-size:11px;color:var(--dim)}
.card.specs-card .missing{color:var(--pink);font-weight:600;margin-left:4px;font-size:10px}
.card.specs-card .inputs-stack{display:flex;flex-direction:column;gap:6px}
.input-row{display:flex;align-items:center;gap:6px}
.input-row label{font-size:11px;color:var(--dim);width:32px;flex:0 0 32px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.input-row input{flex:1;padding:7px 9px;border-radius:6px;border:1px solid var(--b);background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit;min-width:0}
.input-row input:focus{outline:none;border-color:var(--lime)}
.btn.ean-search{flex:0 0 auto;padding:6px 8px;font-size:11px;background:transparent;border:1px solid var(--violet);color:var(--violet)}
.btn.ean-search:hover{background:var(--violet);color:#fff}
.ean-result.match{color:var(--lime)}
.ean-result.fail{color:var(--amber)}

/* Botões compartilhados */
.actions{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 12px}
.card.sem-sabor .actions,.card.gallery-card .actions{padding:0}
.btn{flex:1;min-width:80px;padding:8px;border-radius:8px;border:1px solid var(--b);background:transparent;color:var(--fg);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center}
.btn:hover{border-color:var(--lime)}
.btn.primary{background:var(--lime);color:#000;border-color:var(--lime)}
.btn.complete{border-color:var(--lime);color:var(--lime)}
.btn.complete:hover{background:var(--lime);color:#000}
.btn.discard,.btn.danger{border-color:var(--pink);color:var(--pink)}
.btn.discard:hover,.btn.danger:hover{background:var(--pink);color:#fff}
.btn.ghost{background:transparent;border-color:var(--b);color:var(--dim)}
.btn:disabled{opacity:.5;cursor:wait}
.status{padding:0 12px 10px;font-size:11px;min-height:14px}
.card.sem-sabor .status,.card.gallery-card .status{padding:0;min-height:0}
.status.ok{color:var(--lime)}
.status.err{color:var(--pink)}
</style>
</head><body>

<header>
  <div class="head-row">
    <div>
      <h1><em>🦎</em> esteira</h1>
      <div class="subtitle">tudo numa tela só — sem-sabor → pendentes → gallery</div>
    </div>
    <div style="display:flex;gap:6px">
      <a class="topbtn" href="/api/webhook?action=admin_hub&token=${esc(token)}">← hub</a>
      <button class="topbtn" onclick="location.reload()">↻</button>
    </div>
  </div>
  <div class="tabs">
    <a class="tab active" href="#all" onclick="setFilter('all')">tudo <span class="count">${unidentified.length + pending.length + awaiting.length + specs.length}</span></a>
    <a class="tab" href="#sem-sabor" onclick="setFilter('sem-sabor')">❓ sem sabor <span class="count">${unidentified.length}</span></a>
    <a class="tab" href="#pendentes" onclick="setFilter('pendentes')">📸 pendentes <span class="count">${pending.length}</span></a>
    <a class="tab" href="#gallery" onclick="setFilter('gallery')">🖼️ gallery <span class="count">${awaiting.length}</span></a>
    <a class="tab" href="#specs" onclick="setFilter('specs')">💰 specs <span class="count">${specs.length}</span></a>
  </div>
</header>

<section id="sec-sem-sabor" data-phase="sem-sabor">
  <div class="section-head">
    <h2 id="sem-sabor">fase 1 — sem sabor</h2>
    <span class="phase-tag tag-1">❓ ${unidentified.length}</span>
  </div>
  <div class="section-helper">vision viu marca/modelo mas não leu o sabor. digita e cadastra.</div>
  ${unidentified.length === 0
    ? '<div class="empty">✅ nada pendente</div>'
    : `<div class="grid-sem-sabor">${semSaborCards}</div>`}
</section>

<section id="sec-pendentes" data-phase="pendentes">
  <div class="section-head">
    <h2 id="pendentes">fase 2 — pendentes (refs + arte)</h2>
    <span class="phase-tag tag-2">📸 ${pending.length}</span>
  </div>
  <div class="section-helper">escolhe a referência boa, sobe foto manual ou pula. quem precisa de foto manual fica ambar.</div>
  ${(() => {
    const stuck = pending.filter(p => {
      const refs = Array.isArray(p.reference_candidates) ? p.reference_candidates : [];
      return refs.length === 0 && p.art_status === 'pending_reference';
    });
    return stuck.length > 0
      ? `<div style="background:rgba(255,184,0,.08);border:1px solid var(--amber);border-radius:10px;padding:12px;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
           <div style="flex:1;min-width:200px"><strong style="color:var(--amber)">⚠️ ${stuck.length} travados sem ref</strong><br/><span style="font-size:11px;color:var(--dim)">produto criado mas Serper nunca rodou. dispara em batch:</span></div>
           <button class="btn primary" id="btn-mass-kickoff" style="flex:0 0 auto">🚀 disparar refs nos ${stuck.length}</button>
           <span class="status" id="mass-kickoff-status" style="flex:1 0 100%;padding:0;font-size:12px"></span>
         </div>`
      : '';
  })()}
  ${pending.length === 0
    ? '<div class="empty">✅ nada esperando ref/foto</div>'
    : `<div class="grid-pendentes">${pendentesCards}</div>`}
</section>

<section id="sec-gallery" data-phase="gallery">
  <div class="section-head">
    <h2 id="gallery">fase 3 — gallery (aprovar arte)</h2>
    <span class="phase-tag tag-3">🖼️ ${awaiting.length}</span>
  </div>
  <div class="section-helper">arte gerada, aprova → vai pra fase 4 (preço/EAN).</div>
  ${awaiting.length === 0
    ? '<div class="empty">✅ nada esperando aprovação</div>'
    : `<div class="grid-gallery">${galleryCards}</div>`}
</section>

<section id="sec-specs" data-phase="specs">
  <div class="section-head">
    <h2 id="specs">fase 4 — completar specs (preço + EAN)</h2>
    <span class="phase-tag tag-4">💰 ${specs.length}</span>
  </div>
  <div class="section-helper">arte aprovada mas falta preço ou EAN. clica 🔎 buscar pra IA achar EAN no Google. ao salvar com os 2 campos preenchidos, produto vira visível no app.</div>
  ${specs.length === 0
    ? '<div class="empty">✅ tudo finalizado — sem produtos pendentes de specs</div>'
    : `<div class="grid-gallery">${specsCards}</div>`}
</section>

<script>
const TOKEN = ${JSON.stringify(token)};

function setFilter(which) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const tab = document.querySelector('.tab[href="#' + which + '"]') || document.querySelector('.tab[href="#all"]');
  tab.classList.add('active');
  const sections = document.querySelectorAll('section[data-phase]');
  sections.forEach(s => {
    if (which === 'all') s.style.display = '';
    else s.style.display = (s.dataset.phase === which) ? '' : 'none';
  });
}

async function api(action, body, method = 'POST') {
  const r = await fetch('/api/webhook?action=' + action, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

async function adminApi(path, body, method = 'POST') {
  const sep = path.includes('?') ? '&' : '?';
  const url = path + sep + 'token=' + encodeURIComponent(TOKEN);
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

// ===== FASE 1: SEM SABOR =====
document.querySelectorAll('.card.sem-sabor').forEach(card => {
  const batchId = card.dataset.batchId;
  const photoIdx = parseInt(card.dataset.photoIdx);
  const input = card.querySelector('.flavor-input');
  const status = card.querySelector('.status');
  card.querySelector('[data-op="ss-complete"]').onclick = async () => {
    const flavor = input.value.trim();
    if (flavor.length < 2) { status.textContent = '⚠️ digita o sabor'; status.className = 'status err'; return; }
    status.textContent = 'cadastrando...'; status.className = 'status';
    try {
      const data = await api('complete_unidentified', { batch_id: batchId, photo_index: photoIdx, flavor });
      status.className = 'status ok'; status.textContent = data.message || '✓ cadastrado';
      card.style.transition = 'opacity .4s'; card.style.opacity = '0';
      setTimeout(() => card.remove(), 500);
    } catch (e) { status.className = 'status err'; status.textContent = e.message; }
  };
  card.querySelector('[data-op="ss-discard"]').onclick = async () => {
    if (!confirm('descartar essa foto?')) return;
    status.textContent = 'descartando...';
    try {
      const data = await api('complete_unidentified', { batch_id: batchId, photo_index: photoIdx, discard: true });
      card.style.transition = 'opacity .4s'; card.style.opacity = '0';
      setTimeout(() => card.remove(), 500);
    } catch (e) { status.className = 'status err'; status.textContent = e.message; }
  };
});

// ===== FASE 2: PENDENTES =====
document.querySelectorAll('.card.pendente').forEach(card => {
  const id = card.dataset.id;
  const status = document.getElementById('st-p-' + id);
  const setStatus = (msg, cls) => { status.textContent = msg; status.className = 'status' + (cls ? ' ' + cls : ''); };

  const approveBtn = card.querySelector('[data-op="p-approve-ref"]');
  if (approveBtn) approveBtn.onclick = async () => {
    const checked = card.querySelector('input[type="radio"]:checked');
    if (!checked) { setStatus('⚠️ seleciona uma ref', 'err'); return; }
    setStatus('aprovando ref + gerando arte (~30s)...');
    try {
      await api('approve_reference', { productId: parseInt(id), referenceUrl: checked.value });
      setStatus('✓ ref aprovada — gerando arte', 'ok');
      setTimeout(() => location.reload(), 2500);
    } catch (e) { setStatus(e.message, 'err'); }
  };

  const fileInput = card.querySelector('[data-op="p-pod-photo"]');
  if (fileInput) fileInput.onchange = async (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    setStatus('analisando foto + gerando arte...');
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          // upload_pod_photo espera { productId, podPhotoBase64 }
          await api('upload_pod_photo', { productId: parseInt(id), podBase64: reader.result });
          setStatus('✓ foto subida — gerando arte', 'ok');
          setTimeout(() => location.reload(), 2500);
        } catch (e) { setStatus(e.message, 'err'); }
      };
      reader.readAsDataURL(file);
    } catch (e) { setStatus(e.message, 'err'); }
  };

  const retryBtn = card.querySelector('[data-op="p-retry"]');
  if (retryBtn) retryBtn.onclick = async () => {
    setStatus('rebuscando referências...');
    try {
      await api('retry_search', { productId: parseInt(id) });
      setStatus('✓ rebuscando — recarrega em 10s', 'ok');
      setTimeout(() => location.reload(), 10000);
    }
    catch (e) { setStatus(e.message, 'err'); }
  };

  const skipBtn = card.querySelector('[data-op="p-skip"]');
  if (skipBtn) skipBtn.onclick = async () => {
    if (!confirm('gerar arte só com dados textuais (sem foto de referência)?')) return;
    setStatus('gerando arte text-only...');
    try {
      await api('skip_reference', { productId: parseInt(id) });
      setStatus('✓ gerando (~30s)', 'ok');
      setTimeout(() => location.reload(), 2500);
    }
    catch (e) { setStatus(e.message, 'err'); }
  };

  const removeBtn = card.querySelector('[data-op="p-remove"]');
  if (removeBtn) removeBtn.onclick = async () => {
    if (!confirm('remover esse produto?')) return;
    setStatus('removendo...');
    try {
      await api('remove_pending', { productId: parseInt(id) });
      card.style.transition = 'opacity .4s'; card.style.opacity = '0';
      setTimeout(() => card.remove(), 500);
    } catch (e) { setStatus(e.message, 'err'); }
  };
});

// ===== FASE 3: GALLERY =====
document.querySelectorAll('.card.gallery-card').forEach(card => {
  const id = card.dataset.id;
  const status = card.querySelector('.status');
  card.querySelectorAll('.btn').forEach(btn => {
    btn.onclick = async () => {
      const op = btn.dataset.op;
      const map = { 'g-approve':'approve', 'g-regen':'regenerate', 'g-reject':'reject' };
      const realOp = map[op]; if (!realOp) return;
      const barcode = card.querySelector('input[data-field="barcode"]')?.value.trim() || null;
      const priceReais = card.querySelector('input[data-field="price"]')?.value;
      const price_cents = priceReais ? Math.round(parseFloat(priceReais) * 100) : null;
      card.querySelectorAll('.btn').forEach(b => b.disabled = true);
      status.className = 'status'; status.textContent = 'processando...';
      try {
        const data = await api('gallery_action', { id, op: realOp, barcode, price_cents });
        status.className = 'status ok'; status.textContent = data.message || '✓ ok';
        if (realOp === 'approve' || realOp === 'reject') {
          card.style.transition = 'opacity .4s'; card.style.opacity = '0';
          setTimeout(() => card.remove(), 500);
        } else {
          card.querySelectorAll('.btn').forEach(b => b.disabled = false);
        }
      } catch (e) {
        status.className = 'status err'; status.textContent = 'erro: ' + e.message;
        card.querySelectorAll('.btn').forEach(b => b.disabled = false);
      }
    };
  });
});

// ===== FASE 4: COMPLETAR SPECS =====
document.querySelectorAll('.card.specs-card').forEach(card => {
  const id = card.dataset.id;
  const status = card.querySelector('.status');
  const eanResult = card.querySelector('.ean-result');
  const priceInput = card.querySelector('input[data-field="price"]');
  const eanInput = card.querySelector('input[data-field="barcode"]');

  // Botão buscar EAN auto
  const searchBtn = card.querySelector('[data-op="ean-search"]');
  if (searchBtn) searchBtn.onclick = async () => {
    searchBtn.disabled = true;
    eanResult.className = 'ean-result';
    eanResult.textContent = '🔎 procurando no Google...';
    try {
      const data = await api('auto_search_ean', { productId: parseInt(id) });
      if (data.ean) {
        eanInput.value = data.ean;
        eanResult.className = 'ean-result match';
        eanResult.textContent = '✓ achei: ' + data.ean + ' (' + data.confidence + ' fonte' + (data.confidence > 1 ? 's' : '') + ')';
      } else {
        eanResult.className = 'ean-result fail';
        eanResult.textContent = '⚠️ não achei EAN — coloca manual';
      }
    } catch (e) {
      eanResult.className = 'ean-result fail';
      eanResult.textContent = 'erro: ' + e.message;
    } finally {
      searchBtn.disabled = false;
    }
  };

  // Botão salvar e finalizar
  const saveBtn = card.querySelector('[data-op="save-finalize"]');
  if (saveBtn) saveBtn.onclick = async () => {
    const priceReais = priceInput.value;
    const price_cents = priceReais ? Math.round(parseFloat(priceReais) * 100) : null;
    const barcode = eanInput.value.trim().replace(/\\D/g, '');
    if (!price_cents && !barcode) {
      status.className = 'status err'; status.textContent = '⚠️ preenche pelo menos 1 campo';
      return;
    }
    saveBtn.disabled = true;
    status.className = 'status'; status.textContent = 'salvando...';
    try {
      const data = await api('save_specs', {
        productId: parseInt(id),
        price_cents,
        barcode: barcode || null,
      });
      status.className = 'status ok';
      status.textContent = data.message || '✓ salvo';
      if (data.finalized) {
        card.style.transition = 'opacity .4s';
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 500);
      } else {
        saveBtn.disabled = false;
      }
    } catch (e) {
      status.className = 'status err';
      status.textContent = 'erro: ' + e.message;
      saveBtn.disabled = false;
    }
  };
});

// ===== BOTÃO LOTE EAN (08/05/2026) =====
const btnLoteEan = document.getElementById('btn-lote-ean');
if (btnLoteEan) btnLoteEan.onclick = () => {
  // Abre modal
  const modal = document.createElement('div');
  modal.id = 'modal-lote-ean';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto';
  modal.innerHTML = \`
    <div style="background:var(--bg2);border:1px solid var(--violet);border-radius:14px;padding:20px;max-width:760px;width:100%;max-height:90vh;overflow:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h2 style="color:var(--violet);margin:0;font-size:18px">📸 lote EAN — cruza com cascade online</h2>
        <button id="modal-close" style="background:transparent;border:1px solid var(--b);color:var(--fg);padding:5px 10px;border-radius:6px;cursor:pointer">✕</button>
      </div>
      <div style="font-size:12px;color:var(--dim);line-height:1.5;margin-bottom:14px">
        Manda fotos dos códigos de barras (qualquer ordem). Vision lê cada um. Em paralelo, cascade online (Open Food Facts → UPCitemDB → Serper) busca candidatos pra cada produto pendente. Cruza:<br/>
        <span style="color:var(--lime)">✅ matched</span> = EAN da foto bate com candidato online → linka automático<br/>
        <span style="color:var(--amber)">📸 órfão</span> = EAN não achou online → você clica num produto pra linkar<br/>
        <span style="color:var(--pink)">⚠️ conflito</span> = mesmo EAN aparece em 2 produtos online → escolhe
      </div>
      <input type="file" id="lote-ean-files" accept="image/*" multiple style="margin-bottom:10px;width:100%;padding:10px;background:var(--bg);border:1px dashed var(--violet);border-radius:8px;color:var(--fg)">
      <div id="lote-ean-preview" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px;margin-bottom:14px;max-height:200px;overflow:auto"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <button id="lote-ean-go" class="btn primary" style="flex:1" disabled>🚀 processar 0 fotos</button>
        <button id="lote-ean-clear" class="btn ghost">limpar</button>
      </div>
      <div id="lote-ean-progress" style="font-size:12px;color:var(--dim);min-height:18px"></div>
      <div id="lote-ean-result"></div>
    </div>
  \`;
  document.body.appendChild(modal);

  const fileInput = modal.querySelector('#lote-ean-files');
  const preview = modal.querySelector('#lote-ean-preview');
  const goBtn = modal.querySelector('#lote-ean-go');
  const clearBtn = modal.querySelector('#lote-ean-clear');
  const closeBtn = modal.querySelector('#modal-close');
  const progress = modal.querySelector('#lote-ean-progress');
  const resultDiv = modal.querySelector('#lote-ean-result');
  let selectedFiles = [];

  closeBtn.onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  clearBtn.onclick = () => {
    fileInput.value = '';
    selectedFiles = [];
    preview.innerHTML = '';
    goBtn.disabled = true;
    goBtn.textContent = '🚀 processar 0 fotos';
    resultDiv.innerHTML = '';
  };

  fileInput.onchange = () => {
    selectedFiles = Array.from(fileInput.files);
    preview.innerHTML = '';
    selectedFiles.forEach((f, i) => {
      const img = document.createElement('img');
      img.style.cssText = 'width:100%;aspect-ratio:1;object-fit:cover;border-radius:4px;border:1px solid var(--b)';
      img.src = URL.createObjectURL(f);
      preview.appendChild(img);
    });
    goBtn.disabled = selectedFiles.length === 0;
    goBtn.textContent = '🚀 processar ' + selectedFiles.length + ' foto' + (selectedFiles.length === 1 ? '' : 's');
  };

  goBtn.onclick = async () => {
    if (selectedFiles.length === 0) return;
    goBtn.disabled = true;
    progress.textContent = '⏳ convertendo ' + selectedFiles.length + ' fotos pra base64...';
    resultDiv.innerHTML = '';

    try {
      // Converte todas em paralelo
      const photos = await Promise.all(selectedFiles.map(async (f, i) => {
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(f);
        });
        return { name: f.name, base64: b64 };
      }));

      progress.textContent = '🔎 Vision lendo EANs + cascade online dos produtos pendentes (~1min)...';
      const data = await api('cross_ean_batch', { photos });

      // Renderiza resumo + tabela
      const s = data.summary || {};
      progress.innerHTML = '✅ processado: ' +
        '<span style="color:var(--lime)">' + (s.matched||0) + ' matched</span> · ' +
        '<span style="color:var(--amber)">' + (s.orphan||0) + ' órfãos</span> · ' +
        '<span style="color:var(--pink)">' + (s.conflict||0) + ' conflitos</span> · ' +
        '<span style="color:var(--dim)">' + (s.unreadable||0) + ' ilegíveis</span> · ' +
        '<strong style="color:var(--lime)">' + (s.linked||0) + ' linkados auto!</strong>';

      const renderResultRow = (r, idx) => {
        const eanDisp = r.ean_lido ? '<code style="color:var(--lime)">' + r.ean_lido + '</code>' : '<span style="color:var(--pink)">—</span>';
        let action = '';
        if (r.status === 'matched') {
          action = '<span style="color:var(--lime)">✅ ' + (r.product?.name || '') + '</span>';
        } else if (r.status === 'orphan') {
          // Select pra Andrade escolher produto
          const opts = (data.unmatched_products || []).map(p => '<option value="' + p.id + '">' + p.name + '</option>').join('');
          action = '<select data-orphan-idx="' + idx + '" style="background:var(--bg);color:var(--fg);border:1px solid var(--amber);padding:4px;border-radius:4px;font-size:11px;max-width:180px"><option value="">📸 escolhe produto...</option>' + opts + '</select> <button class="btn" data-link-orphan="' + idx + '" style="font-size:11px;padding:4px 8px">🔗</button>';
        } else if (r.status === 'conflict') {
          action = '<span style="color:var(--pink)">⚠️ ' + r.matches.map(m=>m.name).slice(0,2).join(' / ') + '</span>';
        } else {
          action = '<span style="color:var(--dim)">' + r.detail + '</span>';
        }
        return '<tr style="border-bottom:1px solid var(--b)"><td style="padding:6px;font-size:11px;color:var(--dim)">' + (idx+1) + '</td><td style="padding:6px;font-size:11px">' + eanDisp + '</td><td style="padding:6px;font-size:11px">' + action + '</td></tr>';
      };

      const tableHtml = '<table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:12px"><thead><tr style="background:var(--bg);border-bottom:2px solid var(--violet)"><th style="padding:6px;text-align:left;color:var(--dim);font-size:11px">#</th><th style="padding:6px;text-align:left;color:var(--dim);font-size:11px">EAN lido</th><th style="padding:6px;text-align:left;color:var(--dim);font-size:11px">resultado</th></tr></thead><tbody>' + (data.results || []).map(renderResultRow).join('') + '</tbody></table>';
      resultDiv.innerHTML = tableHtml;

      // Bind handlers pros botões "linkar órfão"
      resultDiv.querySelectorAll('[data-link-orphan]').forEach(btn => {
        btn.onclick = async () => {
          const idx = parseInt(btn.dataset.linkOrphan);
          const sel = resultDiv.querySelector('select[data-orphan-idx="' + idx + '"]');
          const productId = sel.value;
          if (!productId) { alert('escolhe um produto primeiro'); return; }
          const result = data.results[idx];
          btn.disabled = true; btn.textContent = '...';
          try {
            await api('link_orphan_ean', { productId: parseInt(productId), barcode: result.ean_lido });
            btn.textContent = '✓';
            btn.style.background = 'var(--lime)'; btn.style.color = '#000';
          } catch (e) {
            btn.disabled = false; btn.textContent = '🔗';
            alert('erro: ' + e.message);
          }
        };
      });
      goBtn.disabled = false;
    } catch (e) {
      progress.textContent = '❌ erro: ' + e.message;
      goBtn.disabled = false;
    }
  };
};

// Permite anchor #pendentes etc no load
if (location.hash) setFilter(location.hash.slice(1));

// ===== BOTÃO MASS KICKOFF (recupera 34 travados sem ref) =====
const massBtn = document.getElementById('btn-mass-kickoff');
if (massBtn) {
  massBtn.onclick = async () => {
    const st = document.getElementById('mass-kickoff-status');
    if (!confirm('disparar busca de refs Serper pra TODOS os travados? (consome créditos Serper)')) return;
    massBtn.disabled = true;
    st.textContent = 'disparando...'; st.className = 'status';
    try {
      const data = await api('mass_kickoff_search', {});
      st.className = 'status ok';
      st.textContent = (data.message || '✓ disparado') + ' — recarregando em 60s...';
      setTimeout(() => location.reload(), 60000);
    } catch (e) {
      st.className = 'status err';
      st.textContent = 'erro: ' + e.message;
      massBtn.disabled = false;
    }
  };
}
</script>
</body></html>`;
}

// ===== PIPELINE VISUAL HORIZONTAL (08/05/2026) =====
// Andrade pediu: "pipeline visual com linha por produto mostrando progresso colorido,
// click direto no step que falta — sem zigue-zague entre abas"
// Substitui esteiraHtml. Cada produto = 1 linha com 5 steps clickable.
function pipelineHtml(unidentified, pending, awaiting, specs, token) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Constrói rows unificadas — cada item vira 1 linha com 5 steps
  const rows = [];

  // Tipo 1: sem-sabor (sem produto criado ainda)
  for (const u of unidentified) {
    let brand = '?', model = '';
    try {
      const vis = typeof u.vision_response === 'string' ? JSON.parse(u.vision_response) : u.vision_response;
      const p = vis?.products?.[0] || {};
      brand = p.brand || '?';
      model = p.model || '';
    } catch (_) {}
    rows.push({
      kind: 'unidentified',
      key: 'u-' + u.batch_id + '-' + u.photo_index,
      batchId: u.batch_id,
      photoIdx: u.photo_index,
      photoUrl: u.photo_url,
      arteUrl: null,
      brand, model, flavor: null,
      productId: null,
      stepStates: { sabor: 'todo', ref: 'locked', arte: 'locked', preco: 'locked', ean: 'locked' },
    });
  }

  // Tipo 2: pending (produto criado, sem arte)
  for (const p of pending) {
    const m = p.metadata || {};
    const refs = Array.isArray(p.reference_candidates) ? p.reference_candidates : [];
    const hasRef = !!p.reference_image_url;
    const isSearching = p.art_status === 'pending_reference' && refs.length === 0;
    const refState = hasRef ? 'done' : (isSearching ? 'working' : 'todo');
    rows.push({
      kind: 'pending',
      key: 'p-' + p.id,
      productId: p.id,
      brand: m.brand || '?',
      model: m.model || '',
      flavor: m.flavor_pt || m.flavor_en || m.flavor || null,
      photoUrl: p.box_photo_url || m.box_photo_url || null,
      arteUrl: null,
      data: p,
      stepStates: {
        sabor: 'done',
        ref: refState,
        arte: 'locked',
        preco: 'locked',
        ean: 'locked',
      },
    });
  }

  // Tipo 3: awaiting (arte gerada, esperando aprovação)
  for (const p of awaiting) {
    const m = p.metadata || {};
    const arteUrl = m.pending_art_url || p.image_url || null;
    rows.push({
      kind: 'awaiting',
      key: 'a-' + p.id,
      productId: p.id,
      brand: m.brand || '?',
      model: m.model || '',
      flavor: m.flavor_pt || m.flavor_en || m.flavor || null,
      photoUrl: p.box_photo_url || m.box_photo_url || null,
      arteUrl,
      data: p,
      stepStates: {
        sabor: 'done',
        ref: 'done',
        arte: 'todo',
        preco: 'locked',
        ean: 'locked',
      },
    });
  }

  // Tipo 4: specs (arte aprovada, falta preço/EAN)
  for (const p of specs) {
    const m = p.metadata || {};
    rows.push({
      kind: 'specs',
      key: 's-' + p.id,
      productId: p.id,
      brand: m.brand || '?',
      model: m.model || '',
      flavor: m.flavor_pt || m.flavor_en || m.flavor || null,
      photoUrl: p.box_photo_url || m.box_photo_url || null,
      arteUrl: p.image_url,
      data: p,
      stepStates: {
        sabor: 'done',
        ref: 'done',
        arte: 'done',
        preco: (p.price_cents > 0) ? 'done' : 'todo',
        ean: (p.barcode && p.barcode.length > 0) ? 'done' : 'todo',
      },
    });
  }

  const totalRows = rows.length;
  const counts = {
    sabor: rows.filter(r => r.stepStates.sabor === 'todo').length,
    ref: rows.filter(r => r.stepStates.ref === 'todo' || r.stepStates.ref === 'working').length,
    arte: rows.filter(r => r.stepStates.arte === 'todo').length,
    preco: rows.filter(r => r.stepStates.preco === 'todo').length,
    ean: rows.filter(r => r.stepStates.ean === 'todo').length,
  };

  const stepIcon = { done: '●', working: '◐', todo: '○', locked: '·' };
  const stepLabel = { sabor: 'sabor', ref: 'ref', arte: 'arte', preco: 'preço', ean: 'EAN' };

  const renderStep = (step, state, key) => {
    const icon = stepIcon[state] || '○';
    const cls = 'step state-' + state;
    const clickable = (state === 'todo' || state === 'working');
    return `<button class="${cls}" data-step="${step}" data-key="${esc(key)}" ${clickable ? '' : 'disabled'}><span class="dot">${icon}</span><span class="lbl">${stepLabel[step]}</span></button>`;
  };

  const renderRow = (row) => {
    const thumb = row.arteUrl || row.photoUrl;
    const subtitle = [row.brand, row.model, row.flavor].filter(Boolean).join(' · ');
    const dataAttrs = `data-key="${esc(row.key)}" data-kind="${row.kind}" data-product-id="${esc(row.productId || '')}" data-batch-id="${esc(row.batchId || '')}" data-photo-idx="${esc(row.photoIdx ?? '')}"`;
    return `
      <div class="row" ${dataAttrs}>
        <div class="row-main">
          <div class="row-thumb">${thumb ? `<img src="${esc(thumb)}" loading="lazy" alt="">` : '<div class="no-thumb">?</div>'}</div>
          <div class="row-info">
            <div class="row-name">${esc(row.flavor || '(sem identificação)')}</div>
            <div class="row-sub">${esc(subtitle)}</div>
          </div>
          <div class="row-steps">
            ${renderStep('sabor', row.stepStates.sabor, row.key)}
            ${renderStep('ref', row.stepStates.ref, row.key)}
            ${renderStep('arte', row.stepStates.arte, row.key)}
            ${renderStep('preco', row.stepStates.preco, row.key)}
            ${renderStep('ean', row.stepStates.ean, row.key)}
          </div>
        </div>
        <div class="row-expand" hidden></div>
      </div>`;
  };

  // Embed dos dados das rows como JSON pra o JS frontend usar
  const rowsJson = JSON.stringify(rows.map(r => ({
    key: r.key,
    kind: r.kind,
    productId: r.productId,
    batchId: r.batchId || null,
    photoIdx: r.photoIdx ?? null,
    name: r.flavor,
    brand: r.brand,
    model: r.model,
    flavor: r.flavor,
    arteUrl: r.arteUrl,
    photoUrl: r.photoUrl,
    refs: r.data && Array.isArray(r.data.reference_candidates) ? r.data.reference_candidates : [],
    refUrl: r.data && r.data.reference_image_url ? r.data.reference_image_url : null,
    barcode: r.data && r.data.barcode ? r.data.barcode : null,
    priceCents: r.data && r.data.price_cents ? r.data.price_cents : 0,
    artStatus: r.data && r.data.art_status ? r.data.art_status : null,
    imageStatus: r.data && r.data.image_status ? r.data.image_status : null,
    pendingArtUrl: r.data && r.data.metadata && r.data.metadata.pending_art_url ? r.data.metadata.pending_art_url : null,
    qcScore: r.data && r.data.metadata && r.data.metadata.qc_score ? r.data.metadata.qc_score : null,
  })));

  return `<!DOCTYPE html>
<html lang="pt-BR" translate="no"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0A0A14">
<title>Pipeline ✦ Drope</title>
<style>
:root{--bg:#0A0A14;--bg2:#14141F;--bg3:#1d1d2c;--fg:#EAEAF2;--dim:#8A8AA3;--pink:#FF2D6F;--lime:#D4FF2E;--violet:#9D4EDD;--amber:#FFB800;--b:rgba(255,255,255,0.08)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:0 0 80px;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;font-size:14px}
header{padding:14px 16px;border-bottom:1px solid var(--b);position:sticky;top:0;background:rgba(10,10,20,.97);backdrop-filter:blur(8px);z-index:10}
.head-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
h1{margin:0;font-size:18px}h1 em{color:var(--lime);font-style:normal}
.subtitle{font-size:11px;color:var(--dim);margin-top:2px}
.legend{display:flex;gap:14px;margin-top:10px;font-size:11px;color:var(--dim);flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:4px}
.legend .dot-done{color:var(--lime)}
.legend .dot-todo{color:var(--pink)}
.legend .dot-working{color:var(--violet)}
.legend .dot-locked{color:var(--dim)}
.topbtn{padding:6px 10px;border-radius:8px;background:var(--bg2);border:1px solid var(--b);color:var(--dim);font-size:12px;text-decoration:none;cursor:pointer;font-family:inherit}
.filter-bar{display:flex;gap:6px;margin-top:10px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.filter{flex:0 0 auto;padding:5px 10px;border-radius:99px;border:1px solid var(--b);background:var(--bg2);color:var(--fg);font-size:11px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px}
.filter.active{background:var(--lime);color:#000;border-color:var(--lime)}
.filter .badge{background:rgba(0,0,0,.2);padding:0 6px;border-radius:99px;font-size:10px;font-weight:700}
.filter.active .badge{background:rgba(0,0,0,.3)}

.list{padding:8px 16px;max-width:980px;margin:0 auto}
.row{background:var(--bg2);border:1px solid var(--b);border-radius:10px;margin-bottom:6px;overflow:hidden;transition:border-color .15s}
.row:hover{border-color:rgba(212,255,46,.3)}
.row-main{display:flex;align-items:center;gap:12px;padding:8px 10px}
.row-thumb{flex:0 0 48px;width:48px;height:48px;background:#000;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.row-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.no-thumb{color:var(--dim);font-size:18px;font-weight:bold}
.row-info{flex:1;min-width:0}
.row-name{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-sub{font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-steps{display:flex;gap:3px;flex-shrink:0}
.step{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 7px;border-radius:6px;border:1px solid var(--b);background:transparent;color:var(--fg);font-family:inherit;font-size:9px;cursor:pointer;min-width:46px;transition:all .15s}
.step:hover:not(:disabled){border-color:var(--lime);background:var(--bg3)}
.step:disabled{cursor:default;opacity:.5}
.step .dot{font-size:14px;line-height:1}
.step .lbl{text-transform:lowercase;letter-spacing:.02em;font-size:9px;color:var(--dim)}
.step.state-done .dot{color:var(--lime)}
.step.state-done .lbl{color:var(--lime)}
.step.state-todo .dot{color:var(--pink)}
.step.state-todo{border-color:rgba(255,45,111,.4)}
.step.state-todo:hover:not(:disabled){border-color:var(--pink);background:rgba(255,45,111,.1)}
.step.state-working .dot{color:var(--violet);animation:pulse 1.4s ease-in-out infinite}
.step.state-working{border-color:rgba(157,78,221,.4)}
.step.state-locked .dot{color:var(--dim)}
@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}

.row-expand{padding:0 12px 12px;border-top:1px solid var(--b);background:var(--bg)}
.row-expand[hidden]{display:none}
.expand-title{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--violet);margin:10px 0 8px;font-weight:700}
.expand-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media(max-width:600px){.expand-grid{grid-template-columns:1fr}}
.expand-photos{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.expand-photo{background:#000;border-radius:6px;overflow:hidden;aspect-ratio:1}
.expand-photo img{width:100%;height:100%;object-fit:cover;display:block}
.expand-photo .lbl{position:absolute;background:rgba(0,0,0,.7);color:var(--fg);font-size:10px;padding:2px 6px;border-radius:4px;margin:4px}
.input-group{display:flex;gap:6px;align-items:center;margin-bottom:8px}
.input-group label{font-size:11px;color:var(--dim);min-width:42px;text-transform:uppercase;font-weight:600;letter-spacing:.04em}
.input-group input{flex:1;padding:7px 9px;border-radius:6px;border:1px solid var(--b);background:var(--bg2);color:var(--fg);font-size:13px;font-family:inherit;min-width:0}
.input-group input:focus{outline:none;border-color:var(--lime)}
.btn{padding:7px 12px;border-radius:6px;border:1px solid var(--b);background:transparent;color:var(--fg);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.btn.primary{background:var(--lime);color:#000;border-color:var(--lime)}
.btn.violet{background:transparent;border-color:var(--violet);color:var(--violet)}
.btn.violet:hover{background:var(--violet);color:#fff}
.btn.danger{border-color:var(--pink);color:var(--pink)}
.btn.danger:hover{background:var(--pink);color:#fff}
.btn:disabled{opacity:.5;cursor:wait}
.btn-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.refs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:6px;margin-bottom:10px}
.ref-thumb{position:relative;aspect-ratio:1;background:#000;border:2px solid transparent;border-radius:6px;overflow:hidden;cursor:pointer}
.ref-thumb input{position:absolute;opacity:0;pointer-events:none}
.ref-thumb img{width:100%;height:100%;object-fit:cover}
.ref-thumb:has(input:checked),.ref-thumb.checked{border-color:var(--lime)}
.ref-score{position:absolute;bottom:2px;right:2px;background:rgba(0,0,0,.7);color:var(--lime);font-size:9px;padding:1px 4px;border-radius:3px;font-weight:700}
.expand-status{font-size:11px;color:var(--dim);min-height:14px;margin-top:8px}
.expand-status.ok{color:var(--lime)}
.expand-status.err{color:var(--pink)}
.empty-list{text-align:center;padding:40px;color:var(--dim);font-style:italic}
.spin{display:inline-block;width:10px;height:10px;border:2px solid var(--violet);border-top-color:transparent;border-radius:50%;animation:spinr .8s linear infinite;vertical-align:middle;margin-right:4px}
@keyframes spinr{to{transform:rotate(360deg)}}
.row.hidden-by-filter{display:none}
.qc-badge{display:inline-block;padding:1px 6px;background:rgba(212,255,46,.15);color:var(--lime);border-radius:4px;font-size:10px;font-weight:700;margin-left:6px}
.qc-badge.bad{background:rgba(255,184,0,.15);color:var(--amber)}
</style>
</head><body>

<header>
  <div class="head-row">
    <div>
      <h1><em>🦎</em> pipeline</h1>
      <div class="subtitle">${totalRows} produtos · clica num bullet vermelho/cinza pra resolver</div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="topbtn" id="btn-lote-ean" style="background:var(--violet);color:#fff;border-color:var(--violet);font-weight:700">📸 lote EAN</button>
      <a class="topbtn" href="/api/webhook?action=admin_hub&token=${esc(token)}">← hub</a>
      <button class="topbtn" onclick="location.reload()">↻</button>
    </div>
  </div>
  <div class="legend">
    <span class="dot-done">● feito</span>
    <span class="dot-todo">○ falta</span>
    <span class="dot-working">◐ rolando</span>
    <span class="dot-locked">· trancado</span>
  </div>
  <div class="filter-bar">
    <button class="filter active" data-filter="all">tudo <span class="badge">${totalRows}</span></button>
    <button class="filter" data-filter="sabor">○ sabor <span class="badge">${counts.sabor}</span></button>
    <button class="filter" data-filter="ref">○ ref <span class="badge">${counts.ref}</span></button>
    <button class="filter" data-filter="arte">○ arte <span class="badge">${counts.arte}</span></button>
    <button class="filter" data-filter="preco">○ preço <span class="badge">${counts.preco}</span></button>
    <button class="filter" data-filter="ean">○ EAN <span class="badge">${counts.ean}</span></button>
  </div>
</header>

<div class="list">
  ${totalRows === 0
    ? '<div class="empty-list">✅ tudo finalizado — nenhum produto pendente</div>'
    : rows.map(renderRow).join('')}
</div>

<script>
const TOKEN = ${JSON.stringify(token)};
const ROWS = ${rowsJson};
const ROWS_BY_KEY = Object.fromEntries(ROWS.map(r => [r.key, r]));

async function api(action, body = {}) {
  const r = await fetch('/api/webhook?action=' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

// ===== FILTROS =====
document.querySelectorAll('.filter').forEach(f => {
  f.onclick = () => {
    document.querySelectorAll('.filter').forEach(x => x.classList.remove('active'));
    f.classList.add('active');
    const which = f.dataset.filter;
    document.querySelectorAll('.row').forEach(row => {
      if (which === 'all') {
        row.classList.remove('hidden-by-filter');
      } else {
        const data = ROWS_BY_KEY[row.dataset.key];
        if (!data) return;
        const state = data.kind === 'unidentified' && which === 'sabor' ? 'todo' :
                      data.kind === 'pending' && which === 'ref' ? (data.refUrl ? 'done' : (data.artStatus === 'pending_reference' && (!data.refs || data.refs.length === 0) ? 'working' : 'todo')) :
                      data.kind === 'awaiting' && which === 'arte' ? 'todo' :
                      data.kind === 'specs' && which === 'preco' ? (data.priceCents > 0 ? 'done' : 'todo') :
                      data.kind === 'specs' && which === 'ean' ? (data.barcode ? 'done' : 'todo') :
                      'locked';
        if (state === 'todo' || state === 'working') row.classList.remove('hidden-by-filter');
        else row.classList.add('hidden-by-filter');
      }
    });
  };
});

// ===== STEP CLICK =====
document.querySelectorAll('.step').forEach(btn => {
  btn.onclick = () => {
    if (btn.disabled) return;
    const step = btn.dataset.step;
    const key = btn.dataset.key;
    const row = btn.closest('.row');
    const data = ROWS_BY_KEY[key];
    if (!data) return;
    const expand = row.querySelector('.row-expand');
    // Toggle: se já expandido nesse step, fecha
    if (!expand.hidden && expand.dataset.step === step) {
      expand.hidden = true; expand.innerHTML = ''; expand.dataset.step = '';
      return;
    }
    expand.dataset.step = step;
    expand.innerHTML = renderStepUI(step, data);
    expand.hidden = false;
    bindStepUI(step, data, expand, row);
  };
});

function renderStepUI(step, d) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  if (step === 'sabor') {
    return \`
      <div class="expand-title">📝 informa o sabor</div>
      <div class="expand-photos">
        <div class="expand-photo"><img src="\${esc(d.photoUrl||'')}" alt=""></div>
        <div style="font-size:11px;color:var(--dim);align-self:center;padding:0 8px">↑ foto que o Vision não conseguiu ler<br/><br/>2 caminhos:<br/>• digita o sabor manual abaixo<br/>• <strong>OU</strong> manda foto melhor — IA tenta identificar tudo sozinha</div>
      </div>
      <div class="input-group">
        <label>sabor</label>
        <input type="text" data-field="flavor" placeholder="ex: Strawberry Kiwi">
      </div>
      <div class="btn-row">
        <button class="btn primary" data-act="sabor-save">✓ cadastrar manual</button>
        <label class="btn violet">📸 foto melhor (auto)<input type="file" accept="image/*" capture="environment" data-act="sabor-rephoto" hidden></label>
        <button class="btn danger" data-act="sabor-discard">🗑️ descartar</button>
      </div>
      <div class="expand-status"></div>
    \`;
  }
  if (step === 'ref') {
    const refs = d.refs || [];
    const refsHtml = refs.length === 0
      ? '<div style="color:var(--dim);font-size:12px;padding:10px;text-align:center;border:1px dashed var(--b);border-radius:6px">⚠️ nenhuma referência ainda — clica buscar de novo ou manda foto manual</div>'
      : \`<div class="refs-grid">\${refs.map((r, i) => \`
          <label class="ref-thumb">
            <input type="radio" name="ref-\${esc(d.key)}" value="\${esc(r.url)}" \${d.refUrl === r.url ? 'checked' : ''}>
            <img src="\${esc(r.url)}" loading="lazy">
            <span class="ref-score">\${r.combined_score ? '🎯'+r.combined_score : '⭐'+(r.quality_score||0)}</span>
          </label>\`).join('')}</div>\`;
    return \`
      <div class="expand-title">🔎 escolher referência</div>
      <div class="expand-photos">
        <div class="expand-photo">\${d.photoUrl ? \`<img src="\${esc(d.photoUrl)}" alt="">\` : '<div style="color:var(--dim);text-align:center;padding-top:30%">sem caixa</div>'}</div>
        <div style="font-size:11px;color:var(--dim);align-self:center">↑ sua foto da caixa</div>
      </div>
      \${refsHtml}
      <div class="btn-row">
        \${refs.length > 0 ? '<button class="btn primary" data-act="ref-approve">✓ usar selecionada</button>' : ''}
        <label class="btn">📸 foto manual<input type="file" accept="image/*" capture="environment" data-act="ref-photo" hidden></label>
        <button class="btn violet" data-act="ref-retry">🔄 buscar de novo</button>
        <button class="btn" data-act="ref-skip">🎬 sem ref</button>
        <button class="btn danger" data-act="ref-remove">🗑️ remover</button>
      </div>
      <div class="expand-status"></div>
    \`;
  }
  if (step === 'arte') {
    const qc = d.qcScore;
    const qcBadge = qc ? \`<span class="qc-badge \${parseFloat(qc) < 7 ? 'bad' : ''}">QC \${qc}</span>\` : '';
    return \`
      <div class="expand-title">🎨 aprovar arte \${qcBadge}</div>
      <div class="expand-photos">
        <div class="expand-photo">\${d.photoUrl ? \`<img src="\${esc(d.photoUrl)}" alt="">\` : ''}</div>
        <div class="expand-photo">\${d.arteUrl || d.pendingArtUrl ? \`<img src="\${esc(d.arteUrl||d.pendingArtUrl)}" alt="">\` : '<div style="color:var(--dim);text-align:center;padding-top:30%">sem arte</div>'}</div>
      </div>
      <div class="btn-row">
        <button class="btn primary" data-act="arte-approve">✓ aprovar arte</button>
        <button class="btn violet" data-act="arte-regen">🔄 regerar</button>
        <button class="btn danger" data-act="arte-reject">✕ rejeitar</button>
      </div>
      <div class="expand-status"></div>
    \`;
  }
  if (step === 'preco') {
    const pv = d.priceCents ? (d.priceCents/100).toFixed(2) : '';
    return \`
      <div class="expand-title">💰 preço de venda</div>
      <div class="input-group">
        <label>R$</label>
        <input type="number" step="0.01" min="0" data-field="price" placeholder="ex: 89.90" value="\${pv}" autofocus>
      </div>
      <div class="btn-row">
        <button class="btn primary" data-act="preco-save">💾 salvar preço</button>
      </div>
      <div class="expand-status"></div>
    \`;
  }
  if (step === 'ean') {
    return \`
      <div class="expand-title">🔢 código de barras (EAN)</div>
      <div class="input-group">
        <label>EAN</label>
        <input type="text" data-field="ean" placeholder="13 dígitos" value="\${esc(d.barcode||'')}" maxlength="14" autofocus>
        <button class="btn violet" data-act="ean-search">🔎 buscar</button>
      </div>
      <div class="expand-status" data-field="ean-result"></div>
      <div class="btn-row">
        <button class="btn primary" data-act="ean-save">💾 salvar EAN</button>
      </div>
    \`;
  }
  return '<div>step desconhecido</div>';
}

function bindStepUI(step, d, expand, row) {
  const status = expand.querySelector('.expand-status');
  const setS = (msg, cls) => { if(status){status.textContent = msg; status.className = 'expand-status' + (cls?' '+cls:'');} };
  const setStepDone = (stepName) => {
    const stepBtn = row.querySelector('.step[data-step="' + stepName + '"]');
    if (stepBtn) {
      stepBtn.className = 'step state-done';
      stepBtn.querySelector('.dot').textContent = '●';
    }
  };

  expand.querySelectorAll('[data-act]').forEach(el => {
    const act = el.dataset.act;
    el.addEventListener(el.tagName === 'INPUT' && el.type === 'file' ? 'change' : 'click', async (ev) => {
      try {
        if (act === 'sabor-save') {
          const flavor = expand.querySelector('input[data-field="flavor"]').value.trim();
          if (flavor.length < 2) { setS('⚠️ digita o sabor', 'err'); return; }
          setS('cadastrando...');
          await api('complete_unidentified', { batch_id: d.batchId, photo_index: d.photoIdx, flavor });
          setS('✓ cadastrado — recarrega em 2s', 'ok');
          setTimeout(() => location.reload(), 1500);
        } else if (act === 'sabor-rephoto') {
          const file = ev.target.files[0]; if (!file) return;
          setS('subindo + reanalisando com Vision (~10s)...');
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const data = await api('reanalyze_unidentified', {
                batch_id: d.batchId,
                photo_index: d.photoIdx,
                newPhotoBase64: reader.result,
              });
              if (data.identified) {
                setS('✓ ' + (data.brand + ' ' + (data.model || '') + ' ' + (data.flavor || '')) + ' — produto criado!', 'ok');
                row.style.transition = 'opacity .4s'; row.style.opacity = '0';
                setTimeout(() => location.reload(), 1500);
              } else if (data.identified_partial) {
                setS('⚠️ ' + data.reason + '. coloca o sabor manual abaixo agora.', 'err');
                // Atualiza brand/model na linha pra refletir
              } else {
                setS('⚠️ ' + (data.reason || 'vision falhou de novo'), 'err');
              }
            } catch (e) { setS('erro: ' + e.message, 'err'); }
          };
          reader.readAsDataURL(file);
        } else if (act === 'sabor-discard') {
          if (!confirm('descartar essa foto?')) return;
          setS('descartando...');
          await api('complete_unidentified', { batch_id: d.batchId, photo_index: d.photoIdx, discard: true });
          row.style.transition = 'opacity .4s'; row.style.opacity = '0';
          setTimeout(() => row.remove(), 500);
        } else if (act === 'ref-approve') {
          const r = expand.querySelector('input[type="radio"]:checked');
          if (!r) { setS('⚠️ seleciona uma ref', 'err'); return; }
          setS('aprovando + gerando arte (~30s)...');
          await api('approve_reference', { productId: d.productId, referenceUrl: r.value });
          setS('✓ ref aprovada — gerando arte. recarrega em 2min.', 'ok');
          setStepDone('ref');
          setTimeout(() => location.reload(), 5000);
        } else if (act === 'ref-photo') {
          const file = ev.target.files[0]; if (!file) return;
          setS('subindo foto + gerando arte...');
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              await api('upload_pod_photo', { productId: d.productId, podBase64: reader.result });
              setS('✓ foto subida — gerando arte. recarrega.', 'ok');
              setTimeout(() => location.reload(), 3000);
            } catch (e) { setS('erro: ' + e.message, 'err'); }
          };
          reader.readAsDataURL(file);
        } else if (act === 'ref-retry') {
          setS('rebuscando refs...');
          await api('retry_search', { productId: d.productId });
          setS('✓ rebuscando — recarrega em 10s', 'ok');
          setTimeout(() => location.reload(), 10000);
        } else if (act === 'ref-skip') {
          if (!confirm('gerar arte só com dados textuais (sem foto de referência)?')) return;
          setS('gerando text-only...');
          await api('skip_reference', { productId: d.productId });
          setS('✓ gerando — recarrega em 1min', 'ok');
          setTimeout(() => location.reload(), 5000);
        } else if (act === 'ref-remove') {
          if (!confirm('remover esse produto?')) return;
          setS('removendo...');
          await api('remove_pending', { productId: d.productId });
          row.style.transition = 'opacity .4s'; row.style.opacity = '0';
          setTimeout(() => row.remove(), 500);
        } else if (act === 'arte-approve' || act === 'arte-regen' || act === 'arte-reject') {
          const op = act === 'arte-approve' ? 'approve' : (act === 'arte-regen' ? 'regenerate' : 'reject');
          setS('processando...');
          const data = await api('gallery_action', { id: d.productId, op });
          setS(data.message || '✓ ok', 'ok');
          if (op === 'approve' || op === 'reject') {
            setStepDone('arte');
            setTimeout(() => location.reload(), 1500);
          }
        } else if (act === 'preco-save') {
          const v = expand.querySelector('input[data-field="price"]').value;
          if (!v || parseFloat(v) <= 0) { setS('⚠️ preço inválido', 'err'); return; }
          setS('salvando...');
          const data = await api('save_specs', { productId: d.productId, price_cents: Math.round(parseFloat(v) * 100) });
          setS('✓ preço salvo' + (data.finalized ? ' — produto FINALIZADO!' : ''), 'ok');
          setStepDone('preco');
          d.priceCents = Math.round(parseFloat(v) * 100);
          if (data.finalized) {
            setTimeout(() => { row.style.transition='opacity .4s'; row.style.opacity='0'; setTimeout(()=>row.remove(),500); }, 1000);
          }
        } else if (act === 'ean-search') {
          const result = expand.querySelector('[data-field="ean-result"]');
          el.disabled = true;
          result.textContent = '🔎 procurando no Google...';
          result.className = 'expand-status';
          try {
            const data = await api('auto_search_ean', { productId: d.productId });
            if (data.ean) {
              expand.querySelector('input[data-field="ean"]').value = data.ean;
              result.className = 'expand-status ok';
              const sourceLabel = { 'open_food_facts': '🌾 Open Food Facts', 'upcitemdb': '📊 UPCitemDB', 'serper_google': '🔎 Google' }[data.source] || data.source;
              result.textContent = '✓ ' + data.ean + ' · fonte: ' + sourceLabel + ' (' + data.confidence + ')';
            } else {
              result.className = 'expand-status err';
              const tried = (data.all_tries || []).length;
              result.textContent = '⚠️ não achei em ' + (tried || 3) + ' fontes — manda foto do código ou digita manual';
            }
          } catch (e) {
            result.className = 'expand-status err';
            result.textContent = 'erro: ' + e.message;
          } finally { el.disabled = false; }
        } else if (act === 'ean-save') {
          const ean = expand.querySelector('input[data-field="ean"]').value.trim().replace(/\\D/g,'');
          if (!ean || ean.length < 8) { setS('⚠️ EAN inválido (precisa 8-13 dígitos)', 'err'); return; }
          setS('salvando...');
          const data = await api('save_specs', { productId: d.productId, barcode: ean });
          setS('✓ EAN salvo' + (data.finalized ? ' — produto FINALIZADO!' : ''), 'ok');
          setStepDone('ean');
          d.barcode = ean;
          if (data.finalized) {
            setTimeout(() => { row.style.transition='opacity .4s'; row.style.opacity='0'; setTimeout(()=>row.remove(),500); }, 1000);
          }
        }
      } catch (e) {
        setS('erro: ' + e.message, 'err');
      }
    });
  });
}
</script>
</body></html>`;
}

async function handleGalleryView(req, res) {
  const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
  const params = {};
  qs.split('&').forEach(p => {
    const [k, v] = p.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  if (!ADMIN_TOKEN || params.token !== ADMIN_TOKEN) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send('<h1 style="color:#ff2d95;font-family:sans-serif">unauthorized</h1>');
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).send('supabase not configured');
  }
  try {
    // OSSO 28C — query defensiva: aceita image_status=awaiting_approval (canon)
    // OU produto com art_status=complete + image_url=null (arte gerada mas
    // ficou dessincronizada — fallback pra não perder produto pra revisar).
    const awaiting = await sbGet('drope_products',
      'or=(image_status.eq.awaiting_approval,and(art_status.eq.complete,image_url.is.null))&order=updated_at.desc&limit=200');
    const approved = await sbGet('drope_products',
      'image_status=eq.ok&order=updated_at.desc&limit=200');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(galleryHtml(awaiting || [], approved || [], ADMIN_TOKEN));
  } catch (e) {
    console.error('[gallery view] error:', e.message);
    return res.status(500).send('error: ' + e.message);
  }
}

async function handleGalleryAction(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });
  const provided = (req.headers && req.headers['x-admin-token']) || '';
  if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const b = req.body || {};
  const { id, op, barcode, price_cents } = b;
  if (!id || !op) return res.status(400).json({ ok: false, error: 'missing id or op' });

  try {
    const rows = await sbGet('drope_products', `id=eq.${encodeURIComponent(id)}&select=id,name,slug,metadata&limit=1`);
    const product = rows[0];
    if (!product) return res.status(404).json({ ok: false, error: 'product not found' });

    const meta = product.metadata || {};
    const update = {};

    if (op === 'approve') {
      const artUrl = meta.pending_art_url;
      if (!artUrl) return res.status(400).json({ ok: false, error: 'no pending_art_url to approve' });
      update.image_url = artUrl;
      update.image_status = 'ok';
    } else if (op === 'reject' || op === 'regenerate') {
      update.image_status = 'pending_regeneration';
    } else {
      return res.status(400).json({ ok: false, error: 'invalid op' });
    }

    if (typeof barcode === 'string' && barcode.trim()) {
      update.barcode = barcode.trim();
    }
    if (typeof price_cents === 'number' && price_cents > 0) {
      update.price_cents = price_cents;
    }

    await sbUpdate('drope_products', `id=eq.${encodeURIComponent(id)}`, update);

    // BLOCO 2: ao aprovar via gallery, dispara vídeo em background (fire-and-forget)
    if (op === 'approve' && update.image_url) {
      const slug = product.slug || slugify(meta.brand || 'pod', meta.model || '', meta.flavor_en || meta.flavor_pt || 'video');
      fireBackgroundVideoGeneration(update.image_url, slug, null, null, product.name);
    }

    // OSSO 28C — ao regenerar, dispara geração imediata (não fica esperando cron).
    // fireBackgroundArtGeneration é fire-and-forget — frontend pode pollar art_status.
    if (op === 'regenerate') {
      try {
        const nextAttempt = (meta.last_art_attempt || 0) + 1;
        await sbUpdate('drope_products', `id=eq.${encodeURIComponent(id)}`, { image_status: 'generating' });
        fireBackgroundArtGeneration(id, ADMIN_LUCAS, nextAttempt).catch(e => console.warn('[gallery_action regenerate] fireArt:', e.message));
      } catch (e) { console.warn('[gallery_action regenerate] dispatch err:', e.message); }
    }

    return res.status(200).json({
      ok: true,
      message: op === 'approve' ? 'aprovada ✓ — vídeo em background' : (op === 'regenerate' ? 'regerando agora (~30s)' : 'rejeitada'),
    });
  } catch (e) {
    console.error('[gallery action] error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ============ CATALOG (REFATOR 30/04/2026 tarde 5) ============
// GET /api/webhook?action=catalog → JSON com produtos visíveis do drope_products
// Substitui o array hardcoded `let products = [...]` que vivia em index.html (66 produtos
// apontando pra arquivos PNG estáticos, vários inexistentes). Agora o app cliente puxa
// daqui e qualquer produto cadastrado pelo bot aparece automaticamente.
//
// Schema de saída compatível com legado: { id, slug, name, desc, price, price_cents, cat,
// perfil, puffs, marca, modelo, sabor, img, stock, barcode, emoji }
//
// Filtros: hidden=false + image_status='ok'. Cache 5min CDN.

function emojiForFlavor(flavor) {
  const f = (flavor || '').toLowerCase();
  const map = [
    [/morango|strawberry/, '🍓'],
    [/abacaxi|pineapple/, '🍍'],
    [/manga|mango/, '🥭'],
    [/melancia|watermelon/, '🍉'],
    [/maca|maçã|apple/, '🍏'],
    [/pera|pear/, '🍐'],
    [/uva|grape/, '🍇'],
    [/limao|lemon|lima|lime/, '🍋'],
    [/menta|mint|hortela|hortelã|menthol/, '🌿'],
    [/blueberry|mirtilo|amora|blackberry/, '🫐'],
    [/banana/, '🍌'],
    [/pessego|pêssego|peach/, '🍑'],
    [/pitaya|dragon/, '🐉'],
    [/maracuja|maracujá|passion/, '🥭'],
    [/coco|coconut/, '🥥'],
    [/romã|roma|pomegranate/, '🍎'],
    [/mix|tropical/, '🌴'],
    [/cereja|cherry|sakura/, '🍒'],
    [/cream|creme|baunilha|vanilla/, '🍦'],
    [/ice|gelo|frost|cool/, '❄️'],
  ];
  for (const [re, e] of map) if (re.test(f)) return e;
  return '🦎';
}

function inferPerfil(category, flavor, descricao) {
  const cat = (category || '').toLowerCase();
  if (cat === 'frutado' || cat === 'mentolado' || cat === 'gelado' || cat === 'doce') return cat;
  const f = `${flavor || ''} ${descricao || ''}`.toLowerCase();
  if (/menta|mint|hortela|hortelã|menthol/.test(f)) return 'mentolado';
  if (/ice|gelado|frio|cool|frost/.test(f)) return 'gelado';
  if (/cream|creme|baunilha|vanilla|chocolate|doce/.test(f)) return 'doce';
  return 'frutado';
}

async function handleCatalog(req, res) {
  // CORS — pode vir do próprio domínio ou localhost de dev
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  // FEATURE 3 (osso21) — filtros opcionais via query string:
  //   ?flavor=fruity|sweet|icy|menthol|tobacco|other  → filtra por flavor_category
  //   ?limit=N      → máximo N produtos (default 300, home usa 8)
  //   ?sort=popular → ordena por total_sold DESC (default name.asc)
  const qs = (req.url && req.url.includes('?')) ? req.url.split('?')[1] : '';
  const params = {};
  qs.split('&').forEach(p => {
    const [k, v] = p.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });
  const flavor = (params.flavor || '').toLowerCase();
  const validFlavors = ['fruity', 'sweet', 'icy', 'menthol', 'tobacco', 'other'];
  const limit = Math.max(1, Math.min(300, parseInt(params.limit) || 300));
  const sort = (params.sort || '').toLowerCase();
  const orderClause = sort === 'popular' ? 'total_sold.desc.nullslast' : 'name.asc';

  // hidden=false + image_status='ok' (sem isso a UI fica meio quebrada).
  // qty_available NÃO é filtrado — UI legada já mostra "esgotado" quando stock<=0.
  const buildFilter = (withOsso21) => {
    const parts = [
      'select=id,slug,name,image_url,price_cents,qty_available,descricao_quebrada,' +
        'cores_predominantes,category,metadata,barcode,created_via' +
        (withOsso21 ? ',flavor_category,total_sold' : ''),
      'hidden=eq.false',
      'image_status=eq.ok',
      `order=${withOsso21 ? orderClause : 'name.asc'}`,
      `limit=${limit}`,
    ];
    if (withOsso21 && flavor && validFlavors.includes(flavor)) {
      parts.push(`flavor_category=eq.${flavor}`);
    }
    return parts.join('&');
  };

  try {
    // 1ª tentativa com osso21 (flavor_category + total_sold). Se a migration
    // ainda não foi aplicada, o GET retorna [] vazio (sbGet loga e devolve []),
    // então fazemos fallback sem essas colunas.
    let rows = await sbGet('drope_products', buildFilter(true));
    if (!Array.isArray(rows) || rows.length === 0) {
      const fallback = await sbGet('drope_products', buildFilter(false));
      if (Array.isArray(fallback) && fallback.length > 0) rows = fallback;
    }
    if (!Array.isArray(rows)) {
      return res.status(502).json({ error: 'unexpected supabase response' });
    }

    const products = rows.map(p => {
      const meta = p.metadata || {};
      const flavorPt = (meta.flavor_pt || '').toLowerCase();
      const flavorEn = (meta.flavor_en || '').toLowerCase();
      const flavorName = flavorPt || flavorEn;
      const brand = (meta.brand || '').toLowerCase();
      const model = (meta.model || '').toLowerCase();
      const desc = p.descricao_quebrada || '';
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        desc,
        price: (p.price_cents || 0) / 100, // R$ decimal — preserva centavos
        price_cents: p.price_cents || 0,
        cat: 'pod', // todo: diversificar quando tabacaria entrar via bot
        perfil: inferPerfil(p.category, flavorName, desc),
        flavor_category: p.flavor_category || 'other', // osso21
        total_sold: p.total_sold || 0,
        puffs: meta.puffs || null,
        marca: brand,
        modelo: model,
        sabor: flavorName,
        img: p.image_url || null,
        stock: typeof p.qty_available === 'number' ? p.qty_available : null,
        barcode: p.barcode || null,
        emoji: emojiForFlavor(flavorName || desc),
        created_via: p.created_via,
      };
    });

    // Cache de 5min na CDN — o app cliente também tem cache localStorage local.
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
    return res.status(200).json({
      products,
      count: products.length,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[catalog] err:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ============ OSSO 21 — IA-FIRST CLIENTE (01/05/2026) ============
// Funções compartilhadas pelo home_personalized, queue_drop_notifications e
// updateFlavorProfile (recalcular após pagamento confirmado).

// Mapeia "perfil" legado (frutado/gelado/mentolado/doce) pra flavor_category novo.
// Tem produtos cadastrados antes da migration que ficam só com perfil.
function perfilToFlavor(perfil) {
  const p = (perfil || '').toLowerCase();
  if (p === 'frutado') return 'fruity';
  if (p === 'gelado') return 'icy';
  if (p === 'mentolado') return 'menthol';
  if (p === 'doce') return 'sweet';
  return 'other';
}

// Calcula perfil de sabor com base nos pedidos pagos do cliente.
// Persiste em drope_customers.flavor_profile (JSONB com %), favorite_flavor,
// favorite_brand. Idempotente — pode rodar sempre que pagamento confirma.
async function updateFlavorProfile(customerId) {
  if (!customerId) return null;
  try {
    const orders = await sbGet('drope_orders',
      `customer_id=eq.${customerId}&status=eq.paid&select=items&limit=200`);
    if (!Array.isArray(orders) || orders.length === 0) return null;

    const flavorCounts = {};
    const brandCounts = {};
    let total = 0;

    for (const order of orders) {
      const items = Array.isArray(order.items) ? order.items : [];
      for (const item of items) {
        const qty = Math.max(1, parseInt(item.qty) || 1);
        // Busca flavor_category pelo slug se item não trouxe
        let cat = item.flavor_category || perfilToFlavor(item.perfil);
        if (!cat || cat === 'other') {
          if (item.slug) {
            const prod = await sbGet('drope_products',
              `slug=eq.${encodeURIComponent(item.slug)}&select=flavor_category,metadata&limit=1`);
            if (prod[0]) {
              cat = prod[0].flavor_category || 'other';
              const brand = (prod[0].metadata || {}).brand || item.marca || null;
              if (brand) brandCounts[brand] = (brandCounts[brand] || 0) + qty;
            }
          }
        } else if (item.marca) {
          brandCounts[item.marca] = (brandCounts[item.marca] || 0) + qty;
        }
        flavorCounts[cat || 'other'] = (flavorCounts[cat || 'other'] || 0) + qty;
        total += qty;
      }
    }

    if (total === 0) return null;

    const profile = {};
    for (const [k, v] of Object.entries(flavorCounts)) {
      profile[k] = Math.round((v / total) * 100) / 100;
    }
    const sortedFlavors = Object.entries(profile).sort((a, b) => b[1] - a[1]);
    const sortedBrands = Object.entries(brandCounts).sort((a, b) => b[1] - a[1]);
    const favoriteFlavor = sortedFlavors[0]?.[0] || null;
    const favoriteBrand = sortedBrands[0]?.[0] || null;

    await sbUpdate('drope_customers', `id=eq.${customerId}`, {
      flavor_profile: profile,
      favorite_flavor: favoriteFlavor,
      favorite_brand: favoriteBrand,
      total_orders: orders.length,
    });
    console.log('[updateFlavorProfile]', String(customerId).slice(0, 8), 'fav:', favoriteFlavor, 'orders:', orders.length);
    return profile;
  } catch (e) {
    console.error('[updateFlavorProfile] err:', e.message);
    return null;
  }
}

// Pega N produtos rankeados por match com flavor_profile do cliente.
// Excluí o último produto comprado (já vai aparecer no card "dropar de novo").
async function getRecommendations(customer, limit = 6) {
  // Tenta com flavor_category + total_sold; se a migration não rodou, fallback.
  let products = await sbGet('drope_products',
    'select=id,slug,name,image_url,price_cents,qty_available,flavor_category,total_sold,metadata,descricao_quebrada,category' +
    '&hidden=eq.false&image_status=eq.ok&qty_available=gt.0&limit=80&order=total_sold.desc.nullslast');
  if (!Array.isArray(products) || products.length === 0) {
    products = await sbGet('drope_products',
      'select=id,slug,name,image_url,price_cents,qty_available,metadata,descricao_quebrada,category' +
      '&hidden=eq.false&image_status=eq.ok&qty_available=gt.0&limit=80&order=name.asc');
  }
  if (!Array.isArray(products)) return [];

  const profile = (customer && customer.flavor_profile) || {};
  const lastProductId = customer && customer.last_product_id;

  const scored = products
    .filter(p => p.id !== lastProductId)
    .map(p => {
      const cat = p.flavor_category || perfilToFlavor(inferPerfil(p.category, '', p.descricao_quebrada || ''));
      const matchScore = profile[cat] || 0;
      const meta = p.metadata || {};
      const flavorName = (meta.flavor_pt || meta.flavor_en || '').toLowerCase();
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        // OSSO 25 — campos separados pra UI: sabor hero + brand muted
        flavor: meta.flavor_pt || meta.flavor_en || '',
        brand: meta.brand || null,
        model: meta.model || null,
        image_url: p.image_url || null,
        price: (p.price_cents || 0) / 100,
        price_cents: p.price_cents || 0,
        flavor_category: cat,
        match_score: matchScore,
        match_reason: matchScore >= 0.3 ? `combina com seu perfil ${labelFlavor(cat)}` :
                      matchScore > 0      ? `mistura com seu perfil`             :
                                            'popular agora',
        emoji: emojiForFlavor(flavorName || p.descricao_quebrada || ''),
      };
    });

  scored.sort((a, b) => {
    if (b.match_score !== a.match_score) return b.match_score - a.match_score;
    return 0; // já vem ordenado por total_sold
  });

  return scored.slice(0, limit);
}

function labelFlavor(cat) {
  const map = { fruity: 'frutado', sweet: 'doce', icy: 'gelado', menthol: 'mentolado', tobacco: 'tabaco', other: 'variado' };
  return map[cat] || cat;
}

// OSSO 22 — Heurística de classificação por nome (fallback se Vision falhar
// ou pra backfill). REGRA: ICE domina — "Mango Ice" = icy, não fruity.
function classifyFlavorByName(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'other';
  // 1º: ice/freeze/frost/cool DOMINA (mesmo se houver fruta no nome)
  if (/\b(ice|gelo|gelad[ao]|freeze|frost|cool|cold|stone\s*freeze|frozen|crystal)\b/.test(t)) return 'icy';
  // 2º: menthol — termos específicos (menta, mint, etc.)
  if (/\b(menthol|mint|menta|hortela|hortelã|spearmint|peppermint|eucalyptus|eucalipto)\b/.test(t)) return 'menthol';
  // 3º: tobacco — antes de fruity (alguns nomes têm "classic")
  if (/\b(tobacco|tabaco|cigar|cuban|wood|tabac)\b/.test(t)) return 'tobacco';
  // 4º: doce — antes de fruity (chocolate, vanilla, caramel)
  if (/\b(candy|sweet|caramel|caramelo|vanilla|baunilha|chocolate|gum|bubblegum|cake|cookie|cream|creme|sugar|honey|toffee|cotton\s*candy|algodao|doce)\b/.test(t)) return 'sweet';
  // 5º: fruta
  if (/\b(mango|manga|grape|uva|strawberry|morango|watermelon|melancia|peach|pessego|pêssego|apple|maca|maçã|berry|fruit|fruta|tropical|lemon|limao|limão|lime|lima|orange|laranja|cherry|cereja|aloe|kiwi|passion|maracuja|maracujá|guava|goiaba|pineapple|abacaxi|blueberry|mirtilo|raspberry|framboesa|melon|melao|melão|banana|lychee|coconut|coco|pitaya|dragon|toranja|grapefruit)\b/.test(t)) return 'fruity';
  return 'other';
}

// GET/POST /api/webhook?action=backfill_flavors
// Reclassifica produtos cujo flavor_category está NULL ou 'other'.
// Usa nome+sabor pra inferir via classifyFlavorByName. Idempotente.
async function handleBackfillFlavors(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }
  try {
    // Busca produtos sem categoria definida ou em 'other'
    const rows = await sbGet('drope_products',
      'select=id,name,metadata,flavor_category&or=(flavor_category.is.null,flavor_category.eq.other)&limit=500');
    if (!Array.isArray(rows)) return res.status(502).json({ ok: false, error: 'unexpected response' });

    let updated = 0, unchanged = 0;
    const details = [];
    for (const p of rows) {
      const meta = p.metadata || {};
      const haystack = `${p.name || ''} ${meta.flavor_pt || ''} ${meta.flavor_en || ''}`;
      const cat = classifyFlavorByName(haystack);
      if (cat === (p.flavor_category || 'other')) { unchanged++; continue; }
      await sbUpdate('drope_products', `id=eq.${p.id}`, { flavor_category: cat });
      updated++;
      details.push({ id: p.id, name: p.name, was: p.flavor_category || null, now: cat });
    }
    return res.status(200).json({ ok: true, scanned: rows.length, updated, unchanged, details });
  } catch (e) {
    console.error('[backfill_flavors] err:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/webhook?action=home_personalized&customer_phone=5511XXXXX
//        OR &customer_id=uuid
// Retorna { type: 'new'|'returning', last_order, recommendations, vibe_options }
async function handleHomePersonalized(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  const qs = (req.url && req.url.includes('?')) ? req.url.split('?')[1] : '';
  const params = {};
  qs.split('&').forEach(p => {
    const [k, v] = p.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });

  const VIBE_OPTIONS = ['fruity', 'sweet', 'icy', 'menthol'];

  try {
    let customer = null;
    if (params.customer_id) {
      const rows = await sbGet('drope_customers',
        `id=eq.${encodeURIComponent(params.customer_id)}&select=id,phone,name,flavor_profile,favorite_flavor,favorite_brand,total_orders,last_order_date,last_product_id,last_delivery_address&limit=1`);
      customer = rows[0] || null;
    } else if (params.customer_phone) {
      const phoneClean = String(params.customer_phone).replace(/\D/g, '');
      if (phoneClean) {
        const rows = await sbGet('drope_customers',
          `phone=eq.${phoneClean}&select=id,phone,name,flavor_profile,favorite_flavor,favorite_brand,total_orders,last_order_date,last_product_id,last_delivery_address&limit=1`);
        customer = rows[0] || null;
      }
    }

    // Sem cliente conhecido → tipo 'new': retorna só vibes + top populares
    if (!customer) {
      const popular = await getRecommendations({ flavor_profile: {}, last_product_id: null }, 6);
      return res.status(200).json({
        type: 'new',
        last_order: null,
        recommendations: popular.map(p => ({ ...p, match_reason: 'popular agora' })),
        vibe_options: VIBE_OPTIONS,
        generated_at: new Date().toISOString(),
      });
    }

    // Cliente sem perfil ainda (capturado pelo bot mas nunca comprou) → trata como 'new'
    const totalOrders = customer.total_orders || 0;
    if (totalOrders === 0 || !customer.last_product_id) {
      const popular = await getRecommendations(customer, 6);
      return res.status(200).json({
        type: 'new',
        customer_id: customer.id,
        last_order: null,
        recommendations: popular,
        vibe_options: VIBE_OPTIONS,
        generated_at: new Date().toISOString(),
      });
    }

    // Cliente recorrente → busca último produto e monta card "dropar de novo"
    let lastOrder = null;
    if (customer.last_product_id) {
      const lp = await sbGet('drope_products',
        `id=eq.${customer.last_product_id}&select=id,slug,name,image_url,price_cents,qty_available,metadata,flavor_category&limit=1`);
      if (lp[0]) {
        const p = lp[0];
        const lastDate = customer.last_order_date ? new Date(customer.last_order_date) : null;
        const daysAgo = lastDate ? Math.max(0, Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))) : null;
        const meta = p.metadata || {};
        const flavorName = (meta.flavor_pt || meta.flavor_en || '').toString();
        lastOrder = {
          product_id: p.id,
          slug: p.slug,
          product_name: p.name,
          product_image: p.image_url || null,
          product_price: (p.price_cents || 0) / 100,
          flavor_category: p.flavor_category || 'other',
          // OSSO 25 — campos separados pra UI montar "sabor hero + marca muted"
          flavor: flavorName,
          brand: meta.brand || null,
          model: meta.model || null,
          days_ago: daysAgo,
          in_stock: typeof p.qty_available === 'number' ? p.qty_available > 0 : true,
          emoji: emojiForFlavor(flavorName.toLowerCase()),
          last_delivery_address: customer.last_delivery_address || null,
        };
      }
    }

    const recommendations = await getRecommendations(customer, 3);

    return res.status(200).json({
      type: 'returning',
      customer_id: customer.id,
      customer_name: customer.name || null,
      flavor_profile: customer.flavor_profile || {},
      favorite_flavor: customer.favorite_flavor || null,
      favorite_brand: customer.favorite_brand || null,
      total_orders: totalOrders,
      last_order: lastOrder,
      recommendations,
      vibe_options: VIBE_OPTIONS,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[home_personalized] err:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// GET/POST /api/webhook?action=customer_profile&customer_phone=...
// Retorna o flavor_profile pra tela /perfil do app. Diferente do home_personalized,
// SEMPRE recalcula antes de devolver — garante consistência após pagamento.
async function handleCustomerProfile(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const qs = (req.url && req.url.includes('?')) ? req.url.split('?')[1] : '';
  const params = {};
  qs.split('&').forEach(p => {
    const [k, v] = p.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  });

  try {
    let customer = null;
    if (params.customer_id) {
      const rows = await sbGet('drope_customers',
        `id=eq.${encodeURIComponent(params.customer_id)}&limit=1`);
      customer = rows[0] || null;
    } else if (params.customer_phone) {
      const phoneClean = String(params.customer_phone).replace(/\D/g, '');
      if (phoneClean) {
        const rows = await sbGet('drope_customers',
          `phone=eq.${phoneClean}&limit=1`);
        customer = rows[0] || null;
      }
    }
    if (!customer) return res.status(404).json({ error: 'customer not found' });

    // Recalcula on-demand pra garantir frescor.
    await updateFlavorProfile(customer.id);
    const refreshed = await sbGet('drope_customers',
      `id=eq.${customer.id}&limit=1`);
    const c = refreshed[0] || customer;

    return res.status(200).json({
      customer_id: c.id,
      name: c.name || null,
      flavor_profile: c.flavor_profile || {},
      favorite_flavor: c.favorite_flavor || null,
      favorite_brand: c.favorite_brand || null,
      total_orders: c.total_orders || 0,
      member_since: c.created_at || null,
      last_order_date: c.last_order_date || null,
    });
  } catch (e) {
    console.error('[customer_profile] err:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ============ OSSO 21 FEATURE 5 — DROPS INTELIGENTES ============
// Quando produtos novos chegam (Andrade biparam no /receber), o sistema
// cruza com o flavor_profile dos clientes e enfileira notificações.
// Cron domingo 10h SP envia em lotes (máx 3 produtos por cliente / semana).

function getNextSundayMorning(hourSP = 10) {
  // Calcula próxima ocorrência de domingo às `hourSP` (America/Sao_Paulo) em UTC.
  // SP é UTC-3 sem DST (lei 13.575/2017). 10h SP = 13h UTC.
  const now = new Date();
  const utcHour = (hourSP + 3) % 24;
  const target = new Date(now);
  target.setUTCHours(utcHour, 0, 0, 0);
  // Avança até domingo (getUTCDay() === 0)
  let i = 0;
  while (target.getUTCDay() !== 0 || target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
    i++;
    if (i > 14) break;
  }
  return target.toISOString();
}

// POST /api/webhook?action=queue_drop_notifications  (admin/manual ou hook do /receber)
// Varre produtos cadastrados nas últimas 24h e cruza com flavor_profile dos clientes.
async function handleQueueDropNotifications(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const newProducts = await sbGet('drope_products',
      `created_at=gte.${encodeURIComponent(cutoff)}&hidden=eq.false&image_status=eq.ok&select=id,name,flavor_category,price_cents,image_url&limit=50`);

    if (!Array.isArray(newProducts) || newProducts.length === 0) {
      return res.status(200).json({ ok: true, queued: 0, reason: 'no new products' });
    }

    const customers = await sbGet('drope_customers',
      `flavor_profile=not.is.null&select=id,phone,name,flavor_profile&limit=500`);

    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(200).json({ ok: true, queued: 0, reason: 'no customers with profile' });
    }

    const scheduledFor = getNextSundayMorning(10);
    let queued = 0;
    const details = [];

    for (const product of newProducts) {
      const cat = product.flavor_category || 'other';
      for (const customer of customers) {
        const profile = customer.flavor_profile || {};
        const matchScore = profile[cat] || 0;
        if (matchScore < 0.2) continue; // threshold: 20% do perfil

        const inserted = await sbInsert('drope_drop_notifications', {
          customer_id: customer.id,
          product_id: product.id,
          match_reason: `perfil ${labelFlavor(cat)} ${Math.round(matchScore * 100)}%`,
          status: 'pending',
          scheduled_for: scheduledFor,
        });
        // Dedup falha (UNIQUE constraint customer_id+product_id) → ignora silencioso.
        if (inserted) {
          queued++;
          details.push({ customer: String(customer.id).slice(0, 8), product: product.name, match: matchScore });
        }
      }
    }

    // OSSO 22 — Cruza produtos novos × drope_customer_interests waiting.
    // Match por nome do produto, marca, modelo, sabor ou flavor_category.
    let interestsMatched = 0;
    try {
      const interests = await sbGet('drope_customer_interests',
        'select=id,customer_id,interest&status=eq.waiting&limit=300');
      if (Array.isArray(interests) && interests.length > 0) {
        for (const product of newProducts) {
          const meta = product.metadata || {};
          const haystack = `${product.name} ${meta.brand || ''} ${meta.model || ''} ${meta.flavor_pt || ''} ${meta.flavor_en || ''} ${product.flavor_category || ''}`.toLowerCase();
          for (const it of interests) {
            const term = String(it.interest || '').toLowerCase().trim();
            if (!term || term.length < 3) continue;
            if (!haystack.includes(term)) continue;
            // Match — enfileira notificação E marca interest como notified
            const inserted = await sbInsert('drope_drop_notifications', {
              customer_id: it.customer_id,
              product_id: product.id,
              match_reason: `interesse: "${term}"`,
              status: 'pending',
              scheduled_for: scheduledFor,
            });
            if (inserted) {
              interestsMatched++;
              await sbUpdate('drope_customer_interests', `id=eq.${it.id}`,
                { status: 'notified', notified_at: new Date().toISOString() });
            }
          }
        }
      }
    } catch (e) { console.warn('[queue_drop_notifications] interests cross err:', e.message); }

    console.log(`[queue_drop_notifications] queued=${queued} interests=${interestsMatched} products=${newProducts.length} customers=${customers.length}`);
    return res.status(200).json({
      ok: true, queued, interests_matched: interestsMatched,
      scheduled_for: scheduledFor,
      scanned: { products: newProducts.length, customers: customers.length },
      details,
    });
  } catch (e) {
    console.error('[queue_drop_notifications] err:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET/POST /api/webhook?action=run_drop_notifications  (cron domingo 10h SP)
// Envia WhatsApp pra cada cliente com até 3 produtos pendentes. Marca como sent.
// Limite extra: máx 3 notificações por cliente por semana (atendido pelo agrupamento).
async function handleRunDropNotifications(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }

  try {
    const now = new Date().toISOString();
    const filter =
      `status=eq.pending&scheduled_for=lte.${encodeURIComponent(now)}` +
      `&select=id,customer_id,product_id,match_reason,scheduled_for` +
      `&order=scheduled_for.asc&limit=200`;
    const pending = await sbGet('drope_drop_notifications', filter);

    if (!Array.isArray(pending) || pending.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, reason: 'none pending' });
    }

    // Agrupa por cliente, limitando a 3 produtos por cliente.
    const byCustomer = {};
    for (const n of pending) {
      if (!byCustomer[n.customer_id]) byCustomer[n.customer_id] = [];
      if (byCustomer[n.customer_id].length < 3) byCustomer[n.customer_id].push(n);
    }

    let sent = 0;
    let errors = 0;
    const skippedIds = []; // notifs além das 3 — viram "sent" sem envio (limite/semana)
    const details = [];

    for (const [customerId, notifs] of Object.entries(byCustomer)) {
      // Busca dados do cliente + produtos
      const custRows = await sbGet('drope_customers',
        `id=eq.${customerId}&select=phone,name&limit=1`);
      const customer = custRows[0];
      if (!customer || !customer.phone) {
        // Sem phone, marca como sent pra não ficar replayando.
        for (const n of notifs) {
          await sbUpdate('drope_drop_notifications', `id=eq.${n.id}`, { status: 'sent', sent_at: now });
        }
        details.push({ customer: String(customerId).slice(0, 8), reason: 'no_phone' });
        continue;
      }
      const productIds = notifs.map(n => n.product_id);
      const prodRows = await sbGet('drope_products',
        `id=in.(${productIds.join(',')})&select=id,name,price_cents,image_url&limit=10`);
      if (!Array.isArray(prodRows) || prodRows.length === 0) {
        for (const n of notifs) {
          await sbUpdate('drope_drop_notifications', `id=eq.${n.id}`, { status: 'sent', sent_at: now });
        }
        continue;
      }

      const products = prodRows.map(p => ({
        ...p,
        price: (p.price_cents || 0) / 100,
      }));

      const firstName = (customer.name || '').split(' ')[0];
      const greet = firstName ? `🦎 fala ${firstName}!` : `🦎`;
      let msg;
      if (products.length === 1) {
        msg = `${greet} chegou um *${products[0].name}* que tem tudo a ver com o que você curte.\n\nR$ ${products[0].price.toFixed(2).replace('.', ',')}\n\nquer dar uma olhada?`;
      } else {
        const list = products.map(p => `• ${p.name} — R$ ${p.price.toFixed(2).replace('.', ',')}`).join('\n');
        msg = `${greet} chegaram uns drops novos que combinam com você:\n\n${list}\n\nbora conferir?`;
      }

      try {
        await sendText(customer.phone, msg, {});
        // Manda imagem do primeiro produto se houver
        if (products[0].image_url) {
          try { await sendImage(customer.phone, products[0].image_url, '', {}); } catch(e) {}
        }
        // Mensagem 2 com link clicável
        await sendText(customer.phone, 'drope-app.vercel.app', {});
        // Marca todos como enviados
        for (const n of notifs) {
          await sbUpdate('drope_drop_notifications', `id=eq.${n.id}`,
            { status: 'sent', sent_at: new Date().toISOString() });
        }
        sent += notifs.length;
        details.push({ customer: String(customerId).slice(0, 8), products: products.length, status: 'sent' });
      } catch (e) {
        errors++;
        console.error('[run_drop_notifications] send err:', String(customerId).slice(0, 8), e.message);
      }
    }

    // Para clientes com mais de 3 notifs pendentes: as extras ficam "pending"
    // e são entregues nas próximas semanas (limite de 3 por execução é acumulativo).

    console.log(`[run_drop_notifications] sent=${sent} errors=${errors} pending_total=${pending.length}`);
    return res.status(200).json({
      ok: true, sent, errors,
      scanned: pending.length, by_customer: Object.keys(byCustomer).length,
      details,
    });
  } catch (e) {
    console.error('[run_drop_notifications] err:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ============ ADMIN CUSTOMERS (FEATURE 4 — 30/04/2026) ============
// GET /api/webhook?action=admin-customers&token=ADMIN_TOKEN → HTML com lista + métricas
// Reusa estética da gallery (dark neon). Serve pra Lucas ver base de clientes,
// status de retenção e abrir conversa direto via wa.me.

function customerStatus(lastSeenAt) {
  if (!lastSeenAt) return { label: 'sem contato', color: 'dim', days: null };
  const days = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / (24 * 60 * 60 * 1000));
  if (days < 15) return { label: '🟢 ativo', color: 'lime', days };
  if (days < 30) return { label: '🟡 sumindo', color: 'pink', days };
  return { label: '🔴 sumiu', color: 'pink', days };
}

function fmtDateBR(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch { return '—'; }
}

function customersHtml(customers, token) {
  // Métricas resumo
  const total = customers.length;
  let activo = 0, sumindo = 0, sumiu = 0;
  let totalSpent = 0, totalOrders = 0;
  for (const c of customers) {
    const s = customerStatus(c.last_seen_at);
    if (s.days != null && s.days < 15) activo++;
    else if (s.days != null && s.days < 30) sumindo++;
    else if (s.days != null) sumiu++;
    totalSpent += Number(c.total_spent_cents) || 0;
    totalOrders += Number(c.total_orders) || 0;
  }
  const ticketMedio = totalOrders > 0 ? totalSpent / totalOrders : 0;

  const renderRow = (c) => {
    const status = customerStatus(c.last_seen_at);
    const phone = String(c.phone || '').replace(/\D/g, '');
    const phoneDisplay = phone ? `+${phone.slice(0, 2)} ${phone.slice(2, 4)} ${phone.slice(4, 9)}-${phone.slice(9)}` : '—';
    const waLink = phone ? `https://wa.me/${phone}?text=${encodeURIComponent('fala, tudo bem? 🦎')}` : '#';
    const reorderText = encodeURIComponent('e aí 🦎 tá precisando dropar de novo?\n\ndrope-app.vercel.app');
    const reorderLink = phone ? `https://wa.me/${phone}?text=${reorderText}` : '#';
    const name = escapeHtml(c.name || '(sem nome)');
    const email = escapeHtml(c.email || '');
    const source = escapeHtml(c.source || 'unknown');
    const orders = Number(c.total_orders) || 0;
    const spent = ((Number(c.total_spent_cents) || 0) / 100).toFixed(2).replace('.', ',');
    const lastDays = status.days != null ? `há ${status.days}d` : '—';
    return `
      <tr>
        <td class="cell-name">
          <div class="name-line">${name}</div>
          ${email ? `<div class="email-line">${email}</div>` : ''}
          <div class="meta-line">${source}</div>
        </td>
        <td><a href="${waLink}" target="_blank" class="phone-link">${phoneDisplay}</a></td>
        <td>${fmtDateBR(c.created_at)}</td>
        <td>${fmtDateBR(c.last_seen_at)}<div class="meta-line">${lastDays}</div></td>
        <td class="num">${orders}</td>
        <td class="num">R$ ${spent}</td>
        <td><span class="status status-${status.color}">${status.label}</span></td>
        <td class="actions-cell">
          <a href="${waLink}" target="_blank" class="btn-mini btn-msg">💬 oi</a>
          <a href="${reorderLink}" target="_blank" class="btn-mini btn-reorder">🦎 recompra</a>
        </td>
      </tr>`;
  };

  return `<!doctype html>
<html lang="pt-br"><head>
<meta charset="utf-8">
<title>Drope ✦ Admin Clientes</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root { --bg: #0a0a0a; --neon: #b026ff; --lime: #c0ff33; --pink: #ff2d95; --txt: #fff; --dim: #888; --card: #111; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--txt); font-family: -apple-system, system-ui, sans-serif; padding: 16px; }
h1 { color: var(--neon); margin: 0 0 8px; font-size: 22px; }
h2 { color: var(--dim); margin: 24px 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
.summary { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); margin-bottom: 24px; }
.metric { background: var(--card); border: 1px solid #222; border-radius: 10px; padding: 12px; }
.metric-label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
.metric-value { font-size: 22px; font-weight: 700; margin-top: 4px; }
.metric-value.neon { color: var(--neon); }
.metric-value.lime { color: var(--lime); }
.metric-value.pink { color: var(--pink); }
.tablewrap { overflow-x: auto; background: var(--card); border-radius: 12px; border: 1px solid #222; }
table { width: 100%; border-collapse: collapse; min-width: 900px; }
th, td { padding: 12px; text-align: left; border-bottom: 1px solid #1a1a1a; font-size: 13px; vertical-align: top; }
th { color: var(--dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; background: #0d0d0d; }
.cell-name { min-width: 180px; }
.name-line { font-weight: 600; }
.email-line { color: var(--dim); font-size: 11px; margin-top: 2px; }
.meta-line { color: var(--dim); font-size: 10px; margin-top: 2px; text-transform: lowercase; }
.phone-link { color: var(--neon); text-decoration: none; }
.phone-link:hover { text-decoration: underline; }
.num { text-align: right; }
.status { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.status-lime { background: rgba(192,255,51,.15); color: var(--lime); }
.status-pink { background: rgba(255,45,149,.15); color: var(--pink); }
.status-dim { background: rgba(136,136,136,.15); color: var(--dim); }
.actions-cell { white-space: nowrap; }
.btn-mini { display: inline-block; padding: 6px 10px; margin-right: 6px; border-radius: 6px; text-decoration: none; font-size: 11px; font-weight: 600; }
.btn-msg { background: var(--lime); color: #000; }
.btn-reorder { background: var(--neon); color: #fff; }
.btn-mini:hover { filter: brightness(1.1); }
.empty { color: var(--dim); padding: 24px; text-align: center; font-style: italic; }
.nav-links a { color: var(--neon); margin-right: 12px; text-decoration: none; font-size: 12px; }
.nav-links a:hover { text-decoration: underline; }
</style>
</head><body>
<h1>Drope ✦ Admin Clientes</h1>
<div class="nav-links" style="margin-bottom:16px">
  <a href="?action=gallery&token=${escapeHtml(token || '')}">← gallery</a>
  <a href="?action=admin-customers&token=${escapeHtml(token || '')}">↻ refresh</a>
</div>

<div class="summary">
  <div class="metric"><div class="metric-label">Total</div><div class="metric-value neon">${total}</div></div>
  <div class="metric"><div class="metric-label">🟢 ativos</div><div class="metric-value lime">${activo}</div></div>
  <div class="metric"><div class="metric-label">🟡 sumindo</div><div class="metric-value pink">${sumindo}</div></div>
  <div class="metric"><div class="metric-label">🔴 sumiu</div><div class="metric-value pink">${sumiu}</div></div>
  <div class="metric"><div class="metric-label">Total gasto</div><div class="metric-value">R$ ${(totalSpent / 100).toFixed(2).replace('.', ',')}</div></div>
  <div class="metric"><div class="metric-label">Ticket médio</div><div class="metric-value">R$ ${(ticketMedio / 100).toFixed(2).replace('.', ',')}</div></div>
</div>

<div class="tablewrap">
${customers.length === 0 ? '<div class="empty">nenhum cliente cadastrado ainda</div>' : `
<table>
  <thead>
    <tr>
      <th>Cliente</th>
      <th>Telefone</th>
      <th>Desde</th>
      <th>Último contato</th>
      <th class="num">Pedidos</th>
      <th class="num">Total</th>
      <th>Status</th>
      <th>Ações</th>
    </tr>
  </thead>
  <tbody>
    ${customers.map(renderRow).join('')}
  </tbody>
</table>`}
</div>

<p style="color:var(--dim);font-size:11px;margin-top:24px">Status: 🟢 contato &lt;15 dias · 🟡 15-30 dias · 🔴 &gt;30 dias</p>
</body></html>`;
}

async function handleAdminCustomers(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Auth via ?token= ou x-admin-token header
  const url = req.url || '';
  const queryToken = (url.split('?')[1] || '').split('&').find(p => p.startsWith('token='))?.slice(6) || '';
  const headerToken = (req.headers && req.headers['x-admin-token']) || '';
  const token = queryToken || headerToken;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).send('<h1 style="color:#ff2d95;font-family:sans-serif">unauthorized</h1>');
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).send('supabase not configured');
  }
  try {
    // Tenta buscar com source; se falhar (coluna não existe), busca sem
    let customers = await sbGet('drope_customers',
      'select=id,phone,name,email,source,created_at,last_seen_at,total_orders,total_spent_cents&order=last_seen_at.desc&limit=500');
    if (!Array.isArray(customers) || (customers.length === 0 && (await sbGet('drope_customers', 'select=id&limit=1')).length > 0)) {
      // Provável erro com a coluna source — fallback sem ela
      customers = await sbGet('drope_customers',
        'select=id,phone,name,email,created_at,last_seen_at,total_orders,total_spent_cents&order=last_seen_at.desc&limit=500');
    }
    const html = customersHtml(customers || [], token);
    return res.status(200).send(html);
  } catch (e) {
    console.error('[admin-customers] error:', e.message);
    return res.status(500).send(`<pre style="color:#ff2d95">error: ${escapeHtml(e.message)}</pre>`);
  }
}

// ============ FEATURES PÓS-CATÁLOGO (30/04/2026) ============
// 6 features unificadas: follow-up, recompra, catálogo no bot, dashboard matinal,
// health check e política de reembolso. Todas as actions de servidor entram aqui.
// Token de auth pra crons: CRON_TOKEN (mesmo do cron-release-expired-reservations).

const CRON_TOKEN = process.env.CRON_TOKEN || "";

// Detecção de keyword pra cliente — antes de chamar Claude (evita custo + resposta padronizada)
function detectClienteIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const lower = message.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

  // Catálogo: lista produtos disponíveis
  const catalogPatterns = [
    /\bcardapio\b/, /\bcatalogo\b/, /\bmenu\b/,
    /\bo que tem\b/, /\bque tem ai\b/, /\bquais pods?\b/, /\bquais sabores\b/,
    /\bme mostra\b/, /\bmostra os? pods?\b/, /\bproduto/, /\blista de\b/,
  ];
  for (const re of catalogPatterns) if (re.test(lower)) return 'catalog';

  // Reembolso/troca: política fixa
  const refundPatterns = [
    /\breembolso\b/, /\btroca\b/, /\btrocar\b/, /\bdevolv/,
    /\bdevolucao\b/, /\bestorno\b/,
  ];
  for (const re of refundPatterns) if (re.test(lower)) return 'refund';

  return null;
}

const REFUND_POLICY_TEXT = `nossa política de trocas:

✦ pod com defeito de fábrica: troca grátis em até 7 dias
✦ sabor errado (erro nosso): troca grátis
✦ não gostou do sabor: sem troca (pod aberto não rola)
✦ reembolso: caso a caso, manda msg pro lucas

qualquer problema, manda aqui que a gente resolve 🦎`;

function formatBRL(cents) {
  if (cents == null || isNaN(cents)) return '0,00';
  return (Number(cents) / 100).toFixed(2).replace('.', ',');
}

// Retorna { items, footer }. Caller manda em 2 sendText separados pra footer (com link)
// ficar clicável no WhatsApp — link grudado em texto longo perde clicabilidade.
async function buildCatalogMessage() {
  const filter = `hidden=eq.false&image_status=eq.ok&qty_available=gt.0&select=name,price_cents&order=name.asc&limit=20`;
  const products = await sbGet('drope_products', filter);
  if (!products || products.length === 0) {
    return { items: 'tamo sem estoque agora, mas volta logo 🦎', footer: null };
  }
  const lines = products.map(p => `✦ ${p.name} — R$ ${formatBRL(p.price_cents)}`);
  return {
    items: `🦎 o que a gente tem agora:\n\n${lines.join('\n')}`,
    footer: `pra pedir: drope-app.vercel.app\nou manda aqui o nome do que quer 😉`,
  };
}

// Auth pra endpoints de cron: aceita CRON_TOKEN (header x-cron-token, Authorization Bearer, ?token=)
// OU ADMIN_TOKEN (Andrade chamando manual)
function checkCronAuth(req) {
  const url = req.url || '';
  const authHeader = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const cronHeader = (req.headers && req.headers['x-cron-token']) || '';
  const adminHeader = (req.headers && req.headers['x-admin-token']) || '';
  const queryToken = (url.split('?')[1] || '').split('&').find(p => p.startsWith('token='))?.slice(6) || '';

  const candidates = [authHeader, cronHeader, adminHeader, queryToken].filter(Boolean);
  for (const c of candidates) {
    if (CRON_TOKEN && c === CRON_TOKEN) return true;
    if (ADMIN_TOKEN && c === ADMIN_TOKEN) return true;
  }
  return false;
}

async function getCustomerPhoneById(customerId) {
  if (!customerId) return null;
  const rows = await sbGet('drope_customers', `id=eq.${customerId}&select=phone&limit=1`);
  const phone = rows[0]?.phone || null;
  if (!phone) return null;
  return String(phone).replace(/\D/g, '');
}

// FEATURE 3A — Captura silenciosa de cliente.
// Toda interação (bot WhatsApp ou checkout app) cria/atualiza registro em drope_customers
// sem pedir nada ao cliente. Idempotente via phone (UNIQUE NOT NULL no schema).
//
// Tenta INSERT com `source` (osso20). Se a coluna ainda não existe (migration não rodou),
// faz fallback INSERT sem source — sistema nunca trava por isso. last_seen_at sempre atualiza.
async function captureCustomerSilent(phone, source = 'whatsapp', extra = {}) {
  if (!phone || !SUPABASE_URL || !SUPABASE_KEY) return null;
  const phoneClean = String(phone).replace(/\D/g, '');
  if (!phoneClean) return null;
  try {
    const existing = await sbGet('drope_customers', `phone=eq.${encodeURIComponent(phoneClean)}&select=id&limit=1`);
    if (existing.length > 0) {
      // Já existe → só atualiza last_seen_at (mantém source/name/email originais)
      const updateRow = { last_seen_at: new Date().toISOString() };
      if (extra.name) updateRow.name = String(extra.name).slice(0, 100);
      if (extra.email) updateRow.email = String(extra.email).slice(0, 100);
      await sbUpdate('drope_customers', `id=eq.${existing[0].id}`, updateRow);
      return existing[0];
    }
    // Novo → tenta com source primeiro, fallback sem source se a coluna não existir
    const baseRow = {
      phone: phoneClean,
      last_seen_at: new Date().toISOString(),
    };
    if (extra.name) baseRow.name = String(extra.name).slice(0, 100);
    if (extra.email) baseRow.email = String(extra.email).slice(0, 100);
    let created = await sbInsert('drope_customers', { ...baseRow, source });
    if (!created) {
      // Coluna source provavelmente não existe — retry sem ela
      created = await sbInsert('drope_customers', baseRow);
    }
    if (created) console.log('[captureCustomerSilent] new:', phoneClean.slice(0, 6) + '***', 'src:', source);
    return created;
  } catch (e) {
    console.error('[captureCustomerSilent] err:', e.message);
    return null;
  }
}

function getOrderPhone(order) {
  const snap = order.customer_snapshot || {};
  if (snap.phone) {
    const clean = String(snap.phone).replace(/\D/g, '');
    if (clean) return clean;
  }
  return null;
}

// FEATURE 1 — Follow-up pós-venda
// 2h depois que pedido vira delivered/picked_up (ou paid sem entrega registrada),
// manda WhatsApp pro cliente. Idempotente via metadata.follow_up_sent.
async function handleRunFollowups(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }

  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const baseSelect = 'select=id,order_nsu,customer_id,customer_snapshot,metadata,delivered_at,picked_up_at,payment_confirmed_at,status';

  // Pedidos entregues há mais de 2h
  const deliveredFilter = `status=in.(delivered,picked_up)&or=(delivered_at.lt.${encodeURIComponent(cutoff)},picked_up_at.lt.${encodeURIComponent(cutoff)})&${baseSelect}&order=updated_at.asc&limit=50`;
  const delivered = await sbGet('drope_orders', deliveredFilter);

  // Fallback: pedidos pagos sem rastreio de entrega há mais de 2h
  const paidFilter = `status=eq.paid&payment_confirmed_at=lt.${encodeURIComponent(cutoff)}&delivered_at=is.null&picked_up_at=is.null&${baseSelect}&order=payment_confirmed_at.asc&limit=50`;
  const paid = await sbGet('drope_orders', paidFilter);

  const all = [...delivered, ...paid];
  const seen = new Set();
  const orders = all.filter(o => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });

  let sent = 0, skipped = 0, errors = 0;
  const details = [];

  for (const order of orders) {
    const meta = order.metadata || {};
    if (meta.follow_up_sent) { skipped++; continue; }

    let phone = getOrderPhone(order);
    if (!phone && order.customer_id) phone = await getCustomerPhoneById(order.customer_id);
    if (!phone) {
      skipped++;
      details.push({ order_nsu: order.order_nsu, reason: 'no_phone' });
      continue;
    }

    try {
      await sendText(phone, "e aí, chegou tudo certo? 🦎\n\nqualquer coisa manda aqui que a gente resolve", {});
      const newMeta = { ...meta, follow_up_sent: true, follow_up_sent_at: new Date().toISOString() };
      await sbUpdate('drope_orders', `id=eq.${order.id}`, { metadata: newMeta });
      sent++;
      details.push({ order_nsu: order.order_nsu, status: 'sent' });
    } catch (e) {
      console.error('[run_followups] error:', order.order_nsu, e.message);
      errors++;
    }
  }

  console.log(`[run_followups] sent=${sent} skipped=${skipped} errors=${errors} scanned=${orders.length}`);
  return res.status(200).json({ ok: true, sent, skipped, errors, scanned: orders.length, cutoff, details });
}

// FEATURE 2 — Lembrete de recompra 15 dias
// Pedido pago há 15+ dias sem recompra mais recente → manda lembrete único.
// Idempotente via metadata.reorder_sent.
async function handleRunReorder(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }

  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const filter = `status=eq.paid&payment_confirmed_at=lt.${encodeURIComponent(cutoff)}&select=id,order_nsu,customer_id,customer_snapshot,metadata,payment_confirmed_at&order=payment_confirmed_at.asc&limit=100`;
  const orders = await sbGet('drope_orders', filter);

  let sent = 0, skipped = 0, errors = 0;
  const details = [];

  for (const order of orders) {
    const meta = order.metadata || {};
    if (meta.reorder_sent) { skipped++; continue; }

    // Se já tem pedido pago mais recente do mesmo cliente, NÃO manda
    if (order.customer_id) {
      const recent = await sbGet('drope_orders',
        `customer_id=eq.${order.customer_id}&payment_confirmed_at=gt.${encodeURIComponent(cutoff)}&status=eq.paid&select=id&limit=1`);
      if (recent && recent.length > 0) {
        skipped++;
        details.push({ order_nsu: order.order_nsu, reason: 'recent_purchase' });
        continue;
      }
    }

    let phone = getOrderPhone(order);
    if (!phone && order.customer_id) phone = await getCustomerPhoneById(order.customer_id);
    if (!phone) {
      skipped++;
      details.push({ order_nsu: order.order_nsu, reason: 'no_phone' });
      continue;
    }

    try {
      // 2 mensagens: a 2ª com só o link fica clicável no WhatsApp
      await sendText(phone, "faz 15 dias que você dropou 🦎\n\nseu pod deve tá acabando.\n\nbora dropar de novo?", {});
      await sendText(phone, "drope-app.vercel.app", {});
      const newMeta = { ...meta, reorder_sent: true, reorder_sent_at: new Date().toISOString() };
      await sbUpdate('drope_orders', `id=eq.${order.id}`, { metadata: newMeta });
      sent++;
      details.push({ order_nsu: order.order_nsu, status: 'sent' });
    } catch (e) {
      console.error('[run_reorder] error:', order.order_nsu, e.message);
      errors++;
    }
  }

  console.log(`[run_reorder] sent=${sent} skipped=${skipped} errors=${errors} scanned=${orders.length}`);
  return res.status(200).json({ ok: true, sent, skipped, errors, scanned: orders.length, cutoff, details });
}

// FEATURE 4 — Dashboard matinal
// Resumo das últimas 24h enviado pro WhatsApp do Lucas. Cron diário 9h SP (12h UTC).
// FLC FASE 6 (07/05/2026) — Auto-close de batches abandonados.
// Piggyback no daily_dashboard: roda 1x/dia, fecha batches do Andrade que
// ficaram presos em batch_active >2h sem foto nova. Resolve o caso visto hoje
// onde Andrade tinha pending batch_active de 8h atras travando o fluxo.
async function autoCloseAbandonedBatches() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { closed: 0, errors: 0, skipped: 0 };
  let closed = 0, errors = 0, skipped = 0, found = 0;
  try {
    // Le todos pendings (filtro do mode no cliente, jsonb sem indice)
    const rows = await sbGet('drope_pending_state', 'select=phone,state,updated_at&order=updated_at.desc&limit=100');
    if (!Array.isArray(rows)) return { closed: 0, errors: 0, skipped: 0 };
    const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2h
    for (const row of rows) {
      const state = row.state || {};
      if (state.mode !== 'batch_active') continue;
      found++;
      const lastTouch = state.lastPhotoAt || state.startedAt || new Date(row.updated_at).getTime();
      if (lastTouch > cutoff) { skipped++; continue; } // ainda recente
      try {
        // Simula fechar lote pelo proprio Andrade
        await closeBatch(row.phone, state, {});
        closed++;
        await sendText(row.phone,
          `⏰ Lote anterior estava aberto ha mais de 2h sem fotos novas. Fechei automaticamente. Manda 'lote' pra começar outro.`,
          {});
        try { await logSystemEvent('batch_auto_closed', { phone: row.phone, fotoCount: state.fotoCount || 0, batch_id: state.batch_id }, row.phone); } catch (_) {}
      } catch (e) {
        console.warn('[auto-close-batch] err:', row.phone, e.message);
        errors++;
      }
    }
  } catch (e) {
    console.warn('[auto-close-batch] outer err:', e.message);
  }
  console.log(`[auto-close-batch] found=${found} closed=${closed} skipped=${skipped} errors=${errors}`);
  return { found, closed, skipped, errors };
}

async function handleDailyDashboard(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }

  // FLC FASE 6 — auto-close batches abandonados (piggyback no daily cron)
  let autoClose = null;
  try { autoClose = await autoCloseAbandonedBatches(); } catch (e) { console.warn('[daily_dashboard] auto-close err:', e.message); }

  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Pedidos pagos últimas 24h
  const orders24h = await sbGet('drope_orders',
    `status=eq.paid&created_at=gt.${encodeURIComponent(cutoff24h)}&select=total_cents,items,customer_id&limit=500`);

  const orderCount = orders24h.length;
  const totalCents = orders24h.reduce((s, o) => s + (Number(o.total_cents) || 0), 0);
  const ticketCents = orderCount > 0 ? Math.round(totalCents / orderCount) : 0;

  // Top 3 vendidos (agrega items[] jsonb)
  const productCount = {};
  for (const o of orders24h) {
    const items = Array.isArray(o.items) ? o.items : [];
    for (const it of items) {
      const name = it?.name || it?.product_name;
      if (!name) continue;
      const qty = parseInt(it?.qty) || 1;
      productCount[name] = (productCount[name] || 0) + qty;
    }
  }
  const top3 = Object.entries(productCount).sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Estoque
  const lowStock = await sbGet('drope_products',
    `hidden=eq.false&qty_available=gt.0&qty_available=lt.3&select=name,qty_available&order=qty_available.asc&limit=20`);
  const outStock = await sbGet('drope_products',
    `hidden=eq.false&qty_available=eq.0&select=name&order=name.asc&limit=20`);

  // Clientes únicos da semana
  const weekOrders = await sbGet('drope_orders',
    `status=eq.paid&created_at=gt.${encodeURIComponent(cutoff7d)}&customer_id=not.is.null&select=customer_id&limit=2000`);
  const uniqueCustomers = new Set(weekOrders.map(o => o.customer_id).filter(Boolean)).size;

  // Mensagem
  let msg;
  if (orderCount === 0) {
    msg = "nenhum pedido ontem. bora ativar 🦎";
  } else {
    const lines = [];
    lines.push("☀️ bom dia andrade — drope ontem:");
    lines.push("");
    lines.push(`📦 ${orderCount} pedido${orderCount > 1 ? 's' : ''} | R$ ${formatBRL(totalCents)} | ticket médio R$ ${formatBRL(ticketCents)}`);
    if (top3.length > 0) {
      lines.push("");
      lines.push("🔥 top sellers:");
      top3.forEach(([name, qty], i) => lines.push(`${i + 1}. ${name} (${qty}un)`));
    }
    if (lowStock.length > 0 || outStock.length > 0) {
      lines.push("");
      lines.push("⚠️ estoque baixo:");
      lowStock.forEach(p => lines.push(`• ${p.name} (${p.qty_available} un)`));
      outStock.forEach(p => lines.push(`• ${p.name} (zerou!)`));
    }
    lines.push("");
    lines.push(`👥 clientes únicos esta semana: ${uniqueCustomers}`);
    lines.push("");
    lines.push("bora dropar 🦎");
    msg = lines.join('\n');
  }

  // Manda pro Lucas
  let sent = false;
  if (ADMIN_LUCAS) {
    try {
      await sendText(ADMIN_LUCAS, msg, {});
      sent = true;
    } catch (e) {
      console.error('[daily_dashboard] sendText error:', e.message);
    }
  }

  // OSSO 23 — Cleanup do system_log no cron diário (mantém últimos 30 dias).
  // Best-effort: se falhar, dashboard ainda completa.
  let cleanup = null;
  try { cleanup = await cleanupSystemLog(); } catch (e) { console.warn('[daily_dashboard] cleanup err:', e.message); }

  return res.status(200).json({
    ok: true,
    sent,
    summary: {
      orders_24h: orderCount,
      total_brl: formatBRL(totalCents),
      ticket_brl: formatBRL(ticketCents),
      top_sellers: top3.map(([name, qty]) => ({ name, qty })),
      low_stock_count: lowStock.length,
      out_stock_count: outStock.length,
      unique_customers_week: uniqueCustomers,
    },
    log_cleanup: cleanup,
    auto_close_batches: autoClose,
  });
}

// GET/POST /api/webhook?action=auto_close_batches&token=ADMIN_TOKEN
// Endpoint manual pra forcar o auto-close (sem esperar o cron diario).
// Util pra debug ou pra Andrade chamar quando quiser destravar manualmente.
async function handleAutoCloseBatches(req, res) {
  let queryTok = '';
  try {
    const qs = (req.url || '').split('?')[1] || '';
    const m = qs.split('&').find(x => x.startsWith('token='));
    if (m) queryTok = decodeURIComponent(m.slice(6));
  } catch (e) {}
  const headerTok = req.headers['x-admin-token'] || '';
  if (!ADMIN_TOKEN || (headerTok !== ADMIN_TOKEN && queryTok !== ADMIN_TOKEN)) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const result = await autoCloseAbandonedBatches();
  return res.status(200).json({ ok: true, ...result });
}

// GET/POST /api/webhook?action=friday_briefing  — cron sexta 18h SP (21h UTC)
// OSSO 33: relatório completo da semana + decisões pendentes pro Andrade autorizar.
// Sábado a IA roda as ações autorizadas (parte da pipeline OSSO 32 fornecedor).
async function handleFridayBriefing(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }

  const now = Date.now();
  const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // ===== SEMANA =====
  const weekOrders = await sbGet('drope_orders',
    `status=eq.paid&created_at=gt.${encodeURIComponent(cutoff7d)}&select=total_cents,items,customer_id,created_at&limit=2000`);
  const weekCount = weekOrders.length;
  const weekCents = weekOrders.reduce((s, o) => s + (Number(o.total_cents) || 0), 0);
  const weekTicket = weekCount > 0 ? Math.round(weekCents / weekCount) : 0;

  const productCount = {};
  for (const o of weekOrders) {
    const items = Array.isArray(o.items) ? o.items : [];
    for (const it of items) {
      const name = it?.name || it?.product_name;
      if (!name) continue;
      const qty = parseInt(it?.qty) || 1;
      productCount[name] = (productCount[name] || 0) + qty;
    }
  }
  const top5 = Object.entries(productCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const uniqueCustomers = new Set(weekOrders.map(o => o.customer_id).filter(Boolean)).size;

  // ===== ESTOQUE =====
  const lowStock = await sbGet('drope_products',
    `hidden=eq.false&qty_available=gt.0&qty_available=lt.5&select=name,qty_available&order=qty_available.asc&limit=30`);
  const outStock = await sbGet('drope_products',
    `hidden=eq.false&qty_available=eq.0&select=name&order=name.asc&limit=30`);

  // ===== PERDAS =====
  let perdasWeek = [];
  try {
    perdasWeek = await sbGet('drope_perdas',
      `created_at=gt.${encodeURIComponent(cutoff7d)}&select=motivo,qty,product_name&limit=500`);
  } catch (e) { console.warn('[friday_briefing] perdas:', e.message); }
  const perdasCount = perdasWeek.reduce((s, p) => s + (Number(p.qty) || 0), 0);
  const perdasByMotivo = {};
  for (const p of perdasWeek) {
    perdasByMotivo[p.motivo] = (perdasByMotivo[p.motivo] || 0) + (Number(p.qty) || 0);
  }

  // ===== DECISÕES PENDENTES (Andrade autoriza, sábado IA executa) =====
  let semPreco = [];
  try {
    semPreco = await sbGet('drope_products',
      `hidden=eq.false&price_cents=eq.0&select=name&order=created_at.desc&limit=20`);
  } catch (e) { console.warn('[friday_briefing] semPreco:', e.message); }
  let artesPendentes = [];
  try {
    artesPendentes = await sbGet('drope_products',
      `hidden=eq.false&image_url=is.null&select=name,art_status&order=created_at.desc&limit=20`);
  } catch (e) { console.warn('[friday_briefing] artes:', e.message); }
  let pedidosTravados = [];
  try {
    pedidosTravados = await sbGet('drope_orders',
      `status=in.(pending,paid)&created_at=lt.${encodeURIComponent(cutoff24h)}&select=order_nsu,status,created_at&order=created_at.asc&limit=20`);
  } catch (e) { console.warn('[friday_briefing] travados:', e.message); }

  // ===== MENSAGEM =====
  const lines = [];
  lines.push("🦎 *briefing sexta — drope*");
  lines.push("");
  lines.push("📊 *semana:*");
  if (weekCount === 0) {
    lines.push("• nenhum pedido pago. semana zerada.");
  } else {
    lines.push(`• ${weekCount} pedidos | R$ ${formatBRL(weekCents)} | ticket R$ ${formatBRL(weekTicket)}`);
    lines.push(`• ${uniqueCustomers} clientes únicos`);
  }
  if (top5.length > 0) {
    lines.push("");
    lines.push("🔥 *top 5 vendidos:*");
    top5.forEach(([n, q], i) => lines.push(`${i+1}. ${n} (${q}un)`));
  }

  lines.push("");
  lines.push("📦 *estoque:*");
  lines.push(`• zerados: ${outStock.length}`);
  lines.push(`• baixos (<5): ${lowStock.length}`);
  if (outStock.length > 0 && outStock.length <= 8) {
    outStock.forEach(p => lines.push(`  · ${p.name}`));
  }
  if (lowStock.length > 0 && lowStock.length <= 8) {
    lowStock.forEach(p => lines.push(`  · ${p.name} (${p.qty_available})`));
  }

  if (perdasCount > 0) {
    lines.push("");
    lines.push(`💔 *perdas semana:* ${perdasCount} un`);
    Object.entries(perdasByMotivo).forEach(([m, q]) => lines.push(`• ${m}: ${q}`));
  }

  // ===== SUGESTÕES DE PEDIDO (heurística simples — OSSO 32 dispatch refina) =====
  const suggested = [];
  for (const p of [...outStock, ...lowStock]) {
    const q = Number(p.qty_available) || 0;
    suggested.push({ name: p.name, qty_atual: q, qty_pedir: Math.max(5, 10 - q) });
  }
  if (suggested.length > 0) {
    lines.push("");
    lines.push("🛒 *sugestão de pedido (sábado vou cruzar com Amer/Modelo):*");
    suggested.slice(0, 12).forEach(s => lines.push(`• ${s.name} — pedir ${s.qty_pedir}x`));
    if (suggested.length > 12) lines.push(`  …e mais ${suggested.length - 12}`);
  }

  const decisoes = [];
  if (semPreco.length > 0) decisoes.push(`💰 ${semPreco.length} produtos sem preço — define ou esconde`);
  if (artesPendentes.length > 0) decisoes.push(`🎨 ${artesPendentes.length} artes pendentes — aprova foto ou regenera`);
  if (pedidosTravados.length > 0) decisoes.push(`⏰ ${pedidosTravados.length} pedidos >24h parados — confere status`);

  if (decisoes.length > 0) {
    lines.push("");
    lines.push("🟡 *decisões pra você:*");
    decisoes.forEach(d => lines.push(`• ${d}`));
  }

  lines.push("");
  lines.push("🎯 *responde aqui o que autoriza:*");
  lines.push("• 'autoriza tudo' — IA executa pedido + decisões sábado");
  lines.push("• 'autoriza pedido' / 'autoriza decisões' — só uma parte");
  lines.push("• 'pula' — semana sem ações automáticas");
  lines.push("• ou texto livre que eu interpreto");

  const msg = lines.join('\n');

  const isDry = (req.url || '').indexOf('dry=1') >= 0;
  const summaryObj = {
    week_orders: weekCount, week_cents: weekCents,
    week_ticket_cents: weekTicket, unique_customers: uniqueCustomers,
    top5: top5.map(([n, q]) => ({ name: n, qty: q })),
    out_stock_count: outStock.length, low_stock_count: lowStock.length,
    perdas_qty: perdasCount, perdas_by_motivo: perdasByMotivo,
    decisoes,
  };

  // INSERT briefing (status=pending) — vira o state pra detectar resposta do Andrade
  let briefingId = null;
  if (!isDry) {
    try {
      const inserted = await sbInsert('drope_briefings', {
        type: 'friday', status: 'pending',
        content: msg, summary: summaryObj, suggested,
      });
      briefingId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
    } catch (e) { console.warn('[friday_briefing] insert:', e.message); }
  }

  let sent = false;
  if (ADMIN_LUCAS && !isDry) {
    try {
      await sendText(ADMIN_LUCAS, msg, {});
      sent = true;
    } catch (e) {
      console.error('[friday_briefing] sendText error:', e.message);
    }
  }

  try {
    await logSystemEvent('friday_briefing', {
      briefing_id: briefingId,
      week_orders: weekCount, week_brl: formatBRL(weekCents),
      out_stock: outStock.length, low_stock: lowStock.length,
      perdas: perdasCount, decisoes_count: decisoes.length,
      suggested_count: suggested.length,
    });
  } catch (e) { console.warn('[friday_briefing] log:', e.message); }

  return res.status(200).json({
    ok: true, sent, dry_run: isDry, briefing_id: briefingId,
    preview: isDry ? msg : undefined,
    summary: {
      ...summaryObj,
      week_brl: formatBRL(weekCents),
      week_ticket_brl: formatBRL(weekTicket),
    },
    suggested,
  });
}

// ===== OSSO 33: interpretAuthorizations + handleBriefingResponse + briefing_reminder =====
//
// Usa Claude Haiku pra extrair de uma resposta livre do Andrade ("autoriza tudo",
// "fecha pedido só do mango", "pula", etc.) um JSON estruturado de autorizações.
// Schema: { execute_pedido: bool, execute_decisoes: bool, ajustes: [{produto,qty}], notas }
async function interpretAuthorizations(text, briefing) {
  const sys = `Voce extrai autorizacoes de uma resposta do dono de uma tabacaria a um briefing semanal.
Responda APENAS JSON valido (sem markdown), com este schema:
{
  "execute_pedido": boolean,
  "execute_decisoes": boolean,
  "ajustes": [{"produto": "nome aproximado", "qty": numero}],
  "skip": boolean,
  "notas": "string curta com qualquer instrucao adicional, ou vazia"
}

Regras:
- "autoriza tudo" → execute_pedido=true, execute_decisoes=true
- "autoriza pedido" → execute_pedido=true
- "autoriza decisoes" → execute_decisoes=true
- "pula"/"nao"/"deixa" → skip=true
- Se mencionou produto + quantidade ("manda 10 do mango") → adiciona em ajustes
- Quando incerto, prefere conservador (false)`;
  const user = `Briefing enviado:
${(briefing?.content || '').slice(0, 1500)}

Resposta do dono:
${text.slice(0, 800)}`;
  const reply = await callClaude([{ role: 'user', content: user }], sys, 400);
  if (!reply) return null;
  const jsonMatch = reply.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch (_) { return null; }
}

function formatAuth(a) {
  if (!a) return '(sem detalhes)';
  if (a.skip) return 'pula a semana — nada vai rodar sábado';
  const parts = [];
  if (a.execute_pedido) parts.push('• pedido pra fornecedor sábado cedo');
  if (a.execute_decisoes) parts.push('• ações nas decisões pendentes');
  if (Array.isArray(a.ajustes) && a.ajustes.length > 0) {
    parts.push('• ajustes:');
    for (const aj of a.ajustes) parts.push(`   - ${aj.produto}: ${aj.qty}x`);
  }
  if (a.notas) parts.push(`• nota: ${a.notas}`);
  return parts.length ? parts.join('\n') : '(nenhuma ação autorizada)';
}

// Detecta se é resposta a um briefing pendente recente. Retorna o briefing OU null.
async function getOpenBriefing() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  try {
    const rows = await sbGet('drope_briefings',
      `status=eq.pending&sent_at=gte.${encodeURIComponent(cutoff)}&order=sent_at.desc&limit=1`);
    return rows && rows[0] ? rows[0] : null;
  } catch (e) { console.warn('[getOpenBriefing]', e.message); return null; }
}

// Chamado de handleAdminLucas quando texto chega e tem briefing pendente.
// Retorna true se consumiu a mensagem (caller deve return).
async function tryHandleBriefingResponse(phone, text, body) {
  const briefing = await getOpenBriefing();
  if (!briefing) return false;
  const lower = text.toLowerCase().trim();
  // Não consumir comandos admin claros — eles têm prioridade
  const adminCmds = /^(cadastra|chegou|entrada|abasteci|estoque|pendentes|gerar arte|gallery|preço|preco|pdv|defeito|sim|outra|depois|aprova|aprovar|cancela|sai|n[ãa]o|n)\b/;
  if (adminCmds.test(lower) || /^codigo\b/i.test(lower)) return false;

  const auth = await interpretAuthorizations(text, briefing);
  if (!auth) {
    await sendText(phone, "⚠️ não consegui interpretar — manda mais explícito:\n• 'autoriza tudo'\n• 'pula'", body);
    return true;
  }
  try {
    await sbUpdate('drope_briefings', `id=eq.${briefing.id}`, {
      authorizations: auth, response_raw: text.slice(0, 2000),
      status: auth.skip ? 'skipped' : 'authorized',
      authorized_at: new Date().toISOString(),
    });
  } catch (e) { console.warn('[tryHandleBriefingResponse] update:', e.message); }
  const reply = auth.skip
    ? "✅ pulou a semana — sábado ninguém roda."
    : `✅ autorizado! sábado IA executa:\n\n${formatAuth(auth)}`;
  await sendText(phone, reply, body);
  try {
    await logSystemEvent('briefing_response', {
      briefing_id: briefing.id, skip: !!auth.skip,
      execute_pedido: !!auth.execute_pedido, execute_decisoes: !!auth.execute_decisoes,
      ajustes_count: (auth.ajustes || []).length,
    });
  } catch (_) {}
  return true;
}

// GET/POST /api/webhook?action=briefing_reminder — cron sábado 10h SP (13h UTC)
// Se tem briefing 'pending' não respondido há >12h, manda lembrete gentil.
async function handleBriefingReminder(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  let pending = [];
  try {
    pending = await sbGet('drope_briefings',
      `status=eq.pending&sent_at=lt.${encodeURIComponent(cutoff)}&reminder_sent_at=is.null&order=sent_at.desc&limit=1`);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  if (!pending || pending.length === 0) return res.status(200).json({ ok: true, reminded: 0 });
  const b = pending[0];
  if (ADMIN_LUCAS) {
    try {
      await sendText(ADMIN_LUCAS,
        "🦎 lembrete amigo: o briefing de sexta tá esperando tua resposta.\n\n• 'autoriza tudo' — pra IA rodar\n• 'pula' — pra semana sem ações", {});
    } catch (e) { console.error('[briefing_reminder] sendText:', e.message); }
  }
  try {
    await sbUpdate('drope_briefings', `id=eq.${b.id}`,
      { reminder_sent_at: new Date().toISOString() });
  } catch (_) {}
  return res.status(200).json({ ok: true, reminded: 1, briefing_id: b.id });
}

// POST /api/webhook?action=admin_upload_reference — OSSO 34 manual upload
// Body JSON { productId, imageBase64, mimeType }. Header x-admin-token (ou ?token=).
// Sobe pro Storage product-art/references/ref-{id}.{ext} e atualiza ref_status='manual_uploaded'.
async function handleAdminUploadReference(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const headerTok = req.headers['x-admin-token'] || '';
  let queryTok = '';
  try {
    const qs = (req.url || '').split('?')[1] || '';
    const m = qs.split('&').find(x => x.startsWith('token='));
    if (m) queryTok = decodeURIComponent(m.slice(6));
  } catch (_) {}
  if (!ADMIN_TOKEN || (headerTok !== ADMIN_TOKEN && queryTok !== ADMIN_TOKEN)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ error: 'unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid json' }); }
  }
  const { productId, imageBase64, mimeType } = body || {};
  if (!productId || !imageBase64) return res.status(400).json({ error: 'productId e imageBase64 obrigatórios' });
  if (typeof imageBase64 !== 'string' || imageBase64.length > 12 * 1024 * 1024) {
    return res.status(413).json({ error: 'imageBase64 muito grande (max ~9MB raw)' });
  }

  try {
    const ext = (mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const fileName = `references/ref-${productId}.${ext}`;
    const buffer = Buffer.from(imageBase64, 'base64');

    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/product-art/${fileName}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body: buffer,
      }
    );
    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      return res.status(502).json({ error: 'upload failed', details: err.slice(0, 300) });
    }
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/product-art/${fileName}`;
    try {
      await sbUpdate('drope_products', `id=eq.${encodeURIComponent(productId)}`,
        { reference_image_url: publicUrl, ref_status: 'manual_uploaded' });
    } catch (e) {
      return res.status(502).json({ error: 'update failed', details: e.message });
    }
    return res.status(200).json({ ok: true, url: publicUrl, ref_status: 'manual_uploaded' });
  } catch (err) {
    console.error('[admin_upload_reference] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// GET/POST /api/webhook?action=saturday_dispatch — cron sábado 6h BRT (9h UTC)
// OSSO 32 dispatch: pega último briefing 'authorized', monta pedido baseado em
// briefing.suggested + ajustes, manda pros 3 fornecedores via UazAPI, registra
// drope_pedidos_fornecedor (status=aguardando_lista). Marca briefing executed.
async function handleSaturdayDispatch(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!checkCronAuth(req)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }
  const isDry = (req.url || '').indexOf('dry=1') >= 0;

  // Briefing autorizado (últimas 36h, não executado)
  const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  let briefing = null;
  try {
    const rows = await sbGet('drope_briefings',
      `status=eq.authorized&sent_at=gte.${encodeURIComponent(cutoff)}&order=sent_at.desc&limit=1`);
    briefing = rows && rows[0] ? rows[0] : null;
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'briefing query: ' + e.message });
  }
  if (!briefing) return res.status(200).json({ ok: true, dispatched: 0, reason: 'sem briefing autorizado nas últimas 36h' });
  const auth = briefing.authorizations || {};
  if (auth.skip || !auth.execute_pedido) {
    if (!isDry) {
      try { await sbUpdate('drope_briefings', `id=eq.${briefing.id}`, { status: 'executed', executed_at: new Date().toISOString() }); } catch (_) {}
    }
    return res.status(200).json({ ok: true, dispatched: 0, reason: 'briefing não autoriza pedido', briefing_id: briefing.id });
  }

  // Aplica ajustes do Andrade (override de qty por nome aproximado)
  const suggested = Array.isArray(briefing.suggested) ? [...briefing.suggested] : [];
  const ajustes = Array.isArray(auth.ajustes) ? auth.ajustes : [];
  for (const aj of ajustes) {
    if (!aj || !aj.produto) continue;
    const needle = String(aj.produto).toLowerCase();
    const match = suggested.find(s => (s.name || '').toLowerCase().includes(needle));
    if (match) match.qty_pedir = Number(aj.qty) || match.qty_pedir;
    else suggested.push({ name: aj.produto, qty_atual: 0, qty_pedir: Number(aj.qty) || 5 });
  }

  if (suggested.length === 0) {
    if (!isDry) {
      try { await sbUpdate('drope_briefings', `id=eq.${briefing.id}`, { status: 'executed', executed_at: new Date().toISOString() }); } catch (_) {}
    }
    return res.status(200).json({ ok: true, dispatched: 0, reason: 'sem itens pra pedir', briefing_id: briefing.id });
  }

  // Mensagem genérica pros fornecedores — pede lista pra eles + adianta o que precisamos
  const itemsTxt = suggested.slice(0, 30).map(s => `• ${s.name} — ${s.qty_pedir}x`).join('\n');
  const moreNote = suggested.length > 30 ? `\n…e mais ${suggested.length - 30} itens` : '';
  const fornecedores = FORNECEDORES_ATIVOS();
  const dispatched = [];
  const errors = [];

  for (const f of fornecedores) {
    const greet = `bom dia ${f.nome.split(' ')[0]}! tabacaria Drope (Andrade) aqui 🦎`;
    const msg = `${greet}

quero ver tua lista de hoje com preços. preciso desses itens (mas manda lista completa que eu olho):

${itemsTxt}${moreNote}

responde quando puder com preços e disponibilidade — fechamos hoje cedo.`;

    if (!isDry) {
      try {
        await sendText(f.phone, msg, {});
        dispatched.push({ nome: f.nome, phone: f.phone, sent: true });
      } catch (e) {
        console.error('[saturday_dispatch] sendText', f.nome, e.message);
        errors.push({ nome: f.nome, error: e.message });
      }
      try {
        await sbInsert('drope_pedidos_fornecedor', {
          fornecedor_phone: f.phone,
          fornecedor_nome: f.nome,
          status: 'aguardando_lista',
          proposta: { suggested_items: suggested, source_briefing: briefing.id },
        });
      } catch (e) { console.warn('[saturday_dispatch] insert pedido:', e.message); }
    } else {
      dispatched.push({ nome: f.nome, phone: f.phone, sent: false, dry: true });
    }
  }

  // Marca briefing executed e notifica Andrade
  if (!isDry) {
    try {
      await sbUpdate('drope_briefings', `id=eq.${briefing.id}`,
        { status: 'executed', executed_at: new Date().toISOString() });
    } catch (e) { console.warn('[saturday_dispatch] briefing update:', e.message); }
    if (ADMIN_LUCAS) {
      const summaryAndrade = `🦎 *sábado dispatch:* mandei pedido pros ${dispatched.length} fornecedores (${dispatched.map(d => d.nome).join(', ')}). ${errors.length > 0 ? `⚠️ ${errors.length} erros.` : ''}\n\nresponde aqui quando vir as listas voltarem.`;
      try { await sendText(ADMIN_LUCAS, summaryAndrade, {}); } catch (_) {}
    }
  }

  try {
    await logSystemEvent('saturday_dispatch', {
      briefing_id: briefing.id, fornecedores: fornecedores.length,
      dispatched: dispatched.length, errors: errors.length,
      itens_suggested: suggested.length,
    });
  } catch (_) {}

  return res.status(200).json({
    ok: true, dry_run: isDry, briefing_id: briefing.id,
    fornecedores: fornecedores.length, dispatched, errors,
    itens_count: suggested.length,
    preview_msg: isDry ? `bom dia [nome]!\n\n${itemsTxt}${moreNote}` : undefined,
  });
}

// ===== MERCADO PAGO PIX HANDLERS (05/05/2026) =====

// Cria pagamento Pix via API do Mercado Pago, retorna QR code + copia-e-cola
// ===== INFINITEPAY (migrado de api/infinitepay-*.js em 08/05/2026) =====
async function handleInfinitePayCheckout(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const { handle, items, total, order_id, customer } = req.body || {};
    if (!handle || !items || !items.length) return res.status(400).json({ error: 'missing handle or items' });

    const protocol = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'drope-app.vercel.app';
    const redirectUrl = `${protocol}://${host}/#success-pay`;
    const webhookUrl = `${protocol}://${host}/api/webhook?action=infinitepay_webhook`;

    const payload = {
      handle,
      order_nsu: order_id || `drope-${Date.now()}`,
      redirect_url: redirectUrl,
      webhook_url: webhookUrl,
      items: items.map(i => ({ quantity: i.quantity, price: i.price, description: 'Tabacaria Drope' })),
    };
    if (customer && (customer.name || customer.email || customer.phone_number)) {
      payload.customer = {};
      if (customer.name) payload.customer.name = customer.name;
      if (customer.email) payload.customer.email = customer.email;
      if (customer.phone_number) payload.customer.phone_number = customer.phone_number;
    }

    console.log('[InfinitePay] payload:', JSON.stringify(payload).substring(0, 400));
    const response = await fetch('https://api.infinitepay.io/invoices/public/checkout/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    console.log('[InfinitePay] status:', response.status, 'data:', JSON.stringify(data).substring(0, 300));

    if (response.ok && data.url) {
      return res.status(200).json({ url: data.url, id: data.id || data.invoice_slug });
    }
    if (handle && total) {
      const fallbackUrl = `https://infinitepay.io/${handle}?amount=${total}`;
      console.log('[InfinitePay] usando fallback URL:', fallbackUrl);
      return res.status(200).json({ url: fallbackUrl, fallback: true });
    }
    return res.status(502).json({ error: 'infinitepay error', details: data });
  } catch (err) {
    console.error('[InfinitePay] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handleInfinitePayWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const INFINITEPAY_WEBHOOK_SECRET = process.env.INFINITEPAY_WEBHOOK_SECRET || "";
  const STORE_WHATS_NUMBER = process.env.STORE_WHATS_NUMBER || "5511924810126";

  try {
    if (INFINITEPAY_WEBHOOK_SECRET) {
      const provided = req.headers['x-webhook-secret'] || req.headers['x-infinitepay-signature'];
      if (provided !== INFINITEPAY_WEBHOOK_SECRET) {
        console.warn('[InfinitePay Webhook] invalid secret');
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const body = req.body || {};
    console.log('[InfinitePay Webhook] payload:', JSON.stringify(body).substring(0, 400));

    const event = body.event || body.type || 'unknown';
    const transactionId = body.transaction_id || body.transactionId || body.id;
    const orderNsu = body.order_nsu || body.orderNsu || body.nsu || '';
    const amountCents = body.amount || body.total || 0;
    const paymentMethod = body.payment_method || body.paymentMethod || 'pix';
    const customer = body.customer || {};

    const approvedEvents = ['payment.approved', 'payment.confirmed', 'transaction.approved', 'approved'];
    if (!approvedEvents.includes(String(event).toLowerCase())) {
      console.log('[InfinitePay Webhook] evento ignorado:', event);
      return res.status(200).json({ ok: true, ignored: true, event });
    }

    let updatedCustomerId = null;
    if (SUPABASE_URL && SUPABASE_KEY && orderNsu) {
      try {
        const updateRes = await fetch(
          `${SUPABASE_URL}/rest/v1/drope_orders?order_nsu=eq.${encodeURIComponent(orderNsu)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation',
            },
            body: JSON.stringify({
              status: 'paid',
              payment_confirmed_at: new Date().toISOString(),
              transaction_id: transactionId,
              amount_paid_cents: amountCents,
            }),
          }
        );
        const updated = await updateRes.json();
        console.log('[InfinitePay Webhook] Supabase update status:', updateRes.status, 'rows:', Array.isArray(updated) ? updated.length : 'n/a');
        if (Array.isArray(updated) && updated[0] && updated[0].customer_id) {
          updatedCustomerId = updated[0].customer_id;
        }
      } catch (e) {
        console.error('[InfinitePay Webhook] Supabase update error:', e.message);
      }
    }

    if (updatedCustomerId) {
      const host = req.headers?.host || process.env.VERCEL_URL || '';
      const proto = (req.headers?.['x-forwarded-proto'] || 'https');
      if (host) {
        const url = `${proto}://${host}/api/webhook?action=customer_profile&customer_id=${updatedCustomerId}`;
        fetch(url).catch(e => console.error('[InfinitePay Webhook] flavor_profile refresh err:', e.message));
      }
    }

    if (UAZAPI_TOKEN && STORE_WHATS_NUMBER) {
      try {
        const amountBRL = (amountCents / 100).toFixed(2).replace('.', ',');
        const customerLine = customer.name
          ? `${customer.name}${customer.phone_number ? ' · ' + customer.phone_number : ''}`
          : 'cliente';
        const lines = [
          `💰 *PAGAMENTO CONFIRMADO* ✅`, ``,
          `Pedido: *#${orderNsu}*`,
          `Valor: *R$ ${amountBRL}*`,
          `Método: ${paymentMethod}`, ``,
          `👤 ${customerLine}`, ``,
          `_Drope ✦ InfinitePay Webhook_`,
        ];
        await fetch(`${UAZAPI_SERVER}/send/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'token': UAZAPI_TOKEN },
          body: JSON.stringify({ number: STORE_WHATS_NUMBER, text: lines.join('\n') }),
        });
        console.log('[InfinitePay Webhook] whatsapp loja notificado');
      } catch (e) {
        console.error('[InfinitePay Webhook] whatsapp err:', e.message);
      }
    }

    return res.status(200).json({ ok: true, processed: true, orderNsu, transactionId });
  } catch (err) {
    console.error('[InfinitePay Webhook] ERROR:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

async function handleMPCreatePix(req, res) {
  // CORS
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!MP_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'MP_ACCESS_TOKEN not configured' });
  }

  try {
    const body = req.body || {};
    const { items, total_cents, order_id, customer } = body;

    if (!items || !items.length || !total_cents) {
      return res.status(400).json({ error: 'missing items or total_cents' });
    }

    const description = `Tabacaria Drope - Pedido ${order_id || 'avulso'}`;

    const payload = {
      transaction_amount: total_cents / 100,
      description: description,
      payment_method_id: 'pix',
      payer: {
        email: (customer && customer.email) || 'cliente@drope.app',
        first_name: (customer && customer.name) ? customer.name.split(' ')[0] : undefined,
        last_name: (customer && customer.name && customer.name.split(' ').length > 1)
          ? customer.name.split(' ').slice(1).join(' ') : undefined,
      },
      notification_url: `https://drope-app.vercel.app/api/webhook?action=mp_webhook`,
      metadata: {
        order_id: order_id || `dr-${Date.now().toString(36)}`,
        items_count: items.length,
      },
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    console.log('[MercadoPago] Creating Pix:', JSON.stringify(payload).substring(0, 400));

    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': order_id || `dr-${Date.now()}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log('[MercadoPago] Response:', response.status);

    if (!response.ok) {
      console.error('[MercadoPago] Error:', JSON.stringify(data).substring(0, 500));
      return res.status(502).json({ error: 'mercadopago_error', status: response.status, details: data.message || data.cause || data });
    }

    const txData = data.point_of_interaction?.transaction_data;
    if (!txData) {
      return res.status(502).json({ error: 'no_pix_data' });
    }

    return res.status(200).json({
      ok: true,
      payment_id: data.id,
      status: data.status,
      qr_code: txData.qr_code,
      qr_code_base64: txData.qr_code_base64,
      ticket_url: txData.ticket_url,
      expires_at: data.date_of_expiration,
      amount: data.transaction_amount,
    });
  } catch (err) {
    console.error('[MercadoPago] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Checa status de pagamento existente (polling do frontend)
async function handleMPCheckPix(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://drope-app.vercel.app');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  const paymentId = url.searchParams.get('payment_id');
  if (!paymentId || !MP_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'missing payment_id or token' });
  }
  try {
    const checkRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });
    const checkData = await checkRes.json();
    return res.status(200).json({
      status: checkData.status,
      status_detail: checkData.status_detail,
      payment_id: checkData.id,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Recebe notificação do MP quando pagamento é aprovado
async function handleMPWebhook(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'drope-mp-webhook' });
  }

  try {
    const body = req.body || {};
    console.log('[MP Webhook] received:', JSON.stringify(body).substring(0, 400));

    let paymentId = null;
    if (body.data && body.data.id) paymentId = body.data.id;
    else if (body.topic === 'payment' && body.id) paymentId = body.id;
    else if (body.type === 'payment' && body.data?.id) paymentId = body.data.id;

    if (!paymentId) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!MP_ACCESS_TOKEN) {
      return res.status(200).json({ ok: false, error: 'token_missing' });
    }

    const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (!paymentRes.ok) {
      console.error('[MP Webhook] fetch failed:', paymentRes.status);
      return res.status(200).json({ ok: false, error: 'payment_fetch_failed' });
    }

    const payment = await paymentRes.json();
    console.log('[MP Webhook] status:', payment.status, 'id:', payment.id);

    if (payment.status !== 'approved') {
      return res.status(200).json({ ok: true, status: payment.status, awaiting: true });
    }

    const orderNsu = payment.metadata?.order_id || '';
    const amountCents = Math.round((payment.transaction_amount || 0) * 100);
    const payerEmail = payment.payer?.email || '';
    const payerName = [payment.payer?.first_name, payment.payer?.last_name].filter(Boolean).join(' ') || '';

    // Marca pedido como PAGO no Supabase
    if (SUPABASE_URL && SUPABASE_KEY && orderNsu) {
      try {
        await fetch(
          `${SUPABASE_URL}/rest/v1/drope_orders?order_nsu=eq.${encodeURIComponent(orderNsu)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              status: 'paid',
              payment_confirmed_at: new Date().toISOString(),
              transaction_id: String(payment.id),
              amount_paid_cents: amountCents,
              payment_method: 'mercadopago_pix',
            }),
          }
        );
        console.log('[MP Webhook] order updated:', orderNsu);
      } catch (e) {
        console.error('[MP Webhook] Supabase error:', e.message);
      }
    }

    // Notifica WhatsApp do Lucas
    if (UAZAPI_TOKEN && ADMIN_LUCAS) {
      try {
        const amountBRL = (amountCents / 100).toFixed(2).replace('.', ',');
        const lines = [
          '\u{1F4B0} *PAGAMENTO CONFIRMADO* \u{2705}',
          '',
          `Pedido: *#${orderNsu}*`,
          `Valor: *R$ ${amountBRL}*`,
          'Via: Pix (Mercado Pago)',
          '',
          `\u{1F464} ${payerName || payerEmail || 'cliente'}`,
          '',
          '_Drope \u{2726} Mercado Pago_',
        ];
        await sendText(ADMIN_LUCAS, lines.join('\n'), {});
      } catch (e) {
        console.error('[MP Webhook] WhatsApp err:', e.message);
      }
    }

    return res.status(200).json({ ok: true, processed: true, orderNsu });
  } catch (err) {
    console.error('[MP Webhook] ERROR:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// FEATURE 5 — Smoke test / health check (sem auth, monitoramento público)
async function handleHealthCheck(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const checks = {
    supabase: { status: 'unknown' },
    uazapi: { status: 'unknown' },
    env_vars: {},
    gallery_pending: 0,
  };

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const products = await sbGet('drope_products', 'hidden=eq.false&select=id&limit=1000');
      const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const ordersRecent = await sbGet('drope_orders', `created_at=gt.${encodeURIComponent(cutoff24h)}&select=id&limit=500`);
      const pendingArt = await sbGet('drope_products',
        `image_status=in.(pending_art,pending_regeneration,awaiting_approval)&select=id&limit=200`);
      checks.supabase = {
        status: 'ok',
        products: products.length,
        orders_24h: ordersRecent.length,
      };
      checks.gallery_pending = pendingArt.length;

      // Self-heal: produtos com art_status='reference_approved' há >60s e sem image_url
      // são órfãos (ref aprovada mas dispatch falhou). Re-dispara generate_art para até 5.
      const orphanCutoff = new Date(Date.now() - 60 * 1000).toISOString();
      const orphans = await sbGet('drope_products',
        `art_status=eq.reference_approved&image_url=is.null&updated_at=lt.${encodeURIComponent(orphanCutoff)}&select=id,name&limit=5`);
      checks.orphan_arts_healed = 0;
      for (const p of (orphans || [])) {
        try {
          await sbUpdate('drope_products', `id=eq.${p.id}`, { art_status: 'generating', image_status: 'pending_art' });
          fireBackgroundArtGeneration(p.id, ADMIN_LUCAS, 1).catch(e => console.warn('[health_check selfheal]', p.id, e.message));
          checks.orphan_arts_healed++;
        } catch (e) { console.warn('[health_check selfheal] item:', p.id, e.message); }
      }
    } catch (e) {
      checks.supabase = { status: 'fail', error: e.message };
    }
  } else {
    checks.supabase = { status: 'fail', error: 'env not configured' };
  }

  checks.uazapi = {
    status: (UAZAPI_SERVER && UAZAPI_TOKEN) ? 'ok' : 'fail',
    server_configured: !!UAZAPI_SERVER,
    token_configured: !!UAZAPI_TOKEN,
  };

  checks.env_vars = {
    XAI_API_KEY: !!XAI_API_KEY,
    CLAUDE_KEY: !!CLAUDE_KEY,
    SUPABASE_URL: !!SUPABASE_URL,
    SUPABASE_KEY: !!SUPABASE_KEY,
    UAZAPI_TOKEN: !!UAZAPI_TOKEN,
    ADMIN_TOKEN: !!ADMIN_TOKEN,
    CRON_TOKEN: !!CRON_TOKEN,
    ADMIN_LUCAS: !!ADMIN_LUCAS,
  };

  let overall = 'healthy';
  if (checks.supabase.status !== 'ok') {
    overall = 'unhealthy';
  } else if (checks.uazapi.status !== 'ok') {
    overall = 'degraded';
  } else {
    const critical = ['SUPABASE_URL', 'SUPABASE_KEY', 'UAZAPI_TOKEN', 'CLAUDE_KEY'];
    if (critical.some(k => !checks.env_vars[k])) overall = 'degraded';
  }

  return res.status(overall === 'unhealthy' ? 503 : 200).json({
    status: overall,
    timestamp: new Date().toISOString(),
    checks,
  });
}

// debug_claude — público, retorna SÓ metadata das últimas chamadas Claude (sem conteúdo de mensagens).
// Útil pra diagnosticar "deu ruim aqui" sem precisar de logs Vercel.
async function handleDebugClaude(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase not configured' });
  }
  const url = req.url || '';
  const hoursMatch = url.match(/[?&]hours=(\d+)/);
  const hours = hoursMatch ? Math.min(parseInt(hoursMatch[1]) || 6, 168) : 6;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  let costRows = [];
  try {
    // logApiCost grava action='api_cost' e o tipo vai em detail.api (claude_haiku, claude_vision, etc)
    costRows = await sbGet('drope_system_log',
      `action=eq.api_cost&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=200&select=created_at,detail,phone`);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'cost rows: ' + e.message });
  }
  const claudeRows = costRows.filter(r => /^claude/.test(r.detail?.api || ''));
  const apiCounts = {};
  for (const r of costRows) {
    const a = r.detail?.api || 'unknown';
    apiCounts[a] = (apiCounts[a] || 0) + 1;
  }
  const summary = { claude_total: claudeRows.length, by_status: {}, errors: [] };
  for (const r of claudeRows) {
    const d = r.detail || {};
    const s = String(d.status || 'na');
    summary.by_status[s] = (summary.by_status[s] || 0) + 1;
    if ((d.status || 0) >= 400 || (d.status === 0)) {
      summary.errors.push({
        at: r.created_at, api: d.api, status: d.status,
        ms: d.ms, error_type: d.error_type, error_msg: d.error_msg,
        phone_prefix: (r.phone || '').slice(0, 6),
      });
    }
  }
  return res.status(200).json({
    ok: true, since, hours,
    api_counts: apiCounts,
    summary,
    last_15_claude: claudeRows.slice(0, 15).map(r => ({
      at: r.created_at, api: r.detail?.api,
      status: r.detail?.status, ms: r.detail?.ms,
      in_tok: r.detail?.input_tokens, out_tok: r.detail?.output_tokens,
      error_type: r.detail?.error_type, error_msg: r.detail?.error_msg,
      phone_prefix: (r.phone || '').slice(0, 6),
    })),
  });
}

// test_claude — público, dispara uma chamada Haiku mock e retorna o body do erro
// (sem expor a key). Pra diagnosticar 400 sem precisar de logs Vercel.
async function handleTestClaude(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!CLAUDE_KEY) return res.status(500).json({ ok: false, error: 'no CLAUDE_KEY' });
  // ?mode=bug → reproduz o bug original (passa entry ao invés de entry.messages)
  // default → array correto
  const mode = (req.url || '').match(/[?&]mode=(\w+)/)?.[1] || 'fix';
  const correctMessages = [{ role: 'user', content: 'oi' }];
  const buggyMessages = { messages: correctMessages, lastActivity: Date.now(), state: null, pending: null };
  const payloadMessages = mode === 'bug' ? buggyMessages : correctMessages;
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        system: 'Atendente Drope SP. Responda curto.',
        messages: payloadMessages,
      }),
    });
    const data = await r.json();
    return res.status(200).json({
      ok: true, mode, status: r.status, ms: Date.now() - t0,
      response: data,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, mode, error: e.message, ms: Date.now() - t0 });
  }
}

// ============ HANDLER PRINCIPAL ============
module.exports = async function handler(req, res) {
  console.log("METHOD:", req.method);

  // ===== ROTA: ESTEIRA (08/05/2026) — TELA ÚNICA: sem-sabor + pendentes + gallery =====
  // GET /api/webhook?action=esteira&token=ADMIN_TOKEN → HTML com 3 fases numa só tela
  // Andrade: "podiam ficar todos numa tela só, em apenas uma tela eu faria tudo"
  if (req.url && req.url.indexOf('action=esteira') >= 0) {
    return await handleEsteiraView(req, res);
  }

  // ===== ROTA: ADMIN GALLERY (BLOCO 1) =====
  // GET  /api/webhook?action=gallery&token=ADMIN_TOKEN          → HTML com cards
  // POST /api/webhook?action=gallery_action                     → ações em JSON
  //   header x-admin-token: ADMIN_TOKEN
  //   body { id, op: 'approve'|'reject'|'regenerate', barcode?, price_cents? }
  if (req.url && req.url.indexOf('action=gallery') >= 0 && req.url.indexOf('gallery_action') < 0) {
    return await handleGalleryView(req, res);
  }
  if (req.url && req.url.indexOf('action=gallery_action') >= 0) {
    return await handleGalleryAction(req, res);
  }

  // ===== ROTA: ADMIN CUSTOMERS (FEATURE 4 — 30/04/2026 tarde) =====
  // GET /api/webhook?action=admin-customers&token=ADMIN_TOKEN → HTML com lista + métricas
  if (req.url && req.url.indexOf('action=admin-customers') >= 0) {
    return await handleAdminCustomers(req, res);
  }

  // ===== ROTA: CATALOG (REFATOR 30/04/2026 tarde 5) =====
  // GET /api/webhook?action=catalog → JSON com produtos visíveis do drope_products.
  // Substitui o array hardcoded `let products = [...]` que vivia em index.html.
  // Público (sem auth) — é o catálogo que o app cliente consome.
  if (req.url && req.url.indexOf('action=catalog') >= 0) {
    return await handleCatalog(req, res);
  }

  // ===== ROTAS OSSO 21 — IA-FIRST CLIENTE (01/05/2026) =====
  // GET /api/webhook?action=home_personalized&customer_phone=...  (ou &customer_id=...)
  //     Retorna { type: 'new'|'returning', last_order, recommendations, vibe_options }
  // GET /api/webhook?action=customer_profile&customer_phone=...   (recalcula flavor_profile)
  // POST /api/webhook?action=queue_drop_notifications  (admin/cron — varre produtos novos)
  // GET  /api/webhook?action=run_drop_notifications     (cron domingo 10h SP)
  if (req.url && req.url.indexOf('action=home_personalized') >= 0) {
    return await handleHomePersonalized(req, res);
  }
  if (req.url && req.url.indexOf('action=customer_profile') >= 0) {
    return await handleCustomerProfile(req, res);
  }
  if (req.url && req.url.indexOf('action=queue_drop_notifications') >= 0) {
    return await handleQueueDropNotifications(req, res);
  }
  if (req.url && req.url.indexOf('action=run_drop_notifications') >= 0) {
    return await withRetry('run_drop_notifications', () => handleRunDropNotifications(req, res));
  }
  if (req.url && req.url.indexOf('action=backfill_flavors') >= 0) {
    return await handleBackfillFlavors(req, res);
  }
  // OSSO 23 — Sistema Imune
  if (req.url && req.url.indexOf('action=system_health') >= 0) {
    return await handleSystemHealth(req, res);
  }
  // Diagnostico admin (debug rapido sem precisar de logs Vercel)
  if (req.url && req.url.indexOf('action=admin_diag') >= 0) {
    return await handleAdminDiag(req, res);
  }
  // TIER 1.4 — Recovery de produtos travados em image_status='generating' (timeout Grok)
  if (req.url && req.url.indexOf('action=art_stuck_recovery') >= 0) {
    return await handleArtStuckRecovery(req, res);
  }
  // Painel: fotos sem sabor identificavel (08/05/2026 - Andrade)
  if (req.url && req.url.indexOf('action=unidentified_photos') >= 0) {
    return await handleUnidentifiedPhotos(req, res);
  }
  // POST: completar sabor de uma foto via UI HTML
  if (req.method === 'POST' && req.url && req.url.indexOf('action=complete_unidentified') >= 0) {
    return await handleCompleteUnidentified(req, res);
  }
  // 08/05/2026 — Reanalyze foto melhor: se Vision identifica tudo, cria produto direto
  if (req.method === 'POST' && req.url && req.url.indexOf('action=reanalyze_unidentified') >= 0) {
    return await handleReanalyzeUnidentified(req, res);
  }
  // Painel admin do balanço (07/05/2026 - Andrade) — historico + divergencias
  if (req.url && req.url.indexOf('action=balance_panel') >= 0) {
    return await handleBalancePanel(req, res);
  }
  // FLC FASE 6 — auto-close manual de batches abandonados
  if (req.url && req.url.indexOf('action=auto_close_batches') >= 0) {
    return await handleAutoCloseBatches(req, res);
  }
  if (req.url && req.url.indexOf('action=cost_report') >= 0) {
    return await handleCostReport(req, res);
  }
  if (req.url && req.url.indexOf('action=weekly_health') >= 0) {
    return await withRetry('weekly_health', () => handleWeeklyHealth(req, res));
  }
  // Sistema imune — relatorio semanal de reconciliacoes (07/05/2026)
  if (req.url && req.url.indexOf('action=weekly_imune_report') >= 0) {
    return await handleWeeklyImuneReport(req, res);
  }

  // ===== ROTAS FEEDBACK (sessão MEKA 30/04 noite — bolinha admin) =====
  // POST /api/webhook?action=feedback     → admin manda screenshot+state+notas
  // GET  /api/webhook?action=feedback_list&token=ADMIN_TOKEN → HTML com cards pra Claude ler
  if (req.url && req.url.indexOf('action=feedback_list') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    try {
      const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
      const params = {};
      qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
      if (!ADMIN_TOKEN || params.token !== ADMIN_TOKEN) {
        return res.status(401).send('unauthorized');
      }
      // Lista files no Storage com prefix feedback/
      const listUrl = `${SUPABASE_URL}/storage/v1/object/list/${STORAGE_BUCKET}`;
      const listResp = await fetch(listUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: 'feedback/', limit: 200, sortBy: { column: 'created_at', order: 'desc' } }),
      });
      const files = await listResp.json();
      // Files vêm como array {name, created_at, ...}. Pode ser sub-paths "TIMESTAMP/screenshot.png" ou "TIMESTAMP/meta.json"
      // Como Storage list não-recursivo retorna pastas, vou listar com prefix vazio aqui
      // E alternativamente listar recursivamente:
      let entries = [];
      if (Array.isArray(files)) {
        // Filter por timestamp folders e get meta de cada um
        const folders = files.filter(f => f && f.name && f.id === null); // pastas têm id=null
        for (const folder of folders.slice(0, 50)) {
          try {
            const metaUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/feedback/${folder.name}/meta.json`;
            const metaResp = await fetch(metaUrl);
            if (metaResp.ok) {
              const meta = await metaResp.json();
              const screenshotUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/feedback/${folder.name}/screenshot.png`;
              entries.push({ id: folder.name, ...meta, screenshotUrl });
            }
          } catch (e) { /* skip */ }
        }
      }
      // Render HTML simples
      const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const cards = entries.map(e => `
        <div class="card">
          <div class="hd"><b>${esc(e.id)}</b> ✦ <span class="dim">${esc(e.url || '')}</span></div>
          ${e.notes ? `<div class="notes">"${esc(e.notes)}"</div>` : ''}
          ${e.error ? `<div class="err">⚠️ erro: ${esc(e.error)}</div>` : ''}
          <a href="${esc(e.screenshotUrl)}" target="_blank"><img src="${esc(e.screenshotUrl)}" loading="lazy" /></a>
          <details><summary>state + ua</summary><pre>${esc(JSON.stringify({ state: e.state, ua: e.userAgent, viewport: e.viewport }, null, 2))}</pre></details>
        </div>
      `).join('');
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Feedback ✦ Drope</title>
<style>
  body{margin:0;padding:20px;background:#0A0A14;color:#EAEAF2;font-family:system-ui,sans-serif}
  h1{margin:0 0 18px;font-size:20px}
  .card{background:#14141F;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;margin-bottom:14px}
  .hd{font-size:13px;margin-bottom:6px}
  .dim{color:#8A8AA3;font-size:12px}
  .notes{padding:8px 10px;background:rgba(212,255,46,0.08);border-left:2px solid #D4FF2E;margin:8px 0;border-radius:4px}
  .err{padding:8px 10px;background:rgba(255,45,111,0.1);border-left:2px solid #FF2D6F;margin:8px 0;border-radius:4px;font-size:13px}
  img{max-width:100%;border-radius:8px;border:1px solid rgba(255,255,255,0.1);margin:8px 0}
  details{margin-top:8px;font-size:12px;color:#8A8AA3}
  pre{background:#0A0A14;padding:10px;border-radius:6px;overflow-x:auto;font-size:11px;line-height:1.4}
  .empty{color:#8A8AA3;text-align:center;padding:40px}
</style></head><body>
<h1>📤 feedback do app (${entries.length})</h1>
${entries.length ? cards : '<div class="empty">nenhum feedback ainda. botão admin envia screenshot+state pra cá.</div>'}
</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (e) {
      console.error('[feedback_list] error:', e.message);
      return res.status(500).send('error: ' + e.message);
    }
  }

  if (req.url && req.url.indexOf('action=feedback') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const screenshotB64 = reqBody.screenshotB64;
      if (!screenshotB64) return res.status(400).json({ error: 'screenshotB64 obrigatório' });

      // ID = timestamp ISO sanitizado
      const id = new Date().toISOString().replace(/[:.]/g, '-');

      // Upload screenshot
      const screenshotPath = `feedback/${id}/screenshot.png`;
      const cleanB64 = screenshotB64.replace(/^data:image\/\w+;base64,/, '');
      const imgBuf = Buffer.from(cleanB64, 'base64');
      const upImg = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${screenshotPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'image/png', 'x-upsert': 'true' },
        body: imgBuf,
      });
      if (!upImg.ok) {
        const t = await upImg.text();
        console.error('[feedback] screenshot upload failed:', upImg.status, t);
        return res.status(500).json({ error: 'screenshot upload failed', detail: t });
      }

      // Upload meta.json
      const meta = {
        id,
        timestamp: new Date().toISOString(),
        url: reqBody.url || '',
        userAgent: reqBody.userAgent || '',
        viewport: reqBody.viewport || null,
        state: reqBody.state || null,
        notes: reqBody.notes || '',
        error: reqBody.error || '',
      };
      const metaPath = `feedback/${id}/meta.json`;
      const upMeta = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${metaPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'application/json', 'x-upsert': 'true' },
        body: JSON.stringify(meta),
      });
      if (!upMeta.ok) console.warn('[feedback] meta upload failed:', upMeta.status);

      return res.status(200).json({ ok: true, id, screenshotUrl: `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${screenshotPath}` });
    } catch (e) {
      console.error('[feedback] error:', e.message, e.stack);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== ROTAS RECEBER ESTOQUE (sessão MEKA 30/04 noite — scanner barcode mobile) =====
  // GET  /api/webhook?action=check_barcode&barcode=NUM   → { exists, product? }
  // POST /api/webhook?action=analyze_photo               → roda Vision e devolve campos prontos
  // POST /api/webhook?action=quick_register              → insere produto + dispara arte em background
  // POSTs auth: header x-admin-token = ADMIN_TOKEN
  if (req.url && req.url.indexOf('action=check_barcode') >= 0) {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
      if (req.method === 'OPTIONS') return res.status(200).end();

      const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
      const params = {};
      qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
      const barcode = (params.barcode || '').replace(/\D/g, '');
      if (!barcode) return res.status(200).json({ exists: false, error: 'no barcode' });

      const rows = await sbGet('drope_products', `barcode=eq.${encodeURIComponent(barcode)}&limit=1`);
      if (rows && rows.length > 0) {
        const p = rows[0];
        return res.status(200).json({
          exists: true,
          product: {
            id: p.id,
            name: p.name,
            slug: p.slug,
            qty_available: p.qty_available || 0,
            barcode: p.barcode,
            image_url: p.image_url,
            price_cents: p.price_cents || 0,
          }
        });
      }
      return res.status(200).json({ exists: false, barcode });
    } catch (e) {
      console.error('[check_barcode] error:', e.message);
      return res.status(500).json({ exists: false, error: e.message });
    }
  }

  if (req.url && req.url.indexOf('action=analyze_photo') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const caixaB64 = reqBody.caixaBase64 || reqBody.imageBase64;
      const podB64 = reqBody.podBase64 || null;
      if (!caixaB64) return res.status(400).json({ error: 'caixaBase64 obrigatório' });

      const caixaUrl = caixaB64.startsWith('data:') ? caixaB64 : `data:image/jpeg;base64,${caixaB64}`;
      const podUrl = podB64 ? (podB64.startsWith('data:') ? podB64 : `data:image/jpeg;base64,${podB64}`) : null;

      const data = await analyzeProductImage(caixaUrl, podUrl);
      if (!data) return res.status(500).json({ error: 'vision falhou' });
      return res.status(200).json({ ok: true, data });
    } catch (e) {
      console.error('[analyze_photo] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.url && req.url.indexOf('action=quick_register') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const barcode = (reqBody.barcode || '').toString().replace(/\D/g, '');
      const brand = cleanVisionField(reqBody.brand);
      const model = cleanVisionField(reqBody.model || '');
      const flavorPt = cleanVisionField(reqBody.flavor_pt || reqBody.flavor || '');
      const flavorEn = cleanVisionField(reqBody.flavor_en || reqBody.flavor || flavorPt || '');
      const flavor = flavorPt || flavorEn;
      // OSSO 22 — Auto-classificação de sabor (Vision já retorna; fallback heurístico)
      const VALID_CATEGORIES = ['fruity', 'sweet', 'icy', 'menthol', 'tobacco', 'other'];
      let flavorCategory = (reqBody.flavor_category || '').toString().toLowerCase().trim();
      if (!VALID_CATEGORIES.includes(flavorCategory)) {
        flavorCategory = classifyFlavorByName(`${reqBody.brand || ''} ${reqBody.model || ''} ${flavorEn} ${flavorPt}`);
      }
      const puffs = reqBody.puffs ? Number(reqBody.puffs) : null;
      const ml = reqBody.ml ? Number(reqBody.ml) : null;
      const mg = reqBody.mg_nicotina ? Number(reqBody.mg_nicotina) : 5;
      const deviceColor = cleanVisionField(reqBody.device_color || '');
      const deviceVisual = cleanVisionField(reqBody.device_visual || '');
      const deviceVisualDetailed = cleanVisionField(reqBody.device_visual_detailed || '');
      const cores = cleanVisionField(reqBody.cores_predominantes || '');
      const flavorElements = cleanVisionField(reqBody.flavor_elements || '');
      const descricaoQuebrada = cleanVisionField(reqBody.descricao_quebrada || '');
      let priceCents = reqBody.priceCents != null ? Number(reqBody.priceCents) : null;
      const deferArt = !!reqBody.defer_art;
      const boxPhotoBase64 = reqBody.boxPhotoBase64 || null;

      if (!brand || !flavor) {
        return res.status(400).json({ error: 'brand e flavor são obrigatórios' });
      }

      // Auto-preço se tem regra de marca+modelo e priceCents não foi fornecido
      if (!priceCents && model) {
        try {
          const rule = await getPriceRule(brand, model);
          if (rule?.price_cents) priceCents = rule.price_cents;
        } catch (e) { console.warn('[quick_register] getPriceRule:', e.message); }
      }
      const finalPriceCents = priceCents || 0;

      // Dedup: se barcode bate ou brand+model+flavor existe, incrementa estoque
      let existing = null;
      if (barcode) {
        const r = await sbGet('drope_products', `barcode=eq.${encodeURIComponent(barcode)}&limit=1`);
        if (r && r[0]) existing = r[0];
      }
      if (!existing) {
        try {
          const r = await findExistingProduct(brand, model, flavor);
          if (r) existing = r;
        } catch (e) { console.warn('[quick_register] findExistingProduct:', e.message); }
      }
      if (existing) {
        const newQty = (existing.qty_available || 0) + 1;
        await sbUpdate('drope_products', `id=eq.${existing.id}`, { qty_available: newQty });
        return res.status(200).json({
          ok: true,
          mode: 'stock_entry',
          product: { id: existing.id, name: existing.name, qty_available: newQty },
        });
      }

      // Insert novo produto
      const fullName = `${brand} ${model || ''} ${flavor}`.replace(/\s+/g, ' ').trim();
      const slug = slugify(brand, model, flavor);

      // Upload da foto da caixa (se mandou) — fica salva pra Andrade ver depois quando enviar foto do pod
      let boxPhotoUrl = null;
      if (boxPhotoBase64) {
        try {
          const cleanB64 = boxPhotoBase64.replace(/^data:image\/\w+;base64,/, '');
          const buf = Buffer.from(cleanB64, 'base64');
          const photoPath = `pending-boxes/${slug}.jpg`;
          const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${photoPath}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
            body: buf,
          });
          if (r.ok) boxPhotoUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${photoPath}`;
          else console.warn('[quick_register] box photo upload failed:', r.status);
        } catch (e) { console.warn('[quick_register] box photo error:', e.message); }
      }

      const metadata = {
        brand,
        model: model || null,
        flavor_en: flavorEn || flavor,
        flavor_pt: flavorPt || flavor,
        puffs, ml, mg_nicotina: mg,
        device_color: deviceColor || null,
        device_visual: deviceVisual || null,
        device_visual_detailed: deviceVisualDetailed || null,
        cores_predominantes: cores || null,
        flavor_elements: flavorElements || null,
        registered_via: 'receber_app',
        box_photo_url: boxPhotoUrl,
      };

      // Status: pending_pod_photo se Andrade pediu pra adiar a arte; senão pending_art (gera direto)
      const imageStatus = deferArt ? 'pending_pod_photo' : 'pending_art';

      const insertData = {
        name: fullName,
        slug,
        barcode: barcode || null,
        category: 'pod',
        qty_available: 1,
        price_cents: finalPriceCents,
        hidden: finalPriceCents === 0,
        image_status: imageStatus,
        // Pipeline novo: produto começa com art_status='pending_reference'.
        // Busca de imagem dispara em background; quando termina vira 'pending_review' ou 'needs_manual_photo'.
        // OSSO 27 fix (01/05/2026): se SERPER_API_KEY ausente, NÃO seta pending_reference
        // (ficaria travado eternamente no fire-and-forget). Vai direto pra needs_manual_photo
        // pra UI já mostrar os botões corretos (foto manual / gerar sem ref).
        art_status: SERPER_API_KEY ? 'pending_reference' : 'needs_manual_photo',
        box_photo_url: boxPhotoUrl || null,
        created_via: 'receber_app',
        descricao_quebrada: descricaoQuebrada || null,
        flavor_category: flavorCategory, // OSSO 22 — auto-classificação Vision/heurística
        metadata,
      };

      const inserted = await sbInsert('drope_products', insertData);
      if (!inserted || !inserted.id) {
        return res.status(500).json({ error: 'insert falhou', detail: sbInsert._lastError || 'desconhecido' });
      }

      if (priceCents && model) {
        try { await setPriceRule(brand, model, priceCents); }
        catch (e) { console.warn('[quick_register] setPriceRule:', e.message); }
      }

      // PIPELINE NOVO: dispara busca de referência via Serper em background (fire-and-forget).
      // Não bloqueia o scanner — quando termina, marca produto pra revisão no /admin-referencias.
      // Se Andrade quer fluxo legado (deferArt=false), ainda dispara art generation direto.
      // OSSO 27 fix: skip se SERPER_API_KEY ausente (não dispara busca que vai falhar).
      let willSearchRefs = false;
      if (deferArt && SERPER_API_KEY) {
        // Fluxo deferred do receber.html: scanner segue, refs buscam em background
        searchProductReferences(inserted.id, brand, model, flavor)
          .catch(e => console.error('[quick_register] searchRefs failed:', e.message));
        willSearchRefs = true;
      } else if (deferArt) {
        // Sem SERPER → produto fica em needs_manual_photo (já setado acima); admin manda foto.
        willSearchRefs = false;
      } else {
        try {
          await fireBackgroundArtGeneration(inserted.id, ADMIN_LUCAS, 1);
        } catch (e) { console.warn('[quick_register] fireArt:', e.message); }
      }

      return res.status(200).json({
        ok: true,
        mode: deferArt ? 'created_pending_pod' : 'created',
        product: {
          id: inserted.id,
          name: fullName,
          slug,
          barcode: barcode || null,
          hidden: insertData.hidden,
          price_cents: finalPriceCents,
        },
        willSearchRefs,
        willGenerateArt: !deferArt,
      });
    } catch (e) {
      console.error('[quick_register] error:', e.message, e.stack);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== OSSO 29 — ADMIN HUB (01/05/2026) =====
  // GET /api/webhook?action=admin_hub                  → HTML hub com login + tiles
  // GET /api/webhook?action=admin_counts&type=X&token= → JSON contadores pra badges
  if (req.url && req.url.indexOf('action=admin_counts') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    const qs = (req.url || '').split('?')[1] || '';
    const params = {};
    qs.split('&').forEach(p => {
      const [k, v] = p.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    if (!ADMIN_TOKEN || params.token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    const type = params.type || '';
    let count = 0;
    try {
      if (type === 'pending') {
        const rows = await sbGet('drope_products',
          `or=(image_status.eq.pending_pod_photo,art_status.in.(pending_review,needs_manual_photo,pending_reference))&select=id&limit=300`);
        count = (rows || []).length;
      } else if (type === 'gallery') {
        // Gallery pendente = artes geradas esperando aprovação
        const rows = await sbGet('drope_products',
          `image_status=eq.awaiting_approval&select=id&limit=300`);
        count = (rows || []).length;
      } else if (type === 'esteira') {
        // Esteira (08/05/2026): soma sem-sabor + pendentes + gallery + specs numa badge só
        const [unident, pending, gallery, specs] = await Promise.all([
          sbGet('drope_batch_queue', `decision=eq.unidentified_flavor&select=id,batch_id,photo_index&limit=300`),
          sbGet('drope_products', `or=(image_status.eq.pending_pod_photo,art_status.in.(pending_review,needs_manual_photo,pending_reference),image_url.is.null)&image_status=neq.removed&select=id&limit=300`),
          sbGet('drope_products', `image_status=eq.awaiting_approval&select=id&limit=300`),
          sbGet('drope_products', `image_status=eq.ok&image_url=not.is.null&or=(price_cents.eq.0,price_cents.is.null,barcode.is.null,barcode.eq.)&select=id&limit=300`),
        ]);
        // Dedup unidentified por batch+photo
        const seen = new Set();
        let unidentCount = 0;
        for (const r of (unident || [])) {
          const k = `${r.batch_id}:${r.photo_index}`;
          if (!seen.has(k)) { seen.add(k); unidentCount++; }
        }
        count = unidentCount + (pending || []).length + (gallery || []).length + (specs || []).length;
      } else if (type === 'stock') {
        const rows = await sbGet('drope_products', `select=id&limit=1000`);
        count = (rows || []).length;
      } else if (type === 'customers') {
        const rows = await sbGet('drope_customers', `select=id&limit=1000`);
        count = (rows || []).length;
      } else if (type === 'orders') {
        const rows = await sbGet('drope_orders', `select=id&limit=1000`);
        count = (rows || []).length;
      }
    } catch (e) { console.error('[admin_counts] err:', e.message); }
    return res.status(200).json({ type, count });
  }

  if (req.url && req.url.indexOf('action=admin_hub') >= 0) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    if (req.method === 'OPTIONS') return res.status(200).end();
    // Hub é HTML estático com lógica client-side. Não valida token server-side
    // (cada tela filha valida o seu). HTML idêntico pra "logado" ou "logout" —
    // o JS decide qual UI renderizar baseado em URL/localStorage.
    const html = `<!DOCTYPE html>
<html lang="pt-BR" translate="no">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0A0A14">
  <meta name="google" content="notranslate">
  <title>Admin ✦ Drope</title>
  <style>
    :root{--bg:#0A0A14;--bg2:#14141F;--fg:#EAEAF2;--dim:#8A8AA3;--pink:#FF2D6F;--lime:#D4FF2E;--violet:#9D4EDD;--amber:#FFB800;--b:rgba(255,255,255,0.08)}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;min-height:100dvh}
    .login{display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:20px}
    .login-box{background:var(--bg2);border:1px solid var(--b);border-radius:16px;padding:32px;max-width:360px;width:100%;text-align:center}
    .login-box h1{margin:0 0 8px;font-size:22px}.login-box h1 em{color:var(--lime);font-style:normal}
    .login-box p{color:var(--dim);font-size:13px;margin:0 0 20px}
    .login-box input{width:100%;padding:14px;border-radius:10px;border:1px solid var(--b);background:var(--bg);color:var(--fg);font-size:13px;font-family:monospace;text-align:center;outline:none}
    .login-box input:focus{border-color:var(--lime)}
    .login-box button{width:100%;margin-top:12px;padding:14px;border-radius:10px;border:none;background:var(--lime);color:#000;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
    .login-box .err{color:var(--pink);font-size:12px;margin-top:8px;display:none}
    header{padding:16px;border-bottom:1px solid var(--b);display:flex;align-items:center;justify-content:space-between}
    h1{margin:0;font-size:20px}h1 em{color:var(--lime);font-style:normal}
    .subtitle{font-size:12px;color:var(--dim);margin-top:2px}
    .logout{padding:8px 14px;border-radius:10px;background:var(--bg2);border:1px solid var(--b);color:var(--dim);font-size:12px;cursor:pointer;font-family:inherit}
    .grid{padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:520px;margin:0 auto}
    @media(min-width:680px){.grid{grid-template-columns:1fr 1fr 1fr;max-width:780px}}
    .tile{background:var(--bg2);border:1px solid var(--b);border-radius:14px;padding:20px 14px;text-decoration:none;color:var(--fg);display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;transition:border-color .2s,transform .1s;position:relative}
    .tile:active{transform:scale(0.97)}
    .tile:hover{border-color:var(--lime)}
    .tile .icon{font-size:30px;line-height:1}
    .tile .label{font-size:14px;font-weight:700;text-transform:lowercase;letter-spacing:.02em}
    .tile .desc{font-size:11px;color:var(--dim);line-height:1.3}
    .tile .badge{position:absolute;top:8px;right:8px;background:var(--pink);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:99px;min-width:20px;text-align:center}
    .tile .badge.lime{background:var(--lime);color:#000}
    .tile .badge.amber{background:var(--amber);color:#000}
    .tile .badge.violet{background:var(--violet);color:#fff}
    .footer{padding:20px;text-align:center;color:var(--dim);font-size:11px;margin-top:20px}
  </style>
</head>
<body>
<script>
// OSSO 29 — Admin Hub. Centraliza acesso a todas as telas /admin.
// Login client-side: salva token em localStorage e propaga via URL params.
const PAGES = [
  { id:'esteira',   icon:'🎯', label:'esteira',   desc:'sem-sabor → pendentes → gallery numa tela só', url:'/api/webhook?action=esteira', countKey:'esteira', badgeColor:'lime' },
  { id:'estoque',   icon:'📦', label:'estoque',   desc:'produtos cadastrados',      url:'/api/admin-list-stock',                  countKey:'stock', badgeColor:'amber' },
  { id:'clientes',  icon:'👥', label:'clientes',  desc:'base + métricas',           url:'/api/webhook?action=admin-customers',    countKey:'customers', badgeColor:'lime' },
  { id:'pedidos',   icon:'📋', label:'pedidos',   desc:'orders e status',           url:'/api/admin-orders',                       countKey:'orders', badgeColor:'violet' },
  { id:'refs',      icon:'🔎', label:'refs',      desc:'referências do Serper',     url:'/api/webhook?action=pending_references', countKey:null, badgeColor:'' },
  { id:'custos',    icon:'💰', label:'custos',    desc:'gastos com APIs (7d)',      url:'/api/webhook?action=cost_report&days=7', countKey:null, badgeColor:'' },
  { id:'saude',     icon:'🏥', label:'saúde',     desc:'system health',             url:'/api/webhook?action=system_health',      countKey:null, badgeColor:'' },
  { id:'balanco',   icon:'📊', label:'balanço',   desc:'conferência fisica vs digital', url:'/api/webhook?action=balance_panel',  countKey:null, badgeColor:'lime' },
  { id:'feedback',  icon:'💬', label:'feedback',  desc:'bolinha admin',             url:'/api/webhook?action=feedback_list',      countKey:null, badgeColor:'' },
];
function getToken() {
  const params = new URLSearchParams(location.search);
  return params.get('token') || localStorage.getItem('drope_admin_token') || '';
}
function setToken(t) { try { localStorage.setItem('drope_admin_token', t); } catch(e) {} }
function clearToken() { try { localStorage.removeItem('drope_admin_token'); } catch(e) {} location.href = '/api/webhook?action=admin_hub'; }
function renderLogin() {
  document.body.innerHTML = \`
    <div class="login">
      <div class="login-box">
        <h1><em>🦎</em> drope admin</h1>
        <p>cola o token de admin pra entrar</p>
        <input id="tokenInput" type="password" placeholder="token..." autofocus />
        <button onclick="doLogin()">entrar</button>
        <div class="err" id="loginErr">token vazio</div>
      </div>
    </div>\`;
  document.getElementById('tokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
}
function doLogin() {
  const t = (document.getElementById('tokenInput').value || '').trim();
  if (!t) { document.getElementById('loginErr').style.display = 'block'; return; }
  setToken(t);
  location.href = '/api/webhook?action=admin_hub&token=' + encodeURIComponent(t);
}
function renderHub(token) {
  const tiles = PAGES.map(p => {
    const sep = p.url.indexOf('?') >= 0 ? '&' : '?';
    const url = p.url + sep + 'token=' + encodeURIComponent(token);
    return \`<a class="tile" href="\${url}" id="tile-\${p.id}" target="_blank" rel="noopener">
      <span class="icon">\${p.icon}</span>
      <span class="label">\${p.label}</span>
      <span class="desc">\${p.desc}</span>
    </a>\`;
  }).join('');
  document.body.innerHTML = \`
    <header>
      <div>
        <h1><em>🦎</em> drope admin</h1>
        <div class="subtitle">tudo numa tela só</div>
      </div>
      <button class="logout" onclick="clearToken()">sair</button>
    </header>
    <div class="grid">\${tiles}</div>
    <div class="footer">drope ✦ \${PAGES.length} áreas administrativas</div>\`;
  loadCounts(token);
}
async function loadCounts(token) {
  const types = ['esteira', 'stock', 'customers', 'orders'];
  await Promise.all(types.map(async (t) => {
    try {
      const r = await fetch('/api/webhook?action=admin_counts&type=' + t + '&token=' + encodeURIComponent(token));
      if (!r.ok) return;
      const d = await r.json();
      if (typeof d.count === 'number' && d.count > 0) addBadge(t, d.count);
    } catch (e) {}
  }));
}
function addBadge(countKey, count) {
  const page = PAGES.find(p => p.countKey === countKey);
  if (!page) return;
  const tile = document.getElementById('tile-' + page.id);
  if (!tile) return;
  const old = tile.querySelector('.badge');
  if (old) old.remove();
  const badge = document.createElement('span');
  badge.className = 'badge' + (page.badgeColor ? ' ' + page.badgeColor : '');
  badge.textContent = count;
  tile.appendChild(badge);
}
const token = getToken();
if (token) {
  setToken(token);
  // Se token tá só no localStorage, propaga pra URL pra reload manter contexto
  const urlToken = new URLSearchParams(location.search).get('token');
  if (!urlToken && token) {
    history.replaceState(null, '', '/api/webhook?action=admin_hub&token=' + encodeURIComponent(token));
  }
  renderHub(token);
} else {
  renderLogin();
}
</script>
</body>
</html>`;
    return res.status(200).send(html);
  }

  // ===== ROTAS PENDENTES DE FOTO DO POD (sessão MEKA 30/04 noite — fluxo deferred) =====
  // GET  /api/webhook?action=pending_pod_photos&token=ADMIN_TOKEN  → HTML lista cards
  // POST /api/webhook?action=upload_pod_photo                       → recebe foto do pod, re-roda Vision com box+pod, dispara arte
  // POST /api/webhook?action=skip_pod_photo                         → pula pod, gera arte só com a caixa
  // POST /api/webhook?action=generate_all_pending_pod              → batch: dispara arte de todos os pending_pod_photo
  if (req.url && req.url.indexOf('action=pending_pod_photos') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    try {
      const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
      const params = {};
      qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
      if (!ADMIN_TOKEN || params.token !== ADMIN_TOKEN) return res.status(401).send('unauthorized');

      // OSSO 27 (01/05/2026) — Tela unificada: pending_pod_photo OU produtos
      // que precisam de decisão sobre referência (pending_reference / pending_review /
      // needs_manual_photo). Antes era 2 telas separadas; agora 1 só com refs + foto + skip.
      // OSSO 28C fix: exclui produtos com image_status='removed'.
      // 02/05/2026 patch: também inclui produtos com image_url IS NULL mesmo se
      // image_status='ok' (cadastros bulk de modelo sem arte ainda).
      const pending = await sbGet('drope_products',
        `or=(image_status.eq.pending_pod_photo,art_status.in.(pending_review,needs_manual_photo,pending_reference),image_url.is.null)` +
        `&image_status=neq.removed` +
        `&select=id,name,barcode,box_photo_url,reference_image_url,reference_candidates,image_status,art_status,metadata,updated_at,image_url` +
        `&order=created_at.desc&limit=200`);
      // OSSO 27 fix defensivo: produto em pending_reference há > 3 min com refs vazias =
      // busca travou (SERPER ausente, dispatch caiu, etc.). Trata como needs_manual_photo
      // pra UI mostrar botões corretos sem precisar mexer no banco.
      const STALE_REF_MS = 3 * 60 * 1000;
      const now = Date.now();
      for (const p of (pending || [])) {
        if (p.art_status === 'pending_reference') {
          const refsLen = Array.isArray(p.reference_candidates) ? p.reference_candidates.length : 0;
          const ageMs = p.updated_at ? (now - new Date(p.updated_at).getTime()) : Infinity;
          if (refsLen === 0 && ageMs > STALE_REF_MS) {
            p.art_status = 'needs_manual_photo';
            p._stale_search = true;
          }
        }
      }
      const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const cards = (pending || []).map(p => {
        const m = p.metadata || {};
        const boxUrl = p.box_photo_url || m.box_photo_url || '';
        const subtitle = [m.brand, m.model, m.flavor_pt || m.flavor_en].filter(Boolean).join(' ✦ ');
        const refs = Array.isArray(p.reference_candidates) ? p.reference_candidates : [];
        const hasApprovedRef = !!p.reference_image_url;
        // Estado da busca de referências
        const isSearching = p.art_status === 'pending_reference';
        const needsManual = p.art_status === 'needs_manual_photo';
        // HTML do bloco de referências
        const refsHtml = isSearching
          ? '<div class="refs-loading"><span class="spin"></span> buscando referências na internet…</div>'
          : refs.length === 0
            ? '<div class="empty-refs">⚠️ nenhuma referência boa encontrada<br/><span style="opacity:0.7">manda foto manual ou tenta buscar de novo</span></div>'
            : `<div class="refs">${refs.map((r, i) => `
                <label class="ref-card${hasApprovedRef && p.reference_image_url === r.url ? ' selected' : ''}">
                  <input type="radio" name="ref-${p.id}" value="${esc(r.url)}" data-product-id="${p.id}" ${hasApprovedRef && p.reference_image_url === r.url ? 'checked' : ''} />
                  <img src="${esc(r.url)}" loading="lazy" alt="ref ${i+1}" />
                  <span class="score">${typeof r.combined_score === 'number' ? '🎯' + r.combined_score : '⭐' + (r.quality_score || 0)}</span>
                </label>`).join('')}</div>`;
        // Status badge (texto curto + cor)
        const statusLabel =
          isSearching       ? 'buscando refs' :
          needsManual       ? 'sem refs' :
          p.art_status === 'pending_review' ? `${refs.length} refs` :
          p.art_status === 'reference_approved' ? 'ref aprovada' :
          p.image_status === 'pending_pod_photo' ? 'esperando foto' :
                              esc(p.art_status || p.image_status || '');
        return `
        <div class="card" data-id="${esc(p.id)}" data-status="${esc(p.art_status || '')}">
          <div class="hd">
            <div class="name">${esc(p.name)}</div>
            <div class="sub">${esc(subtitle)}</div>
            <div class="bc">${p.barcode ? 'barcode: <code>'+esc(p.barcode)+'</code>' : ''}</div>
            <div class="status-badge status-${esc(p.art_status || p.image_status || '')}">${esc(statusLabel)}</div>
          </div>
          <div class="card-grid">
            <div class="col">
              <div class="lbl">📦 sua foto da caixa</div>
              ${boxUrl
                ? `<a href="${esc(boxUrl)}" target="_blank"><img class="box-photo" src="${esc(boxUrl)}" loading="lazy" alt="caixa" /></a>`
                : '<div class="no-photo">sem foto</div>'}
            </div>
            <div class="col">
              <div class="lbl">🔎 referências da internet</div>
              ${refsHtml}
            </div>
          </div>
          <div class="actions">
            ${refs.length > 0
              ? `<button type="button" class="btn primary" onclick="approveRef(${esc(p.id)})">✅ usar selecionada</button>`
              : ''}
            <label class="btn">
              📸 ${refs.length > 0 ? 'nenhuma serve — ' : ''}foto manual
              <input type="file" accept="image/*" capture="environment" onchange="onPodPhoto(event, ${esc(p.id)})" hidden />
            </label>
            ${needsManual
              ? `<button type="button" class="btn" onclick="retrySearch(${esc(p.id)})">🔄 buscar de novo</button>`
              : ''}
            <button type="button" class="btn ghost" onclick="skipRef(${esc(p.id)})">🎬 gerar sem referência</button>
            <button type="button" class="btn ghost" onclick="removePending(${esc(p.id)})">🗑️ remover</button>
          </div>
          <div class="status" id="st-${esc(p.id)}"></div>
        </div>`;
      }).join('');

      const token = params.token;
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0A0A14">
<title>Pendentes ✦ Drope</title>
<style>
  :root { --bg:#0A0A14; --bg2:#14141F; --fg:#EAEAF2; --dim:#8A8AA3; --pink:#FF2D6F; --lime:#D4FF2E; --violet:#9D4EDD; --amber:#FFB800; --b:rgba(255,255,255,0.08); }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif}
  header{padding:14px 16px 10px;border-bottom:1px solid var(--b);position:sticky;top:0;background:var(--bg);z-index:5;display:flex;align-items:center;justify-content:space-between}
  h1{margin:0;font-size:18px}
  h1 em{color:var(--lime);font-style:normal}
  .count{font-size:12px;color:var(--dim);margin-top:2px}
  .topbtn{padding:8px 12px;border-radius:10px;background:var(--bg2);border:1px solid var(--b);color:var(--fg);font-size:13px;text-decoration:none;display:inline-block;font-family:inherit;cursor:pointer}
  .topbtn.primary{background:var(--lime);color:#000;border-color:var(--lime);font-weight:700}
  /* OSSO 27 — grid principal: 1 coluna mobile, 2 colunas desktop */
  .grid{padding:14px;display:grid;grid-template-columns:1fr;gap:14px;max-width:780px;margin:0 auto;padding-bottom:120px}
  .card{background:var(--bg2);border:1px solid var(--b);border-radius:14px;overflow:hidden}
  .hd{padding:12px 14px;border-bottom:1px solid var(--b);position:relative}
  .name{font-weight:700;font-size:15px;margin-bottom:2px}
  .sub{font-size:12px;color:var(--dim);margin-bottom:2px}
  .bc{font-size:11px;color:var(--dim);margin-top:2px}
  .bc code{color:var(--fg);background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:4px;font-family:monospace}
  /* Status badge no canto superior direito do card */
  .status-badge{position:absolute;top:12px;right:14px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:999px;background:var(--bg);border:1px solid var(--b);color:var(--dim);white-space:nowrap}
  .status-pending_review{color:var(--lime);border-color:var(--lime)}
  .status-needs_manual_photo{color:var(--amber);border-color:var(--amber)}
  .status-reference_approved{color:var(--violet);border-color:var(--violet)}
  .status-pending_reference{color:var(--dim);border-color:var(--dim)}
  .status-pending_pod_photo{color:var(--lime);border-color:rgba(212,255,46,0.4)}
  /* Card-grid: caixa | refs (2 colunas no desktop, 1 no mobile) */
  .card-grid{display:grid;grid-template-columns:1fr 2fr;gap:10px;padding:12px}
  @media(max-width:560px){.card-grid{grid-template-columns:1fr}}
  .col{min-width:0}
  .lbl{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
  .box-photo{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:#000}
  .no-photo{display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;color:var(--dim);background:#000;border-radius:8px;font-size:12px}
  .refs{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
  .ref-card{position:relative;display:block;cursor:pointer;border-radius:8px;overflow:hidden;border:2px solid var(--b);background:#000;aspect-ratio:1}
  .ref-card.selected{border-color:var(--lime);box-shadow:0 0 0 2px rgba(212,255,46,.3)}
  .ref-card input{position:absolute;opacity:0;pointer-events:none}
  .ref-card img{width:100%;height:100%;object-fit:cover;display:block}
  .ref-card .score{position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,.7);color:var(--lime);padding:2px 6px;border-radius:6px;font-size:10px;font-weight:700}
  .empty-refs{padding:14px;background:rgba(255,184,0,.08);border:1px solid rgba(255,184,0,.3);border-radius:8px;font-size:12px;color:var(--amber);line-height:1.5;text-align:center}
  .refs-loading{padding:18px;font-size:12px;color:var(--dim);text-align:center}
  .actions{padding:10px 14px;display:grid;grid-template-columns:1fr;gap:8px;border-top:1px solid var(--b);background:rgba(255,255,255,.02)}
  .btn{padding:11px 12px;border-radius:10px;border:1px solid var(--b);background:var(--bg2);color:var(--fg);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center;display:block;touch-action:manipulation}
  .btn.primary{background:var(--lime);color:#000;border-color:var(--lime)}
  .btn.ghost{background:transparent;color:var(--dim)}
  .btn:active{transform:scale(0.98)}
  label.btn{display:block}
  .status{padding:0 14px 12px;font-size:12px;color:var(--dim);min-height:0}
  .status.ok{color:var(--lime)}
  .status.err{color:var(--pink)}
  .empty{padding:60px 20px;text-align:center;color:var(--dim)}
  .actbar{position:fixed;bottom:0;left:0;right:0;padding:12px calc(12px + env(safe-area-inset-left));background:linear-gradient(0deg,var(--bg) 0%,rgba(10,10,20,0.6) 100%);display:flex;gap:10px;justify-content:center;border-top:1px solid var(--b);backdrop-filter:blur(8px)}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(212,255,46,0.2);border-top-color:var(--lime);border-radius:50%;animation:s 0.8s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes s{to{transform:rotate(360deg)}}
  /* Preview da arte gerada (OSSO 26) */
  .art-preview{padding:8px;background:#000;display:flex;flex-direction:column;align-items:center;gap:10px}
  .art-preview img{max-width:100%;max-height:380px;border-radius:10px;border:1px solid rgba(212,255,46,0.4);box-shadow:0 0 24px rgba(212,255,46,0.15)}
</style>
</head>
<body>
<header>
  <div>
    <h1><em>📸</em> pendentes — escolhe referência ou manda foto</h1>
    <div class="count">${(pending || []).length} pod${(pending || []).length === 1 ? '' : 's'} esperando decisão</div>
  </div>
  <a class="topbtn" href="/#admin-dash">voltar</a>
</header>
<div class="grid" id="grid">
${cards || '<div class="empty">✅ nenhum pod pendente de foto.<br><br>cadastra mais pelo /receber.</div>'}
</div>
${(pending || []).length > 0 ? `<div class="actbar">
  <button class="topbtn" onclick="notifyWhats()">📤 me avisar no whats</button>
  <button class="topbtn primary" onclick="generateAll()">🎬 gerar todos sem pod</button>
</div>` : ''}
<script>
const TOKEN = ${JSON.stringify(token)};
function setStatus(id, html, cls){
  const el = document.getElementById('st-' + id);
  if (!el) return;
  el.className = 'status' + (cls ? ' ' + cls : '');
  el.innerHTML = html || '';
}
function fileToB64(f){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}
// OSSO 27 — Listener de seleção de referência (visual selected)
document.addEventListener('change', (e) => {
  if (e.target.type === 'radio' && e.target.name && e.target.name.indexOf('ref-') === 0) {
    const card = e.target.closest('.card');
    if (!card) return;
    card.querySelectorAll('.ref-card').forEach(c => c.classList.remove('selected'));
    const lbl = e.target.closest('.ref-card');
    if (lbl) lbl.classList.add('selected');
  }
});
// OSSO 27 — Aprovar referência selecionada → marca como reference_image_url + dispara arte
async function approveRef(productId){
  const card = document.querySelector('.card[data-id="'+productId+'"]');
  if (!card) return;
  const radio = card.querySelector('input[type=radio]:checked');
  if (!radio) { setStatus(productId, '⚠️ seleciona uma referência primeiro', 'err'); return; }
  setStatus(productId, '<span class="spin"></span> aprovando + gerando arte (~30s)…');
  try {
    const r = await fetch('/api/webhook?action=approve_reference', {
      method: 'POST', headers: {'Content-Type':'application/json','x-admin-token':TOKEN},
      body: JSON.stringify({ productId, referenceUrl: radio.value }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http '+r.status));
    setStatus(productId, '✅ referência aprovada — arte vai gerar', 'ok');
    setTimeout(() => { if (card) card.style.display = 'none'; }, 3000);
  } catch(e) { setStatus(productId, '⚠️ erro: '+e.message, 'err'); }
}
// OSSO 27 — Pular referência → gera arte só com dados textuais (Vision metadata)
async function skipRef(productId){
  if (!confirm('gerar arte SÓ com os dados textuais (sem foto de referência)?\\n\\nO device pode ficar genérico.')) return;
  setStatus(productId, '<span class="spin"></span> gerando sem referência…');
  try {
    const r = await fetch('/api/webhook?action=skip_reference', {
      method: 'POST', headers: {'Content-Type':'application/json','x-admin-token':TOKEN},
      body: JSON.stringify({ productId }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http '+r.status));
    setStatus(productId, '✅ arte gerando sem referência…', 'ok');
    const card = document.querySelector('.card[data-id="'+productId+'"]');
    setTimeout(() => { if (card) card.style.display = 'none'; }, 3000);
  } catch(e) { setStatus(productId, '⚠️ erro: '+e.message, 'err'); }
}
// OSSO 27 — Refazer busca de referências (quando Serper não achou na primeira)
async function retrySearch(productId){
  setStatus(productId, '<span class="spin"></span> buscando referências de novo…');
  try {
    const r = await fetch('/api/webhook?action=retry_search', {
      method: 'POST', headers: {'Content-Type':'application/json','x-admin-token':TOKEN},
      body: JSON.stringify({ productId }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http '+r.status));
    setStatus(productId, '✅ buscando… recarrega em 10s pra ver o resultado', 'ok');
    setTimeout(() => location.reload(), 10000);
  } catch(e) { setStatus(productId, '⚠️ erro: '+e.message, 'err'); }
}
async function onPodPhoto(ev, id){
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  // OSSO 26 (01/05/2026) — fluxo síncrono: aguarda resposta com art_url e
  // mostra preview pro admin aprovar. Antes era fire-and-forget que sumia.
  let progress = 0;
  const progressTimer = setInterval(() => {
    progress = Math.min(95, progress + 3);
    setStatus(id, '<span class="spin"></span>analisando + gerando arte… ' + progress + '%');
  }, 1200);

  try {
    const b64 = await fileToB64(f);
    setStatus(id, '<span class="spin"></span>enviando foto…');
    // Timeout maior que o maxDuration do Vercel (60s) — se passar, faz polling.
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort('timeout-frontend'), 65000);
    let data;
    try {
      const r = await fetch('/api/webhook?action=upload_pod_photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
        body: JSON.stringify({ productId: id, podBase64: b64 }),
        signal: ac.signal,
      });
      clearTimeout(timeoutId);
      data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || ('http ' + r.status));
    } catch (e) {
      clearTimeout(timeoutId);
      // Frontend timeout → fallback pra polling do art_status
      if (e.name === 'AbortError' || /timeout/i.test(e.message)) {
        setStatus(id, '<span class="spin"></span>arte demorando, aguardando…');
        data = await pollArtStatus(id, 90000);
        if (!data) throw new Error('arte demorou demais — confira em /admin/gallery');
      } else {
        throw e;
      }
    } finally {
      clearInterval(progressTimer);
    }

    const artUrl = (data.art && (data.art.art_url || data.art.image_url)) || data.art_url;
    if (artUrl) {
      showArtPreview(id, artUrl);
      setStatus(id, '✅ arte gerada — confere e aprova', 'ok');
    } else if (data.art && data.art.error) {
      setStatus(id, '⚠️ arte falhou: ' + data.art.error + ' • toca de novo pra retentar', 'err');
    } else {
      setStatus(id, '⚠️ arte não chegou — confere em /admin/gallery', 'err');
    }
  } catch(e) {
    clearInterval(progressTimer);
    setStatus(id, '⚠️ erro: ' + e.message, 'err');
  }
}

async function pollArtStatus(id, maxMs){
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const r = await fetch('/api/webhook?action=art_status&product_id=' + id + '&token=' + encodeURIComponent(TOKEN), {
        headers: { 'x-admin-token': TOKEN },
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.ready || j.failed) return { ok: true, art: { art_url: j.art_url, status: j.image_status, error: j.failed ? 'image_status=error' : null } };
    } catch(e) { /* continua */ }
  }
  return null;
}

function showArtPreview(id, artUrl){
  const card = document.querySelector('[data-id="' + id + '"]');
  if (!card) return;
  // Esconde foto da caixa, mostra arte gerada com botões aprovar/regenerar
  const boxImg = card.querySelector('.box');
  if (boxImg && boxImg.tagName === 'IMG') boxImg.style.display = 'none';
  let preview = card.querySelector('.art-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.className = 'art-preview';
    preview.style.cssText = 'padding:8px;background:#000;display:flex;flex-direction:column;align-items:center;gap:10px';
    card.insertBefore(preview, card.querySelector('.actions') || card.lastChild);
  }
  preview.innerHTML =
    '<img src="' + artUrl + '" alt="arte gerada" style="max-width:100%;max-height:380px;border-radius:10px;border:1px solid rgba(212,255,46,0.4);box-shadow:0 0 24px rgba(212,255,46,0.15)" />' +
    '<div style="display:flex;gap:8px;width:100%">' +
      '<button class="btn primary" style="flex:1" onclick="approveArt(' + id + ')">✅ aprovar</button>' +
      '<button class="btn" style="flex:1" onclick="regenerateArt(' + id + ')">🎬 outra</button>' +
    '</div>';
}

async function approveArt(id){
  setStatus(id, '<span class="spin"></span>aprovando…');
  try {
    // gallery_action espera { id, op: 'approve' } — copia pending_art_url pra image_url + status='ok'
    const r = await fetch('/api/webhook?action=gallery_action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ id, op: 'approve' }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http ' + r.status));
    setStatus(id, '✅ aprovada — tá no catálogo', 'ok');
    const card = document.querySelector('[data-id="' + id + '"]');
    if (card) setTimeout(() => card.remove(), 1200);
  } catch(e) {
    setStatus(id, '⚠️ erro ao aprovar: ' + e.message, 'err');
  }
}

async function regenerateArt(id){
  setStatus(id, '<span class="spin"></span>gerando outra (~30s)…');
  try {
    // Marca pending_regeneration + dispara generate_pending pra rodar o pipeline
    const r1 = await fetch('/api/webhook?action=gallery_action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ id, op: 'regenerate' }),
    });
    const j1 = await r1.json();
    if (!r1.ok || !j1.ok) throw new Error(j1.error || ('http ' + r1.status));
    // Dispara geração explícita (evita esperar cron). generate_pending processa
    // 1 produto por chamada, escolhendo entre os pending_regeneration mais antigos.
    fetch('/api/webhook?action=generate_pending').catch(() => {});
    const polled = await pollArtStatus(id, 90000);
    if (polled && polled.art && polled.art.art_url) {
      showArtPreview(id, polled.art.art_url);
      setStatus(id, '✅ nova arte gerada', 'ok');
    } else {
      setStatus(id, '⚠️ nova arte demorou — recarrega a página', 'err');
    }
  } catch(e) {
    setStatus(id, '⚠️ erro: ' + e.message, 'err');
  }
}
async function skipPodPhoto(id){
  if (!confirm('gerar arte SÓ com a foto da caixa?\\n\\n(o device pode ficar genérico — o pod real seria mais fiel)')) return;
  setStatus(id, '<span class="spin"></span>disparando arte…');
  try {
    const r = await fetch('/api/webhook?action=skip_pod_photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ productId: id }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http ' + r.status));
    setStatus(id, '✅ arte gerando', 'ok');
    setTimeout(() => location.reload(), 1500);
  } catch(e) {
    setStatus(id, '⚠️ erro: ' + e.message, 'err');
  }
}
async function removePending(id){
  if (!confirm('remover esse cadastro?\\n\\n(produto vai sumir do app — pode recadastrar depois)')) return;
  setStatus(id, '<span class="spin"></span>removendo…');
  try {
    const r = await fetch('/api/webhook?action=remove_pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ productId: id }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http ' + r.status));
    const card = document.querySelector('[data-id="' + id + '"]');
    if (card) card.remove();
  } catch(e) {
    setStatus(id, '⚠️ erro: ' + e.message, 'err');
  }
}
async function generateAll(){
  if (!confirm('gerar arte de TODOS os pendentes sem pod?\\n\\n(vai disparar geração em sequência — pode levar ~30s por pod)')) return;
  try {
    const r = await fetch('/api/webhook?action=generate_all_pending_pod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('http ' + r.status));
    alert('✅ disparado pra ' + data.count + ' pods. recarregando…');
    location.reload();
  } catch(e) {
    alert('⚠️ erro: ' + e.message);
  }
}
async function notifyWhats(){
  try {
    const r = await fetch('/api/webhook?action=notify_pending_pod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('http ' + r.status));
    if (data.count === 0) alert('nenhum pendente — nada pra notificar.');
    else alert('📤 mensagem mandada pro whats com ' + data.count + ' pendente' + (data.count === 1 ? '' : 's'));
  } catch(e) {
    alert('⚠️ erro: ' + e.message);
  }
}
</script>
</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (e) {
      console.error('[pending_pod_photos] error:', e.message);
      return res.status(500).send('error: ' + e.message);
    }
  }

  if (req.url && req.url.indexOf('action=upload_pod_photo') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const productId = reqBody.productId;
      const podBase64 = reqBody.podBase64;
      if (!productId || !podBase64) return res.status(400).json({ error: 'productId e podBase64 obrigatórios' });

      const rows = await sbGet('drope_products', `id=eq.${productId}&select=id,slug,name,metadata,box_photo_url&limit=1`);
      const product = rows[0];
      if (!product) return res.status(404).json({ error: 'product not found' });

      const meta = product.metadata || {};
      const boxUrl = product.box_photo_url || meta.box_photo_url;

      // OSSO 26 (01/05/2026) — FIX FUNDAMENTAL: salva a foto do pod no Storage
      // ANTES de qualquer outra coisa. Bug anterior: foto era usada só pra Vision
      // e descartada — se Grok falhasse, perdíamos a foto e o produto ficava
      // órfão (`needs_manual_photo` + image_url=NULL pra sempre).
      let podPhotoUrl = null;
      try {
        const cleanB64 = podBase64.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(cleanB64, 'base64');
        podPhotoUrl = await uploadToStorage(`pod-refs/${product.slug}-pod`, buf, 'image/jpeg');
      } catch (e) { console.warn('[upload_pod_photo] pod storage upload failed:', e.message); }

      // 02/05 patch — se produto NÃO tem box_photo_url, usa essa mesma foto
      // como box (pra próximas Vision pegarem contexto). Aplica em SKUs
      // bulk-cadastrados via SQL que nasceram sem foto.
      let savedAsBox = null;
      if (!boxUrl) {
        try {
          const cleanB64 = podBase64.replace(/^data:image\/\w+;base64,/, '');
          const buf = Buffer.from(cleanB64, 'base64');
          const ext = (podBase64.includes('image/png') ? 'png' : 'jpg');
          const path = `box-photos/${product.slug}.${ext}`;
          const upUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
          const upR = await fetch(upUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY,
              'Content-Type': `image/${ext}`, 'x-upsert': 'true',
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
            body: buf,
          });
          if (upR.ok) savedAsBox = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
        } catch (e) { console.warn('[upload_pod_photo] save as box_photo:', e.message); }
      }
      const effectiveBoxUrl = boxUrl || savedAsBox;

      // Re-roda Vision com box + pod pra atualizar device_visual com base no pod real
      let updatedMeta = { ...meta };
      if (effectiveBoxUrl) {
        try {
          const podDataUrl = podBase64.startsWith('data:') ? podBase64 : `data:image/jpeg;base64,${podBase64}`;
          const visionData = await analyzeProductImage(effectiveBoxUrl, podDataUrl);
          if (visionData) {
            updatedMeta = {
              ...meta,
              device_color: visionData.device_color || meta.device_color,
              device_visual: visionData.device_visual || meta.device_visual,
              device_visual_detailed: visionData.device_visual_detailed || meta.device_visual_detailed,
              cores_predominantes: visionData.cores_predominantes || meta.cores_predominantes,
            };
          }
        } catch (e) { console.warn('[upload_pod_photo] re-vision failed:', e.message); }
      }

      // Persiste foto do pod + meta atualizada ANTES de gerar arte. Garante que
      // mesmo se Grok falhar (timeout, quota), o admin ainda tem a foto pra
      // gerar arte depois via /admin/gallery (ações 'gerar arte' / generate_pending).
      if (podPhotoUrl) {
        updatedMeta.pod_photo_url = podPhotoUrl;
      }
      if (savedAsBox) {
        updatedMeta.box_photo_url = savedAsBox;
      }
      const updatePayload = {
        image_status: 'generating',
        art_status: 'generating',
        reference_image_url: podPhotoUrl || null, // sobrescreve "needs_manual_photo"
        metadata: updatedMeta,
      };
      if (savedAsBox) updatePayload.box_photo_url = savedAsBox;
      await sbUpdate('drope_products', `id=eq.${productId}`, updatePayload);

      // OSSO 26 — Roda arte INLINE (await). vercel.json tem maxDuration:60s, Grok
      // costuma demorar 15-25s. Se passar de 50s, frontend deu timeout e usa
      // ?action=art_status pra polling.
      let artResult = { generated: false, art_url: null, error: null };
      try {
        await runArtGeneration(productId, ADMIN_LUCAS, 1);
        // Re-lê produto pra pegar art_url salvo
        const fresh = await sbGet('drope_products', `id=eq.${productId}&select=image_url,image_status,metadata&limit=1`);
        const f = fresh[0];
        if (f) {
          artResult.generated = !!(f.image_url || f.metadata?.pending_art_url);
          artResult.art_url = f.metadata?.pending_art_url || f.image_url;
          artResult.status = f.image_status;
        }
      } catch (e) {
        console.error('[upload_pod_photo] runArtGeneration failed:', e.message);
        artResult.error = e.message;
        // Marca como erro pra recovery via /admin
        await sbUpdate('drope_products', `id=eq.${productId}`, { image_status: 'error' });
      }

      return res.status(200).json({
        ok: true,
        productId,
        pod_photo_url: podPhotoUrl,
        art: artResult,
      });
    } catch (e) {
      console.error('[upload_pod_photo] error:', e.message, e.stack);
      return res.status(500).json({ error: e.message });
    }
  }

  // OSSO 26 — Endpoint pra frontend pollar status da arte enquanto gera.
  // GET /api/webhook?action=art_status&product_id=N
  if (req.url && req.url.indexOf('action=art_status') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
    if (req.method === 'OPTIONS') return res.status(200).end();
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) {
      // tolera token via query pra GET fácil
      const qs = (req.url || '').split('?')[1] || '';
      const tok = qs.split('&').find(p => p.startsWith('token='))?.slice(6);
      if (!tok || decodeURIComponent(tok) !== ADMIN_TOKEN) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }
    try {
      const qs = (req.url || '').split('?')[1] || '';
      const params = {};
      qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
      const productId = params.product_id;
      if (!productId) return res.status(400).json({ error: 'product_id obrigatório' });
      const rows = await sbGet('drope_products',
        `id=eq.${productId}&select=id,name,image_url,image_status,art_status,metadata,reference_image_url&limit=1`);
      const p = rows[0];
      if (!p) return res.status(404).json({ error: 'product not found' });
      const meta = p.metadata || {};
      return res.status(200).json({
        product_id: p.id,
        name: p.name,
        image_status: p.image_status,
        art_status: p.art_status,
        art_url: meta.pending_art_url || p.image_url,
        pod_photo_url: meta.pod_photo_url || p.reference_image_url,
        ready: ['awaiting_approval', 'ok'].includes(p.image_status),
        failed: p.image_status === 'error',
      });
    } catch (e) {
      console.error('[art_status] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.url && req.url.indexOf('action=skip_pod_photo') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const productId = reqBody.productId;
      if (!productId) return res.status(400).json({ error: 'productId obrigatório' });

      await sbUpdate('drope_products', `id=eq.${productId}`, { image_status: 'pending_art' });
      try { await fireBackgroundArtGeneration(productId, ADMIN_LUCAS, 1); }
      catch (e) { console.warn('[skip_pod_photo] fireArt:', e.message); }

      return res.status(200).json({ ok: true, productId });
    } catch (e) {
      console.error('[skip_pod_photo] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.url && req.url.indexOf('action=remove_pending') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const productId = reqBody.productId;
      if (!productId) return res.status(400).json({ error: 'productId obrigatório' });

      // Não deleta — marca hidden=true. Permite recovery se errar.
      await sbUpdate('drope_products', `id=eq.${productId}`, { hidden: true, image_status: 'removed' });
      return res.status(200).json({ ok: true, productId });
    } catch (e) {
      console.error('[remove_pending] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.url && req.url.indexOf('action=notify_pending_pod') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const pending = await sbGet('drope_products', `image_status=eq.pending_pod_photo&select=id,name,barcode,metadata&order=created_at.desc&limit=200`);
      if (!pending || pending.length === 0) {
        return res.status(200).json({ ok: true, count: 0, message: 'nenhum pendente' });
      }
      const host = process.env.VERCEL_URL || 'drope-app.vercel.app';
      const link = `https://${host}/api/webhook?action=pending_pod_photos&token=${encodeURIComponent(ADMIN_TOKEN)}`;
      const items = pending.slice(0, 8).map(p => {
        const m = p.metadata || {};
        const sub = [m.brand, m.model, m.flavor_pt || m.flavor_en].filter(Boolean).join(' ');
        const bc = p.barcode ? ` ✦ ${p.barcode}` : '';
        return `• *${sub || p.name}*${bc}`;
      }).join('\n');
      const more = pending.length > 8 ? `\n... e mais ${pending.length - 8}` : '';
      const msg = `📸 *${pending.length} pod${pending.length === 1 ? '' : 's'} esperando foto*\n\nabre as caixas, tira foto do device e envia.\n\n${items}${more}\n\n👉 abrir tela:\n${link}`;

      await sendText(ADMIN_LUCAS, msg, {});
      return res.status(200).json({ ok: true, count: pending.length });
    } catch (e) {
      console.error('[notify_pending_pod] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.url && req.url.indexOf('action=generate_all_pending_pod') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const pending = await sbGet('drope_products', `image_status=eq.pending_pod_photo&select=id&limit=100`);
      if (!pending || pending.length === 0) return res.status(200).json({ ok: true, count: 0 });
      let count = 0;
      for (const p of pending) {
        try {
          await sbUpdate('drope_products', `id=eq.${p.id}`, { image_status: 'pending_art' });
          await fireBackgroundArtGeneration(p.id, ADMIN_LUCAS, 1);
          count++;
        } catch (e) { console.warn('[generate_all_pending_pod] item failed:', p.id, e.message); }
      }
      return res.status(200).json({ ok: true, count });
    } catch (e) {
      console.error('[generate_all_pending_pod] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== ROTAS PIPELINE DE IMAGEM (sessão MEKA 01/05) — busca + revisão + arte em batch =====
  // GET  /api/webhook?action=pending_references&token=ADMIN_TOKEN  → HTML lista de pendentes
  // POST /api/webhook?action=approve_reference                     → aprova ref (URL ou foto base64)
  // POST /api/webhook?action=skip_reference                        → pula refs, gera só com dados
  // POST /api/webhook?action=generate_arts_batch                   → dispara arte de todos approved
  if (req.url && req.url.indexOf('action=pending_references') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    try {
      const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
      const params = {};
      qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
      if (!ADMIN_TOKEN || params.token !== ADMIN_TOKEN) return res.status(401).send('unauthorized');

      const pending = await sbGet('drope_products',
        `art_status=in.(pending_review,needs_manual_photo,reference_approved)&order=created_at.desc&limit=200`);
      const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const cards = (pending || []).map(p => {
        const m = p.metadata || {};
        const subtitle = [m.brand, m.model, m.flavor_pt || m.flavor_en].filter(Boolean).join(' ✦ ');
        const refs = Array.isArray(p.reference_candidates) ? p.reference_candidates : [];
        const approved = !!p.reference_image_url;
        const refsHtml = refs.length === 0
          ? '<div class="empty-refs">⚠️ nenhuma referência boa encontrada na internet</div>'
          : refs.map((r, i) => `
            <label class="ref-card${approved && p.reference_image_url === r.url ? ' selected' : ''}">
              <input type="radio" name="ref-${p.id}" value="${esc(r.url)}" data-product-id="${p.id}" ${approved && p.reference_image_url === r.url ? 'checked' : ''} />
              <img src="${esc(r.url)}" loading="lazy" alt="ref ${i+1}" />
              <span class="score">${typeof r.combined_score === 'number' ? '🎯' + r.combined_score : '⭐' + (r.quality_score || 0)}</span>
            </label>`).join('');
        return `
        <div class="card" data-id="${p.id}" data-status="${esc(p.art_status)}">
          <div class="hd">
            <div class="name">${esc(p.name)}</div>
            <div class="sub">${esc(subtitle)} ${p.barcode ? '✦ '+esc(p.barcode) : ''}</div>
            <div class="status status-${esc(p.art_status)}">${esc(p.art_status)}</div>
          </div>
          <div class="grid">
            <div class="col">
              <div class="lbl">📦 sua foto da caixa</div>
              ${p.box_photo_url ? `<a href="${esc(p.box_photo_url)}" target="_blank"><img class="box-photo" src="${esc(p.box_photo_url)}" loading="lazy" alt="caixa" /></a>` : '<div class="no-photo">sem foto</div>'}
            </div>
            <div class="col">
              <div class="lbl">🔎 referências (${refs.length})</div>
              <div class="refs">${refsHtml}</div>
            </div>
          </div>
          <div class="actions">
            <button type="button" class="btn primary" onclick="approveSelected(${p.id})">✅ aprovar selecionada</button>
            <label class="btn">
              📸 nenhuma serve — foto manual
              <input type="file" accept="image/*" capture="environment" onchange="onManualPhoto(event, ${p.id})" hidden />
            </label>
            <button type="button" class="btn ghost" onclick="skipRef(${p.id})">⏭️ pular — gerar só com dados</button>
          </div>
          <div class="msg" id="msg-${p.id}"></div>
        </div>`;
      }).join('');

      const token = params.token;
      const totalApproved = (pending || []).filter(p => p.art_status === 'reference_approved').length;
      const html = `<!DOCTYPE html><html lang="pt-BR" translate="no"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0A0A14">
<meta name="google" content="notranslate"><title>Referências ✦ Drope</title>
<style>
  :root{--bg:#0A0A14;--bg2:#14141F;--fg:#EAEAF2;--dim:#8A8AA3;--pink:#FF2D6F;--lime:#D4FF2E;--violet:#9D4EDD;--amber:#FFB800;--b:rgba(255,255,255,0.08)}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif}
  header{padding:14px 16px 10px;border-bottom:1px solid var(--b);position:sticky;top:0;background:var(--bg);z-index:5;display:flex;align-items:center;justify-content:space-between}
  h1{margin:0;font-size:18px}h1 em{color:var(--lime);font-style:normal}
  .count{font-size:12px;color:var(--dim);margin-top:2px}
  .topbtn{padding:8px 12px;border-radius:10px;background:var(--bg2);border:1px solid var(--b);color:var(--fg);font-size:13px;text-decoration:none;display:inline-block;font-family:inherit;cursor:pointer}
  .topbtn.primary{background:var(--lime);color:#000;border-color:var(--lime);font-weight:700}
  .grid-wrap{padding:14px;display:grid;grid-template-columns:1fr;gap:14px;max-width:780px;margin:0 auto;padding-bottom:120px}
  .card{background:var(--bg2);border:1px solid var(--b);border-radius:14px;overflow:hidden}
  .hd{padding:12px 14px;border-bottom:1px solid var(--b);position:relative}
  .name{font-weight:700;font-size:15px;margin-bottom:2px}
  .sub{font-size:12px;color:var(--dim)}
  .status{position:absolute;top:12px;right:14px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:999px;background:var(--bg);border:1px solid var(--b);color:var(--dim)}
  .status-pending_review{color:var(--lime);border-color:var(--lime)}
  .status-needs_manual_photo{color:var(--amber);border-color:var(--amber)}
  .status-reference_approved{color:var(--violet);border-color:var(--violet)}
  .grid{display:grid;grid-template-columns:1fr 2fr;gap:10px;padding:12px}
  @media(max-width:560px){.grid{grid-template-columns:1fr}}
  .lbl{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
  .box-photo{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:#000}
  .no-photo{display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;color:var(--dim);background:#000;border-radius:8px;font-size:12px}
  .refs{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
  .ref-card{position:relative;display:block;cursor:pointer;border-radius:8px;overflow:hidden;border:2px solid var(--b);background:#000;aspect-ratio:1}
  .ref-card.selected{border-color:var(--lime);box-shadow:0 0 0 2px rgba(212,255,46,.3)}
  .ref-card input{position:absolute;opacity:0;pointer-events:none}
  .ref-card img{width:100%;height:100%;object-fit:cover;display:block}
  .ref-card .score{position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,.7);color:var(--lime);padding:2px 6px;border-radius:6px;font-size:10px;font-weight:700}
  .empty-refs{padding:18px;background:rgba(255,184,0,.08);border:1px solid rgba(255,184,0,.3);border-radius:8px;font-size:12px;color:var(--amber)}
  .actions{padding:10px 14px;display:grid;grid-template-columns:1fr;gap:8px;border-top:1px solid var(--b);background:rgba(255,255,255,.02)}
  .btn{padding:11px 12px;border-radius:10px;border:1px solid var(--b);background:var(--bg2);color:var(--fg);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center;display:block;touch-action:manipulation}
  .btn.primary{background:var(--lime);color:#000;border-color:var(--lime)}
  .btn.ghost{background:transparent;color:var(--dim)}
  .btn:active{transform:scale(.98)}
  .msg{padding:0 14px 12px;font-size:12px;color:var(--dim);min-height:0}
  .msg.ok{color:var(--lime)}.msg.err{color:var(--pink)}
  .empty{padding:60px 20px;text-align:center;color:var(--dim)}
  .actbar{position:fixed;bottom:0;left:0;right:0;padding:12px;background:linear-gradient(0deg,var(--bg) 0%,rgba(10,10,20,.6) 100%);display:flex;gap:10px;justify-content:center;border-top:1px solid var(--b);backdrop-filter:blur(8px)}
  .spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(212,255,46,.2);border-top-color:var(--lime);border-radius:50%;animation:s .8s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body>
<header>
  <div><h1><em>🖼️</em> referências pendentes</h1>
  <div class="count">${(pending || []).length} pod${(pending || []).length === 1 ? '' : 's'} ✦ ${totalApproved} aprovado${totalApproved === 1 ? '' : 's'}</div></div>
  <a class="topbtn" href="/#admin-dash">voltar</a>
</header>
<div class="grid-wrap">${cards || '<div class="empty">✅ nenhuma referência pendente.<br><br>cadastra produtos pelo /receber.</div>'}</div>
${(pending || []).length > 0 ? `<div class="actbar">
  <button type="button" class="topbtn primary" onclick="generateAll()">🎬 gerar arte de todos aprovados (${totalApproved})</button>
</div>` : ''}
<script>
const TOKEN = ${JSON.stringify(token)};
function setMsg(id, html, cls){const el=document.getElementById('msg-'+id);if(!el)return;el.className='msg'+(cls?' '+cls:'');el.innerHTML=html||''}
// Atualiza visual da seleção quando user clica num radio
document.addEventListener('change', (e) => {
  if (e.target.type === 'radio' && e.target.name && e.target.name.indexOf('ref-') === 0) {
    const card = e.target.closest('.card');
    if (!card) return;
    card.querySelectorAll('.ref-card').forEach(c => c.classList.remove('selected'));
    const lbl = e.target.closest('.ref-card');
    if (lbl) lbl.classList.add('selected');
  }
});
function fileToB64(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f)})}
async function approveSelected(id){
  const card = document.querySelector('.card[data-id="'+id+'"]');
  if (!card) return;
  const radio = card.querySelector('input[type=radio]:checked');
  if (!radio) { setMsg(id, 'seleciona uma referência primeiro', 'err'); return; }
  setMsg(id, '<span class="spin"></span>aprovando…');
  try {
    const r = await fetch('/api/webhook?action=approve_reference', {
      method: 'POST', headers: {'Content-Type':'application/json','x-admin-token':TOKEN},
      body: JSON.stringify({ productId: id, referenceUrl: radio.value }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http '+r.status));
    setMsg(id, '✅ aprovada — pronta pra gerar arte', 'ok');
    setTimeout(() => location.reload(), 800);
  } catch(e) { setMsg(id, '⚠️ erro: '+e.message, 'err'); }
}
async function onManualPhoto(ev, id){
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  setMsg(id, '<span class="spin"></span>enviando foto manual…');
  try {
    const b64 = await fileToB64(f);
    const r = await fetch('/api/webhook?action=approve_reference', {
      method: 'POST', headers: {'Content-Type':'application/json','x-admin-token':TOKEN},
      body: JSON.stringify({ productId: id, manualPhotoBase64: b64 }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http '+r.status));
    setMsg(id, '✅ foto aprovada', 'ok');
    setTimeout(() => location.reload(), 800);
  } catch(e) { setMsg(id, '⚠️ erro: '+e.message, 'err'); }
}
async function skipRef(id){
  if (!confirm('gerar arte SÓ com dados textuais (sem referência visual)?\\nO device pode ficar genérico.')) return;
  setMsg(id, '<span class="spin"></span>marcando pra gerar…');
  try {
    const r = await fetch('/api/webhook?action=skip_reference', {
      method: 'POST', headers: {'Content-Type':'application/json','x-admin-token':TOKEN},
      body: JSON.stringify({ productId: id }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('http '+r.status));
    setMsg(id, '✅ marcado', 'ok');
    setTimeout(() => location.reload(), 800);
  } catch(e) { setMsg(id, '⚠️ erro: '+e.message, 'err'); }
}
async function generateAll(){
  if (!confirm('gerar arte de TODOS os aprovados? Pode levar ~30s por pod.')) return;
  try {
    const r = await fetch('/api/webhook?action=generate_arts_batch', {
      method: 'POST', headers: {'Content-Type':'application/json','x-admin-token':TOKEN},
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('http '+r.status));
    alert('✅ disparado pra ' + (data.dispatched || 0) + ' pods. recarregando…');
    location.reload();
  } catch(e) { alert('⚠️ erro: '+e.message); }
}
</script></body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (e) {
      console.error('[pending_references] error:', e.message);
      return res.status(500).send('error: ' + e.message);
    }
  }

  if (req.url && req.url.indexOf('action=approve_reference') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const productId = reqBody.productId;
      const referenceUrl = reqBody.referenceUrl;
      const manualPhotoBase64 = reqBody.manualPhotoBase64;
      if (!productId) return res.status(400).json({ error: 'productId obrigatório' });
      if (!referenceUrl && !manualPhotoBase64) return res.status(400).json({ error: 'referenceUrl ou manualPhotoBase64 obrigatório' });

      let finalUrl = referenceUrl;

      // Foto manual: otimiza com sharp e faz upload pro Storage
      if (manualPhotoBase64) {
        let sharp;
        try { sharp = require('sharp'); } catch (e) { sharp = null; }
        const cleanB64 = manualPhotoBase64.replace(/^data:image\/\w+;base64,/, '');
        let buf = Buffer.from(cleanB64, 'base64');
        if (sharp) {
          try {
            buf = await sharp(buf)
              .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
              .sharpen({ sigma: 1.0 })
              .normalize()
              .jpeg({ quality: 90 })
              .toBuffer();
          } catch (e) { console.warn('[approve_reference] sharp falhou, usa raw:', e.message); }
        }
        const path = `pod-references/pod_${productId}_ref.jpg`;
        const upR = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
          body: buf,
        });
        if (!upR.ok) {
          const t = await upR.text();
          return res.status(500).json({ error: 'upload manual falhou', detail: t });
        }
        finalUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
      }

      await sbUpdate('drope_products', `id=eq.${productId}`, {
        reference_image_url: finalUrl,
        art_status: 'generating',
        image_status: 'pending_art',
      });
      fireBackgroundArtGeneration(productId, ADMIN_LUCAS, 1).catch(e => console.warn('[approve_reference] fireArt:', e.message));
      return res.status(200).json({ ok: true, productId, reference_image_url: finalUrl });
    } catch (e) {
      console.error('[approve_reference] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.url && req.url.indexOf('action=skip_reference') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const productId = reqBody.productId;
      if (!productId) return res.status(400).json({ error: 'productId obrigatório' });
      // Marca como reference_approved sem reference_image_url — runArtGeneration cai no path normal
      await sbUpdate('drope_products', `id=eq.${productId}`, {
        art_status: 'reference_approved',
        reference_image_url: null,
        image_status: 'pending_art',
      });
      // OSSO 27 — dispara geração imediata (antes só marcava status, ficava esperando cron)
      fireBackgroundArtGeneration(productId, ADMIN_LUCAS, 1).catch(e => console.warn('[skip_reference] fireArt:', e.message));
      return res.status(200).json({ ok: true, productId });
    } catch (e) {
      console.error('[skip_reference] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // OSSO 27 — Refazer busca de referências (Serper Google) quando a primeira
  // tentativa falhou (`needs_manual_photo`) ou admin quer outra rodada.
  // OSSO 28 fix: SÍNCRONO (await). Antes era fire-and-forget e Vercel matava
  // a invocação antes da busca terminar. Frontend espera ~30-50s pela resposta.
  if (req.url && req.url.indexOf('action=retry_search') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
    if (req.method === 'OPTIONS') return res.status(200).end();
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    const qsAuth = (() => {
      const q = (req.url || '').split('?')[1] || '';
      const p = q.split('&').find(x => x.startsWith('token='));
      return p ? decodeURIComponent(p.slice(6)) : '';
    })();
    if (!ADMIN_TOKEN || (provided !== ADMIN_TOKEN && qsAuth !== ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorized' });

    try {
      let productId;
      if (req.method === 'POST') {
        const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        productId = reqBody.productId;
      } else {
        const q = (req.url || '').split('?')[1] || '';
        const p = q.split('&').find(x => x.startsWith('productId=') || x.startsWith('product_id='));
        productId = p ? decodeURIComponent(p.split('=')[1]) : null;
      }
      if (!productId) return res.status(400).json({ error: 'productId obrigatório' });
      const rows = await sbGet('drope_products',
        `id=eq.${productId}&select=id,metadata&limit=1`);
      const prod = rows[0];
      if (!prod) return res.status(404).json({ error: 'produto não encontrado' });
      const m = prod.metadata || {};
      // Reset status pra pending_reference
      await sbUpdate('drope_products', `id=eq.${productId}`, {
        art_status: 'pending_reference',
        reference_candidates: [],
      });
      // OSSO 28 — AWAIT: searchProductReferences pode demorar 20-40s (Serper +
      // download de até 8 imagens + sharp + upload Storage). Frontend lida.
      const candidates = await searchProductReferences(productId, m.brand || '', m.model || '', m.flavor_en || m.flavor_pt || '');
      return res.status(200).json({
        ok: true,
        productId,
        candidates_count: Array.isArray(candidates) ? candidates.length : 0,
      });
    } catch (e) {
      console.error('[retry_search] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.url && req.url.indexOf('action=generate_arts_batch') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const approved = await sbGet('drope_products', `art_status=eq.reference_approved&select=id,name&limit=50`);
      if (!approved || approved.length === 0) return res.status(200).json({ ok: true, dispatched: 0 });
      let dispatched = 0;
      for (const p of approved) {
        try {
          // Marca como generating + dispara fireBackgroundArtGeneration (que reusa runArtGeneration)
          await sbUpdate('drope_products', `id=eq.${p.id}`, { art_status: 'generating', image_status: 'pending_art' });
          await fireBackgroundArtGeneration(p.id, ADMIN_LUCAS, 1);
          dispatched++;
        } catch (e) { console.warn('[batch_arts] item failed:', p.id, e.message); }
      }
      return res.status(200).json({ ok: true, dispatched });
    } catch (e) {
      console.error('[generate_arts_batch] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== MASS KICKOFF SEARCH (08/05/2026) =====
  // Pega todos com art_status='pending_reference' + image_url null + sem refs (travados)
  // e dispara busca Serper em background pra cada um, fire-and-forget.
  // Useful pra recuperar de bug onde batch_photo flow esqueceu de disparar searchProductReferences.
  // POST /api/webhook?action=mass_kickoff_search
  // header x-admin-token: ADMIN_TOKEN
  // returns: { ok, dispatched, products: [...] }
  if (req.url && req.url.indexOf('action=mass_kickoff_search') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      // Pega travados: pending_reference + image_url null + sem refs (até 50)
      const stuck = await sbGet('drope_products',
        `art_status=eq.pending_reference&image_url=is.null&select=id,name,metadata,box_photo_url&limit=50`);
      const filtered = (stuck || []).filter(p => {
        const refs = Array.isArray(p.reference_candidates) ? p.reference_candidates : [];
        return refs.length === 0;
      });
      if (filtered.length === 0) return res.status(200).json({ ok: true, dispatched: 0, products: [] });

      // Dispara fire-and-forget pra cada um — bate no próprio /api/webhook?action=retry_search
      // Cada call inicia uma invocação serverless própria. Usamos AbortController com 1s
      // timeout pra liberar essa invocação rápido — a tarefa real continua na invocação child.
      const baseUrl = (req.headers['x-forwarded-host'] && req.headers['x-forwarded-proto'])
        ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
        : `https://${req.headers.host || 'drope-app.vercel.app'}`;
      let dispatched = 0;
      const products = [];
      for (const p of filtered) {
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 1500);
          fetch(`${baseUrl}/api/webhook?action=retry_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
            body: JSON.stringify({ productId: p.id }),
            signal: ctrl.signal,
          }).catch(() => {}).finally(() => clearTimeout(tid));
          dispatched++;
          products.push({ id: p.id, name: p.name });
        } catch (e) {
          console.warn('[mass_kickoff_search] dispatch err for', p.id, e.message);
        }
      }
      return res.status(200).json({
        ok: true,
        dispatched,
        total_stuck: filtered.length,
        message: `${dispatched} produtos disparados pra busca de refs (~30s cada). Recarrega em 1min pra ver resultado.`,
        products,
      });
    } catch (e) {
      console.error('[mass_kickoff_search] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== AUTO SEARCH EAN (08/05/2026) =====
  // Busca EAN/barcode do produto no Google via Serper.
  // POST /api/webhook?action=auto_search_ean
  // body { productId } | header x-admin-token
  // returns { ok, ean, source_snippet, candidates: [...] }
  if (req.url && req.url.indexOf('action=auto_search_ean') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const productId = reqBody.productId;
      if (!productId) return res.status(400).json({ error: 'productId obrigatório' });

      const rows = await sbGet('drope_products', `id=eq.${encodeURIComponent(productId)}&select=id,name,metadata&limit=1`);
      const prod = rows && rows[0];
      if (!prod) return res.status(404).json({ error: 'produto não encontrado' });
      const m = prod.metadata || {};
      const brand = m.brand || '';
      const model = m.model || '';
      const flavor = m.flavor_pt || m.flavor_en || m.flavor || '';
      if (!brand) return res.status(400).json({ error: 'produto sem brand no metadata' });

      const isValidEan = (ean) => {
        if (!/^\d{12,13}$/.test(ean)) return false;
        if (/^(19|20)\d{2}$/.test(ean)) return false;
        if (/^0{8,}/.test(ean)) return false;
        if (/^(\d)\1{10,}$/.test(ean)) return false;
        return true;
      };

      const tries = []; // { source, ean, confidence, snippet, source_url, ms }

      // ===== TIER 1: Open Food Facts (grátis, sem chave) =====
      const offT0 = Date.now();
      try {
        const offQuery = encodeURIComponent(`${brand} ${model} ${flavor}`.trim());
        const offUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${offQuery}&search_simple=1&action=process&json=1&page_size=10`;
        const offR = await fetch(offUrl, { signal: AbortSignal.timeout(6000) });
        if (offR.ok) {
          const offData = await offR.json();
          const products = (offData.products || []).filter(p => p.code && isValidEan(p.code));
          if (products.length > 0) {
            tries.push({
              source: 'open_food_facts',
              ean: products[0].code,
              confidence: products.length,
              snippet: products[0].product_name || products[0].generic_name || '',
              source_url: `https://world.openfoodfacts.org/product/${products[0].code}`,
              ms: Date.now() - offT0,
            });
          }
        }
      } catch (e) { console.warn('[auto_search_ean] OFF err:', e.message); }

      // ===== TIER 2: UPCDatabase pesquisa por nome (grátis sem chave em alguns endpoints) =====
      const upcT0 = Date.now();
      try {
        const upcQuery = encodeURIComponent(`${brand} ${model} ${flavor}`.trim());
        // upcitemdb.com tem endpoint trial sem chave (1 req/10s, mas pra teste serve)
        const upcUrl = `https://api.upcitemdb.com/prod/trial/search?s=${upcQuery}&match_mode=0&type=product`;
        const upcR = await fetch(upcUrl, { signal: AbortSignal.timeout(6000) });
        if (upcR.ok) {
          const upcData = await upcR.json();
          const items = (upcData.items || []).filter(it => it.ean && isValidEan(it.ean));
          if (items.length > 0) {
            tries.push({
              source: 'upcitemdb',
              ean: items[0].ean,
              confidence: items.length,
              snippet: items[0].title || '',
              source_url: items[0].images && items[0].images[0] ? items[0].images[0] : '',
              ms: Date.now() - upcT0,
            });
          }
        }
      } catch (e) { console.warn('[auto_search_ean] UPC err:', e.message); }

      // ===== TIER 3: Serper Google fallback =====
      if (SERPER_API_KEY && tries.length === 0) {
        const serperT0 = Date.now();
        const queries = [
          `"${brand} ${model} ${flavor}" EAN barcode`,
          `"${brand}" "${model}" "${flavor}" código de barras`,
          `${brand} ${model} ${flavor} barcode`,
        ];
        const candidates = [];
        for (const q of queries) {
          const data = await _serperSearch(q, 'search', 8);
          if (!data) continue;
          const organic = data.organic || [];
          for (const o of organic) {
            const text = `${o.title || ''}. ${o.snippet || ''}`;
            const norm = text.replace(/[\s\-\.]/g, '');
            const matches = norm.match(/\b\d{12,13}\b/g) || [];
            for (const ean of matches) {
              if (!isValidEan(ean)) continue;
              candidates.push({ ean, snippet: text.slice(0, 150), source_url: o.link || '' });
            }
          }
          if (candidates.length > 0) break;
        }
        const counts = {};
        for (const c of candidates) counts[c.ean] = (counts[c.ean] || 0) + 1;
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (sorted[0]) {
          const bestEan = sorted[0][0];
          const bestEntry = candidates.find(c => c.ean === bestEan);
          tries.push({
            source: 'serper_google',
            ean: bestEan,
            confidence: sorted[0][1],
            snippet: bestEntry ? bestEntry.snippet : '',
            source_url: bestEntry ? bestEntry.source_url : '',
            ms: Date.now() - serperT0,
          });
        }
      }

      // Pega a primeira fonte que achou (cascade ordem importa)
      const winner = tries[0] || null;
      return res.status(200).json({
        ok: true,
        ean: winner ? winner.ean : null,
        source: winner ? winner.source : null,
        confidence: winner ? winner.confidence : 0,
        source_snippet: winner ? winner.snippet : null,
        source_url: winner ? winner.source_url : null,
        all_tries: tries, // pra debug — mostra quem tentou e quem achou
        product: { id: prod.id, name: prod.name, brand, model, flavor },
      });
    } catch (e) {
      console.error('[auto_search_ean] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== CROSS EAN BATCH (08/05/2026) — Andrade pediu cruzamento foto + online =====
  // Recebe N fotos de codigos de barras + array de productIds (ou pega pendentes auto).
  // Pra cada foto, Vision le o EAN. Pra cada produto, dispara cascade online em paralelo.
  // Cruza: EAN da foto bate com candidato online de algum produto?
  //   - SIM unico match → linka automatico
  //   - SIM multiplos → conflito (Andrade decide)
  //   - NAO → orfao (Andrade clica produto pra linkar)
  // POST /api/webhook?action=cross_ean_batch
  // body: { photos: [{ name, base64 }], productIds?: [num] }
  // header x-admin-token
  if (req.url && req.url.indexOf('action=cross_ean_batch') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const photos = Array.isArray(reqBody.photos) ? reqBody.photos : [];
      if (photos.length === 0) return res.status(400).json({ error: 'fotos vazias' });
      if (photos.length > 60) return res.status(400).json({ error: 'maximo 60 fotos por lote' });

      // 1) Pega produtos pendentes de EAN (image_status=ok + sem barcode)
      let pendingProducts;
      if (Array.isArray(reqBody.productIds) && reqBody.productIds.length > 0) {
        const idsList = reqBody.productIds.map(x => parseInt(x)).filter(Boolean).join(',');
        pendingProducts = await sbGet('drope_products',
          `id=in.(${idsList})&select=id,name,barcode,metadata`);
      } else {
        pendingProducts = await sbGet('drope_products',
          `image_status=eq.ok&image_url=not.is.null&or=(barcode.is.null,barcode.eq.)&select=id,name,barcode,metadata&limit=200`);
      }
      pendingProducts = pendingProducts || [];

      // 2) Em paralelo: lê EAN de cada foto + busca candidatos online de cada produto
      const photoReadsP = photos.map(async (ph, idx) => {
        try {
          const result = await _visionReadEan(ph.base64);
          return { idx, name: ph.name || ('foto_' + idx), result };
        } catch (e) {
          return { idx, name: ph.name || ('foto_' + idx), result: null, error: e.message };
        }
      });

      const candidatesP = pendingProducts.map(async (p) => {
        const m = p.metadata || {};
        const brand = m.brand || '', model = m.model || '', flavor = m.flavor_pt || m.flavor_en || m.flavor || '';
        const cands = await _collectEanCandidates(brand, model, flavor);
        return { productId: p.id, name: p.name, brand, model, flavor, candidates: cands };
      });

      const [photoReads, productCandidates] = await Promise.all([
        Promise.all(photoReadsP),
        Promise.all(candidatesP),
      ]);

      // 3) Cruza: pra cada EAN lido, em qual produto bate?
      // Index reverso: ean → array de productIds que tem esse ean nos candidates
      const eanToProducts = {};
      for (const pc of productCandidates) {
        for (const cand of pc.candidates) {
          if (!eanToProducts[cand.ean]) eanToProducts[cand.ean] = [];
          eanToProducts[cand.ean].push({
            productId: pc.productId, name: pc.name, source: cand.source,
          });
        }
      }

      // 4) Pra cada foto, gera resultado
      const results = [];
      const linksToApply = []; // { productId, barcode } pra salvar
      const usedProductIds = new Set();

      for (const pr of photoReads) {
        const r = { foto: pr.name, foto_idx: pr.idx };
        if (!pr.result || !pr.result.ean) {
          r.status = 'unreadable';
          r.detail = pr.result ? (pr.result.alertas || []).join('; ') : 'vision falhou';
          results.push(r);
          continue;
        }
        r.ean_lido = pr.result.ean;
        r.confidence_vision = pr.result.confidence;
        const matches = eanToProducts[pr.result.ean] || [];
        if (matches.length === 0) {
          r.status = 'orphan';
          r.detail = 'EAN não encontrado nos candidatos online de nenhum produto pendente';
        } else if (matches.length === 1) {
          const productId = matches[0].productId;
          if (usedProductIds.has(productId)) {
            r.status = 'duplicate';
            r.detail = 'produto já linkado por outra foto deste lote';
          } else {
            r.status = 'matched';
            r.product = matches[0];
            r.detail = 'cruzou com cascade online (' + matches[0].source + ')';
            linksToApply.push({ productId, barcode: pr.result.ean });
            usedProductIds.add(productId);
          }
        } else {
          r.status = 'conflict';
          r.matches = matches;
          r.detail = 'EAN aparece em ' + matches.length + ' produtos online — escolhe manual';
        }
        results.push(r);
      }

      // 5) Aplica os links (em paralelo)
      let linked = 0;
      await Promise.all(linksToApply.map(async (l) => {
        try {
          await sbUpdate('drope_products', `id=eq.${encodeURIComponent(l.productId)}`, {
            barcode: l.barcode,
            updated_at: new Date().toISOString(),
          });
          linked++;
        } catch (e) { console.warn('[cross_ean] link err:', l.productId, e.message); }
      }));

      // 6) Sumario
      const summary = {
        total_photos: photos.length,
        total_pending_products: pendingProducts.length,
        ean_read_ok: photoReads.filter(r => r.result && r.result.ean).length,
        ean_unreadable: results.filter(r => r.status === 'unreadable').length,
        matched: results.filter(r => r.status === 'matched').length,
        orphan: results.filter(r => r.status === 'orphan').length,
        conflict: results.filter(r => r.status === 'conflict').length,
        duplicate: results.filter(r => r.status === 'duplicate').length,
        linked,
      };
      return res.status(200).json({
        ok: true,
        summary,
        results,
        unmatched_products: pendingProducts.filter(p => !usedProductIds.has(p.id)).map(p => ({
          id: p.id, name: p.name,
          candidates: (productCandidates.find(pc => pc.productId === p.id) || {}).candidates || [],
        })),
      });
    } catch (e) {
      console.error('[cross_ean_batch] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== LINK ORPHAN EAN (08/05/2026) =====
  // Andrade clicou num produto pra linkar EAN órfão (que não bateu cruzamento online)
  // POST /api/webhook?action=link_orphan_ean
  // body: { productId, barcode }
  if (req.url && req.url.indexOf('action=link_orphan_ean') >= 0) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { productId, barcode } = reqBody;
      if (!productId || !barcode) return res.status(400).json({ error: 'productId e barcode obrigatórios' });
      const cleanBc = String(barcode).replace(/\D/g, '');
      if (!/^\d{8,13}$/.test(cleanBc)) return res.status(400).json({ error: 'EAN inválido' });
      await sbUpdate('drope_products', `id=eq.${encodeURIComponent(productId)}`, {
        barcode: cleanBc, updated_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true, productId, barcode: cleanBc });
    } catch (e) {
      console.error('[link_orphan_ean] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== SAVE SPECS (08/05/2026) =====
  // Salva preço + EAN do produto direto na esteira FASE 4.
  // POST /api/webhook?action=save_specs
  // body { productId, price_cents, barcode } | header x-admin-token
  if (req.url && req.url.indexOf('action=save_specs') >= 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const provided = (req.headers && req.headers['x-admin-token']) || '';
    if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    try {
      const reqBody = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { productId, price_cents, barcode } = reqBody;
      if (!productId) return res.status(400).json({ error: 'productId obrigatório' });

      const update = {};
      if (typeof price_cents === 'number' && price_cents > 0) {
        update.price_cents = price_cents;
      }
      if (typeof barcode === 'string' && barcode.trim()) {
        update.barcode = barcode.trim().replace(/\D/g, ''); // só dígitos
      }
      // Se finalizou ambos, descondena o produto (hidden=false pra aparecer no app)
      if (update.price_cents && update.barcode) {
        update.hidden = false;
        update.status = 'active';
      }
      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error: 'nada pra atualizar' });
      }
      update.updated_at = new Date().toISOString();
      await sbUpdate('drope_products', `id=eq.${encodeURIComponent(productId)}`, update);
      return res.status(200).json({
        ok: true,
        productId,
        updated: Object.keys(update),
        finalized: !!(update.price_cents && update.barcode),
        message: (update.price_cents && update.barcode)
          ? '✓ produto finalizado e visível no app'
          : '✓ salvo (faltam outros campos)',
      });
    } catch (e) {
      console.error('[save_specs] error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== MERCADO PAGO PIX (05/05/2026) =====
  // action=mp_create_pix — POST: cria pagamento Pix via API do Mercado Pago
  // action=mp_check_pix  — GET: checa status de pagamento existente (polling)
  // action=mp_webhook    — POST: recebe notificação do MP quando pagamento é aprovado
  if (req.url && req.url.indexOf('action=mp_create_pix') >= 0) {
    return await handleMPCreatePix(req, res);
  }
  if (req.url && req.url.indexOf('action=mp_check_pix') >= 0) {
    return await handleMPCheckPix(req, res);
  }
  if (req.url && req.url.indexOf('action=mp_webhook') >= 0) {
    return await handleMPWebhook(req, res);
  }

  // ===== INFINITEPAY (08/05/2026) — migrado de api/infinitepay-*.js =====
  // Vercel Hobby plan limita 12 funções; consolidamos no webhook.
  // action=infinitepay_checkout — POST: gera link checkout
  // action=infinitepay_webhook — POST: recebe notificação de pagamento
  if (req.url && req.url.indexOf('action=infinitepay_checkout') >= 0) {
    return await handleInfinitePayCheckout(req, res);
  }
  if (req.url && req.url.indexOf('action=infinitepay_webhook') >= 0) {
    return await handleInfinitePayWebhook(req, res);
  }

  // ===== ROTAS PÓS-CATÁLOGO (30/04/2026) =====
  // health_check: público, monitoramento. Os outros: auth via CRON_TOKEN/ADMIN_TOKEN.
  if (req.url && req.url.indexOf('action=health_check') >= 0) {
    return await handleHealthCheck(req, res);
  }
  if (req.url && req.url.indexOf('action=debug_claude') >= 0) {
    return await handleDebugClaude(req, res);
  }
  if (req.url && req.url.indexOf('action=test_claude') >= 0) {
    return await handleTestClaude(req, res);
  }
  if (req.url && req.url.indexOf('action=run_followups') >= 0) {
    // OSSO 23 — withRetry: 1 retry + log + alerta WhatsApp em falha dupla
    return await withRetry('run_followups', () => handleRunFollowups(req, res));
  }
  if (req.url && req.url.indexOf('action=run_reorder') >= 0) {
    return await withRetry('run_reorder', () => handleRunReorder(req, res));
  }
  if (req.url && req.url.indexOf('action=daily_dashboard') >= 0) {
    return await withRetry('daily_dashboard', () => handleDailyDashboard(req, res));
  }
  if (req.url && req.url.indexOf('action=friday_briefing') >= 0) {
    return await withRetry('friday_briefing', () => handleFridayBriefing(req, res));
  }
  if (req.url && req.url.indexOf('action=briefing_reminder') >= 0) {
    return await withRetry('briefing_reminder', () => handleBriefingReminder(req, res));
  }
  if (req.url && req.url.indexOf('action=saturday_dispatch') >= 0) {
    return await withRetry('saturday_dispatch', () => handleSaturdayDispatch(req, res));
  }
  if (req.url && req.url.indexOf('action=admin_upload_reference') >= 0) {
    return await handleAdminUploadReference(req, res);
  }

  // ===== ROTA ADMIN: cadastro em lote de produtos =====
  // POST /api/webhook?action=batch_create&admin_token=XXX
  // Body: JSON array de produtos [{name, slug, description, price, category, puffs, metadata}]
  if (req.url && req.url.indexOf('action=batch_create') >= 0) {
    const urlP = new URL(req.url, 'http://localhost');
    const tk = urlP.searchParams.get('admin_token');
    if (tk !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'use POST with JSON body' });
    try {
      const products = req.body;
      if (!Array.isArray(products) || !products.length) {
        return res.status(400).json({ error: 'body must be a non-empty JSON array' });
      }
      const results = [];
      for (const p of products) {
        const row = await sbInsert('drope_products', {
          name: p.name,
          slug: p.slug,
          price_cents: Math.round((p.price || 0) * 100),
          qty_available: 1,
          hidden: true,
          category: p.category || 'fruity',
          image_status: 'pending_art',
          created_via: 'manual',
          metadata: { ...(p.metadata || {}), description: p.description || '' },
        });
        if (row && row.id) {
          results.push({ id: row.id, name: p.name, status: 'created' });
        } else {
          results.push({ name: p.name, status: 'error', detail: sbInsert._lastError });
        }
      }
      return res.status(200).json({ created: results.filter(r => r.status === 'created').length, total: products.length, results });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ===== ROTA DESACOPLADA: gera arte de produtos pendentes =====
  // OSSO 34.7: AUTOMATIZADO — busca referência + gera arte img2img em uma chamada.
  // Se produto não tem reference_image_url, busca via Serper+Vision antes de gerar.
  // GET (browser-friendly) ou POST. Processa 1 por chamada.
  if (req.url && req.url.indexOf('action=generate_pending') >= 0) {
    if (!SUPABASE_KEY || !XAI_API_KEY) {
      return res.status(500).json({ error: 'missing env vars (SUPABASE_KEY or XAI_API_KEY)' });
    }
    console.log('[generate_pending] starting...');
    const stalecutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    let pending = await sbGet('drope_products',
      'image_status=in.(pending_art,pending_regeneration)&order=updated_at.asc&limit=1');
    if (!pending.length) {
      pending = await sbGet('drope_products',
        `image_status=in.(generating,error)&updated_at=lt.${encodeURIComponent(stalecutoff)}&order=updated_at.asc&limit=1`);
    }
    if (!pending.length) {
      return res.status(200).json({ message: 'nenhum produto pendente de arte', processed: 0 });
    }
    const product = pending[0];
    const meta = product.metadata || {};
    const attempt = (meta.last_art_attempt || 0) + 1;
    await sbUpdate('drope_products', `id=eq.${product.id}`, { image_status: 'generating' });

    // OSSO 34.7: AUTO-BUSCA REFERÊNCIA — se não tem reference_image_url, busca agora
    if (!product.reference_image_url && SERPER_API_KEY && CLAUDE_KEY) {
      console.log(`[generate_pending] #${product.id} sem referência → buscando via Serper...`);
      try {
        const refUrl = await autoFindReference(product);
        if (refUrl) {
          product.reference_image_url = refUrl;
          console.log(`[generate_pending] #${product.id} referência encontrada: ${refUrl.substring(0, 80)}...`);
        } else {
          console.log(`[generate_pending] #${product.id} referência não encontrada → text-only`);
        }
      } catch (refErr) {
        console.warn(`[generate_pending] #${product.id} busca referência falhou: ${refErr.message} → text-only`);
      }
    }

    try {
      await runArtGeneration(product.id, ADMIN_LUCAS, attempt);
      return res.status(200).json({
        processed: 1,
        product: { id: product.id, name: product.name, attempt },
      });
    } catch (e) {
      console.error('[generate_pending] error:', e.message, e.stack);
      await sbUpdate('drope_products', `id=eq.${product.id}`, { image_status: 'error' });
      return res.status(500).json({ error: e.message, product: product.name });
    }
  }

  // ===== ROTA INTERNA: busca automática de referência visual (OSSO 34.2) =====
  // POST /api/webhook?action=busca_referencia&product_id=172&token=ADMIN_TOKEN
  // GET  /api/webhook?action=busca_referencia (pega próximo pendente — pra cron diário)
  // Usa Serper API (Google Images) + Claude Vision (Haiku) pra achar foto do pod.
  try {
    if (req.url && req.url.indexOf('action=busca_referencia') >= 0) {
      const qs2 = req.url.includes('?') ? req.url.split('?')[1] : '';
      const p2 = {};
      qs2.split('&').forEach(pp => {
        const [k, v] = pp.split('=');
        if (k) p2[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });

      // Auth check
      const tok2 = (req.headers && req.headers['x-admin-token']) || p2.token || '';
      if (!ADMIN_TOKEN || tok2 !== ADMIN_TOKEN) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      if (!SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY not set' });
      if (!CLAUDE_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

      // Pegar produto
      let buscaProd;
      if (p2.product_id) {
        const r = await sbGet('drope_products', `id=eq.${p2.product_id}&select=id,name,slug,metadata,ref_status,reference_image_url`);
        buscaProd = r && r[0];
      } else {
        const r = await sbGet('drope_products', `ref_status=in.(none,auto_failed)&order=created_at.desc&limit=1&select=id,name,slug,metadata,ref_status,reference_image_url`);
        buscaProd = r && r[0];
      }

      if (!buscaProd) return res.status(200).json({ ok: true, found: false, message: 'Nenhum produto pendente' });

      console.log(`[busca-ref] #${buscaProd.id} ${buscaProd.name}`);
      const meta = buscaProd.metadata || {};
      const qParts = [meta.brand, meta.model, meta.puffs ? `${meta.puffs} puffs` : '', 'vape pod device'];
      const searchQ = qParts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

      // Serper image search
      const serperRes = await fetch('https://google.serper.dev/images', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: searchQ, num: 8 })
      });
      const serperData = await serperRes.json();
      const imgs = (serperData.images || []).slice(0, 8);

      if (imgs.length === 0) {
        await sbUpdate('drope_products', `id=eq.${buscaProd.id}`, { ref_status: 'auto_failed' });
        return res.status(200).json({ ok: true, product_id: buscaProd.id, found: false, reason: '0 images from Serper' });
      }

      // Download candidates
      const cands = [];
      for (const img of imgs) {
        if (cands.length >= 5) break;
        try {
          const imgR = await fetch(img.imageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'image/*' },
            signal: AbortSignal.timeout(8000),
          });
          if (!imgR.ok) continue;
          const buf = Buffer.from(await imgR.arrayBuffer());
          if (buf.length < 5000) continue;
          cands.push({ buffer: buf, url: img.imageUrl, title: img.title || '' });
        } catch (_) { continue; }
      }

      if (cands.length === 0) {
        await sbUpdate('drope_products', `id=eq.${buscaProd.id}`, { ref_status: 'auto_failed' });
        return res.status(200).json({ ok: true, product_id: buscaProd.id, found: false, reason: 'No valid candidates' });
      }

      // Vision ranking — detecta media_type real pelo magic bytes do buffer
      function detectMediaType(buf) {
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
        return 'image/jpeg'; // fallback
      }
      const vContent = [];
      for (let i = 0; i < cands.length; i++) {
        const mType = detectMediaType(cands[i].buffer);
        vContent.push({ type: 'image', source: { type: 'base64', media_type: mType, data: cands[i].buffer.toString('base64') } });
        vContent.push({ type: 'text', text: `Candidato ${i + 1}` });
      }
      let evalP = `Avalia ${cands.length} imagens candidatas pra FOTO DE REFERENCIA de um pod/vape. Foto IDEAL: dispositivo REAL de frente, fundo limpo, sem watermark. NAO ideal: so caixa, banner, lifestyle, render 3D.`;
      const devDesc = meta.device_visual_detailed || meta.device_visual || '';
      if (devDesc && devDesc.length > 20) evalP += `\nDESCRICAO DO PRODUTO: "${devDesc}"`;
      evalP += `\nResponde SO JSON: { "ranking": [{"candidato":1,"score":0.0-1.0,"motivo":"breve"}], "melhor": numero ou null, "confianca": 0.0-1.0 }`;
      vContent.push({ type: 'text', text: evalP });

      const vRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: vContent }] })
      });
      const vData = await vRes.json();

      // Debug: se a API retornou erro
      if (vData.error) {
        console.error('[busca-ref] Vision API error:', JSON.stringify(vData.error));
        await sbUpdate('drope_products', `id=eq.${buscaProd.id}`, { ref_status: 'auto_failed' });
        return res.status(200).json({ ok: true, product_id: buscaProd.id, found: false, reason: 'Vision API error', debug: vData.error });
      }

      const vText = (vData.content && vData.content[0] && vData.content[0].text) || '';
      console.log('[busca-ref] Vision raw (first 200):', vText.substring(0, 200));
      // Extrai JSON de qualquer formato (com ou sem ```, com texto antes/depois)
      let cleanJ = vText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const jsonMatch = cleanJ.match(/\{[\s\S]*\}/);
      cleanJ = jsonMatch ? jsonMatch[0] : cleanJ;

      let ranking;
      try { ranking = JSON.parse(cleanJ); } catch (parseErr) {
        console.error('[busca-ref] JSON parse failed:', parseErr.message, '| raw:', vText.substring(0, 300));
        await sbUpdate('drope_products', `id=eq.${buscaProd.id}`, { ref_status: 'auto_failed' });
        return res.status(200).json({ ok: true, product_id: buscaProd.id, found: false, reason: 'Vision parse error v2', debug_text: vText.substring(0, 500), debug_clean: cleanJ.substring(0, 300) });
      }

      if (!ranking.melhor || (ranking.confianca || 0) < 0.35) {
        await sbUpdate('drope_products', `id=eq.${buscaProd.id}`, { ref_status: 'auto_failed' });
        return res.status(200).json({ ok: true, product_id: buscaProd.id, found: false, reason: `Low confidence: ${ranking.confianca}` });
      }

      // Upload winner — bucket correto: drope-product-images
      const winner = cands[ranking.melhor - 1];
      const winnerType = detectMediaType(winner.buffer);
      const ext = winnerType === 'image/png' ? 'png' : 'jpg';
      const fName = `references/ref-${buscaProd.id}.${ext}`;
      const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/drope-product-images/${fName}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'apikey': SUPABASE_KEY,
          'Content-Type': winnerType,
          'x-upsert': 'true',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
        body: winner.buffer,
      });
      if (!upRes.ok) {
        const upErr = await upRes.text().catch(() => '');
        await sbUpdate('drope_products', `id=eq.${buscaProd.id}`, { ref_status: 'auto_failed' });
        return res.status(200).json({ ok: true, product_id: buscaProd.id, found: false, reason: 'Upload failed', debug: upErr.substring(0, 200) });
      }

      const pubUrl = `${SUPABASE_URL}/storage/v1/object/public/drope-product-images/${fName}`;
      await sbUpdate('drope_products', `id=eq.${buscaProd.id}`, { ref_status: 'auto_found', reference_image_url: pubUrl });

      console.log(`[busca-ref] ✅ #${buscaProd.id} → ${pubUrl} (conf=${ranking.confianca})`);
      return res.status(200).json({
        ok: true, product_id: buscaProd.id, found: true,
        reference_url: pubUrl, confianca: ranking.confianca,
        source_url: winner.url
      });
    }
  } catch (buscaErr) {
    console.error('[busca-ref] ERROR:', buscaErr.message);
    return res.status(500).json({ error: buscaErr.message });
  }

  // ===== ROTA INTERNA: enrichment de produto novo do batch =====
  // FIX BATCH 3 (07/05/2026): cada produto vira invocacao Vercel propria com 60s.
  // Antes _flcEnrichProduct rodava fire-and-forget na MESMA invocacao do webhook
  // do batch — em lotes grandes morria por timeout.
  try {
    if (req.method === "POST" && req.url && req.url.indexOf('action=enrich_product') >= 0) {
      const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
      const params = {};
      qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });
      const provided = (req.headers && req.headers['x-admin-token']) || '';
      if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) {
        return res.status(401).send('unauthorized');
      }
      const productId = params.product_id;
      if (!productId) return res.status(400).send('missing product_id');
      try {
        const rows = await sbGet('drope_products', `id=eq.${productId}&select=id,metadata&limit=1`);
        const prod = rows && rows[0];
        if (!prod) return res.status(404).send('produto nao encontrado');
        const m = prod.metadata || {};
        const brand = m.brand || '';
        const model = m.model || '';
        const flavor = m.flavor_en || m.flavor || m.flavor_pt || '';
        await _flcEnrichProduct(productId, brand, model, flavor);
        return res.status(200).send('enrichment done productId=' + productId);
      } catch (e) {
        console.error('[enrich_product] error:', e.message, e.stack);
        return res.status(200).send('enrichment error: ' + e.message);
      }
    }
  } catch (outerErr) {
    console.error('[enrich_product outer] error:', outerErr.message);
    return res.status(500).send('outer error: ' + outerErr.message);
  }

  // ===== ROTA INTERNA: geração de arte em background =====
  // Acionada por fireBackgroundArtGeneration() do próprio finalizeCadastro.
  // Auth via ADMIN_TOKEN no header.
  try {
    if (req.method === "POST" && req.url && req.url.indexOf('action=generate_art') >= 0) {
      // Parsing manual de query (req.query não é populated nesta rota)
      const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
      const params = {};
      qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
      });

      const provided = (req.headers && req.headers['x-admin-token']) || '';
      if (!ADMIN_TOKEN || provided !== ADMIN_TOKEN) {
        console.warn('[generate_art] unauthorized');
        return res.status(401).send('unauthorized');
      }
      const productId = params.product_id;
      const phone = params.phone;
      const attempt = parseInt(params.attempt) || 1;
      if (!productId || !phone) return res.status(400).send('missing product_id or phone');

      try {
        await runArtGeneration(productId, phone, attempt);
        return res.status(200).send('art generation done');
      } catch (e) {
        console.error('[generate_art runArtGeneration] error:', e.message, e.stack);
        return res.status(200).send('art generation error: ' + e.message);
      }
    }
  } catch (outerErr) {
    console.error('[generate_art outer] error:', outerErr.message, outerErr.stack);
    return res.status(500).send('outer error: ' + outerErr.message);
  }

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

    // FIX MAIO/2026 — DEDUP GLOBAL (top-level). UazAPI re-envia webhooks com mesmo msgId
    // várias vezes. Antes o dedup vivia dentro de cada handler — uns tinham, outros nao,
    // gerando duplicate (corrida 2x, mensagem 2x, etc). Agora pega TUDO no inicio.
    const _msgIdGlobal = msg.id || msg.messageId || msg.key?.id;
    if (_msgIdGlobal) {
      if (alreadySeen(_msgIdGlobal)) {
        console.log('[dedup-global] dup msgId ignored:', _msgIdGlobal);
        return res.status(200).send("dup");
      }
      // Persistente cross-instance (Vercel cold-start): 30s window
      if (await alreadySeenContentPersistent('webhook', _msgIdGlobal, 30)) {
        console.log('[dedup-global-db] dup msgId persisted ignored:', _msgIdGlobal);
        return res.status(200).send("dup-db");
      }
    }

    // OSSO 35 — Roteamento de grupos WhatsApp
    if (msg.isGroup || chat.wa_isGroup) {
      // ATENCAO: chat.id e ID interno do UazAPI (ex: r2cd552794d445b),
      // NAO e o JID. JID real esta em chat.wa_chatid ou msg.chatid.
      const groupJid = chat.wa_chatid || msg.chatid || chat.jid || '';
      // Grupo PDV — Yasmin/Pai/Tia mandam foto = venda (reusa handleAdminCaixa)
      if (GRUPO_PDV_JID && groupJid === GRUPO_PDV_JID) {
        console.log("[GROUP-PDV] mensagem no grupo PDV:", msg.type || 'text');
        try {
          await handleAdminCaixa(groupJid, msg, body);
        } catch (e) {
          console.error("[GROUP-PDV] erro:", e.message, e.stack);
        }
        return res.status(200).send("group-pdv");
      }
      // Grupo Motoboy — V2 implementado 07/05/2026
      if (GRUPO_MOTOBOY_JID && groupJid === GRUPO_MOTOBOY_JID) {
        console.log("[GROUP-MOTOBOY] mensagem no grupo motoboy:", msg.type || 'text');
        try {
          await handleMotoboyGroup(groupJid, msg, body);
        } catch (e) { console.error("[GROUP-MOTOBOY] erro:", e.message, e.stack); }
        return res.status(200).send("group-motoboy");
      }
      // Outro grupo: ignora
      return res.status(200).send("group ignored: " + groupJid.slice(0, 20));
    }

    const rawPhone = chat.phone || msg.chatid?.replace("@s.whatsapp.net", "") || "";
    const phone = rawPhone.replace(/[^0-9]/g, "");
    if (!phone) return res.status(200).send("no phone");

    console.log("PHONE:", phone.slice(0, 6) + "***", "TYPE:", msg.type || "text");

    if (isRateLimited(phone)) {
      console.log("RATE LIMITED:", phone.slice(0, 6) + "***");
      // OSSO 23 — log silencioso pra auditoria. Não responde, não gasta Claude.
      logSystemEvent('rate_limited', { phone_prefix: phone.slice(0, 6) + '***' }, phone)
        .catch(() => {});
      return res.status(200).send("rate limited");
    }

    // ========== ROTEAMENTO TRIPLO (OSSO 30 — 2026-05-03) ==========
    // ADMIN_LUCAS → cadastro/abastecimento/aprovação arte
    // PDV_PHONES  → baixa de estoque por foto (loja + Yasmin)
    // resto       → bot cliente (catálogo, pedido, sommelier)
    const _route = (phone === ADMIN_LUCAS) ? 'admin_lucas'
                 : (PDV_PHONES.includes(phone)) ? 'admin_caixa'
                 : 'cliente';
    console.log("[ROUTE] →", _route, phone.slice(0, 6) + '***');

    if (_route === 'admin_lucas') {
      await handleAdminLucas(phone, msg, body);
      return res.status(200).send("admin-lucas");
    }

    if (_route === 'admin_caixa') {
      await handleAdminCaixa(phone, msg, body);
      return res.status(200).send("admin-caixa");
    }

    // ========== CLIENTE ==========
    // Dedup primário por msgId — UazAPI ocasionalmente manda o mesmo evento 2x (causa do
    // "cardápio duplicado"). handleAdminLucas tem sua dedup interna; aqui é exclusivo do customer.
    const msgId = msg.id || msg.messageId || msg.key?.id;
    if (msgId && alreadySeen(msgId)) {
      console.log("CLIENT: duplicate msgId ignored:", msgId);
      return res.status(200).send("client-duplicate");
    }

    const message = asString(msg.text) || asString(msg.content) || asString(msg.caption);

    if (isImageMessage(msg) && !message) {
      await sendText(phone, "👋 por enquanto só leio texto.\n\n• manda escrito que te ajudo", body);
      return res.status(200).send("image-rejected");
    }

    if (!message) return res.status(200).send("no message");

    // Dedup secundário por conteúdo — cobre quando UazAPI manda 2 eventos com msgIds diferentes
    // (3s de janela). Evita resposta dupla no caso de cold-start ou retry do servidor.
    const contentSig = require('crypto').createHash('sha1').update(message).digest('hex').slice(0, 12);
    if (alreadySeenContent(phone, contentSig)) {
      console.log("CLIENT: duplicate content ignored for", phone.slice(0, 6) + '***');
      return res.status(200).send("client-content-duplicate");
    }

    // FEATURE 3A — Captura silenciosa do cliente. Fire-and-forget pra não atrasar resposta.
    // O dedup acima garante que rodamos só 1x por mensagem real.
    captureCustomerSilent(phone, 'whatsapp').catch(e => console.error('[capture] err:', e.message));

    // Features 3 e 6 — intercepta keywords antes do Claude (resposta padronizada + sem custo de LLM)
    const intent = detectClienteIntent(message);
    if (intent === 'catalog') {
      console.log("INTENT: catalog");
      const { items: catalogItems, footer: catalogFooter } = await buildCatalogMessage();
      await sendText(phone, catalogItems, body);
      if (catalogFooter) {
        // 2ª mensagem curta com o link → fica clicável no WhatsApp
        await sendText(phone, catalogFooter, body);
      }
      return res.status(200).send("catalog");
    }
    if (intent === 'refund') {
      console.log("INTENT: refund");
      await sendText(phone, REFUND_POLICY_TEXT, body);
      return res.status(200).send("refund");
    }

    // OSSO 22 — SOMMELIER. Busca contexto do cliente + matching de produtos
    // ANTES de chamar Claude. Fica fire-and-forget pra não atrasar primeira
    // resposta se o banco demorar — em paralelo com o getConvo.
    const ctxPromise = getCustomerContextByPhone(phone).catch(() => null);
    const matchesPromise = searchProductsForBot(message).catch(() => []);
    const [customerCtx, productMatches] = await Promise.all([ctxPromise, matchesPromise]);

    // OSSO 22 — Reorder em 1 mensagem. Se cliente recorrente diz "quero de
    // novo" e o último produto está em estoque, atalho sem chamar Claude.
    if (REORDER_PATTERNS.test(message) && customerCtx?.last_product_name) {
      try {
        const lpRows = await sbGet('drope_products',
          `name=eq.${encodeURIComponent(customerCtx.last_product_name)}&select=id,name,price_cents,qty_available,image_url&limit=1`);
        const lp = lpRows[0];
        if (lp && (lp.qty_available || 0) > 0) {
          const price = ((lp.price_cents || 0) / 100).toFixed(2).replace('.', ',');
          const reorderMsg = `🦎 beleza! ${lp.name} — R$ ${price}\n\nretirada na loja ou entrega?\nou paga direto: drope-app.vercel.app`;
          await sendText(phone, reorderMsg, body);
          if (lp.image_url) { try { await sendImage(phone, lp.image_url, '', body); } catch(e) {} }
          return res.status(200).send("reorder");
        }
        // Esgotado → registra interesse
        if (lp && customerCtx.id) {
          await registerInterest(customerCtx.id, lp.name).catch(() => {});
          await sendText(phone, `🦎 o ${lp.name} esgotou. te aviso assim que chegar.`, body);
          return res.status(200).send("reorder-out-of-stock");
        }
      } catch (e) { console.warn('[reorder] err:', e.message); }
    }

    // OSSO 22 — Detecção "sim me avisa" — heurística leve, registra interesse
    // se existe contexto de last_search + cliente respondeu afirmativo curto.
    const isShortYes = /^(sim|si|aham|isso|fechado|beleza|claro|pode|pode\s+sim|ok)\.?$/i.test(message.trim());
    if (isShortYes && customerCtx?.id) {
      const lastQuery = readLastQuery(phone);
      if (lastQuery && lastQuery.outOfStock) {
        await registerInterest(customerCtx.id, lastQuery.term).catch(() => {});
        await sendText(phone, `🦎 anotado! te aviso assim que chegar.`, body);
        clearLastQuery(phone);
        return res.status(200).send("interest-registered");
      }
    }

    // Monta system prompt do sommelier se há contexto OU produtos matched
    const useSommelier = !!(customerCtx?.total_orders > 0) || (productMatches && productMatches.length > 0);
    let systemPrompt;
    if (useSommelier) {
      systemPrompt = SOMMELIER_SYSTEM_TPL
        .replace('{customer_block}', formatCustomerBlock(customerCtx))
        .replace('{products_block}', formatProductsBlock(productMatches));
    } else {
      systemPrompt = SYSTEM_CUSTOMER;
    }

    const convo = getConvo(phone);
    addMsg(phone, "user", message);
    // getConvo retorna entry inteiro {messages,lastActivity,state,pending} — callClaude
    // espera o array de messages. Sem o .messages, Anthropic retorna 400 imediato.
    const reply = await callClaude(convo.messages, systemPrompt, 400);
    if (!reply) {
      await sendText(phone, "⚠️ deu ruim aqui.\n\n• tenta de novo", body);
      return res.status(200).send("error");
    }
    addMsg(phone, "assistant", reply);

    await sendText(phone, reply, body);

    // Se Claude sugeriu "te aviso quando chegar" no reply, anota o último
    // query do cliente pra capturar o "sim" subsequente.
    if (/te aviso (quando|assim que) chegar|avisa quando|me avis[ae]/i.test(reply) && customerCtx?.id) {
      const term = (productMatches && productMatches[0]?.name) || message.slice(0, 80);
      writeLastQuery(phone, { term, outOfStock: true });
    } else {
      // Sem promise de aviso → limpa qualquer last query stale
      clearLastQuery(phone);
    }

    return res.status(200).send("replied");

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message, err.stack);
    return res.status(200).send("error: " + err.message);
  }
};

 