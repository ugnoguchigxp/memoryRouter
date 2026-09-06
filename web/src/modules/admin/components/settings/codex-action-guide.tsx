import { Button } from "@/components/ui/button";
import { useState } from "react";

export function CodexActionGuide({
  recommendedAction,
  isExpired,
  loginCommand,
  onGetCommand,
  isPending,
  onRefresh,
}: {
  recommendedAction: "ready" | "run-codex-login" | "set-codex-access-token" | "install-codex-cli";
  isExpired: boolean;
  loginCommand: string | null;
  onGetCommand: () => void;
  isPending: boolean;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = loginCommand ?? "codex login";
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (recommendedAction === "ready" && !isExpired) {
    return (
      <div className="flex items-center gap-2 rounded bg-success/10 px-3 py-2 text-xs text-success">
        <span>🎉</span>
        <span className="font-semibold">Ready to use Codex as an LLM provider.</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-6 text-xs"
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>
    );
  }

  if (recommendedAction === "install-codex-cli") {
    return (
      <div className="rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
        <p className="font-semibold">Install Codex CLI first:</p>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 rounded bg-background px-2 py-1 font-mono">
            npm install -g @openai/codex
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 text-xs"
            onClick={() => void navigator.clipboard.writeText("npm install -g @openai/codex")}
          >
            Copy
          </Button>
        </div>
        <p className="mt-2">
          Or configure <code>CODEX_ACCESS_TOKEN</code> in your environment.
        </p>
      </div>
    );
  }

  // run-codex-login or expired
  const cmd = loginCommand ?? "codex login";
  return (
    <div className="rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
      <p className="font-semibold">
        {isExpired
          ? "Re-authenticate by running in your terminal:"
          : "Authenticate by running in your terminal:"}
      </p>
      <div className="mt-1 flex items-center gap-2">
        {loginCommand ? (
          <code className="flex-1 rounded bg-background px-2 py-1 font-mono">{cmd}</code>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={onGetCommand}
            disabled={isPending}
          >
            {isPending ? "Loading…" : "Get Login Command"}
          </Button>
        )}
        {loginCommand && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 text-xs"
            onClick={handleCopy}
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
        )}
      </div>
      <p className="mt-2 text-muted-foreground/70">
        After login, click{" "}
        <button type="button" className="underline hover:text-foreground" onClick={onRefresh}>
          Refresh
        </button>{" "}
        to update the status.
      </p>
    </div>
  );
}
