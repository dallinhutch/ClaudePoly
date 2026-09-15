import { describe, expect, it } from "vitest";
import { AnalystEstimateSchema, DossierSchema, QuickEstimateSchema, toolInputSchema } from "@/lib/research/schemas";

/** Keywords the Anthropic strict tool-schema validator rejects (seen in production as a 400). */
const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "pattern"];

function findKeywords(node: unknown, path = "$", found: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n, i) => findKeywords(n, `${path}[${i}]`, found));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED.includes(k)) found.push(`${path}.${k}`);
      findKeywords(v, `${path}.${k}`, found);
    }
  }
  return found;
}

describe("strict tool input schemas", () => {
  it.each([
    ["quick estimate", QuickEstimateSchema],
    ["dossier", DossierSchema],
    ["analyst estimate", AnalystEstimateSchema],
  ])("%s schema has no unsupported constraint keywords and forbids extra properties", (_name, schema) => {
    const json = toolInputSchema(schema);
    expect(findKeywords(json)).toEqual([]);
    expect(json.type).toBe("object");
    expect(json.additionalProperties).toBe(false);
  });
});
