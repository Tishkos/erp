//! Where a Print / Export copy lands.
//!
//! In a browser this is solved for you. In a WebView2 host it is not: without
//! a handler, pressing "PDF" on a document either does nothing visible or
//! drops the file somewhere the person cannot find, and the ERP's whole export
//! feature appears broken. So the shell decides, once, and predictably.
//!
//! The rule is the one every browser uses, because it is the one people
//! already know: the system Downloads folder, the file name the server chose
//! (it sets `Content-Disposition`, so the name is already
//! `API-BGW-2026-000041.pdf` rather than a hash), and a numbered suffix rather
//! than overwriting a copy that is already there. Nobody loses yesterday's
//! statement by exporting today's.

use std::path::{Path, PathBuf};

use tauri::{Manager, Runtime};

/// The name to save under, given one that may already be taken.
///
/// `Invoice.pdf`, then `Invoice (2).pdf`, then `Invoice (3).pdf`. Stops at a
/// hundred rather than looping forever if something pathological is happening
/// in the folder — at that point saving beside the original is still better
/// than hanging the download.
fn free_name(directory: &Path, file_name: &str) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("download");
    let extension = path.extension().and_then(|s| s.to_str());

    for n in 2..=100 {
        let next = match extension {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = directory.join(next);
        if !candidate.exists() {
            return candidate;
        }
    }
    candidate
}

/// Redirects a download to the Downloads folder, under a free name.
///
/// Answers `false` only when there is no Downloads folder to speak of, which
/// lets WebView2 fall back to its own behaviour rather than the shell
/// swallowing the file.
pub fn to_downloads<R: Runtime>(webview: &tauri::Webview<R>, destination: &mut PathBuf) -> bool {
    let Ok(downloads) = webview.path().download_dir() else {
        return true; // no Downloads folder: let the host decide
    };

    // WebView2 has already derived the file name from `Content-Disposition`,
    // which the export route sets — see `src/server/print/route.ts`. Taking it
    // from the destination keeps that name rather than inventing one from the
    // URL, which for `/export/stock_ledger?...` would be meaningless.
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download")
        .to_string();

    *destination = free_name(&downloads, &file_name);
    true
}
