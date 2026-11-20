// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Diagnostics::Debug::{
            GetErrorMode, SetErrorMode, SEM_FAILCRITICALERRORS,
        };

        // Child processes inherit the process error mode. Let debugger probes
        // return loader errors without blocking on a system dialog.
        unsafe { SetErrorMode(GetErrorMode() | SEM_FAILCRITICALERRORS) };
    }

    app_lib::run();
}
