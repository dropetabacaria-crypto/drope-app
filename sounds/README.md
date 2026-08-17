# Sons do DROPE 🦎 (voz do camaleão)

Cada notificação tem uma **PASTA**. Jogue os MP3 (uma ou várias variações) DENTRO
da pasta certa. O nome do arquivo pode ser qualquer um (`1.mp3`, `2.mp3`, ...).
Quando há mais de uma variação, o app **sorteia uma** a cada vez.

## Loja (painel do lojista)
| Pasta | Fala |
|---|---|
| `venda-drope/` | Venda no Drópi! |

## Cliente (app)
| Pasta | Fala |
|---|---|
| `cli-pago/` | Pagamento confirmado! |
| `cli-aceito/` | Oba! A loja aceitou seu pedido. |
| `cli-preparo/` | Seu pedido tá sendo preparado! |
| `cli-saiu/` | Seu pedido saiu pra entrega! |
| `cli-motoca-chegando/` | O motoca tá chegando! |
| `cli-motoca-chegou/` | O motoca chegou! Corre lá. |
| `cli-retirada/` | Seu pedido tá pronto pra retirada! |
| `cli-entregue/` | Pedido entregue! Bom proveito. |

---
Depois de jogar os arquivos nas pastas, avise o Claude. Ele vai:
1. Listar os arquivos de cada pasta e montar o índice (manifest),
2. Ligar cada som no evento certo (loja no painel + cliente no app), com sorteio
   de variação,
3. Fazer o deploy.

Os arquivos ficam acessíveis em `https://drope-app.vercel.app/sounds/<pasta>/<arquivo>.mp3`.
