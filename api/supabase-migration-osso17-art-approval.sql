-- Drope — Migration Osso 17: aprovação de arte no WhatsApp
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: arte gerada pelo OpenAI gpt-image-1 às vezes não fica boa.
-- Lucas precisa aprovar antes da arte virar imagem oficial. Estados novos:
--   'awaiting_approval' — arte gerada, esperando Lucas. image_url usa foto provisória
--                          (caixa). pending_art_url no metadata tem a arte candidata.
--   Outros estados continuam: 'ok', 'pending_regeneration', 'error', 'generating'.

-- Drop + recreate constraint pra adicionar 'awaiting_approval'
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'drope_products_image_status_check'
  ) then
    alter table public.drope_products drop constraint drope_products_image_status_check;
  end if;
end $$;

alter table public.drope_products
  add constraint drope_products_image_status_check
  check (image_status in ('ok', 'pending_regeneration', 'error', 'generating', 'awaiting_approval'));

-- Índice pra query "produtos esperando aprovação de arte" (pode crescer)
create index if not exists drope_products_image_status_idx
  on public.drope_products (image_status)
  where image_status = 'awaiting_approval';

-- Validação
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'drope_products_image_status_check';
