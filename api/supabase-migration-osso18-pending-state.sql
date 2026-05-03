-- Drope — Migration Osso 18: pending state persistente cross-instance
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: o Map em-memória pendingRegistrations não sobrevive cold-start
-- do Vercel. Lucas começa cadastro, recebe preview, demora 5min pra responder
-- "sim" → instance nova, Map zerado, "sim" cai no menu de comandos.
--
-- Solução: tabela KV simples persistindo o state do flow do Lucas. setPending
-- escreve aqui (upsert), getPending lê daqui em fallback se memory zerou,
-- clearPending deleta. TTL controlado em código (filtro updated_at > now()-30min).

create table if not exists public.drope_pending_state (
    phone      text primary key,
    state      jsonb not null,
    updated_at timestamptz not null default now()
);

create index if not exists drope_pending_state_updated_idx
  on public.drope_pending_state (updated_at);

alter table public.drope_pending_state disable row level security;

-- Cleanup periódico (rodar manual quando precisar):
--   delete from drope_pending_state where updated_at < now() - interval '1 hour';

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'drope_pending_state'
order by ordinal_position;
