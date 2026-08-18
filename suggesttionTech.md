Layer	Pick	Why for this doc
Framework	Next.js 16 (16.3 is the current supported release) 
Abhs
	Fine. Use Server Actions for mutations, but keep all domain logic in /server/domain — §23 requires the API to enforce identical validations, so you need one code path, not two
Database	PostgreSQL 17	This is your product. Transactions = §24 atomic posting. numeric(19,4) = money. RLS = branch/dept scope. Advisory locks = gapless document numbering. Triggers + REVOKE UPDATE/DELETE = §5.4 immutable audit. Unique partial index on idempotency key = §23 duplicate prevention
ORM	Drizzle	SQL-first, real transaction blocks. You'll be hand-writing the FIFO layer consumption and posting queries anyway. Prisma if your team is less SQL-comfortable — it's safer for juniors but abstracts things that bite at scale
Admin scaffolding	Payload CMS	It's Next.js-native and installs directly into your /app folder, 
CodeCudos
 giving you admin UI, auth, field-level access control, versioning and S3 uploads for free
Transactional screens	shadcn/ui + Tailwind + TanStack Table	Hand-built
Excel-paste grids	AG Grid Enterprise or Handsontable	§7.2 and §8.3 explicitly require multi-line clipboard paste with validation. Don't hand-roll this
Workflow + jobs	Inngest	Approvals, escalations, depreciation runs, recurring journals, period-close checklists, integration retry/dead-letter queues. Step functions with built-in idempotency and cron. Temporal if you want harder durability guarantees; pg-boss if you want to stay Postgres-only
Auth	better-auth or WorkOS	§25 mandates MFA for privileged roles and immediate session revocation — buy this
Authorization	CASL, enforced in the service layer	Your matrix is (View/Create/Edit Draft/Submit/Approve/Execute/Post/Reverse) × (branch, department). OpenFGA if it gets more relational
Reporting	Metabase + Cube	See below
Files	S3/R2 + presigned URLs, store SHA-256 + version	§21 needs immutable posted evidence, versioning, expiring external link
please use https://github.com/shadcn-ui/ui