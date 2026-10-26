CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  national_id TEXT,
  account_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  kyc_status TEXT NOT NULL DEFAULT 'Not started',
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS national_id TEXT;
CREATE INDEX IF NOT EXISTS customers_national_id_idx ON customers(national_id);

CREATE TABLE IF NOT EXISTS system_users (
  email TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  role_key TEXT NOT NULL,
  initials TEXT NOT NULL,
  account JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loan_applications (
  application_id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(customer_id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  submitted_on DATE,
  record JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS loan_applications_customer_idx ON loan_applications(customer_id);
CREATE INDEX IF NOT EXISTS loan_applications_status_idx ON loan_applications(status);

CREATE TABLE IF NOT EXISTS repayments (
  payment_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES loan_applications(application_id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  received_on DATE,
  record JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS repayments_application_idx ON repayments(application_id);
CREATE INDEX IF NOT EXISTS repayments_received_on_idx ON repayments(received_on);

CREATE TABLE IF NOT EXISTS core_repayments (
  payment_id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(customer_id) ON DELETE SET NULL,
  account_id TEXT NOT NULL,
  received_on DATE,
  amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  reference TEXT NOT NULL DEFAULT '',
  record JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS core_repayments_customer_idx ON core_repayments(customer_id);
CREATE INDEX IF NOT EXISTS core_repayments_account_idx ON core_repayments(account_id);
CREATE INDEX IF NOT EXISTS core_repayments_received_on_idx ON core_repayments(received_on);

CREATE TABLE IF NOT EXISTS loan_attachments (
  attachment_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES loan_applications(application_id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Supporting document',
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size BIGINT NOT NULL DEFAULT 0,
  contents BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS loan_attachments_application_idx ON loan_attachments(application_id);

CREATE TABLE IF NOT EXISTS team_messages (
  message_id TEXT PRIMARY KEY,
  sender_username TEXT NOT NULL,
  recipient_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  record JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS team_messages_thread_idx ON team_messages(sender_username, recipient_username, created_at);

CREATE TABLE IF NOT EXISTS team_chat_presence (
  email TEXT NOT NULL,
  session_id TEXT NOT NULL,
  is_online BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, session_id)
);

CREATE INDEX IF NOT EXISTS team_chat_presence_email_idx ON team_chat_presence(email, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS team_calls (
  call_id TEXT PRIMARY KEY,
  room_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_call_members (
  call_id TEXT NOT NULL REFERENCES team_calls(call_id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (call_id, username)
);

CREATE TABLE IF NOT EXISTS team_call_signals (
  signal_id BIGSERIAL PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES team_calls(call_id) ON DELETE CASCADE,
  sender_username TEXT NOT NULL,
  recipient_username TEXT,
  signal_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS team_call_signals_call_idx ON team_call_signals(call_id, signal_id);
CREATE INDEX IF NOT EXISTS team_call_signals_retention_idx ON team_call_signals(created_at);