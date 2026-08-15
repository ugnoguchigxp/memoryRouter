use serde_json::json;

use super::native_tools::*;

fn make_context() -> NativeToolContext {
    NativeToolContext {
        project_root: std::env::temp_dir(),
        sqlite_core_path: std::env::temp_dir().join("dummy.sqlite"),
    }
}

#[test]
fn test_exposed_tool_count_matches_expected() {
    assert_eq!(exposed_tool_count(), 12);
}

#[test]
fn test_tool_owner_inventory_includes_all_native_tools() {
    let inv = tool_owner_inventory();
    let native = inv["rustNative"].as_array().unwrap();
    assert_eq!(native.len(), 12);
    let names: Vec<&str> = native.iter().map(|n| n.as_str().unwrap()).collect();
    assert!(names.contains(&"initial_instructions"));
    assert!(names.contains(&"context_compile"));
    assert!(names.contains(&"compile_eval"));
    assert!(names.contains(&"context_decision"));
    assert!(names.contains(&"context_decision_feedback"));
    assert!(names.contains(&"search_knowledge"));
    assert!(names.contains(&"register_candidates"));
    assert!(names.contains(&"search_memory"));
    assert!(names.contains(&"fetch_memory"));
    assert!(names.contains(&"search_episodes"));
    assert!(names.contains(&"fetch_episode"));
    assert!(names.contains(&"doctor"));
}

#[test]
fn test_handle_native_dispatch_tools_list_returns_tools() {
    let context = make_context();
    let res = handle_native_dispatch("tools/list", &json!({}), &context).unwrap();
    let tools = res["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 12);
}

#[test]
fn test_handle_native_dispatch_resources_list_returns_resources() {
    let context = make_context();
    let res = handle_native_dispatch("resources/list", &json!({}), &context).unwrap();
    assert!(res["resources"].is_array());
}

#[test]
fn test_handle_native_dispatch_unknown_method_returns_none() {
    let context = make_context();
    let res = handle_native_dispatch("unknown/method", &json!({}), &context);
    assert!(res.is_none());
}

#[test]
fn test_handle_native_dispatch_unknown_tool_returns_none() {
    let context = make_context();
    let res = handle_native_dispatch("tools/call", &json!({"name": "unknown_tool"}), &context);
    assert!(res.is_none());
}

#[test]
fn test_handle_native_dispatch_initial_instructions_returns_text() {
    let context = make_context();
    let res = handle_native_dispatch(
        "tools/call",
        &json!({"name": "initial_instructions"}),
        &context,
    )
    .unwrap();
    let content = res["content"].as_array().unwrap();
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["type"].as_str().unwrap(), "text");
    let text = content[0]["text"].as_str().unwrap();
    assert!(text.contains("## 常用ルール") || text.contains("## Operational Rules"));
    assert!(text.contains("## 主要MCPツール") || text.contains("## Primary MCP Tools"));
    assert!(text.contains("initial_instructions"));
    assert!(text.contains("context_compile"));
    assert!(text.contains("compile_eval"));
    assert!(text.contains("context_decision"));
    assert!(text.contains("context_decision_feedback"));
    assert!(
        text.contains("その他の公開ツールは補助機能")
            || text.contains("Other exposed tools are supplemental")
    );
    assert!(!text.contains("`register_candidates`"));
    assert!(!text.contains("SKILL.md 相当"));
}

#[test]
fn test_resolve_locale_and_environments() {
    let context = make_context();

    // 1. English env
    std::env::set_var("CONTEXT_STILL_LANG", "en-US");
    let res_en = handle_native_dispatch(
        "tools/call",
        &json!({"name": "initial_instructions"}),
        &context,
    )
    .unwrap();
    let text_en = res_en["content"][0]["text"].as_str().unwrap();
    assert!(text_en.contains("Operational Rules"));
    std::env::remove_var("CONTEXT_STILL_LANG");

    // 2. English memory router env
    std::env::set_var("MEMORY_ROUTER_LANG", "en");
    let res_mr = handle_native_dispatch(
        "tools/call",
        &json!({"name": "initial_instructions"}),
        &context,
    )
    .unwrap();
    let text_mr = res_mr["content"][0]["text"].as_str().unwrap();
    assert!(text_mr.contains("Operational Rules"));
    std::env::remove_var("MEMORY_ROUTER_LANG");

    // 3. Default (Japanese)
    std::env::remove_var("CONTEXT_STILL_LANG");
    std::env::remove_var("MEMORY_ROUTER_LANG");
    let res_default = handle_native_dispatch(
        "tools/call",
        &json!({"name": "initial_instructions"}),
        &context,
    )
    .unwrap();
    let text_default = res_default["content"][0]["text"].as_str().unwrap();
    assert!(text_default.contains("常用ルール"));
}

#[test]
fn test_exposed_tools_have_required_fields() {
    let context = make_context();
    let res = handle_native_dispatch("tools/list", &json!({}), &context).unwrap();
    let array = res["tools"].as_array().unwrap();
    for tool in array {
        assert!(tool["name"].is_string());
        assert!(tool["description"].is_string());
        assert!(tool["inputSchema"].is_object());
    }
}

#[test]
fn test_context_compile_exposes_additive_project_identity_contract() {
    let context = make_context();
    let response = handle_native_dispatch("tools/list", &json!({}), &context).unwrap();
    let tool = response["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "context_compile")
        .expect("context_compile is exposed");
    let schema = &tool["inputSchema"];
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["projectRef"]["maxLength"], 256);
    assert_eq!(schema["properties"]["repoKey"]["maxLength"], 1024);
    assert_eq!(schema["properties"]["repoPath"]["maxLength"], 4096);
    for property in ["projectRef", "repoKey", "repoPath"] {
        assert_eq!(
            schema["properties"][property]["pattern"],
            "^[^\\u0000-\\u001F\\u007F-\\u009F]+$"
        );
    }
    assert!(tool["description"]
        .as_str()
        .unwrap()
        .contains("EpisodeCard"));
    assert!(!tool["description"]
        .as_str()
        .unwrap()
        .contains("source evidence"));
}
