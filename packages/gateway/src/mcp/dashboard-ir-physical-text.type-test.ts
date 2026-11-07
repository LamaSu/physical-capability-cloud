import type { KitText, AgentText } from "./dashboard-ir.js";

/** Test-only physical writer: production sinks authenticate before this adapter
 * unwraps their object. Reads remain ordinary DOM text, preserving rendered checks. */
export function physicalTextElement<T extends object>(element: T): Omit<T, "textContent"> & {
  get textContent(): string;
  set textContent(value: KitText | AgentText);
} {
  let text = "";
  Object.defineProperty(element, "textContent", {
    get: () => text,
    set: (value: KitText | AgentText) => { text = value.t; },
    configurable: true,
    enumerable: true,
  });
  return element as Omit<T, "textContent"> & {
    get textContent(): string;
    set textContent(value: KitText | AgentText);
  };
}
