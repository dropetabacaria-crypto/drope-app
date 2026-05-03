-- Drope — Migration Osso 19: adiciona 'pending_art' ao image_status
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: endpoint desacoplado /api/generate-pending-arts precisa de um status
-- 'pending_art' pra marcar produtos que precisam de arte mas ainda não começaram
-- a gerar. Diferente de 'generating' (que indica geração em andamento).

-- Drop constraint antiga e recria com o valor novo
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
  check (image_status in ('ok', 'pending_art', 'pending_regeneration', 'error', 'generating', 'awaiting_approval'));

-- Atualiza produtos que ficaram presos com 'generating' pra 'pending_art'
-- (tentativas antigas que deram timeout e nunca completaram)
update public.drope_products
set image_status = 'pending_art'
where image_status = 'generating';

-- Verifica
select image_status, count(*)
from public.drope_products
group by image_status
order by image_status;
