pub mod mcp;
pub mod session;
pub mod agent_access;

#[tauri::command]
pub async fn tool_catalog_read(scope: session::Scope) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || session::read(&scope))
        .await.map_err(|e| format!("工具目录读取失败: {e}"))?
}
