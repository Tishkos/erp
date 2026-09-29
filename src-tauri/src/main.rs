// Windows: no console window behind the application in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    qs_erp_desktop_lib::run()
}
