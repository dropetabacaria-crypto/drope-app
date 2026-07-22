-- ============================================================
-- DROPE — OSSO 37: LOGIN DO CLIENTE POR OTP (WhatsApp)
-- ============================================================
-- Fecha o último vetor: antes o histórico/perfil do cliente era buscável
-- só com o telefone (sem verificação). Agora exige token de sessão emitido
-- após confirmar um código enviado no WhatsApp. Idempotente.
-- ============================================================

-- Códigos OTP (backend-only; nunca lido pela anon).
create table if not exists public.drope_otp (
  phone text primary key,
  code_hash text not null,          -- sha256 do código (nunca guarda o código puro)
  expires_at timestamptz not null,
  attempts int not null default 0,
  last_sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.drope_otp enable row level security;  -- sem policy = só service_role

-- Sessão do cliente no drope_customers.
alter table public.drope_customers add column if not exists session_hash text;      -- sha256 do token de sessão
alter table public.drope_customers add column if not exists session_exp timestamptz; -- validade (60 dias)

-- Endpoints (webhook.js): otp_request (envia código), otp_verify (emite token).
-- customer_orders / home_personalized / customer_profile passaram a exigir o token.
