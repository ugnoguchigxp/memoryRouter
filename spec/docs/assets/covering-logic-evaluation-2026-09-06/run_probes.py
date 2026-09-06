"""Run observation probes against a disposable copy; never edit application sources."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

assets = Path(__file__).resolve().parent
repo = assets.parents[3]
snapshot = Path(tempfile.mkdtemp(prefix="contextstill-covering-review-"))
for name in ("crates", "shared", ".s11tnext", "test/fixtures", "spec/context-compile-foundation"):
    shutil.copytree(repo / name, snapshot / name)
for name in ("Cargo.toml", "Cargo.lock", "src/db/sqlite/core-schema.ts"):
    target = snapshot / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(repo / name, target)
tests = Path("crates/context-stilld/src/domains/queue_lifecycle/covering_executor/tests.rs")
with (snapshot / tests).open("a") as handle:
    handle.write("\n" + (assets / "review_probes.rs").read_text())
manifest = {
    "snapshot": str(snapshot),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
    "files": {
        str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((repo / tests.parent).glob("*.rs"))
    },
    "probeSemantics": "Passing tests reproduce current behavior; they are not acceptance tests.",
}
(assets / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
env = os.environ.copy()
env["CARGO_TARGET_DIR"] = str(repo / "target")
command = ["cargo", "test", "--offline", "-p", "context-stilld", "covering_executor", "--", "--nocapture"]
print("Snapshot:", snapshot, flush=True)
result = subprocess.run(command, cwd=snapshot, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
(assets / "probe-results.txt").write_text(result.stdout)
print(result.stdout)
raise SystemExit(result.returncode)
