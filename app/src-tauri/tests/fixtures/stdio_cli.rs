// Offline native stdio fixture. Never launches a model or reads user config.
use std::io::{BufRead, Write};

#[link(name = "kernel32")]
extern "system" {
    fn GetStdHandle(which: u32) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

fn close_stdout_and_linger() -> ! {
    std::io::stdout().flush().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert_ne!(unsafe { CloseHandle(GetStdHandle((-11_i32) as u32)) }, 0);
    loop { std::thread::sleep(std::time::Duration::from_secs(1)); }
}

fn main() {
    if std::env::args().any(|arg| arg == "--help") {
        println!("fixture app server --stdio --input-format stream-json");
        return;
    }
    let mode = std::env::var("UGS_TEST_STDOUT_MODE").unwrap();
    std::fs::write("transport-started", "native fixture").unwrap();
    if mode == "claude-closed-input" {
        unsafe { CloseHandle(GetStdHandle((-10_i32) as u32)); }
        std::thread::sleep(std::time::Duration::from_millis(200));
        return;
    }
    if mode == "slow-claude" {
        println!("{}", r#"{"type":"system","subtype":"init"}"#);
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3000));
        let mut input = String::new();
        std::io::stdin().lock().read_line(&mut input).unwrap();
        if input.len() > 250_000 && input.ends_with('\n') {
            println!("{}", r#"{"type":"result","result":"fixture complete"}"#);
        }
        return;
    }
    if mode == "stream-complete" || mode == "stream-failed" || mode == "clean-exit" {
        if mode == "stream-failed" {
            println!("{}", r#"{"type":"result","is_error":true,"result":"fixture upstream failed"}"#);
        } else if mode == "stream-complete" {
            println!("{}", r#"{"type":"result","result":"fixture complete"}"#);
        } else {
            println!("{}", r#"{"type":"assistant","message":{"content":[{"type":"text","text":"fixture complete"}]}}"#);
            std::io::stdout().flush().unwrap();
            unsafe { CloseHandle(GetStdHandle((-11_i32) as u32)); }
            std::thread::sleep(std::time::Duration::from_millis(100));
            std::process::exit(0);
        }
        close_stdout_and_linger();
    }
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.contains("\"method\":\"initialize\"") {
            if mode == "initial-eof" { close_stdout_and_linger(); }
            println!("{}", r#"{"id":"ugs-init","result":{}}"#);
        } else if line.contains("\"method\":\"thread/start\"") {
            println!("{}", r#"{"id":"ugs-thread-start","result":{"thread":{"id":"fixture-thread"}}}"#);
        } else if line.contains("\"method\":\"turn/start\"") {
            std::fs::write("turn-started", "fixture handshake").unwrap();
            println!("{}", r#"{"id":"ugs-turn-start","result":{"turn":{"id":"fixture-turn","status":"inProgress"}}}"#);
            println!("{}", r#"{"method":"item/started","params":{"item":{"id":"fixture-command","type":"commandExecution","command":"fixture","status":"inProgress"}}}"#);
            if mode == "complete" {
                println!("{}", r#"{"method":"item/completed","params":{"item":{"id":"fixture-command","type":"commandExecution","status":"completed","exitCode":0,"aggregatedOutput":"退出代码: 0\n检查✅: 通过"}}}"#);
                println!("{}", r#"{"method":"item/agentMessage/delta","params":{"itemId":"fixture-answer","delta":"fixture complete"}}"#);
                println!("{}", r#"{"method":"turn/completed","params":{"turn":{"id":"fixture-turn","status":"completed"}}}"#);
            } else if mode == "invalid-exit" {
                std::io::stdout().flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(100));
                std::io::stdout().write_all(&[0xff, b'\n']).unwrap();
                std::io::stdout().flush().unwrap();
                std::process::exit(0);
            } else if mode == "invalid-linger" {
                std::io::stdout().flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(100));
                std::io::stdout().write_all(&[0xff, b'\n']).unwrap();
            } else if mode == "stall" || mode == "cancel" {
                std::io::stdout().flush().unwrap();
                loop { std::thread::sleep(std::time::Duration::from_secs(1)); }
            }
            close_stdout_and_linger();
        }
        std::io::stdout().flush().unwrap();
    }
}
