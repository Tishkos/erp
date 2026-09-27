-- Setup check: see docs/SETUP-CHECKLIST.md for what each result should be.
-- Read-only. Run: psql "$DATABASE_URL_OWNER" -f docs/setup-check.sql

\echo 1. Shipment-stage warehouses (want 3 rows)
select shipment_stage, code, name from warehouse where shipment_stage is not null order by shipment_stage;
\echo 2. CEO users (want at least 1)
select u.email, u.display_name from app_user u join user_role r on r.user_id = u.id where r.role_code = 'ceo' and u.is_active;
\echo 3. Open period for today (want 1, status open)
select name, status from fiscal_period where current_date between starts_on and ends_on;
\echo 4. USD exchange rate (want 1)
select currency_code, iqd_per_unit, effective_from from exchange_rate where currency_code = 'USD' order by effective_from desc limit 1;
\echo 5. Missing posting mappings (want 0)
select m.event_type, m.line_role from (values
 ('purchasing.ap_invoice','supplier_payable'),('purchasing.ap_invoice','grni'),('purchasing.ap_invoice','expense'),('purchasing.ap_invoice','purchase_variance'),
 ('sales.ar_invoice','customer_receivable'),('sales.ar_invoice','sales_revenue'),
 ('sales.customer_receipt','customer_receivable'),('sales.customer_receipt','customer_clearing'),
 ('sales.customer_receipt_identified','customer_clearing'),('sales.customer_receipt_identified','customer_receivable'),
 ('purchasing.supplier_payment','supplier_payable'),
 ('purchasing.supplier_credit_memo','supplier_payable'),('purchasing.supplier_credit_memo','return_clearing'),
 ('sales.customer_credit_memo','customer_receivable'),('sales.customer_credit_memo','sales_returns'),
 ('inventory.opening_stock','opening_balance'),('inventory.stock_adjustment','inventory_adjustment')
) as m(event_type, line_role)
where not exists (select 1 from posting_rule p where p.event_type = m.event_type and p.line_role = m.line_role and p.is_active);
\echo 6. Stock items missing an Inventory or COGS account (want 0)
select code, name from item where is_stock and active and (inventory_account_id is null or cogs_account_id is null);
\echo 7. Bank or cash accounts with no ledger account (want 0)
select code, name from bank_cash_account where gl_account_id is null;
\echo 8. Active users with no branch (want 0)
select email from app_user u where is_active and not exists (select 1 from user_branch_scope s where s.user_id = u.id);
\echo 9. Users notified of status changes, per branch
select branch_code, count(*) from shipment_watcher group by branch_code;
\echo 10. Latest applied migration (want 1795900000017 or later)
select max(created_at) from drizzle.__drizzle_migrations;
