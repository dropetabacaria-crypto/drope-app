// Drope — frete pela ROTA (Google Maps Routes API). Módulo compartilhado:
// api/webhook.js (cotação na tela) e api/save-order.js (recalcula e recusa frete adulterado).
// Fica fora de api/ pra NÃO virar uma função a mais na Vercel.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
async function _sbGet(table, filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  return r.ok ? r.json() : [];
}
// Busca a loja (geo + endereço) pelo slug.
async function freteFilialBySlug(slug) {
  const fr = await _sbGet('drope_filiais', `slug=eq.${encodeURIComponent(String(slug || 'sp').toLowerCase())}&select=id,slug,metadata&limit=1`);
  return (Array.isArray(fr) && fr[0]) || null;
}

// ===================== FRETE PELA ROTA (Google Maps Routes API) — set/2026 =====================
// Taxa = R$2/km do TRAJETO de moto/carro pelas ruas (não linha reta), mínimo R$8, até 15 km.
// Origem = endereço da loja; destino = endereço COMPLETO do cliente (rua+número, não o centro do CEP).
// Tudo no SERVIDOR: o celular só mostra; o save-order recalcula e recusa frete adulterado.
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const FRETE_PER_KM_CENTS = Number(process.env.FRETE_PER_KM_CENTS || 200);
const FRETE_MIN_CENTS = Number(process.env.FRETE_MIN_CENTS || 800);
const FRETE_MAX_KM = Number(process.env.FRETE_MAX_KM || 15);
const FRETE_ROAD_FACTOR = 1.35; // só na estimativa reserva (sem Google): linha reta × 1,35
const _freteCache = new Map();  // destino normalizado → { km, lat, lng, source, t }

function _freteAddrText(a) {
  a = a || {};
  const cep = String(a.cep || '').replace(/\D/g, '');
  const rua = [a.street || a.rua || '', a.num || a.numero || ''].filter(Boolean).join(', ');
  const cidade = [a.city || a.cidade || 'São Paulo', a.uf || 'SP'].filter(Boolean).join(' - ');
  return [rua, a.neigh || a.bairro || '', cidade, cep ? cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '', 'Brasil'].filter(Boolean).join(', ');
}
function _freteStoreOrigin(filial) {
  const md = (filial && filial.metadata) || {};
  const e = md.endereco || {}, g = md.geo || {};
  if (e.address) return [e.address, e.city || 'São Paulo - SP', e.cep || g.cep || '', 'Brasil'].filter(Boolean).join(', ');
  return 'Rua da Igreja, 1528, São Paulo - SP, Brasil';
}
function _freteFeeCents(km) { return Math.max(FRETE_MIN_CENTS, Math.round(km * FRETE_PER_KM_CENTS)); }
async function _googleRouteKm(originText, destText) {
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.legs.endLocation' },
    body: JSON.stringify({ origin: { address: originText }, destination: { address: destText }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', languageCode: 'pt-BR', regionCode: 'BR', units: 'METRIC' }),
    signal: AbortSignal.timeout(6000),
  });
  const d = await r.json().catch(() => ({}));
  const rt = d && Array.isArray(d.routes) && d.routes[0];
  if (!r.ok || !rt || !rt.distanceMeters) throw new Error('routes ' + r.status + ' ' + JSON.stringify(d).slice(0, 160));
  const end = (((rt.legs || [])[0] || {}).endLocation || {}).latLng || {};
  return { km: Math.round(rt.distanceMeters / 100) / 10, lat: end.latitude || null, lng: end.longitude || null };
}
// Reserva (sem chave Google ou Google fora): CEP → coordenada → linha reta × 1,35 a partir da geo da loja.
async function _freteEstimateKm(filial, addr) {
  const cep = String((addr || {}).cep || '').replace(/\D/g, '');
  const g = ((filial && filial.metadata) || {}).geo || {};
  if (cep.length !== 8 || !g.lat || !g.lng) return null;
  let lat = null, lng = null;
  try {
    const c = await _sbGet('drope_cep_cache', `cep=eq.${cep}&select=lat,lng&limit=1`);
    if (Array.isArray(c) && c[0] && c[0].lat) { lat = c[0].lat; lng = c[0].lng; }
  } catch (e) {}
  if (lat == null) {
    try {
      const r = await fetch(`https://cep.awesomeapi.com.br/json/${cep}`, { signal: AbortSignal.timeout(4000) });
      const d = await r.json(); if (d && d.lat && d.lng) { lat = parseFloat(d.lat); lng = parseFloat(d.lng); }
    } catch (e) {}
  }
  if (lat == null) return null;
  const R = 6371, toR = x => x * Math.PI / 180, dLat = toR(lat - g.lat), dLng = toR(lng - g.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(g.lat)) * Math.cos(toR(lat)) * Math.sin(dLng / 2) ** 2;
  return { km: Math.round(2 * R * Math.asin(Math.sqrt(a)) * FRETE_ROAD_FACTOR * 10) / 10, lat, lng };
}
// { ok, km, fee_cents, fmt, out_of_range, source, message? }
async function _freteQuote(filial, addr) {
  if (!addr || !(addr.street || addr.rua || String(addr.cep || '').replace(/\D/g, '').length === 8)) return { ok: false, error: 'endereço incompleto' };
  const dest = _freteAddrText(addr), origin = _freteStoreOrigin(filial);
  const key = (origin + '→' + dest).toLowerCase();
  let hit = _freteCache.get(key);
  if (!hit || Date.now() - hit.t > 7 * 864e5) {
    hit = null;
    if (GOOGLE_MAPS_KEY) {
      try { const g = await _googleRouteKm(origin, dest); hit = { ...g, source: 'google' }; }
      catch (e) { console.warn('[frete] google falhou:', e.message); }
    }
    if (!hit) { const est = await _freteEstimateKm(filial, addr); if (est) hit = { ...est, source: 'estimativa' }; }
    if (!hit) return { ok: false, error: 'não consegui calcular a entrega pra esse endereço' };
    hit.t = Date.now(); _freteCache.set(key, hit);
  }
  const km = hit.km;
  if (km > FRETE_MAX_KM) {
    return { ok: true, out_of_range: true, km, max_km: FRETE_MAX_KM, source: hit.source, message: `Por enquanto entregamos até ${FRETE_MAX_KM} km ✦ esse endereço fica a ~${String(km).replace('.', ',')} km. Dá pra retirar na loja.` };
  }
  const fee_cents = _freteFeeCents(km);
  return { ok: true, out_of_range: false, km, fee_cents, fmt: 'R$ ' + (fee_cents / 100).toFixed(2).replace('.', ','), per_km_cents: FRETE_PER_KM_CENTS, min_cents: FRETE_MIN_CENTS, max_km: FRETE_MAX_KM, source: hit.source, dest_lat: hit.lat || null, dest_lng: hit.lng || null };
}

module.exports = { freteQuote: _freteQuote, freteFilialBySlug, FRETE_PER_KM_CENTS, FRETE_MIN_CENTS, FRETE_MAX_KM };
