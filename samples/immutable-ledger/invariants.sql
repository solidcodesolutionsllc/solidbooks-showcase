-- Ledger invariants enforced by PostgreSQL itself.
--
-- The application validates every entry first (see ../double-entry), but the
-- database is the last line of defense: no code path, script or future bug
-- can commit an unbalanced entry or rewrite history.
--
-- Custom SQLSTATE codes let the API map each violation to a precise error:
--   SB001 unbalanced entry   SB002 immutable ledger row   SB006 sealed entry
--
-- Adapted from the SolidBooks production migrations. © Solid Code Solutions LLC.

-- 1. Balanced entries --------------------------------------------------------
-- Checked at COMMIT (a deferred constraint trigger), so an entry's header and
-- lines can be inserted in any order inside one transaction, but the
-- transaction cannot commit unless every entry it touched balances.
CREATE FUNCTION ledger_check_entry(p_entry_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_no bigint;
  v_lines    integer;
  v_debit    numeric;
  v_credit   numeric;
BEGIN
  SELECT entry_no INTO v_entry_no FROM journal_entries WHERE id = p_entry_id;
  SELECT count(*), coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0)
    INTO v_lines, v_debit, v_credit
    FROM journal_lines WHERE entry_id = p_entry_id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s); at least 2 are required', v_entry_no, v_lines
      USING ERRCODE = 'SB001';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits % (cents)',
      v_entry_no, v_debit, v_credit
      USING ERRCODE = 'SB001';
  END IF;
END;
$$;

CREATE FUNCTION journal_entries_check_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_check_entry(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION journal_lines_check_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_check_entry(NEW.entry_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entries_check_balanced();

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_lines_check_balanced();

-- 2. Sealed entries ----------------------------------------------------------
-- Lines can only be added by the transaction that created the entry. Without
-- this, a later transaction could append a balanced pair of lines to an old
-- entry and change history without ever unbalancing it.
CREATE FUNCTION journal_lines_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT created_txid FROM journal_entries WHERE id = NEW.entry_id)
     IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'lines can only be added to a journal entry in the transaction that created it'
      USING ERRCODE = 'SB006';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_lines_guard_insert
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard_insert();

-- 3. Immutability ------------------------------------------------------------
-- Posted lines are never updated or deleted, and entries are never deleted.
-- A correction is a reversing entry, so the ledger keeps the full history.
CREATE FUNCTION ledger_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: % is not allowed (post a reversal instead)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'SB002';
END;
$$;

CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();

CREATE TRIGGER journal_lines_no_truncate
  BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change();

CREATE TRIGGER journal_entries_no_delete
  BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();

CREATE TRIGGER journal_entries_no_truncate
  BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change();

-- 4. Reversal is the only change an entry accepts ------------------------------
-- A posted entry may be marked reversed exactly once, and only by pointing at
-- the entry that actually reverses it. Every other column is frozen.
CREATE FUNCTION journal_entries_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.entry_no, NEW.date, NEW.memo, NEW.reverses_entry_id,
      NEW.created_txid, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.entry_no, OLD.date, OLD.memo, OLD.reverses_entry_id,
      OLD.created_txid, OLD.created_at) THEN
    RAISE EXCEPTION 'journal entry % is immutable: only its reversal status can change', OLD.entry_no
      USING ERRCODE = 'SB002';
  END IF;
  IF OLD.status = 'posted' AND NEW.status = 'reversed'
     AND OLD.reversed_by_entry_id IS NULL AND NEW.reversed_by_entry_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM journal_entries r
                 WHERE r.id = NEW.reversed_by_entry_id AND r.reverses_entry_id = OLD.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'journal entry % can only be marked reversed once, by the entry that reverses it',
    OLD.entry_no
    USING ERRCODE = 'SB002';
END;
$$;

CREATE TRIGGER journal_entries_guard_update
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard_update();
