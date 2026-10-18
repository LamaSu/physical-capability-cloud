import { expect, vi } from "vitest";

type KitWindow = Window & { __PCC_UI_BOOTED__?: boolean; __PCC_UI_TEXT_VIOLATIONS__?: number };

/** A subsequent boot must not erase evidence from the previous render. */
export function assertKitTextBeforeBoot() {
  if ((window as KitWindow).__PCC_UI_BOOTED__) assertKitTextViolations();
}

export function assertKitTextViolations() {
  expect((window as KitWindow).__PCC_UI_TEXT_VIOLATIONS__, "plain kit rendered only branded text").toBe(0);
}

/** Wait for driven transport/render callbacks, then inspect the runtime counter. */
export async function flushKitText() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertKitTextViolations();
}

/** Inspect every driven click, including rapid repeats and clicks inside loops. */
export function checkKitClicks() {
  const click = HTMLElement.prototype.click;
  return vi.spyOn(HTMLElement.prototype, "click").mockImplementation(function (this: HTMLElement) {
    click.call(this);
    assertKitTextViolations();
  });
}
