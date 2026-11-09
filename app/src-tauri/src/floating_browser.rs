use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, Webview, WebviewUrl};
use url::Url;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEvent {
    browser_id: String,
    url: String,
}

fn browser_label(browser_id: &str) -> Result<String, String> {
    if browser_id.is_empty() || browser_id.len() > 80
        || !browser_id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') {
        return Err("浏览器标识无效".into());
    }
    Ok(format!("floating-browser-{browser_id}"))
}

#[derive(Deserialize)]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn require_main(webview: &Webview) -> Result<(), String> {
    let url = webview.url().map_err(|error| error.to_string())?;
    let app_url = webview.app_handle().config().build.dev_url.as_ref()
        .map(|url| url.origin().ascii_serialization());
    let trusted = matches!(url.origin().ascii_serialization().as_str(),
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost")
        || cfg!(debug_assertions) && app_url.as_deref() == Some(url.origin().ascii_serialization().as_str());
    if webview.label() == "main" && trusted { Ok(()) } else { Err("浏览器接口仅允许主窗口调用".into()) }
}

fn allowed_url(url: &Url, dev_origin: Option<&str>) -> bool {
    match url.scheme() {
        "file" => url.to_file_path().is_ok(),
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            !host.is_empty() && !host.ends_with(".localhost")
                && dev_origin != Some(url.origin().ascii_serialization().as_str())
        }
        _ => false,
    }
}

fn parse_url(input: &str, dev_origin: Option<&str>) -> Result<Url, String> {
    let input = input.trim();
    let url = if std::path::Path::new(input).is_absolute() {
        Url::from_file_path(input).map_err(|_| "本地路径无效".to_string())?
    } else {
        Url::parse(input).map_err(|_| "网址无效".to_string())?
    };
    if allowed_url(&url, dev_origin) { Ok(url) } else { Err("不允许打开此地址".into()) }
}

fn validate_bounds(bounds: &BrowserBounds) -> Result<(), String> {
    if [bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|value| value.is_finite())
        && bounds.x >= 0.0 && bounds.y >= 0.0 && bounds.width > 0.0 && bounds.height > 0.0
        && bounds.x < 20000.0 && bounds.y < 20000.0 && bounds.width < 20000.0 && bounds.height < 20000.0 {
        Ok(())
    } else { Err("浏览器区域无效".into()) }
}

fn dev_origin(webview: &Webview) -> Option<String> {
    webview.app_handle().config().build.dev_url.as_ref().map(|url| url.origin().ascii_serialization())
}

