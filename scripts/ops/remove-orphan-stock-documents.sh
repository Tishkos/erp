#!/usr/bin/env bash
#
# Remove stock documents that have no ledger rows behind them — the remnants a
# maintenance script leaves when it deletes inventory_movement and not the
# document table (2026-09-27: TRF-HQ-2026-000001, TRF-HQ-2026-000002 and
# ADJ-HQ-2026-000001 on erp.qs-groups.com).
#
#   scripts/ops/remove-orphan-stock-documents.sh TRF-HQ-2026-000001 ...        what would go
#   scripts/ops/remove-orphan-stock-documents.sh --yes TRF-HQ-2026-000001 ...  back up, then remove
#
# Run from the project root on your own machine. It reaches the server over
# ssh the way deploy.sh does.
#
# ── Why remove rather than re-create the movements ────────────────────────
# A Transfer's movements are OUT of one warehouse and IN to another, of stock
# that a Purchase Invoice put there. When the movements were deleted so were
# the purchase, the journals and the audit trail; the stock those transfers
# moved does not exist on the system in any form. Writing an OUT of 150 from a
# warehouse that now holds 80 would drive it negative — which the deferred
# trigger refuses — and an IN of 150 elsewhere would be stock nobody bought.
# The document is the last piece of a run that was formatted away; completing
# the format is the repair.
#
# ── What it refuses ───────────────────────────────────────────────────────
# A document that has any movement at all. Every number given must name a
# Transfer or a Reconciliation, and each must have zero rows in
# inventory_movement — checked inside the same transaction as the delete, so
# nothing can change between the check and the act.
#
# ── What it leaves ────────────────────────────────────────────────────────
# One audit_event per document, with the whole row as before_value, so what
# was removed and why can be read for as long as the audit trail lives.
#
set -euo pipefail

ERP_SSH="${ERP_SSH:-root@31.97.123.206}"
APP="${APP:-/opt/qs-erp-next}"

