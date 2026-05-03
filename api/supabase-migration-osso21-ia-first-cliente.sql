-- ============================================================
-- OSSO 21 — IA-FIRST CLIENTE (01/05/2026)
-- ============================================================
-- Suporta as 5 features do drop "instrucao-meka-ia-first-cliente.md":
--   1. Homepage personalizada (cliente novo vs recorrente)
--   2. Recompra em 1 toque (last_product_id, last_delivery_address)
--   3. Filtro de vibe (flavor_category nos produtos)
--   4. Perfil de sabor (flavor_profile JSONB no cliente)
--   5. Drops inteligentes (drope_drop_notifications + cron)
--
-- Tudo idempotente (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================

-- 1. flavor_category + total_sold nos produtos ---------------
ALTER TABLE drope_products
  ADD COLUMN IF NOT EXISTS flavor_category TEXT DEFAULT 'other';

-- total_sold = soma de quantidades já vendidas (alimentado por save-order
-- e infinitepay-webhook). Permite ordenar catálogo por popularidade.
ALTER TABLE drope_products
  ADD COLUMN IF NOT EXISTS total_sold INTEGER DEFAULT 0;

-- index pra filtro do catálogo
CREATE INDEX IF NOT EXISTS idx_drope_products_flavor_category
  ON drope_products(flavor_category)
  WHERE hidden = false;

-- index pra ordenar por popularidade
CREATE INDEX IF NOT EXISTS idx_drope_products_total_sold
  ON drope_products(total_sold DESC NULLS LAST)
  WHERE hidden = false;

-- ============================================================
-- FUNÇÃO RPC: incrementa total_sold de um produto
-- ============================================================
-- Chamada pelo save-order.js após cada pedido criado com sucesso.
-- Idempotência fica a cargo do caller (já tem dedup por order_nsu).
CREATE OR REPLACE FUNCTION drope_increment_total_sold(p_slug TEXT, p_qty INTEGER)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE drope_products
  SET total_sold = COALESCE(total_sold, 0) + GREATEST(0, p_qty)
  WHERE slug = p_slug;
END;
$$;

-- 2. campos do perfil de cliente ------------------------------
ALTER TABLE drope_customers
  ADD COLUMN IF NOT EXISTS flavor_profile JSONB DEFAULT '{}';
ALTER TABLE drope_customers
  ADD COLUMN IF NOT EXISTS favorite_brand TEXT;
ALTER TABLE drope_customers
  ADD COLUMN IF NOT EXISTS favorite_flavor TEXT;
ALTER TABLE drope_customers
  ADD COLUMN IF NOT EXISTS total_orders INTEGER DEFAULT 0;
ALTER TABLE drope_customers
  ADD COLUMN IF NOT EXISTS last_order_date TIMESTAMPTZ;
ALTER TABLE drope_customers
  ADD COLUMN IF NOT EXISTS last_product_id BIGINT;
ALTER TABLE drope_customers
  ADD COLUMN IF NOT EXISTS last_delivery_address JSONB DEFAULT NULL;

-- 3. tabela de notificações de drop ---------------------------
-- IDs do schema legado são BIGINT (não UUID) — match com drope_customers/products.
CREATE TABLE IF NOT EXISTS drope_drop_notifications (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES drope_customers(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES drope_products(id) ON DELETE CASCADE,
  match_reason TEXT,
  status TEXT DEFAULT 'pending',
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- dedup (mesmo cliente+produto = 1 notificação só)
CREATE UNIQUE INDEX IF NOT EXISTS idx_drop_notif_dedup
  ON drope_drop_notifications(customer_id, product_id);

-- index pro cron varrer pendentes rápido
CREATE INDEX IF NOT EXISTS idx_drop_notif_pending
  ON drope_drop_notifications(status, scheduled_for)
  WHERE status = 'pending';

-- ============================================================
-- BACKFILL (manual ou via Vision no quick_register futuro)
-- ============================================================
-- Heurística inicial pra produtos já cadastrados — usa o nome
-- pra inferir flavor_category. Roda 1x; depois disso, novos
-- produtos são classificados no quick_register.
UPDATE drope_products
SET flavor_category = CASE
  WHEN flavor_category IS NOT NULL AND flavor_category <> 'other' THEN flavor_category
  WHEN name ILIKE '%mint%' OR name ILIKE '%menta%' OR name ILIKE '%hortela%'
       OR name ILIKE '%hortelã%' OR name ILIKE '%menthol%' THEN 'menthol'
  WHEN name ILIKE '%ice%' OR name ILIKE '%gelo%' OR name ILIKE '%frost%'
       OR name ILIKE '%cool%' OR name ILIKE '%frio%' THEN 'icy'
  WHEN name ILIKE '%cream%' OR name ILIKE '%creme%' OR name ILIKE '%vanilla%'
       OR name ILIKE '%baunilha%' OR name ILIKE '%chocolate%' OR name ILIKE '%caramelo%'
       OR name ILIKE '%caramel%' OR name ILIKE '%doce%' OR name ILIKE '%bubblegum%'
       OR name ILIKE '%cotton candy%' OR name ILIKE '%algodao%' THEN 'sweet'
  WHEN name ILIKE '%tobacco%' OR name ILIKE '%tabaco%' OR name ILIKE '%cuban%' THEN 'tobacco'
  WHEN name ILIKE '%mango%' OR name ILIKE '%manga%' OR name ILIKE '%morango%'
       OR name ILIKE '%strawberry%' OR name ILIKE '%apple%' OR name ILIKE '%maca%'
       OR name ILIKE '%maçã%' OR name ILIKE '%uva%' OR name ILIKE '%grape%'
       OR name ILIKE '%melancia%' OR name ILIKE '%watermelon%' OR name ILIKE '%pessego%'
       OR name ILIKE '%pêssego%' OR name ILIKE '%peach%' OR name ILIKE '%abacaxi%'
       OR name ILIKE '%pineapple%' OR name ILIKE '%limao%' OR name ILIKE '%limão%'
       OR name ILIKE '%lemon%' OR name ILIKE '%lima%' OR name ILIKE '%blueberry%'
       OR name ILIKE '%mirtilo%' OR name ILIKE '%cereja%' OR name ILIKE '%cherry%'
       OR name ILIKE '%maracuja%' OR name ILIKE '%maracujá%' OR name ILIKE '%passion%'
       OR name ILIKE '%coco%' OR name ILIKE '%coconut%' OR name ILIKE '%pera%'
       OR name ILIKE '%pear%' OR name ILIKE '%banana%' OR name ILIKE '%pitaya%'
       OR name ILIKE '%dragon%' OR name ILIKE '%berry%' OR name ILIKE '%fruit%'
       OR name ILIKE '%fruta%' OR name ILIKE '%tropical%' THEN 'fruity'
  ELSE COALESCE(flavor_category, 'other')
END
WHERE flavor_category IS NULL OR flavor_category = 'other';
