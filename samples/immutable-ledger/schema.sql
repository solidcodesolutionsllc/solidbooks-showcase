-- A minimal ledger schema for this sample. The production schema is larger
-- (contacts, sources, cash-basis lines, lock dates, audit events, ...); only
-- what the invariants below need is kept here.

CREATE TABLE accounts (
  id   text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense'))
);

CREATE TABLE journal_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_no             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  date                 date NOT NULL,
  memo                 text,
  status               text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reverses_entry_id    uuid UNIQUE REFERENCES journal_entries (id),
  reversed_by_entry_id uuid UNIQUE REFERENCES journal_entries (id),
  -- The transaction that created the entry: only it may add lines (see invariants.sql).
  created_txid         bigint NOT NULL DEFAULT txid_current(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reversal_state CHECK ((status = 'reversed') = (reversed_by_entry_id IS NOT NULL))
);

CREATE TABLE journal_lines (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id     uuid NOT NULL REFERENCES journal_entries (id),
  line_no      integer NOT NULL,
  account_id   text NOT NULL REFERENCES accounts (id),
  debit_cents  bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  CONSTRAINT one_side CHECK ((debit_cents > 0) <> (credit_cents > 0)),
  UNIQUE (entry_id, line_no)
);
