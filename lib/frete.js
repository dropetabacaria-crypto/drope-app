// Drope — frete pela ROTA. Motor: OpenStreetMap (grátis, sem cadastro/cartão) — Nominatim acha o
// endereço, OSRM calcula o trajeto pelas ruas. Se um dia tiver GOOGLE_MAPS_API_KEY, usa o Google.
// Módulo compartilhado:
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
// Regra aprovada pelo Andrade em 27/09/2026 (ver conta de lucro/motoboy no histórico do projeto):
//  cliente paga por FAIXA do trajeto: até 3 km R$ 7,99 · 3–6 km R$ 10,99 · 6–10 km R$ 15,99 ·
//  acima de 10 km não entrega (retirada na loja desligada em 28/09). Pedido com 2+ pods até 6 km: frete GRÁTIS.
//  motoboy recebe R$ 10 + R$ 2/km do trajeto (ele volta vazio pra loja — ver motoboyPayCents).
const FRETE_ZONES = [[3, 799], [6, 1099], [10, 1599]]; // [até km, centavos]
const FRETE_MAX_KM = Number(process.env.FRETE_MAX_KM || 10);
const FRETE_FREE_PODS = 2, FRETE_FREE_KM = 6;
const MOTOBOY_BASE_CENTS = 1000, MOTOBOY_PER_KM_CENTS = 200;
const FRETE_PER_KM_CENTS = MOTOBOY_PER_KM_CENTS; // compat (exportado)
const FRETE_MIN_CENTS = FRETE_ZONES[0][1];      // compat (exportado)
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
  if (e.address) return [e.address, e.bairro || g.neigh || '', e.city || 'São Paulo - SP', e.cep || '', 'Brasil'].filter(Boolean).join(', ');
  return 'Rua Dianópolis, 4100, Vila Prudente, São Paulo - SP, 03126-007, Brasil';
}
function _freteFeeCents(km) { const z = FRETE_ZONES.find(([ate]) => km <= ate); return z ? z[1] : FRETE_ZONES[FRETE_ZONES.length - 1][1]; }
// Pagamento do motoboy por entrega: R$ 10 + R$ 2 por km do trajeto (sem km conhecido → 4 km).
function motoboyPayCents(km) { const k = (typeof km === 'number' && km > 0) ? km : 4; return MOTOBOY_BASE_CENTS + Math.round(k * MOTOBOY_PER_KM_CENTS); }
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
// ===== OpenStreetMap (sem chave) =====
const OSM_UA = 'drope-app/1.0 (+https://drope-app.vercel.app)'; // política do Nominatim: identificar o app
const _geoCache = new Map(); // endereço → { lat, lng }
async function _osmGeocode(addr) {
  const a = addr || {};
  const cep = String(a.cep || '').replace(/\D/g, '');
  const street = [a.num || a.numero || '', a.street || a.rua || ''].filter(Boolean).join(' ').trim();
  const city = a.city || a.cidade || 'São Paulo';
  const key = [street, city, cep].join('|').toLowerCase();
  if (_geoCache.has(key)) return _geoCache.get(key);
  // Estratégia (OSM não conhece número de casa em SP):
  //  1) todos os trechos da RUA certa na cidade (Nominatim, até 10);
  //  2) ponto do CEP (Nominatim → BrasilAPI) — só vale se cair a ≤ 3 km de algum trecho da rua
  //     (a BrasilAPI às vezes devolve coordenada errada);
  //  3) escolhe o trecho mais perto do CEP; sem CEP válido, a média dos trechos do bairro (ou da rua).
  const nomi = async (qs, limit) => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?${qs}&format=json&limit=${limit || 1}&countrycodes=br`, { headers: { 'User-Agent': OSM_UA, 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(5000) });
      const d = await r.json().catch(() => []);
      return Array.isArray(d) ? d.filter(x => x && x.lat).map(x => ({ lat: parseFloat(x.lat), lng: parseFloat(x.lon), name: x.display_name || '' })) : [];
    } catch (e) { return []; }
  };
  const km = (p, q) => { const R = 6371, t = x => x * Math.PI / 180, dA = t(q.lat - p.lat), dO = t(q.lng - p.lng); const h = Math.sin(dA / 2) ** 2 + Math.cos(t(p.lat)) * Math.cos(t(q.lat)) * Math.sin(dO / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const segs = (a.street || a.rua) ? await nomi(`q=${encodeURIComponent([a.street || a.rua, city, a.uf || 'SP'].join(', '))}`, 10) : [];
  let ref = null;
  if (cep.length === 8) {
    const c = await nomi(`postalcode=${cep.replace(/^(\d{5})(\d{3})$/, '$1-$2')}&country=Brasil`, 1);
    if (c[0]) ref = c[0];
    if (!ref) {
      try {
        const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${cep}`, { signal: AbortSignal.timeout(4000) });
        const d = await r.json().catch(() => ({}));
        const co = d && d.location && d.location.coordinates;
        if (co && co.latitude && co.longitude) ref = { lat: parseFloat(co.latitude), lng: parseFloat(co.longitude) };
      } catch (e) {}
    }
  }
  let g = null;
  if (segs.length) {
    if (ref && segs.some(sg => km(sg, ref) <= 3)) {
      g = segs.reduce((best, sg) => (km(sg, ref) < km(best, ref) ? sg : best), segs[0]);
    } else {
      const nb = String(a.neigh || a.bairro || '').toLowerCase();
      const pool = (nb && segs.filter(sg => sg.name.toLowerCase().includes(nb)).length) ? segs.filter(sg => sg.name.toLowerCase().includes(nb)) : segs;
      g = { lat: pool.reduce((t, x) => t + x.lat, 0) / pool.length, lng: pool.reduce((t, x) => t + x.lng, 0) / pool.length };
    }
  } else if (ref) g = ref;
  if (g) g = { lat: g.lat, lng: g.lng };
  if (g) { _geoCache.set(key, g); return g; }
  return null;
}
async function _osrmRouteKm(o, d) {
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=false&alternatives=false`, { headers: { 'User-Agent': OSM_UA }, signal: AbortSignal.timeout(6000) });
  const j = await r.json().catch(() => ({}));
  const rt = j && Array.isArray(j.routes) && j.routes[0];
  if (!r.ok || !rt || !rt.distance) throw new Error('osrm ' + r.status + ' ' + (j && j.code));
  return Math.round(rt.distance / 100) / 10;
}
async function _osmRoute(filial, addr) {
  const g = ((filial && filial.metadata) || {}).geo || {};
  if (!g.lat || !g.lng) return null;
  const dest = await _osmGeocode(addr);
  if (!dest) return null;
  const km = await _osrmRouteKm({ lat: g.lat, lng: g.lng }, dest);
  return { km, lat: dest.lat, lng: dest.lng };
}
// Reserva (sem Google/OSM): CEP → coordenada → linha reta × 1,35 a partir da geo da loja.
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
async function _freteQuote(filial, addr, opts) {
  const pods = Math.max(0, parseInt((opts && opts.pods) || 0, 10) || 0);
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
    if (!hit) {
      try { const o = await _osmRoute(filial, addr); if (o) hit = { ...o, source: 'rota' }; }
      catch (e) { console.warn('[frete] osm falhou:', e.message); }
    }
    if (!hit) { const est = await _freteEstimateKm(filial, addr); if (est) hit = { ...est, source: 'estimativa' }; }
    if (!hit) return { ok: false, error: 'não consegui calcular a entrega pra esse endereço' };
    hit.t = Date.now(); _freteCache.set(key, hit);
  }
  const km = hit.km;
  if (km > FRETE_MAX_KM) {
    return { ok: true, out_of_range: true, km, max_km: FRETE_MAX_KM, source: hit.source, message: `Por enquanto entregamos até ${FRETE_MAX_KM} km ✦ esse endereço fica a ~${String(km).replace('.', ',')} km.` };
  }
  const zone_fee_cents = _freteFeeCents(km);
  const free = pods >= FRETE_FREE_PODS && km <= FRETE_FREE_KM;
  const fee_cents = free ? 0 : zone_fee_cents;
  return { ok: true, out_of_range: false, km, fee_cents, zone_fee_cents, free, fmt: free ? 'grátis' : 'R$ ' + (fee_cents / 100).toFixed(2).replace('.', ','), zone_fmt: 'R$ ' + (zone_fee_cents / 100).toFixed(2).replace('.', ','), free_pods: FRETE_FREE_PODS, free_km: FRETE_FREE_KM, zones: FRETE_ZONES, max_km: FRETE_MAX_KM, source: hit.source, dest_lat: hit.lat || null, dest_lng: hit.lng || null };
}

module.exports = { freteQuote: _freteQuote, freteFilialBySlug, motoboyPayCents, FRETE_ZONES, FRETE_FREE_PODS, FRETE_FREE_KM, FRETE_PER_KM_CENTS, FRETE_MIN_CENTS, FRETE_MAX_KM };
