-- ============================================================
-- DROPE — OSSO 36: HARDENING DE SEGURANÇA (RLS + policies)
-- ============================================================
-- Contexto: auditoria de segurança (22/07/2026). A chave pública (anon),
-- que fica embutida no app, conseguia LER e em alguns casos ESCREVER dados
-- sensíveis direto no banco. Como o app (cliente e painel do lojista) usa
-- SEMPRE o backend /api (service_role, que ignora RLS), nenhuma das regras
-- anon abaixo é usada pelo app — elas eram só superfície de ataque.
--
-- Já aplicado em produção via Management API. Este arquivo é o registro.
-- Idempotente.
-- ============================================================

-- 1) Tabelas que estavam SEM RLS (anon podia ler tudo) -----------------------
alter table public.drope_filiais                enable row level security; -- CRÍTICO: guardava hash de senha + pagamento das lojas
alter table public.drope_ambassadors           enable row level security; -- nome/telefone
alter table public.drope_ambassador_commissions enable row level security; -- comissões/valores
alter table public.drope_balancos              enable row level security; -- contagem de estoque
alter table public.drope_cep_cache             enable row level security; -- cache de CEP

-- 2) drope_orders: policies anon perigosas ----------------------------------
--    - select_by_token: "por token" mas na prática permitia ler TODOS os
--      pedidos (nome/telefone/endereço do cliente = PII).
--    - update_payment: qual=true → anon podia ALTERAR qualquer pedido.
--    - insert: anon podia criar pedido direto.
--    O fluxo real de pedido é todo via /api (save-order, webhook, get-order).
drop policy if exists drope_orders_anon_select_by_token on public.drope_orders;
drop policy if exists drope_orders_anon_update_payment  on public.drope_orders;
drop policy if exists drope_orders_anon_insert          on public.drope_orders;

-- 3) drope_customers: anon não deve escrever PII ----------------------------
drop policy if exists drope_customers_anon_insert       on public.drope_customers;
drop policy if exists drope_customers_anon_update_self  on public.drope_customers;

-- 4) drope_products: anon lia custo/margem (cost_cents) + metadata do lojista
--    O catálogo público é servido via /api?action=catalog (service_role),
--    então o app não precisa dessa leitura anon.
drop policy if exists drope_products_anon_select_public on public.drope_products;

-- Resultado esperado: anon lê 0 linhas em orders/products/customers/filiais/
-- ambassadors/commissions/balancos/cep_cache. Backend (service_role) segue
-- lendo/escrevendo normal. App verificado (catálogo/lojas/checkout via /api).

-- ============================================================
-- PARTE 2 (mesma auditoria): camada LEGADA sem prefixo drope_
-- ============================================================
-- Tabelas antigas (adapter de sincronização legado do cliente) tinham
-- policies role=public de SELECT/INSERT/UPDATE — anon lia E escrevia
-- config da loja (pix/whats), cupons, e produtos legados. O app usa
-- localStorage (primário) + /api (dados reais em drope_*), então trancar
-- só remove a sincronização anon (degrada de boa pro localStorage).
drop policy if exists "public read store"     on public.store_config;
drop policy if exists "public write store"    on public.store_config;
drop policy if exists "public update store"   on public.store_config;
drop policy if exists "public read coupons"   on public.coupons;
drop policy if exists "public write coupons"  on public.coupons;
drop policy if exists "public update coupons" on public.coupons;
drop policy if exists "public read orders"    on public.orders;
drop policy if exists "public insert orders"  on public.orders;
drop policy if exists "public update orders"  on public.orders;
drop policy if exists "public read customers"   on public.customers;
drop policy if exists "public insert customers" on public.customers;
drop policy if exists "public update customers" on public.customers;
drop policy if exists "public read products"   on public.products;
drop policy if exists "public write products"  on public.products;
drop policy if exists "public update products" on public.products;

-- Resultado final verificado: NENHUMA tabela do schema public retorna
-- dados via chave anon. Todo acesso é via /api (service_role).
