import type { KitText } from "./dashboard-ir.js";

// This test-local interface deliberately permits an ambient consumer to declare a
// narrower overload. Its implementation remains an ordinary untrusted string.
export interface AmbientValue { valueOf(): string | object }
export function ambientValue(raw: string): AmbientValue {
  return { valueOf: () => raw } as AmbientValue;
}

declare module "./dashboard-ir-runtime-ambient.type-test.js" {
  interface AmbientValue { valueOf(): KitText }
}
