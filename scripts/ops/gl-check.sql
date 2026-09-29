-- Why a bank or cash account cannot be linked to a G/L account.
-- Read-only. Safe against production.

\echo '== every bank/cash account and the G/L account it carries =='
select a.code,
       a.account_type,
       a.active,
       coalesce(c.code, '** G/L ACCOUNT MISSING **') as gl_account,
       c.name as gl_name
  from bank_cash_account a
  left join chart_of_account c on c.id = a.gl_account_id
 order by a.code;

\echo '== how many G/L accounts the picker can offer =='
select count(*) as offerable
  from chart_of_account c
 where c.account_type = 'asset'
   and not c.is_group
   and c.is_active
   and c.approval_status = 'approved'
   and not exists (select 1 from bank_cash_account b where b.gl_account_id = c.id);

\echo '== and where the rest fall out =='
select count(*) filter (where c.account_type = 'asset') as asset_accounts,
       count(*) filter (where c.account_type = 'asset' and not c.is_group) as posting_accounts,
       count(*) filter (where c.account_type = 'asset' and not c.is_group and c.is_active) as active_posting,
       count(*) filter (where c.account_type = 'asset' and not c.is_group and c.is_active
                          and c.approval_status = 'approved') as approved_active_posting,
       count(*) filter (where c.account_type = 'asset' and not c.is_group and c.is_active
                          and c.approval_status = 'approved'
                          and exists (select 1 from bank_cash_account b where b.gl_account_id = c.id))
         as already_carried
  from chart_of_account c;

\echo '== G/L accounts held by a retired account, which nothing can release =='
select b.code as held_by, b.active, c.code as gl_account, c.name
  from bank_cash_account b
  join chart_of_account c on c.id = b.gl_account_id
 where not b.active
 order by c.code;
