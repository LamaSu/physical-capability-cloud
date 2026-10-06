/** Compile-only regression test, covered by both gateway typecheck configurations.
 * Removing a sink's KitText constraint makes @ts-expect-error fail with TS2578.
 * The function is never called; there are no runtime checks or DOM writes here.
 */
import { kitText, boundValueText, boundStatusText, identifierText, reportedFieldText, recordValueText } from "./dashboard-ir.js";
import type { KitText, IrNode } from "./dashboard-ir.js";
import { el, setText, bindScalar, bindSchemaCard, schemaCardFailure, listFieldLabel, UNAVAILABLE } from "./dashboard-ir-renderer.js";
import type { RDocument, RElement } from "./dashboard-ir-renderer.js";
import { httpStatusText } from "./dashboard-ir-binder.js";
import type { GetResult } from "./dashboard-ir-binder.js";

function checkTextTypes(doc: RDocument, node: RElement, ir: IrNode, raw: string): void {
  const displayed: KitText[] = [
    kitText("PCC copy"), UNAVAILABLE, boundValueText("name", raw), boundStatusText(raw),
    identifierText("id", raw), reportedFieldText("name", raw), recordValueText("status", raw),
    bindScalar(ir, {}), listFieldLabel("name"), httpStatusText(401),
  ];
  el(doc, "pcc-value", displayed[0]);
  setText(node, displayed[1]);
  bindSchemaCard("run-summary-v1", {}, [{ textContent: kitText("") }]);
  const failure: KitText | null = schemaCardFailure("run-summary-v1", {});
  if (failure !== null) setText(node, failure);

  // @ts-expect-error A raw string must not reach the element-creation sink.
  el(doc, "pcc-value", raw);
  // @ts-expect-error A raw string must not reach a slot-write sink.
  setText(node, raw);
  const widened: string = kitText("PCC copy");
  // @ts-expect-error Widening loses the brand; a sink cannot silently regain it.
  setText(node, widened);
  // @ts-expect-error Schema staging retains the helper's brand when its text is read back.
  bindSchemaCard("run-summary-v1", {}, [{ textContent: raw }]);
  // @ts-expect-error Displayed transport reasons also require typed text.
  const response: GetResult = { status: 401, redirected: false, bytesOver: false, json: null, reason: raw };
  void response;
}

void checkTextTypes;
