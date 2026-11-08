// Prepared host-sink rows from the F5 merge-up review's run-merge-up-rows.py,
// tango-merge-up-rows.test.ts and tango-rtl-plain-rows.test.ts.
// Construct code points at runtime so source files contain no raw controls.
const c = (...points: number[]) => String.fromCodePoint(...points);

// A partner ending in a digit could join the currency token into an amount,
// accidentally masking a missing RTL detector rule.
export const PARTNER_TITLE = "Plate reader notes";
export const PARTNER_DESCRIPTION = "Observations from this run";

export const mergeUpClaimRows = [
  { label: "unassigned U+2065 inside a claim word", text: "Payment veri" + c(0x2065) + "fied" },
  { label: "unassigned U+FFF0 inside a claim word", text: "Payment veri" + c(0xfff0) + "fied" },
  { label: "unassigned U+E0000 inside a claim word", text: "Payment veri" + c(0xe0000) + "fied" },
  { label: "Hebrew letter between $ and digits", text: "$" + c(0x05d0) + "5,000" },
  { label: "Arabic letter between a currency code and digits", text: "USD " + c(0x0627) + " 5,000" },
];

export const plainRtlRows = [
  { label: "Hebrew lab report title", text: c(0x05d3, 0x05d5, 0x05d7) + " " + c(0x05de, 0x05e2, 0x05d1, 0x05d3, 0x05d4) + " 3" },
  { label: "Arabic lab report title", text: c(0x062a, 0x0642, 0x0631, 0x064a, 0x0631) + " " + c(0x0627, 0x0644, 0x0645, 0x062e, 0x062a, 0x0628, 0x0631) + " 3" },
];
