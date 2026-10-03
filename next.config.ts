import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// §25 — the localisation architecture is in place from the first screen, even
// though §1.1 fixes English as the only launch language. See src/i18n/config.ts.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  // Standalone output so the app deploys as a long-running container.
  //
  // TECHSTACK.md B2 risk register: the posting path must NOT run on a
  // serverless or edge runtime. §24 requires journal, subledger and inventory
  // writes to commit atomically in one transaction, which needs a stable
  // connection and row locks held across statements.
  output: 'standalone',

  // The document libraries are loaded by Node as they ship rather than
  // bundled into every route that exports: the PDF library reads its own font
  // metrics from beside its code (bundled, those paths no longer exist), and
  // the Word and Excel writers are large enough that compiling them into each
  // export route exhausts the development server's memory.
  serverExternalPackages: ['pdfkit', 'fontkit', 'docx', 'write-excel-file'],

  // Print and export read the embedded Arabic font, the print logo and the
  // DRAFT watermark from disk (src/server/print/assets.ts), so the standalone
  // build must carry them.
  outputFileTracingIncludes: {
    '/**': ['./src/server/print/assets/**/*'],
  },

  typescript: {
    // Type errors fail the build. A release carries "test evidence" (§25);
    // a build that ignores type errors is not evidence.
    ignoreBuildErrors: false,
  },

  // REQ-IMPROVE-001 OP-2 — every build carries the deploy's id, so a browser
  // holding the previous build's chunks asks for them under the old id and
  // gets a reload instead of a 404 after an atomic swap. deploy.sh exports it;
  // /healthz reports it.
  ...(process.env.DEPLOYMENT_ID ? { deploymentId: process.env.DEPLOYMENT_ID } : {}),
  /*
   * A second development server, for looking at a scratch database without
   * disturbing the one somebody is working in (2026-10-03). `next dev` keeps
   * one lock per build directory, so moving the directory is what lets two
   * run: `NEXT_DIST_DIR=.next-cycle PORT=3200 npm run dev`. Unset in every
   * ordinary run, which is every run but that one.
   */
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),


  experimental: {
    // The domain layer is plain TypeScript and must never be bundled into a
    // client component. Anything reaching it goes through the server.
    serverActions: {
      // REQ-IMPROVE-001 OP-9 — the one limit the attachment policy
      // (domain/attachments.ts DEFAULT_MAX_BYTES, 25 MB) and the Excel
      // paste blocks (§7.2, §8.3) both fit under; nginx's
      // client_max_body_size says the same (deploy/nginx.example.conf).
      bodySizeLimit: '26mb',
    },
  },

  async redirects() {
    return [
      /*
       * Loans moved out of Payables into Treasury (2026-10-03). A loan is money
       * borrowed from a bank and repaid from a bank account, which is where the
       * menu always showed it. The old address still opens the register, so a
       * bookmark or a link in somebody's mail keeps working.
       */
      { source: '/payables/loans', destination: '/treasury/loans', permanent: true },
      { source: '/payables/loans/:path*', destination: '/treasury/loans/:path*', permanent: true },
      {
        source: '/purchasing/ap-invoices/:path*',
        destination: '/payables/invoices/:path*',
        permanent: true,
      },
      {
        source: '/purchasing/payables',
        destination: '/payables/open-items',
        permanent: true,
      },
      {
        source: '/purchasing/:path*',
        destination: '/payables/:path*',
        permanent: true,
      },
      {
        source: '/master-data/customers',
        destination: '/sales/customers',
        permanent: true,
      },
      {
        source: '/master-data/customers/:code',
        destination: '/sales/customers/:code',
        permanent: true,
      },
      {
        source: '/master-data/suppliers',
        destination: '/payables/suppliers',
        permanent: true,
      },
      {
        source: '/master-data/suppliers/:code',
        destination: '/payables/suppliers/:code',
        permanent: true,
      },
      {
        source: '/master-data/items',
        destination: '/inventory/items',
        permanent: true,
      },
      {
        source: '/master-data/items/:code',
        destination: '/inventory/items/:code',
        permanent: true,
      },
      {
        source: '/master-data/uom',
        destination: '/inventory/uom',
        permanent: true,
      },
      {
        source: '/master-data/uom/:code',
        destination: '/inventory/uom/:code',
        permanent: true,
      },
      {
        source: '/master-data/business-partners',
        destination: '/sales/customers',
        permanent: true,
      },
      {
        source: '/master-data/business-partners/:code',
        destination: '/sales/customers/:code',
        permanent: true,
      },
    ];
  },

  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/sales/customers',
          destination: '/master-data/customers',
        },
        {
          source: '/sales/customers/:code',
          destination: '/master-data/business-partners/:code',
        },
        {
          source: '/payables/suppliers',
          destination: '/master-data/suppliers',
        },
        {
          source: '/payables/suppliers/:code',
          destination: '/master-data/business-partners/:code',
        },
        {
          source: '/inventory/items',
          destination: '/master-data/items',
        },
        {
          source: '/inventory/items/:code',
          destination: '/master-data/items/:code',
        },
        {
          source: '/inventory/uom',
          destination: '/master-data/uom',
        },
        {
          source: '/inventory/uom/:code',
          destination: '/master-data/uom/:code',
        },
      ],
    };
  },
};

export default withNextIntl(config);
