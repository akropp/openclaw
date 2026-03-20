import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("telegram topic schema", () => {
  it("rejects legacy agentId in topic config", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  agentId: "main",
                },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
  });
});
