-- ============================================================
-- DROPE — OSSO 9: AGENTE CADASTRO WHATSAPP
-- ============================================================
-- Adiciona colunas necessárias pro fluxo de cadastro automático
-- via foto pelo WhatsApp do Andrade. Idempotente.
--
-- Briefing: briefing-agente-cadastro-serie.md
-- Voz: prompts-imagem-video-drope.md (Padrão A+ híbrido)
-- ============================================================

alter table drope_products
  add column if not exists descricao_quebrada text,
  add column if not exists image_status      text default 'ok',
  add column if not exists cores_predominantes text,
  add column if not exists created_via       text default 'manual';

-- Constraint pra image_status (valores válidos)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'drope_products_image_status_check'
  ) then
    alter table drope_products
      add constraint drope_products_image_status_check
      check (image_status in ('ok', 'pending_regeneration', 'error', 'generating'));
  end if;
end $$;

-- Constraint pra created_via (valores válidos)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'drope_products_created_via_check'
  ) then
    alter table drope_products
      add constraint drope_products_created_via_check
      check (created_via in ('manual', 'admin', 'whatsapp_agent'));
  end if;
end $$;

-- Índice pra busca case-insensitive por (marca, modelo, sabor) usada no UPSERT do agente
create index if not exists drope_products_lookup_idx
  on drope_products (lower(name));

-- Validação
select
  column_name,
  data_type,
  column_default,
  is_nullable
from information_schema.columns
where table_schema='public'
  and table_name='drope_products'
  and column_name in ('descricao_quebrada','image_status','cores_predominantes','created_via')
order by column_name;
