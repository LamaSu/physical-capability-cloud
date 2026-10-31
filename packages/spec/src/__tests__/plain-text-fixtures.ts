/** Shared accepted/rejected inputs for the canonical helpers and their shipped JS mirrors. */
export const PLAIN_TEXT_CASES: Readonly<Record<"idText" | "hexText" | "traceText" | "nameText", readonly (readonly [unknown, string])[]>> = {
  idText: [
    ["job-1", "reported: job-1"], ["Kernel:local_1.2", "reported: Kernel:local_1.2"], ["a".repeat(128), "reported: " + "a".repeat(128)],
    ["a".repeat(129), "reported: " + "a".repeat(129)], ["bad id", "reported: bad id"],
    ["_start", "reported: _start"], ["éclair", "reported: éclair"], ["job\u0000", "reported: job\u0000"],
    [42, "reported: 42"], [false, "reported: false"], [null, ""], [undefined, ""], ["", ""],
    [{ t: "job-1" }, "reported: [object Object]"], [["job-1"], "reported: job-1"],
  ],
  hexText: [
    ["0x" + "aB".repeat(20), "0x" + "aB".repeat(20)], ["0x" + "f0".repeat(32), "0x" + "f0".repeat(32)],
    ["0xabc", "unrecognised value"], ["0X" + "a".repeat(40), "unrecognised value"],
    ["0x" + "g".repeat(40), "unrecognised value"], [" 0x" + "a".repeat(40), "unrecognised value"],
    ["0x" + "a".repeat(39), "unrecognised value"], ["0x" + "a".repeat(65), "unrecognised value"],
    [null, "unrecognised value"], [undefined, "unrecognised value"], [42, "unrecognised value"],
    [["0x" + "a".repeat(40)], "unrecognised value"],
  ],
  traceText: [
    ["trace_01", "trace trace_01"], ["ABCD-1234", "trace ABCD-1234"], ["a".repeat(64), "trace " + "a".repeat(64)],
    ["short", ""], ["a".repeat(65), ""], ["trace.01", ""], ["trace 01", ""], ["trace_\n01", ""],
    [null, ""], [undefined, ""], [12345678, ""], [["trace_01"], ""],
  ],
  nameText: [
    ["Mill A", "name: Mill A"], ["Sample received", "name: Sample received"], ["analytical-balance", "name: analytical-balance"],
    ["", "name: "], ["Paid $5", "name withheld: stated money or verification"],
    ["payment received", "name withheld: stated money or verification"], ["verification passed", "name withheld: stated money or verification"],
    ["verified", "name withheld: stated money or verification"], ["p\u0430id", "name withheld: stated money or verification"],
    ["withheld", "name withheld: stated money or verification"], [42, "reported: 42"],
    [null, ""], [undefined, ""], [{ name: "Mill A" }, "reported: [object Object]"],
  ],
};

export const PLAIN_TIME_ACCEPTED = [
  "2000-01-01T00:00:00Z", "2024-02-29T23:59:59Z", "2026-10-06T12:34:56.1Z",
  "2026-10-06T12:34:56.12Z", "2026-10-06T12:34:56.123Z", "2100-12-31T23:59:59Z",
] as const;
export const PLAIN_TIME_REJECTED: readonly unknown[] = [
  "1999-12-31T23:59:59Z", "2101-01-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-99-99T99:99:99Z",
  "2100-02-29T00:00:00Z", "2026-10-06T24:00:00Z", "2026-10-06T12:34:60Z",
  "2026-10-06T12:34:56.1234Z", "2026-10-06T12:34:56+00:00", "2026-10-06T12:34:56",
  "2026-10-06t12:34:56z", " 2026-10-06T12:34:56Z", "2026-10-06", 0, null, undefined, {},
];

export const FIELD_DEFAULT_CASES: readonly (readonly [unknown, unknown, string])[] = [
  ["number", 12.5, "12.5"], ["integer", 12, "12"], ["integer", 12.5, "12.5"], ["number", -0, "0"],
  ["number", NaN, ""], ["number", Infinity, ""], ["integer", -Infinity, ""], ["number", "12", ""],
  ["integer", true, ""], ["number", null, ""], ["number", {}, ""],
  ["string", "PLA", "PLA"], ["string", "", ""], ["string", "Sample received", "Sample received"],
  ["string", "$5", ""], ["string", "5 USDC", ""], ["string", "payment received", ""],
  ["string", "verification passed", ""], ["string", "verified", ""], ["string", "withheld", ""],
  ["string", "p\u0430id", ""], ["string", "p a i d", ""], ["string", "p41d", ""],
  ["string", "已付款", ""], ["string", 12, ""], ["string", null, ""], ["string", ["PLA"], ""],
  ["boolean", true, ""], ["object", {}, ""], ["array", [], ""], [null, "PLA", ""],
];

export const PLAIN_CLAIM_CASES: readonly (readonly [string, boolean])[] = [
  ["Mill A", false], ["Sample received", false], ["Run confirmed for 9:00", false], ["analytical-balance", false],
  ["$5", true], ["one million dollars", true], ["payment received", true], ["verification passed", true],
  ["p\u0430id", true], ["p a i d", true], ["p41d", true], ["已付款", true], ["withheld", true],
  [String.fromCodePoint(0x202e) + "deifirev tnemyaP", true],
  [String.fromCodePoint(0x202e) + "CCP yb deifirev - LLUF NI DIAP", true],
  [String.fromCodePoint(0x202e) + "diap DSU 000,5", true],
  ["Invoice pa" + String.fromCodePoint(0x202e) + "di", true],
  [String.fromCodePoint(0x2067, 0x202e) + "deifirev tnemyaP" + String.fromCodePoint(0x202c, 0x2069), true],
  [String.fromCodePoint(0x2067) + "ified" + String.fromCodePoint(0x200f) + "ent ver" + String.fromCodePoint(0x200f) + "Paym" + String.fromCodePoint(0x2069), true],
  ["Plate reader run 3" + String.fromCodePoint(0x202e), true],
  ["Payment veri" + String.fromCodePoint(0x2065) + "fied", true],
  ["Payment veri" + String.fromCodePoint(0xe0000) + "fied", true],
  ["$" + String.fromCodePoint(0x05d0) + "5,000", true],
  ["$" + String.fromCodePoint(0x0627) + "5,000", true],
  ["USD" + String.fromCodePoint(0x05d0) + "5000", true],
  [String.fromCodePoint(0x070f) + "Plate reader notes", true],
  [String.fromCodePoint(0x05d3, 0x05d5, 0x05d7), false],
  [String.fromCodePoint(0x062a, 0x0642, 0x0631, 0x064a, 0x0631), false],
  ["ＰＡＩＤ", true], ["paid\u200b", true], ["FUNDS_TRANSFERRED_TO_PAYEE", true],
];

// Unicode properties are swept once; all crafted inputs are assembled at runtime.
export const BIDI_CONTROL_POINTS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069] as const;
export const DEFAULT_IGNORABLE_POINTS: number[] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (/\p{Default_Ignorable_Code_Point}/u.test(String.fromCodePoint(cp))) DEFAULT_IGNORABLE_POINTS.push(cp);
}
