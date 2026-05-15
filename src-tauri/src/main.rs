// Prevents an extra console window on Windows in release builds.
// Without this every Auracle Desktop launch opens a black cmd.exe.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    auracle_desktop_lib::run()
}
