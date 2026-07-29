# Pendências pra fazer com o Andrade

Coisas que dependem do Andrade (acesso, decisão de negócio/compliance ou código que ele fez). Fazer quando ele estiver junto.

---

## 1. Pagamento automático da indicação + entregador (motor de Pix-out)
**Contexto:** a fundação já está pronta no código (`_pixPayout()` em `api/webhook.js` é o ponto único de saída de dinheiro; loja já define a oferta de indicação; chave Pix já é capturada). Falta a parte que move dinheiro de verdade.

- [ ] **Escolher e abrir o provedor de Pix-out** (payout via API): avaliar **Transfeera** x **Celcoin**. KYC/contrato.
- [ ] **Compliance BACEN:** conta individualizada, **sem conta-bolsão** (o provedor resolve white-label — confirmar).
- [ ] Depois de escolhido: setar env `PAYOUT_PROVIDER` na Vercel + integrar o provedor dentro de `_pixPayout()`.
- [ ] **Reter a fatia do indicador no split** do Mercado Pago (application_fee dinâmico) — assim o DROPE tem o dinheiro pra repassar. Eu faço o código; depende do provedor definido.
- [ ] **Cron semanal** que paga os indicadores/entregadores acima do piso e marca como pago.
> Enquanto isso, o "marcar pago" manual no painel funciona como rede de segurança.

## 2. WhatsApp — migrar pro OFICIAL (Meta Cloud API) — decisão tomada
O uazapi (dropepod) morreu (503) e o grátis apaga instância em 1h. Decisão: parar de depender disso e ir pro **WhatsApp Cloud API oficial da Meta**. Base no código **já está pronta** (pluggable): é só ligar as variáveis quando a conta Meta existir. Hoje está **desligado** (`WHATSAPP_PROVIDER=off`) — o app roda sem WhatsApp.

**Custos:** conta Meta e API **grátis** (sem mensalidade). Paga só por msg: OTP ~R$0,17 · aviso de pedido ~R$0,04 (grátis em 24h) · começo ~R$5–15/mês, escala com a venda. Precisa **cartão** na Meta.

**O que precisa providenciar (Andrade/Lucas):**
- [ ] Conta **Meta Business** (Facebook)
- [ ] **CNPJ próprio do DROPE** (ainda não tem) + dados pra verificação
- [ ] **Número/chip dedicado** (fora do WhatsApp normal) pros avisos
- [ ] **Cartão** cadastrado na Meta (cobrança por msg)
- [ ] Verificação do negócio + aprovação dos modelos (uns dias, lado Meta)

**Quando a conta existir, é comigo:** setar `WHATSAPP_PROVIDER=cloud`, `WA_CLOUD_TOKEN`, `WA_PHONE_NUMBER_ID` na Vercel, criar os templates (OTP/avisos) e testar. Já existe `sendWhatsAppTemplate()` pronto.

## 3. Teste real do split do Mercado Pago (Fase 2 — Pix no app)
- [ ] Precisa de uma **2ª conta MP real** da Santos (o Lucas ia passar). Testar o split de ponta a ponta com dinheiro real.

## 4. Tirar o hardcode single-tenant (sinal verde já dado)
- [ ] Remover as gambiarras single-tenant que o Andrade deixou, pra virar multi-loja de verdade. App profissional, sem gambiarra daqui pra frente.

## 5. Endurecer segurança (estava pausado de propósito)
- [ ] Rever RLS / regras de acesso com o Andrade quando o app já estiver funcional. Foco atual é funcionar; endurecer depois.

## 6. Modelo de pagamento estilo iFood (coletar + repassar) — conversa com o Rafael (29/07)
Hoje: split via Mercado Pago (cada loja conecta o PSP dela; loja sem MP não vende). Funciona pra lançar.
Futuro (jeito iFood, pra NÃO obrigar a loja a ter PSP): o DROPE **recebe todo o dinheiro** numa conta própria (1 adquirente/PSP) e **repassa** pra cada loja (Pix/TED) via **provedor de payout** (Transfeera/Celcoin), descontando a comissão. A loja só informa **conta bancária/chave Pix** — não conecta PSP nenhum.
- [ ] Escolher provedor de payout (Pix-out pra terceiros) — `_pixPayout` em webhook.js já é o esqueleto.
- [ ] Resolver o lado regulatório/contábil (arranjo de pagamento, BACEN, impostos, antifraude, chargeback) — é o que pesa.
- Obs: iFood usa Adyen + "iFood Pago" (instituição de pagamento própria) por trás. É referência de **modelo**, não de fornecedor.

---
_Atualizar esta lista conforme as coisas forem resolvidas._
