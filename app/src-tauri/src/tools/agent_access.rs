//! Teach the local agent a read-only catalogue query, without a composer action.
use std::collections::HashMap;
use super::session::Scope;

pub fn guidance(env: Option<&HashMap<String, String>>) -> Option<String> {
    let env = env?;
    let scope: Scope = serde_json::from_str(env.get("UGS_TOOL_CATALOG_SCOPE")?).ok()?;
    if scope.workspace_id.is_empty() || scope.session_id.is_empty() || scope.agent_id.is_empty()
        || env.get("UGS_TOOLS_CLI")?.is_empty() { return None; }
    let script = if cfg!(windows) { "\"$env:UGS_TOOLS_CLI\"" } else { "\"$UGS_TOOLS_CLI\"" };
    Some(format!("【工具自动检索】\n需要找工具时，由你自行查询，无需用户打开面板或选择工具。优先使用当前 Agent 原生的工具搜索、延迟加载或工具注册表。UGS 补充目录可通过终端查询：\nnode {script} tools search \"关键词\"\nnode {script} tools inspect '<工具ID>'\nnode {script} tools list\n会话身份和数据目录已由环境变量注入，无需填写工作区、会话、账号或模型。搜索先返回摘要，inspect 再取参数 Schema。目录是缓存证据；无快照、无匹配或覆盖未知不代表没有工具。只使用当前 Agent 实际暴露的调用通道与权限，不把目录查询当作工具执行。\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guidance_requires_an_exact_injected_session_and_script() {
        let mut env = HashMap::new();
        assert!(guidance(Some(&env)).is_none());
        env.insert("UGS_TOOL_CATALOG_SCOPE".into(), r#"{"workspaceId":"w","sessionId":"s","agentId":"codex","providerId":"p","channelId":"c","model":"m"}"#.into());
        assert!(guidance(Some(&env)).is_none());
        env.insert("UGS_TOOLS_CLI".into(), "C:/UGS/cli/ugs.mjs".into());
        let text = guidance(Some(&env)).unwrap();
        assert!(text.contains("tools search"));
        assert!(text.contains("tools inspect"));
        assert!(text.contains("当前 Agent 原生"));
        assert!(text.contains("缓存证据"));
        assert!(!text.contains("--session"));
        env.insert("UGS_TOOL_CATALOG_SCOPE".into(), "{}".into());
        assert!(guidance(Some(&env)).is_none());
    }
}
