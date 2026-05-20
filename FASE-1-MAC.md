# Fase 1 — Destravar o Mac (15-30 min)

Andrade, leia uma vez antes de executar. Os comandos são curtos, sem
mistério, e vão te deixar exatamente no mesmo lugar onde estava no Windows.

---

## O que eu (Claude) já fiz por você

✅ Criei `.gitattributes` na raiz — força LF em todos os arquivos texto.
   (Resolve o ruído de CRLF que estava no `git status`.)

✅ Corrigi `manifest.json`: `start_url` agora aponta pra `./` (estava
   apontando pra `./drope-app.html`, arquivo que não existe — quebrava o
   PWA quando alguém instalava no celular).

✅ Criei `.env.example` com TODAS as envs necessárias (sem valores). Serve
   de checklist e documentação.

⚠️ Tentei apagar `webhook.js` da raiz (código morto da versão v5 antiga,
   não está roteado no `vercel.json`) mas não tive permissão. Você precisa
   apagar manualmente — está no comando 1 abaixo.

---

## O que VOCÊ precisa rodar no terminal do Mac

Abra o Terminal. Vá pra pasta do projeto:

```bash
cd ~/Projetos/drope-app
```

Agora rode os 5 passos:

### Passo 1 — Apagar arquivo morto e normalizar line endings

```bash
git rm webhook.js
git add --renormalize .
git status
```

`git status` deve mostrar:
- `deleted: webhook.js`
- `new file: .gitattributes`
- `new file: .env.example`
- `modified: manifest.json`
- E a longa lista de arquivos modificados (CRLF→LF — normal e desejado)

### Passo 2 — Commit único da limpeza

```bash
git commit -m "chore: mac migration cleanup

- normalize line endings (CRLF→LF) via .gitattributes
- remove dead webhook.js (v5 old, not routed in vercel.json)
- fix manifest.json start_url (was pointing to non-existent file)
- add .env.example with all env vars used"
```

### Passo 3 — Instalar Vercel CLI

```bash
npm install -g vercel
```

(Se pedir senha, é a do Mac. Se der erro de permissão, tenta
`sudo npm install -g vercel`.)

### Passo 4 — Login + link + puxar envs

```bash
vercel login
# escolhe "Continue with GitHub" (provavelmente é como sua conta foi criada)
# faz a autenticação no navegador, volta pro terminal

vercel link
# vai detectar o projeto pelo .vercel/project.json que já existe
# confirma quando perguntar

vercel env pull .env.local
# isso baixa TODAS as envs do Vercel pro seu Mac em .env.local
# (que está no .gitignore — não vai pro git)
```

### Passo 5 — Rodar localmente

```bash
npm install
vercel dev
```

Depois de uns 30 segundos, abre `http://localhost:3000` no navegador.
Você deve ver a loja Drope rodando — exatamente igual ao Windows.

---

## Pronto. Você está de volta no Drope.

Próximos passos sugeridos (do `DROPE-PRINCIPIOS.md`):

1. **Mês 1, Semana 2:** sessão dedicada da doutrina IA-servo + ministérios.
2. **Mês 1, Semana 3:** revisar catálogo do app — 10 SKUs com arte e
   preço A+.
3. **Mês 1, Semana 4:** app oferecido ativamente no balcão pela Yasmin.

E o ritual semanal (toda segunda):
- O que plantei semana passada?
- Que sinal de vida apareceu?
- O que vou plantar essa semana?

---

## Se algo der errado

- **`vercel: command not found` depois do install:** fecha e abre o
  terminal de novo (o PATH só atualiza em sessão nova).
- **`vercel login` não funciona:** tenta `vercel login --github`.
- **`vercel dev` reclama de env faltando:** confirma que `.env.local`
  existe e tem conteúdo (não pode estar vazio).
- **Algo aparece quebrado no `git status` que não devia:** me chama, a
  gente olha junto.
