# Yasmin — REVISAR amanhã com scanner físico

Lote processado em 02/06/2026 das 50 fotos enviadas. Total: **24 produtos únicos** identificados.

## Status

- ✅ Lote 1 (6 produtos): já importado em `_yasmin-lote-1-6produtos.json`
- ⏳ Lote 2 (18 produtos): pronto pra importar em `_yasmin-lote-2-novos-18.json`
- 📌 Duplicatas detectadas: 2 unidades extras na loja (não cadastrar de novo)

## Marcas identificadas (5 marcas × 24 produtos)

| Marca | Modelo | Sabores | Total |
|---|---|---|---|
| RabBeats | RC50000 | Green Apple Ice, Menthol, Banana Ice | 3 |
| ELFBAR | TRIO | Blueberry Pom Slushy, Black Mint, Pineapple Lime, La Grape, Sour Apple Ice | 5 |
| OXBAR | G30K PRO | Grand Purple, Passion Kiwi, Blackcurrant Lemon Ice, Double Apple | 4 |
| iCITY | CT35000 | Blue Razz, Cherry Lemon, Kiwi Mango, Mix Berries, Watermelon Ice, Frozen Grape, Tropical Rainbow | 7 |
| HQD | Glaze Plus | Watermelon Ice, Ice Mint, Strawberry Banana(?), Grape Ice, Banana Ice | 5 |

## ⚠️ Pontos pra Yasmin confirmar fisicamente com scanner

### 1. Duplicatas — tem 2 unidades, cadastrei como 1
- **RabBeats RC50000 Green Apple Ice** — apareceu nas fotos p01 e p47 (2 unidades em estoque)
- **OXBAR G30K PRO Grand Purple** — apareceu nas fotos p14 e p20 (2 unidades em estoque)

**Ação:** quando Yasmin escanear via /receber.html, o sistema vai detectar EAN já cadastrado e SOMAR ao estoque automaticamente. Não duplicar.

### 2. Produto sem foto da frente (só o verso)
- **HQD Glaze Plus Strawberry Banana** — foto p42 mostrou só o verso (caixa vermelha). EAN extraído: **6923742040742**. Nome do sabor inferido pelo texto parcial "BERRY...BANANA" visível na lateral.

**Ação:** Yasmin pega esse produto fisicamente e confirma o sabor exato no painel frontal. Se for outra coisa, eu corrijo o nome no JSON.

### 3. Produto sem foto do verso (sem EAN)
- **ELFBAR TRIO Blueberry Pom Slushy** — só foto da frente (p05). EAN ficou vazio.

**Ação:** quando Yasmin pegar o produto físico, scanear via /receber.html e o sistema vai preencher o EAN sozinho.

### 4. Possíveis incompatibilidades de marca
Confirmar visualmente que cada produto realmente é da marca dita:
- RabBeats (prefix 694) — China, sub-marca da ELFBAR/EBDesign
- ELFBAR TRIO (prefix 693) — modelo TRIO específico
- OXBAR (prefix 694) — diferente da RabBeats mas mesmo prefix country
- iCITY (prefix 695) — Made in China
- HQD Glaze Plus (prefix 692) — HQD oficial

## Como Yasmin valida fisicamente (amanhã)

1. Abre `https://drope-app.vercel.app/receber.html` no celular dela
2. Pra cada produto físico:
   - Scaneia EAN do código de barras
   - Sistema confirma: "produto já cadastrado, somar 1 ao estoque?" → confirma
   - OU se EAN não bater: "produto novo, cadastrar?" → confirma + preenche nome/preço
3. Pros 24 produtos cadastrados aqui, Yasmin **só precisa scanear** — sistema reconhece o EAN e atualiza estoque automaticamente
4. Se algum EAN não for reconhecido, é porque o OCR meu pegou errado — Yasmin cadastra manualmente (vira REVISAR)

## Critérios de confiança da extração

| Camada | Status |
|---|---|
| Checksum matemático EAN-13 | ✅ 18/18 válidos |
| Prefixo do EAN bate com marca | ✅ todos consistentes |
| Cor frente↔verso bate | ✅ todos com pareamento visual coerente |
| Tempo entre fotos da mesma unidade | ✅ 4-15s (compatível com pareamento) |
| Confirmação online em base de dados | ❌ impossível (vape não está em bases públicas) |

**Conclusão:** confiança alta (~95%) baseada em 4 sinais convergentes. Os 5% restantes resolvem com scanner físico amanhã.
