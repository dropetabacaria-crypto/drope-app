// Título padrão dos pods (27/09/2026): "Marca Modelo Sabor NK"
//   ex.: "Ignite V400 Cola Gelada 40K" · "Elf Bar Ice King Maçã Verde Gelada 40K"
// O cliente pergunta nessa ordem: sabor → puffs → marca → preço. A vitrine mostra o
// SABOR grande e "Marca Modelo · 40k puffs" embaixo; o nome completo serve pra busca/painel.

const BRANDS = {
  'elfbar': 'Elf Bar', 'elf bar': 'Elf Bar', 'ignite': 'Ignite', 'lost mary': 'Lost Mary', 'lostmary': 'Lost Mary',
  'dinner lady': 'Dinner Lady', 'dinnerlady': 'Dinner Lady', 'geek bar': 'Geek Bar', 'geekbar': 'Geek Bar',
  'waka': 'Waka', 'nikbar': 'Nikbar', 'rabbeats': 'RabBeats', 'maxbar': 'Maxbar', 'icity': 'iCity', 'hqd': 'HQD',
  'dojo': 'Dojo', 'hallo': 'Hallo', 'the black sheep': 'The Black Sheep', 'black sheep': 'The Black Sheep',
  'oxbar': 'Oxbar', 'vapesoul': 'Vapesoul', 'vozol': 'Vozol', 'lost vape': 'Lost Vape',
};

function brandDisplay(b) {
  const k = String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!k) return '';
  return BRANDS[k] || k.replace(/\b\w/g, c => c.toUpperCase());
}

function _esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// "40K" / "40000 Puffs" / "BC15000" → 40000 (null se não achar)
function puffsFrom(txt) {
  const n = String(txt || '');
  let m = n.match(/(\d+(?:[.,]\d+)?)\s*k\b/i);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 1000);
  m = n.match(/(\d{1,3}(?:\.\d{3})+|\d{4,6})\s*puffs/i) || n.match(/\b[A-Z]{1,3}(\d{4,5})\b/);
  if (m) return parseInt(m[1].replace(/\./g, ''), 10);
  return null;
}

// Ignite: o número do modelo é puffs/100 (V400 = 40.000, V155 = 15.500, V55 = 5.500)
function _ignitePuffs(model) {
  const m = String(model || '').match(/\bV\s?(\d{2,3})\b/i);
  return m ? parseInt(m[1], 10) * 100 : null;
}

// Tira do modelo o que não é modelo: marca, "Pod Descartável", "Puffs", o sabor, e o "20K"
// solto no fim (os puffs já aparecem no fim do título). Mantém códigos como V400, BC15000, TE30K.
function cleanModel(model, { brand, flavorPt, flavorEn, puffs } = {}) {
  let s = ' ' + String(model || '') + ' ';
  const b = brandDisplay(brand);
  const kill = [b, String(brand || ''), b.replace(/\s+/g, '')].filter(Boolean);
  kill.forEach(k => { s = s.replace(new RegExp('\\s' + _esc(k) + '(?=\\s)', 'ig'), ' '); });
  [flavorPt, flavorEn].filter(Boolean).forEach(f => { s = s.replace(new RegExp(_esc(String(f).trim()), 'ig'), ' '); });
  s = s.replace(/\bpods?\b|\bdescart[aá]vel\b|\bdisposable\b|\bvape\b/ig, ' ')
    .replace(/\b\d{1,3}(?:\.\d{3})+\s*puffs\b|\b\d{3,6}\s*puffs\b|\bpuffs\b/ig, ' ')
    .replace(/\s+/g, ' ').trim();
  const toks = s.split(' ');
  if (toks.length > 1 && /^\d+(?:[.,]\d+)?k$/i.test(toks[toks.length - 1])) {
    const k = puffsFrom(toks[toks.length - 1]);
    if (!puffs || k === puffs) toks.pop();
  }
  return toks.join(' ').trim();
}

// 40000 → "40K" · 15500 → "15,5K" · 1000 → "1K"
function puffsK(n) {
  n = Number(n) || 0;
  if (n < 1000) return '';
  const k = Math.round(n / 100) / 10;
  return String(k).replace('.', ',') + 'K';
}

// Monta o título padrão. Retorna null se faltar marca ou sabor (aí fica o nome digitado).
function stdPodName({ brand, model, flavor, puffs } = {}) {
  const b = brandDisplay(brand);
  const f = String(flavor || '').trim();
  if (!b || !f) return null;
  const mdl = String(model || '').trim();
  const pk = puffsK(puffs);
  // Modelo que já diz os puffs (TE30K, BC15000, 70K) não repete no fim
  const tail = (pk && puffsFrom(mdl) !== Number(puffs)) ? pk : '';
  return [b, mdl, f, tail].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// Padroniza o que a IA leu na foto (brand/model/flavor/puffs) → campos + nome padrão.
function standardizePod(v = {}) {
  const brand = brandDisplay(v.brand);
  const flavorPt = String(v.flavor_pt || '').trim();
  const flavorEn = String(v.flavor_en || '').trim();
  let puffs = Number(v.puffs) || null;
  const rawModel = String(v.model || '');
  if (!puffs || puffs < 500) puffs = (/ignite/i.test(brand) ? _ignitePuffs(rawModel) : null) || puffsFrom(rawModel) || puffsFrom(v.name) || null;
  const model = cleanModel(rawModel, { brand, flavorPt, flavorEn, puffs });
  const name = stdPodName({ brand, model, flavor: flavorPt || flavorEn, puffs });
  return { brand, model, flavor_pt: flavorPt || null, flavor_en: flavorEn || null, puffs, name };
}

module.exports = { brandDisplay, cleanModel, puffsFrom, puffsK, stdPodName, standardizePod };
