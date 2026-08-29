import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const fixtureDirectory = new URL("../shared/fixtures/memory-recall-v1/", import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
}

describe("memory-recall-v1 fixtures", () => {
  const schema = fixture("schema.json") as object;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  it.each(["experience.json", "rule.json", "skill.json", "no-content.json"])(
    "validates %s",
    (name) => {
      const value = fixture(name);
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it("binds noContent to item presence and caps results at five", () => {
    const rule = fixture("rule.json") as {
      items: unknown[];
      noContent: boolean;
    };

    expect(validate({ ...rule, noContent: true }), JSON.stringify(validate.errors)).toBe(false);
    expect(
      validate({ ...rule, items: [], noContent: false }),
      JSON.stringify(validate.errors),
    ).toBe(false);
    expect(
      validate({ ...rule, items: Array.from({ length: 6 }, () => rule.items[0]) }),
      JSON.stringify(validate.errors),
    ).toBe(false);
  });

  it("defines at least fifty synthetic quality queries per memory type", () => {
    const quality = fixture("retrieval-quality.json") as {
      evaluatorVersion: string;
      seed: string;
      queriesPerType: number;
      cases: Array<{
        memoryType: string;
        queryPrefix: string;
        expectedTitlePrefix: string;
      }>;
    };

    expect(quality.evaluatorVersion).toBe("memory-recall-quality-v1");
    expect(quality.seed).toBeTruthy();
    expect(quality.queriesPerType).toBeGreaterThanOrEqual(50);
    expect(quality.cases.map((item) => item.memoryType)).toEqual(["experience", "rule", "skill"]);
    for (const item of quality.cases) {
      expect(item.queryPrefix).toBeTruthy();
      expect(item.expectedTitlePrefix).toBeTruthy();
    }
  });
});
