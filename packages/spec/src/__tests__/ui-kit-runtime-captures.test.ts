/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(process.env.PCC_R2G_KIT_SOURCE ?? new NodeURL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url), "utf8");
const bootTail = /  if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', mount\);\n  else mount\(\);/;
type Text = Readonly<{ t: string }>;
type Boundary = {
  kitText(value: string): Text;
  agentText(value: string): Text;
  el(tag: string, cls: null, value: unknown): HTMLElement;
  agentEl(tag: string, cls: null, value: unknown): HTMLElement;
};

describe("plain kit primitive captures", () => {
  const tampers = [
    ["WeakSet.prototype.has", "WeakSet.prototype.has = function () { return true; };"],
    ["WeakSet.prototype.add", "WeakSet.prototype.add = function () { return this; };"],
    ["Object.freeze", "Object.freeze = function (value) { return value; };"],
  ];
  for (const [name, tamper] of tampers) {
    it(`retains both text tiers after ${name} changes after load`, () => {
      const sandbox = {
        window: { boundary: undefined as Boundary | undefined, __PCC_UI_TEXT_VIOLATIONS__: 0 },
        document, URL,
      };
      expect(source.match(bootTail)).toHaveLength(1);
      vm.runInNewContext(source.replace(bootTail, "  window.boundary = { kitText: kitText, agentText: agentText, el: el, agentEl: agentEl };"), sandbox);
      vm.runInNewContext(tamper!, sandbox);
      const kit = sandbox.window.boundary!;
      const forged = Object.freeze({ t: "Unregistered text" });
      expect(kit.el("span", null, forged).textContent).toBe("—");
      expect(kit.agentEl("span", null, forged).textContent).toBe("—");
      expect(sandbox.window.__PCC_UI_TEXT_VIOLATIONS__).toBe(2);
      const genuine = kit.kitText("PCC copy");
      expect(Object.isFrozen(genuine)).toBe(true);
      expect(kit.el("span", null, genuine).textContent).toBe("PCC copy");
      const agent = kit.agentText("Agent copy");
      expect(Object.isFrozen(agent)).toBe(true);
      expect(kit.agentEl("span", null, agent).textContent).toBe("Agent copy");
      expect(sandbox.window.__PCC_UI_TEXT_VIOLATIONS__).toBe(2);
    });
  }
});
