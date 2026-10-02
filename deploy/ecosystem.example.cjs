// pm2 process file for QS ERP — REQ-IMPROVE-001 OP-9 / OP-12.
//
// The live copy is /opt/qs-erp-next/ecosystem.config.cjs on the VPS, outside
// git because it carries the port and the environment of that host. This is
// its record; keep the two the same (RUNBOOK-host-build.md).
//
//   * script is the absolute path of the standalone server deploy.sh swaps
//     into place — pm2 runs the file, so a symlinked-releases scheme would
//     leave it on the old code.
//   * max_memory_restart and --max-old-space-size bound a leak or an export
//     that grew past the row cap (OP-9); the restart is logged by pm2.
//   * HOSTNAME=127.0.0.1 keeps the app off the public interface; nginx is
//     the only way in.
module.exports = {
  apps: [
    {
      name: 'qs-erp',
      cwd: '/opt/qs-erp-next',
      script: '/opt/qs-erp-next/.next/standalone/server.js',
      node_args: '--max-old-space-size=1536',
      max_memory_restart: '1800M',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 15000,
      env: {
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: 3200,
        // DATABASE_URL, AUTH_SECRET, ATTACHMENT_DIR and the rest come from
        // /opt/qs-erp-next/.env, which deploy.sh sources before `pm2 restart
        // --update-env`. Nothing secret is written here.
      },
      error_file: '/var/log/qs-erp/pm2-error.log',
      out_file: '/var/log/qs-erp/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
