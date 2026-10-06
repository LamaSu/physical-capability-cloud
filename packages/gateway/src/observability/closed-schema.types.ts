/**
 * Compile-time checks of the declare API (N107b round 2): tsc fails if lit() ever takes a string a
 * request could have made. Nothing imports this module and nothing here runs.
 */
import { lit } from "./closed-schema.js";

export function literalTypeChecks(value: string, n: number, stage: "provision" | "discover"): void {
  lit("a literal");
  lit(stage);
  lit(`onboarding_${stage}`);
  // @ts-expect-error a string value is refused
  lit(value);
  // @ts-expect-error a template with a string value in it is refused
  lit(`job ${value} settled`);
  // @ts-expect-error a template with a number in it is refused
  lit(`attempt ${n}`);
  // @ts-expect-error an untyped value is refused
  lit(JSON.parse(value));
}
