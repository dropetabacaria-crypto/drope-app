// Cupons do DROPE — validados SEMPRE no servidor (28/09/2026).
// Antes a lista vivia no celular do cliente e o servidor aceitava qualquer desconto até 50%.
// Agora: o servidor sabe quais cupons existem, as regras de cada um e calcula o desconto.
//
// Regras:
//   BEMVINDO10 — R$ 10 off na PRIMEIRA compra do telefone (nenhum pedido pago/reservado/entregue antes).
//   VOLTA5     — R$ 5 off no SEGUNDO pedido (exatamente 1 compra antes). A loja manda pelo WhatsApp.
//   Indicação  — código pessoal do cliente (ex.: LUCAS27 = primeiro nome + id). O AMIGO ganha R$ 10
//                na 1ª compra; QUEM INDICOU ganha R$ 5 de crédito quando o amigo PAGA (ou retira).
//                O crédito entra sozinho como desconto no próximo pedido de quem indicou.

const COUPONS = {
  BEMVINDO10: { cents: 1000, firstOrderOnly: true, label: 'R$ 10 na primeira compra' },
  VOLTA5: { cents: 500, secondOrderOnly: true, label: 'R$ 5 no seu segundo pedido' },
};

// Pedido que "conta" como compra anterior (não conta checkout abandonado nem cancelado)
const NAO_CONTA = ['created', 'cancelled'];

function _digits(s) { return String(s || '').replace(/\D/g, ''); }

// Quantas compras que contam esse telefone já tem (0, 1 ou 2 = "2 ou mais")
async function _customerOrderCount(phone, sb) {
  const ph = _digits(phone);
  if (ph.length < 10) return 0;
  const cust = await sb(`drope_customers?phone=eq.${encodeURIComponent(ph)}&select=id&limit=1`);
  const id = Array.isArray(cust) && cust[0] && cust[0].id;
  if (!id) return 0;
  const orders = await sb(`drope_orders?customer_id=eq.${encodeURIComponent(id)}&status=not.in.(${NAO_CONTA.join(',')})&select=id&limit=2`);
  return Array.isArray(orders) ? orders.length : 0;
}
async function _customerHasOrder(phone, sb) { return (await _customerOrderCount(phone, sb)) > 0; }

// sb(pathComQuery) → array (GET no Supabase REST). Devolve { ok, code, discount_cents, label } ou { ok:false, message }.
async function checkCoupon({ code, phone, subtotalCents }, sb) {
  const c = String(code || '').trim().toUpperCase();
  let def = COUPONS[c];
  let referrer = null;
  if (!def) {
    try { referrer = await resolveReferral(c, sb); } catch (e) { referrer = null; }
    if (!referrer) return { ok: false, error: 'cupom_invalido', message: 'Cupom inválido ou expirado' };
    if (_digits(referrer.phone) === _digits(phone)) return { ok: false, error: 'cupom_proprio', message: 'Esse é o seu código ✦ manda pros amigos que você ganha R$ 5 quando eles comprarem' };
    const nome = String(referrer.name || '').trim().split(/\s+/)[0] || 'um amigo';
    def = { cents: REF_FRIEND_CENTS, firstOrderOnly: true, label: `R$ 10 na 1ª compra · indicação de ${nome}`, ref_customer_id: referrer.id };
  }
  if (def.firstOrderOnly) {
    if (_digits(phone).length < 10) return { ok: false, error: 'cupom_login', message: 'Entre na sua conta pra usar esse cupom' };
    let has = false;
    try { has = await _customerHasOrder(phone, sb); } catch (e) { has = false; }
    if (has) return { ok: false, error: 'cupom_primeira', message: 'Esse cupom é só pra primeira compra ✦' };
  }
  if (def.secondOrderOnly) {
    if (_digits(phone).length < 10) return { ok: false, error: 'cupom_login', message: 'Entre na sua conta pra usar esse cupom' };
    let n = 0;
    try { n = await _customerOrderCount(phone, sb); } catch (e) { n = -1; }
    if (n === 0) return { ok: false, error: 'cupom_segunda', message: 'Esse cupom é pro seu segundo pedido — no primeiro use o BEMVINDO10 ✦' };
    if (n !== 1) return { ok: false, error: 'cupom_segunda', message: 'Esse cupom vale só no segundo pedido ✦' };
  }
  const sub = Math.max(0, Math.round(Number(subtotalCents) || 0));
  const discount = Math.min(def.cents, Math.max(0, sub - 100)); // nunca deixa o pedido abaixo de R$ 1
  if (discount <= 0) return { ok: false, error: 'cupom_minimo', message: 'Pedido pequeno demais pra esse cupom' };
  return { ok: true, code: c, discount_cents: discount, label: def.label, ...(def.ref_customer_id ? { ref_customer_id: def.ref_customer_id } : {}) };
}

// ===== Indicação =====
const REF_FRIEND_CENTS = 1000, REF_CREDIT_CENTS = 500;
function _ascii(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z]/g, ''); }
function referralCode(customer) {
  if (!customer || !customer.id) return null;
  const first = _ascii(String(customer.name || '').trim().split(/\s+/)[0]).slice(0, 8);
  return (first.length >= 2 ? first : 'DROPE') + customer.id;
}
// "LUCAS27" → cliente 27, conferindo que o nome bate (evita chutar números)
async function resolveReferral(code, sb) {
  const m = String(code || '').trim().toUpperCase().match(/^([A-Z]{2,8})(\d{1,7})$/);
  if (!m) return null;
  const rows = await sb(`drope_customers?id=eq.${Number(m[2])}&select=id,name,phone&limit=1`);
  const c = Array.isArray(rows) && rows[0];
  if (!c || referralCode(c) !== m[1] + m[2]) return null;
  return c;
}
// Crédito disponível de quem indicou: R$ 5 por amigo que pagou/retirou − o que já usou em pedidos.
async function referralCredit(customerId, sb) {
  if (!customerId) return { earned_count: 0, credit_cents: 0 };
  const id = encodeURIComponent(customerId);
  const earned = await sb(`drope_orders?metadata->>ref_customer_id=eq.${id}&or=(payment_confirmed_at.not.is.null,status.in.(picked_up,delivered,completed))&select=id&limit=500`);
  const used = await sb(`drope_orders?customer_id=eq.${id}&status=not.in.(${NAO_CONTA.join(',')})&metadata->>credit_used_cents=not.is.null&select=metadata&limit=500`);
  const n = Array.isArray(earned) ? earned.length : 0;
  const usedC = (Array.isArray(used) ? used : []).reduce((t, o) => t + (Number(o.metadata && o.metadata.credit_used_cents) || 0), 0);
  return { earned_count: n, credit_cents: Math.max(0, n * REF_CREDIT_CENTS - usedC) };
}

module.exports = { checkCoupon, COUPONS, referralCode, resolveReferral, referralCredit, REF_CREDIT_CENTS };
