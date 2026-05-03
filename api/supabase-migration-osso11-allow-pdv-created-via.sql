-- Drope — Migration Osso 11: Permitir 'pdv' como created_via
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: a check constraint do osso9 só aceita 'manual' | 'admin' | 'whatsapp_agent'.
-- O PDV precisa marcar produtos cadastrados pelo balcão como 'pdv' pra distinguir
-- de cadastros via /admin web. Esta migration adiciona 'pdv' à lista permitida.
--
-- Aprovado: Andrade, 2026-04-29.

-- Drop + recreate (Postgres não tem ALTER CHECK CONSTRAINT direto)
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'drope_products_created_via_check'
  ) then
    alter table public.drope_products drop constraint drope_products_created_via_check;
  end if;
end $$;

alter table public.drope_products
  add constraint drope_products_created_via_check
  check (created_via in ('manual', 'admin', 'whatsapp_agent', 'pdv'));

-- Validação
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conname = 'drope_products_created_via_check';
