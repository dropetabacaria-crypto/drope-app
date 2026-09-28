// Cupons do DROPE — validados SEMPRE no servidor (28/09/2026).
// Antes a lista vivia no celular do cliente e o servidor aceitava qualquer desconto até 50%.
// Agora: o servidor sabe quais cupons existem, as regras de cada um e calcula o desconto.
//
// Regras:
//   BEMVINDO10 — R$ 10 off na PRIMEIRA compra do telefone (nenhum pedido pago/reservado/entregue antes).
//   (VOLTA5 e indicação entram aqui depois.)

const COUPONS = {
  BEMVINDO10: { cents: 1000, firstOrderOnly: true, label: 'R$ 10 na primeira compra' },
};

// Pedido que "conta" como compra anterior (não conta checkout abandonado nem cancelado)
const NAO_CONTA = ['created', 'cancelled'];

function _digits(s) { return String(s || '').replace(/\D/g, ''); }

async function _customerHasOrder(phone, sb) {
  const ph = _digits(phone);
  if (ph.length < 10) return false;
  const cust = await sb(`drope_customers?phone=eq.${encodeURIComponent(ph)}&select=id&limit=1`);
  const id = Array.isArray(cust) && cust[0] && cust[0].id;
  if (!id) return false;
  const orders = await sb(`drope_orders?customer_id=eq.${encodeURIComponent(id)}&status=not.in.(${NAO_CONTA.join(',')})&select=id&limit=1`);
  return Array.isArray(orders) && orders.length > 0;
}

// sb(pathComQuery) → array (GET no Supabase REST). Devolve { ok, code, discount_cents, label } ou { ok:false, message }.
async function checkCoupon({ code, phone, subtotalCents }, sb) {
  const c = String(code || '').trim().toUpperCase();
  const def = COUPONS[c];
  if (!def) return { ok: false, error: 'cupom_invalido', message: 'Cupom inválido ou expirado' };
  if (def.firstOrderOnly) {
    if (_digits(phone).length < 10) return { ok: false, error: 'cupom_login', message: 'Entre na sua conta pra usar esse cupom' };
    let has = false;
    try { has = await _customerHasOrder(phone, sb); } catch (e) { has = false; }
    if (has) return { ok: false, error: 'cupom_primeira', message: 'Esse cupom é só pra primeira compra ✦' };
  }
  const sub = Math.max(0, Math.round(Number(subtotalCents) || 0));
  const discount = Math.min(def.cents, Math.max(0, sub - 100)); // nunca deixa o pedido abaixo de R$ 1
  if (discount <= 0) return { ok: false, error: 'cupom_minimo', message: 'Pedido pequeno demais pra esse cupom' };
  return { ok: true, code: c, discount_cents: discount, label: def.label };
}

module.exports = { checkCoupon, COUPONS };
