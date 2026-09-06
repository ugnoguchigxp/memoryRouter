pub fn help_text() -> String {
    [
        "context-stilld",
        "",
        "Usage:",
        "  context-stilld run [--json] [--once]",
        "  context-stilld paths [--json]",
        "  context-stilld status [--json]",
        "  context-stilld bootstrap preflight|init [--json]",
        "  context-stilld mcp status|endpoint|sessions|smoke [--json]",
        "  context-stilld mcp start|stop [--json]  # legacy endpoint-worker lifecycle",
        "  context-stilld queue start|stop|status|inspect|executor-tick [--json]",
        "  context-stilld agent-log-sync run|backfill-codex|stop|status [--json]",
        "  context-stilld admin-api start|stop|status [--json]",
        "  context-stilld runtime sidecars|assert-rust-only [--json]",
        "  context-stilld vector health|smoke [--json]",
        "  context-stilld doctor [summary] [--json]",
        "  context-stilld backup preflight|create [--json]",
        "  context-stilld backup verify --path <backup.sqlite> [--json]",
        "  context-stilld context-compile capabilities [--out <new-report.json>] [--json]",
        "  context-stilld context-compile baseline|compare|experiment|probe [options] [--json]",
        "  context-stilld --version",
        "",
        "Rust owns resident lifecycle boundaries and migrates daemon runtime surfaces toward Rust-native implementations.",
    ]
    .join("\n")
}
