import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { redactSecrets } from "../src/shared/utils/secret-redaction.js";

type RedactionFixture = {
  name: string;
  input: string;
  secret: string;
  safeText: string;
};

const redactionFixtures = JSON.parse(
  readFileSync(new URL("./fixtures/finding-v2/redaction.json", import.meta.url), "utf8"),
) as RedactionFixture[];

describe("Finding v2 cross-runtime contract fixtures", () => {
  test.each(redactionFixtures)("redacts $name without removing unrelated context", (fixture) => {
    const redacted = redactSecrets(fixture.input);
    expect(redacted).not.toContain(fixture.secret);
    expect(redacted).toContain(fixture.safeText);
  });
});
