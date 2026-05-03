-- Drope — Migration Osso 15: dedup persistente cross-instance
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: dedup em-memória (Map global do módulo) não sobrevive entre
-- instâncias Vercel. Quando UazAPI manda 2 eventos quase simultâneos do mesmo
-- input, eles podem cair em instances diferentes e ambos passam o filtro.
-- Esta tabela + função fazem dedup persistente com TTL configurável.

create table if not exists public.drope_dedup (
    phone     text not null,
    sig       text not null,
    seen_at   timestamptz not null default now(),
    primary key (phone, sig)
);

create index if not exists idx_drope_dedup_seen_at
  on public.drope_dedup (seen_at);

alter table public.drope_dedup disable row level security;

-- Função atômica: retorna true se (phone, sig) foi visto nos últimos p_ttl segundos.
-- Senão, registra/atualiza seen_at e retorna false. Usa LOCK FOR UPDATE pra evitar
-- race entre 2 instances Vercel processando o mesmo evento simultâneo.
create or replace function public.drope_check_dedup(p_phone text, p_sig text, p_ttl int)
returns boolean as $$
declare
  v_now      timestamptz := now();
  v_existing timestamptz;
begin
  -- Busca + lock
  select seen_at into v_existing
  from public.drope_dedup
  where phone = p_phone and sig = p_sig
  for update;

  if found and v_existing > v_now - (p_ttl || ' seconds')::interval then
    -- Visto recentemente — é duplicata
    return true;
  end if;

  -- Não duplicata: insere ou atualiza
  insert into public.drope_dedup (phone, sig, seen_at)
  values (p_phone, p_sig, v_now)
  on conflict (phone, sig) do update set seen_at = v_now;

  return false;
end;
$$ language plpgsql;

-- Cleanup: remove rows antigas (>1h). Pode rodar via cron-job externo, ou
-- chamar manualmente. Pra MVP, cleanup leve aqui mesmo no momento de check
-- não vale a pena (latência). Roda esta query periodicamente:
--   delete from public.drope_dedup where seen_at < now() - interval '1 hour';

-- Validação
select
  proname,
  pg_get_function_arguments(oid) as args,
  pg_get_function_result(oid) as returns
from pg_proc
where proname = 'drope_check_dedup';
