import { expect } from "vitest";

/** A real-kit boot initializes this counter; keep every render and interaction closed. */
export function expectNoPccUiTextViolations(stage: string): void {
  expect(
    (window as unknown as Record<string, unknown>).__PCC_UI_TEXT_VIOLATIONS__,
    `pcc-ui text violations after ${stage}`,
  ).toBe(0);
}

/** Let mocked transport responses reach their DOM sinks before checking the counter. */
export async function expectSettledPccUiText(stage: string): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expectNoPccUiTextViolations(stage);
}
