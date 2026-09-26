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

  experimental: {
    // The domain layer is plain TypeScript and must never be bundled into a
    // client component. Anything reaching it goes through the server.
    serverActions: {
      bodySizeLimit: '4mb', // Excel paste blocks — §7.2, §8.3
    },
  },
};

export default withNextIntl(config);
