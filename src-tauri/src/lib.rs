//! The Qimah Al-Safinah ERP, as a Windows application.
//!
//! This shell runs **no part of the ERP**. The ledger, the documents, the
//! permissions and the Postgres row-level security all stay on the server, and
//! that is the whole design: the application's security depends on the server
//! being the only thing that sets `app.user_id`, `app.branch_code` and
//! `app.is_super_user` on a transaction. A desktop build that carried database
//! credentials could set those itself, so it does not carry them. There is no
//! database driver in this binary and no copy of the business logic.
//!
//! What it adds over a browser tab is the part a browser cannot give: a signed
//! installer, its own icon and window, a session that survives a restart, saved
//! downloads that land somewhere predictable, and an update it can install
//! itself.
//!
//! ── The boot page ─────────────────────────────────────────────────────────
//! The window opens on a small bundled page rather than straight at the server.
//! That page probes the server and then navigates to it. Opening directly on
//! the URL would mean that a laptop away from the network — or a server being
//! restarted mid-deploy — got WebView2's own error page, which says
//! `ERR_NAME_NOT_RESOLVED` and offers nothing. The boot page says which address
//! it tried and offers Retry.

mod download;

use tauri::webview::DownloadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Where the ERP lives.
///
/// Overridable at build time so a developer can point the shell at their own
/// `next dev`, and at run time so support can aim a single installed copy at a
/// staging host without a rebuild. Neither path lets a *page* choose the host:
/// the value is read here, before any web content is loaded.
fn server_url() -> String {
    if let Ok(from_env) = std::env::var("QS_ERP_URL") {
        if !from_env.trim().is_empty() {
            return from_env.trim().to_string();
        }
    }
    option_env!("QS_ERP_URL")
        .unwrap_or("https://erp.qs-groups.com")
        .to_string()
}

/// The address the boot page should send the window to, handed over as a
/// window-level global rather than as a query string, so it never appears in a
/// URL that could be bookmarked or logged.
#[tauri::command]
fn erp_url() -> String {
    server_url()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![erp_url])
        .setup(|app| {
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("Qimah Al-Safinah ERP")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 680.0)
            .center()
            .resizable(true)
            // Visible immediately: the bundled boot page IS the splash, and it
            // is branded, so there is nothing to hide. A window held back until
            // the server answers is a window that never opens when it does not.
            .visible(true)
            .zoom_hotkeys_enabled(true)
            // Where a Print / Export copy lands. Without this the ERP's export
            // feature looks broken in a desktop window — see download.rs.
            .on_download(|webview, event| match event {
                DownloadEvent::Requested { destination, .. } => {
                    download::to_downloads(&webview, destination)
                }
                _ => true,
            })
            .build()?;

            // Kept so the window is not dropped; everything else it does is
            // driven by the web content.
            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the ERP desktop shell failed to start");
}
