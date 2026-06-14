# Onde parei — Cadastro Yasmin (02/06/2026)

## Status atual

- ✅ Acesso à pasta Downloads concedido
- ✅ 50 fotos identificadas em 2 pastas (yasmim 1: 41 fotos, yasmim 2: 9 fotos)
- ✅ Copiadas pra `outputs/yasmim-batch/p01.jpeg` até `p50.jpeg`
- ✅ Lidas: p01 a p11 (11 fotos = 6 produtos identificados)
- ⏸️ Pausado: p12 a p50 (39 fotos = ~19 produtos restantes a processar)

## 6 produtos processados (validados via checksum + cor + timestamp)

JSON pronto em: `_yasmin-lote-1-6produtos.json`

1. RabBeats RC50000 Green Apple Ice — EAN 6941976228910 ✅
2. RabBeats RC50000 Menthol — EAN 6941976228972 ✅
3. ELFBAR TRIO Blueberry Pom Slushy — sem EAN (verso não fotografado)
4. ELFBAR TRIO Black Mint — EAN 6932570176288 ✅
5. ELFBAR TRIO Pineapple Lime — EAN 6932570176387 ✅
6. ELFBAR TRIO La Grape — EAN 6932570176394 ✅

## Pendente do Andrade antes de retomar

1. **Validar importação dos 6** — abrir admin → "importar drops em lote" → colar JSON → confirmar que aparecem em "gerenciar drops"
2. **Definir preço de cada produto** — vai ditar pra mim ou colocar manualmente via admin depois
3. **Confirmar estratégia pra produto 3 (Blueberry Pom Slushy sem EAN)** — Yasmin tira foto do verso, ou cadastrar sem EAN e ela scaneia depois

## Padrão descoberto das fotos

- Cada produto = 2 fotos (FRENTE com info + VERSO com EAN)
- Algumas vezes a Yasmin esqueceu o verso (ex.: produto 3 — Blueberry)
- Tempo entre fotos do mesmo produto: 4-8 segundos
- Tempo entre produtos diferentes: 15-70 segundos (gap maior)

## Plano pra retomar

1. Andrade volta ao chat
2. Confirma se import dos 6 funcionou
3. Eu continuo lendo p12 a p50 em batches
4. Vou validando: cor frente↔verso + checksum EAN + tempo
5. Pra cada pareamento duvidoso, marco em REVISAR.md
6. Output final: JSON único com 20-25 produtos prontos pra importar

## Limites realistas da validação (decisão de arquiteto)

- Vape EAN NÃO está em bancos públicos (UPCitemdb, Open Food Facts não cobrem)
- Validação possível:
  - ✅ Checksum matemático EAN-13
  - ✅ Prefixo do EAN bate com marca (694 = RabBeats CH, 693 = ELFBAR CH)
  - ✅ Cor frente↔verso bate
  - ✅ Tempo proximidade (4-8s = mesma unidade)
- Certeza 100% só com scanner físico (Yasmin via `/receber.html`)
