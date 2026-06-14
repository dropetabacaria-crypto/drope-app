# DROPE — Teste End-to-End como Cliente

**Objetivo:** simular uma compra completa pelo app como se fosse cliente novo. Identificar TODA fricção. Não consertar nada agora — só listar pra virar sprint de quarta antes do lançamento.

**Como fazer:**
1. Abre o app numa **janela anônima** (Cmd+Shift+N) — pra simular cliente novo, sem cache
2. URL: `https://drope-app.vercel.app` (SEM o `/#admin`)
3. Segue os passos na ordem
4. Pra cada passo: anota o que **te incomodou**, **te confundiu**, ou **demorou demais**
5. Se travar em algum passo, anota EXATAMENTE onde travou

---

## Roteiro — 10 etapas

### Etapa 1: Primeira impressão (10 segundos)
- O que tu vê primeiro ao abrir o app?
- Tá claro o que é, pra quê serve?
- Tem algum carregamento estranho, pop-up, splash demorada?

### Etapa 2: Cadastro/Login (se exigido)
- Pediu cadastro logo de cara ou deixou tu navegar primeiro?
- Quais dados pediu? Foi rápido?
- Algum campo confuso?

### Etapa 3: Navegação no catálogo
- Quantos produtos aparecem?
- As imagens carregam? (ou aparecem emojis/placeholder?)
- Os preços tão visíveis?
- Tem filtro? Funciona?

### Etapa 4: Abrir um produto
- Clica em qualquer produto. O que aparece na tela de detalhe?
- Tem foto? Descrição? Preço? Estoque?
- Tem botão "comprar"/"adicionar ao carrinho"? Tá claro?

### Etapa 5: Testar o "esgotado — me avise via whats" (deploy de hoje)
- Acha algum produto com estoque 0 (ou força um colocando manualmente no admin)
- Clica nele → o botão deve dizer **"📲 esgotado — me avise via whats"**
- Clica no botão → DEVE abrir o WhatsApp com mensagem pré-preenchida
- Confere: a mensagem tá certa? O número da loja tá certo?

### Etapa 6: Adicionar ao carrinho
- Volta pra um produto com estoque
- Clica em "quero levar"
- Vai pro carrinho? Aparece confirmação? Toast?

### Etapa 7: Ver o carrinho
- Mostra o produto certo, quantidade certa, preço certo?
- Total tá calculado certo?
- Dá pra mudar quantidade?
- Dá pra remover?

### Etapa 8: Checkout
- Clica em "ir pro checkout" (ou similar)
- Quais dados pediu? Nome, endereço, telefone?
- Tem opção de entrega vs retirada?
- Tem campo de cupom?

### Etapa 9: Pagamento Pix
- Aparece QR Code? Chave Pix? Valor certo?
- Tem instrução clara do que fazer depois de pagar?
- Tem botão "já paguei, mandei comprovante"?

### Etapa 10: Confirmação
- Depois de "comprar", aparece tela de pedido confirmado?
- Mostra número do pedido?
- Tem instrução de "te avisamos quando separar/entregar"?

---

## Onde anotar a fricção (template)

Pra cada problema que tu encontrar, copia esse bloco e preenche:

```
ETAPA: [número da etapa onde aconteceu]
O QUE: [descrição curta do problema]
GRAVIDADE: [bloqueador / chato / cosmético]
EVIDÊNCIA: [screenshot se possível, ou frase exata]
```

Exemplo:
```
ETAPA: 5
O QUE: Botão de "esgotado - me avise" abriu WhatsApp mas mandou pro número errado
GRAVIDADE: bloqueador
EVIDÊNCIA: WhatsApp abriu pro número +55 11 9XXX em vez do oficial da loja
```

---

## Critério de "tá pronto pra lançar"

- **Zero bloqueadores** → cliente consegue completar compra até o Pix
- **≤ 3 chatos** → cliente pode reclamar mas não desiste
- **Cosméticos podem ficar** → resolve depois do primeiro pedido real

Se hit isso → **LANÇA QUARTA** (manda WhatsApp pros 5).
Se NÃO hit → corrigir bloqueadores no terça/quarta de manhã, lançar quarta à tarde.