#[tauri::command]
pub async fn floating_browser_open(webview: Webview, browser_id: String, url: String, bounds: BrowserBounds) -> Result<(), String> {
    require_main(&webview)?;
    validate_bounds(&bounds)?;
    let origin = dev_origin(&webview);
    let url = parse_url(&url, origin.as_deref())?;
    let label = browser_label(&browser_id)?;
    let app = webview.app_handle().clone();
    if let Some(browser) = app.get_webview(&label) {
        browser.navigate(url).map_err(|error| error.to_string())?;
        return Ok(());
    }
    let new_window_app = app.clone();
    let navigation_origin = origin.clone();
    let new_window_origin = origin.clone();
    let new_window_id = browser_id.clone();
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_navigation(move |url| allowed_url(url, navigation_origin.as_deref()))
        .on_new_window(move |url, _| {
            if allowed_url(&url, new_window_origin.as_deref()) {
                let _ = new_window_app.emit_to("main", "ugs:browser-open-url", BrowserEvent { browser_id: new_window_id.clone(), url: url.to_string() });
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |browser, payload| {
            let _ = browser.app_handle().emit_to("main", "ugs:browser-location", BrowserEvent { browser_id: browser_id.clone(), url: payload.url().to_string() });
        });
    webview.window().add_child(builder,
        tauri::LogicalPosition::new(bounds.x, bounds.y),
        tauri::LogicalSize::new(bounds.width, bounds.height),
    ).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn floating_browser_bounds(webview: Webview, browser_id: String, bounds: BrowserBounds) -> Result<(), String> {
    require_main(&webview)?;
    validate_bounds(&bounds)?;
    if let Some(browser) = webview.app_handle().get_webview(&browser_label(&browser_id)?) {
        browser.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y)).map_err(|error| error.to_string())?;
        browser.set_size(tauri::LogicalSize::new(bounds.width, bounds.height)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn floating_browser_visibility(webview: Webview, browser_id: String, visible: bool) -> Result<(), String> {
    require_main(&webview)?;
    if let Some(browser) = webview.app_handle().get_webview(&browser_label(&browser_id)?) {
        if visible { browser.show() } else { browser.hide() }.map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn floating_browser_action(webview: Webview, browser_id: String, action: String) -> Result<(), String> {
    require_main(&webview)?;
    let browser = webview.app_handle().get_webview(&browser_label(&browser_id)?).ok_or("浏览器尚未打开")?;
    match action.as_str() {
        "back" => browser.eval("history.back()"),
        "forward" => browser.eval("history.forward()"),
        "reload" => browser.reload(),
        _ => return Err("不支持的浏览器操作".into()),
    }.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn floating_browser_current_url(webview: Webview, browser_id: String) -> Result<String, String> {
    require_main(&webview)?;
    let browser = webview.app_handle().get_webview(&browser_label(&browser_id)?).ok_or("浏览器尚未打开")?;
    browser.url().map(|url| url.to_string()).map_err(|error| error.to_string())
}

// Read the rendered page in its own webview so SPA state and logged-in pages are preserved.
#[tauri::command]
pub async fn floating_browser_page_context(webview: Webview, browser_id: String) -> Result<serde_json::Value, String> {
    require_main(&webview)?;
    let browser = webview.app_handle().get_webview(&browser_label(&browser_id)?).ok_or("浏览器尚未打开")?;
    #[cfg(target_os = "windows")]
    {
        use webview2_com::ExecuteScriptCompletedHandler;
        use windows::core::HSTRING;
        let (sender, mut receiver) = tauri::async_runtime::channel::<Result<String, String>>(1);
        browser.with_webview(move |platform| {
            let fail = sender.clone();
            let script = HSTRING::from("({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,60001)})");
            let result = unsafe {
                platform.controller().CoreWebView2().and_then(|core| core.ExecuteScript(&script,
                    &ExecuteScriptCompletedHandler::create(Box::new(move |status, value| {
                        let _ = sender.try_send(status.map(|_| value).map_err(|e| e.to_string()));
                        Ok(())
                    }))))
            };
            if let Err(error) = result { let _ = fail.try_send(Err(error.to_string())); }
        }).map_err(|error| error.to_string())?;
        let raw = receiver.recv().await.ok_or("无法读取网页内容")??;
        let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "网页内容解析失败")?;
        if !value.is_object() { return Err("无法读取网页正文".into()); }
        Ok(value)
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = browser; Err("当前平台暂不支持读取浏览器正文".into()) }
}

#[tauri::command]
pub async fn floating_browser_close(webview: Webview, browser_id: String) -> Result<(), String> {
    require_main(&webview)?;
    if let Some(browser) = webview.app_handle().get_webview(&browser_label(&browser_id)?) {
        browser.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

// Open local HTML in the browser registered for HTTPS, even if .html is associated with an editor.
#[tauri::command]
pub async fn floating_browser_open_system_file(webview: Webview, url: String) -> Result<(), String> {
    require_main(&webview)?;
    let url = parse_url(&url, dev_origin(&webview).as_deref())?;
    if url.scheme() != "file" { return Err("只能打开本地网页".into()); }
    open_system_browser_file(&url)
}

#[cfg(target_os = "windows")]
fn open_system_browser_file(url: &Url) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

    fn registry_string(root: HKEY, key: &str, value: Option<&str>) -> Result<String, String> {
        let key: Vec<u16> = key.encode_utf16().chain(Some(0)).collect();
        let value = value.map(|v| v.encode_utf16().chain(Some(0)).collect::<Vec<_>>());
        let mut data = vec![0u16; 16384];
        let mut size = (data.len() * 2) as u32;
        let result = unsafe { RegGetValueW(root, key.as_ptr(), value.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
            RRF_RT_REG_SZ, std::ptr::null_mut(), data.as_mut_ptr().cast(), &mut size) };
        if result != 0 { return Err(format!("无法读取系统浏览器设置：{result}")); }
        let end = data.iter().position(|&c| c == 0).unwrap_or(data.len());
        Ok(String::from_utf16_lossy(&data[..end]))
    }

    let prog_id = registry_string(HKEY_CURRENT_USER, r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice", Some("ProgId"))
        .unwrap_or_else(|_| "https".into());
    let command = registry_string(HKEY_CLASSES_ROOT, &format!(r"{prog_id}\shell\open\command"), None)?;
    let executable = if let Some(rest) = command.trim_start().strip_prefix('"') {
        rest.split('"').next().unwrap_or_default()
    } else {
        command.split_whitespace().next().unwrap_or_default()
    };
    if executable.is_empty() { return Err("无法确定系统浏览器程序".into()); }
    std::process::Command::new(executable).arg(url.as_str()).spawn()
        .map_err(|error| format!("打开系统浏览器失败：{error}"))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn open_system_browser_file(url: &Url) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    std::process::Command::new(opener).arg(url.as_str()).spawn()
        .map_err(|error| format!("打开系统浏览器失败：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_labels_are_unique_and_cannot_target_other_webviews() {
        assert_ne!(browser_label("first-1").unwrap(), browser_label("second-2").unwrap());
        for input in ["", "main", "../main", "bad id", "UPPER"] {
            if input == "main" {
                assert_eq!(browser_label(input).unwrap(), "floating-browser-main");
            } else {
                assert!(browser_label(input).is_err(), "{input}");
            }
        }
    }

    #[test]
    fn blocks_app_origins_and_unsafe_schemes() {
        let dev = Some("http://localhost:5173");
        for input in ["javascript:alert(1)", "https://tauri.localhost/", "http://asset.localhost/x", "http://localhost:5173/"] {
            assert!(parse_url(input, dev).is_err(), "{input}");
        }
        for input in ["https://example.com/", "http://localhost:3000/", "file:///C:/test.html"] {
            assert!(parse_url(input, dev).is_ok(), "{input}");
        }
    }
}
