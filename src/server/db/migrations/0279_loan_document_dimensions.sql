-- A loan belongs to the company, not to a department.
--
-- By direction, 2026-10-04, on trying to settle one:
--
--   Account X000026 requires Department / Cost Centre. Supply the missing
--   value(s) and post again.
--
-- X000026 is "Interest on loans". An expense account asks for a department by
-- the §4.2 type default, and nothing had ever said otherwise for a bank loan —
-- so the interest line of a repayment, a settlement or a commission had no
-- answer to give and the posting was refused. The loan has no department to
-- name: the money is borrowed by the company and repaid by the company.
--
-- `document_type_dimension` is where that is said, and it is already how the
-- business line was made optional for these documents in the test fixtures. The
-- same, now in the product, for the three treasury documents whose money is the
-- company's own: a bank loan, a transfer between its own accounts, and a
-- receipt of money arriving.
--
-- Optional, not forbidden: anybody who *wants* to carry a department on one may
-- still do it, and the line will keep it.

INSERT INTO document_type_dimension (document_type_code, dimension, requirement)
SELECT d.code, v.dimension, 'optional'
  FROM (VALUES ('bank_loan'), ('bank_transfer'), ('other_receipt')) AS d(code)
 CROSS JOIN (VALUES ('department'::dimension_type), ('business_line'::dimension_type)) AS v(dimension)
    ON CONFLICT (document_type_code, dimension)
    DO UPDATE SET requirement = 'optional';