MODE=""
if [[ "${1:-}" == "--yes" ]]; then MODE="--yes"; shift; fi
if [[ $# -eq 0 ]]; then
  echo "Usage: $0 [--yes] DOCUMENT_NO [DOCUMENT_NO ...]" >&2
  exit 2
fi
for no in "$@"; do
  if [[ ! "$no" =~ ^(TRF|ADJ)-[A-Z0-9]+-[0-9]{4}-[0-9]{6}$ ]]; then
    echo "'$no' is not a Transfer (TRF-…) or Reconciliation (ADJ-…) number." >&2
    exit 2
  fi
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# The numbers as a SQL array literal: quoted, comma-separated.
NUMBERS=$(printf "'%s'," "$@"); NUMBERS="array[${NUMBERS%,}]"

# What each named document is and whether the ledger holds it. The same
# query is the preview, the guard and the after-report.
read -r -d '' REPORT_SQL <<SQL || true
select rpad(kind, 18) || rpad(document_no, 22) || rpad(branch_code, 6)
       || lpad(quantity, 14) || '  movements: ' || movements::text
       || case when movements = 0 then '  <- orphan, would be removed' else '  <- HAS LEDGER ROWS, refused' end
  from (
    select 'stock_transfer' as kind, t.transfer_no as document_no, t.branch_code,
           t.quantity::text as quantity,
           (select count(*) from inventory_movement m
             where m.source_document_type = 'stock_transfer'
               and m.source_document_id = t.id::text) as movements
      from stock_transfer t where t.transfer_no = any ($NUMBERS)
    union all
    select 'stock_adjustment', a.adjustment_no, a.branch_code, a.quantity::text,
           (select count(*) from inventory_movement m
             where m.source_document_type = 'stock_adjustment'
               and m.source_document_id = a.id::text)
      from stock_adjustment a where a.adjustment_no = any ($NUMBERS)
  ) d
 order by 1;
select 'named but not found: ' || n
  from unnest($NUMBERS) as n
 where n not in (select transfer_no from stock_transfer)
   and n not in (select adjustment_no from stock_adjustment);
SQL

say "The documents named — nothing is being changed"
ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
export PGPASSWORD=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
psql -h 127.0.0.1 -p 5434 -U erp_owner -d erp -tA -v ON_ERROR_STOP=1 <<'SQL'
select set_config('app.is_super_user', 'true', false);
$REPORT_SQL
SQL
REMOTE

if [[ "$MODE" != "--yes" ]]; then
  echo
  echo "Nothing was changed. Run with --yes to back up and remove the orphans."
  exit 0
fi

say "Backing up, then removing"
ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
STAMP=\$(date -u +%Y%m%d-%H%M%S)
export PGPASSWORD=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
psql() { command psql -h 127.0.0.1 -p 5434 -U erp_owner -d erp "\$@"; }

mkdir -p /root/erp-backups
pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc \
  -f "/root/erp-backups/erp-before-orphan-removal-\$STAMP.dump"
ls -la "/root/erp-backups/erp-before-orphan-removal-\$STAMP.dump"

psql -v ON_ERROR_STOP=1 <<'SQL'
begin;

-- The tables force row-level security and the policies open on this flag.
-- Transaction-local, so it ends with the transaction.
select set_config('app.is_super_user', 'true', true);

do \$\$
declare
  v_no    text;
  v_row   record;
  v_moved integer;
begin
  foreach v_no in array $NUMBERS loop
    -- A Transfer.
    select * into v_row from stock_transfer where transfer_no = v_no for update;
    if found then
      select count(*) into v_moved from inventory_movement m
       where m.source_document_type = 'stock_transfer' and m.source_document_id = v_row.id::text;
      if v_moved <> 0 then
        raise exception '% has % movement(s) in the ledger. It is not an orphan and is left alone.', v_no, v_moved;
      end if;
      insert into audit_event (actor_user_id, action, object_type, object_id, branch_code,
                               before_value, after_value, reason, outcome)
      values (null, 'stock_transfer.orphan_removed', 'warehouse_transfer', v_row.id::text, v_row.branch_code,
              to_jsonb(v_row), null,
              'Removed by scripts/ops/remove-orphan-stock-documents.sh: the document had no rows in '
              || 'inventory_movement. Its movements, the purchase behind them, the journals and the audit '
              || 'trail were deleted by format-live-database.sh on 2026-09-27, which did not list '
              || 'stock_transfer; the stock it moved no longer exists on the system.',
              'success');
      delete from stock_transfer where id = v_row.id;
      raise notice 'removed % (transfer %, % -> %, qty %)', v_no, v_row.id, v_row.from_warehouse_code, v_row.to_warehouse_code, v_row.quantity;
      continue;
    end if;

    -- A Reconciliation.
    select * into v_row from stock_adjustment where adjustment_no = v_no for update;
    if found then
      select count(*) into v_moved from inventory_movement m
       where m.source_document_type = 'stock_adjustment' and m.source_document_id = v_row.id::text;
      if v_moved <> 0 then
        raise exception '% has % movement(s) in the ledger. It is not an orphan and is left alone.', v_no, v_moved;
      end if;
      insert into audit_event (actor_user_id, action, object_type, object_id, branch_code,
                               before_value, after_value, reason, outcome)
      values (null, 'stock_adjustment.orphan_removed', 'stock_reconciliation', v_row.id::text, v_row.branch_code,
              to_jsonb(v_row), null,
              'Removed by scripts/ops/remove-orphan-stock-documents.sh: the document had no rows in '
              || 'inventory_movement and its journal_entry_id names a journal that no longer exists. '
              || 'Both were deleted by format-live-database.sh on 2026-09-27, which did not list '
              || 'stock_adjustment; the stock it adjusted no longer exists on the system.',
              'success');
      delete from stock_adjustment where id = v_row.id;
      raise notice 'removed % (reconciliation %, % % in %, qty %)', v_no, v_row.id, v_row.direction, v_row.item_code, v_row.warehouse_code, v_row.quantity;
      continue;
    end if;

    raise exception 'No Transfer or Reconciliation is numbered %.', v_no;
  end loop;
end \$\$;

commit;
SQL
REMOTE

say "What is left of the numbers named (should be nothing)"
ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
export PGPASSWORD=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
psql -h 127.0.0.1 -p 5434 -U erp_owner -d erp -tA -v ON_ERROR_STOP=1 <<'SQL'
select set_config('app.is_super_user', 'true', false);
$REPORT_SQL
select 'audit: ' || action || ' ' || object_id || ' at ' || occurred_at::text
  from audit_event where action in ('stock_transfer.orphan_removed', 'stock_adjustment.orphan_removed')
 order by id;
SQL
REMOTE
