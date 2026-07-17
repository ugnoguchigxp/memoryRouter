import { readFile, writeFile } from "node:fs/promises";

const [, , requestPath, responsePath] = process.argv;
if (!requestPath || !responsePath) process.exit(2);

try {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as {
    endpoint: { url: string; token: string };
    body: unknown;
  };
  const response = await fetch(request.endpoint.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.endpoint.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request.body),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      message = parsed.error ?? text;
    } catch {
      // Keep the original response text.
    }
    await writeFile(
      responsePath,
      JSON.stringify({ ok: false, rows: [], changes: 0, lastInsertRowid: 0, error: message }),
    );
  } else {
    await writeFile(responsePath, text);
  }
} catch (error) {
  await writeFile(
    responsePath,
    JSON.stringify({ transportError: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
}
