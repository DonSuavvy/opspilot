import { describe, expect, it } from "vitest";

import { hasProviderEnv, MISSING_PROVIDER } from "./provider-env";

const AWS = {
  AWS_ANTHROPIC_ACCESS_KEY_ID: "id",
  AWS_ANTHROPIC_SECRET_ACCESS_KEY: "secret",
  AWS_ANTHROPIC_REGION: "ap-southeast-1",
};

describe("hasProviderEnv", () => {
  it("accepts the whole Bedrock trio", () => {
    expect(hasProviderEnv(AWS)).toBe(true);
  });

  it("accepts the first-party key on its own", () => {
    expect(hasProviderEnv({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(true);
  });

  it("accepts an empty environment as nothing configured", () => {
    expect(hasProviderEnv({})).toBe(false);
  });

  it.each(Object.keys(AWS))("refuses the trio with %s missing", (missing) => {
    // The bug this pins: any *one* AWS variable used to satisfy the check, so
    // a repository with only `AWS_ANTHROPIC_REGION` set — the one of the three
    // that is not a secret and so the one most likely to be committed or
    // inherited — passed the gate and then failed deep in the SDK.
    const partial = { ...AWS, [missing]: "" };
    expect(hasProviderEnv(partial)).toBe(false);
  });

  it("still accepts a partial Bedrock block beside a first-party key", () => {
    expect(
      hasProviderEnv({ AWS_ANTHROPIC_REGION: "ap-southeast-1", ANTHROPIC_API_KEY: "sk" }),
    ).toBe(true);
  });

  it("treats whitespace as absent", () => {
    expect(hasProviderEnv({ ...AWS, AWS_ANTHROPIC_REGION: "   " })).toBe(false);
    expect(hasProviderEnv({ ANTHROPIC_API_KEY: " " })).toBe(false);
  });
});

describe("MISSING_PROVIDER", () => {
  it("names both ways to satisfy the check", () => {
    // The old message named only `AWS_ANTHROPIC_*` while the check also
    // accepted `ANTHROPIC_API_KEY`, so a reader of a red job was told to go
    // find secrets they might not need.
    expect(MISSING_PROVIDER).toContain("AWS_ANTHROPIC_ACCESS_KEY_ID");
    expect(MISSING_PROVIDER).toContain("AWS_ANTHROPIC_SECRET_ACCESS_KEY");
    expect(MISSING_PROVIDER).toContain("AWS_ANTHROPIC_REGION");
    expect(MISSING_PROVIDER).toContain("ANTHROPIC_API_KEY");
    expect(MISSING_PROVIDER).toContain("docs/RUNBOOK.md");
  });
});
