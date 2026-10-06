/**
 * Phase B — closed, PCC-owned render IR + adapter (read-only `/mcp/apps`).
 * Design + sol audits (R1-R5 folded): ai/research/pcc-genui-b-closed-ir-design.md. Spec §6.
 *
 * Projected DashboardManifest → a closed IR (strict subset of Atelier's UiTree).
 * Rules: PCC picks every node `type` (frozen catalog = EXACTLY what the adapter
 * emits) + rebuilds every prop from a closed grammar; STRICT REJECTION (never
 * strip/clamp/truncate) with exact own-key (`onlyKeys` over Reflect.ownKeys) at
 * every level; recursive prototype rejection; governed per-kind bindings pinned to
 * the REAL route table (exact end-anchored routes + reserved-collision guard +
 * selector/query grammar + SSE/path identity correlation); NO actions/capability
 * (inert ≠ safe) — effecting kinds render neutral; ALL manifest prose `untrusted`.
 * `validateIr` is an independent whole-tree oracle that MIRRORS every adapter
 * guarantee (same BIND_POLICY, same prop schemas, same parent/child grammar).
 * Runtime dependency-free (type-only import) → runnable via --experimental-strip-types.
 *
 * NOTE (projection follow-up): metric `format` is intentionally NOT accepted here
 * (§6.2 locked: PCC pre-formats the scalar, the IR omits `format`). The upstream
 * projection still preserves `format`; it should be updated to drop it. Until then
 * a metric window carrying `format` is rejected — the correct strict signal.
 */
import type { BoundSourceClass, DashboardManifest, RenderSourceClass } from "@pcc/spec";

/** Display text minted by a typed IR helper; the brand has no runtime representation. */
export type KitText = string & { readonly __kitText: unique symbol };
/** The one constructor for PCC-owned copy. Server/manifest values use typed helpers below. */
export function kitText(s: string): KitText { return s as KitText; }

// Frozen catalog = the EXACT set of node types the adapter emits (nothing more).
export const IR_NODE_TYPES = [
  "root", "section", "heading", "text", "stat", "card", "receipt", "list",
  "badge", "grid", "approval-notice", "plan", "form-summary", "field-label",
] as const;
export type IrNodeType = (typeof IR_NODE_TYPES)[number];
const FROZEN: ReadonlySet<string> = new Set(IR_NODE_TYPES);
export const BADGE_TONES = ["neutral", "info", "positive", "warning", "danger"] as const;
const TONE_SET: ReadonlySet<string> = new Set(BADGE_TONES);
const CARD_KINDS: ReadonlySet<string> = new Set(["capability", "run"]);
const GRID_KINDS: ReadonlySet<string> = new Set(["actions-readonly"]);
const PLAN_KINDS: ReadonlySet<string> = new Set(["composition"]);

const LIM = {
  sections: 24, windowsPerSection: 32, nodesTotal: 2000, depth: 8, inputDepth: 16,
  str: 2000, listRows: 200, fields: 64, metaItems: 12, queryKeys: 16,
  path: 512, select: 256, title: 400,
  pollMinMs: 5000, pollMaxMs: 3_600_000, boundWindowsTotal: 64, // poll-amplification cap (sol R5)
  cleanNodes: 50_000, // deepClean traversal budget — >> any legit manifest/IR, kills wide-object DoS (sol R6)
} as const;

/** The row cap for a list, whatever the manifest's `limit` (DOM-node budget). */
export const LIST_ROW_CAP = LIM.listRows;

// ── Manifest prose may not present money (PX-5 review #2504; astra r2 F1, F4) ─────────────
// Prose (the title, section headings, notes, action and field labels) is agent-authored. It is
// marked `untrusted`, and the view renders it visibly as agent-authored (`pcc-agent`). That does
// not stop "Payment received - verified" or "1,000,000 USDC" from reading as a financial fact, so
// money facts come ONLY from PCC-owned schema cards: prose that states an amount or a money or
// verification status is WITHHELD. A withheld node keeps no agent words at all: it becomes PCC's
// structural notice (`props.withheld: true`, never `untrusted`) and the renderer paints
// WITHHELD_PROSE from its own constant. Agent prose that mentions the notice ("withheld") is
// withheld too, so the notice can only ever come from PCC.
//
// The detector is lexical, so it folds before it matches: compatibility forms (width, circled and
// mathematical letters), combining marks, format and bidi controls (zero-width, RTL override,
// soft hyphen), invisible fillers, Cyrillic, Greek, small-capital and stroke look-alikes, dotless
// and dotted i, camel and snake joins, letter-spaced words ("p a i d") and digit or symbol
// spellings ("p41d"). It matches amounts (a currency symbol, code, word or money emoji next to a
// number, a number word or a magnitude, in either order) and payment or verification words in
// English and other major languages. A claim may not be split across prose either: each section's
// agent prose, then the whole dashboard's, is also checked as one text (see withholdSplitClaims).
// It remains a backstop to the agent-authored marking, not a proof that prose is harmless.
export const WITHHELD_PROSE = kitText(
  "Agent text withheld: it stated an amount or a payment or verification status. Money facts appear only in PCC cards.");
// Case-aware: each capital maps to the Latin capital it imitates, before lowercasing.
const LOOKALIKE: Readonly<Record<string, string>> = {
  // Cyrillic
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x",
  "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04bb": "h", "\u051b": "q", "\u051d": "w",
  "\u04cf": "l", "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041a": "K", "\u041c": "M", "\u041d": "H",
  "\u041e": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0406": "I", "\u0408": "J",
  "\u0405": "S", "\u04ae": "Y", "\u051a": "Q", "\u051c": "W", "\u04c0": "I",
  // Greek
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039a": "K",
  "\u039c": "M", "\u039d": "N", "\u039f": "O", "\u03a1": "P", "\u03a4": "T", "\u03a5": "Y", "\u03a7": "X",
  "\u03bf": "o", "\u03b1": "a", "\u03c1": "p", "\u03bd": "v", "\u03b9": "i", "\u03ba": "k", "\u03c5": "u",
  "\u03c7": "x", "\u03b5": "e", "\u03c4": "t",
  // Latin letters with no compatibility decomposition: dotless i and j, IPA, small capitals, strokes, hooks
  "\u0131": "i", "\u0237": "j", "\u0251": "a", "\u0261": "g", "\u0269": "i", "\u1d00": "a", "\u0299": "b",
  "\u1d04": "c", "\u1d05": "d", "\u1d07": "e", "\ua730": "f", "\u0262": "g", "\u029c": "h", "\u026a": "i",
  "\u1d0a": "j", "\u1d0b": "k", "\u029f": "l", "\u1d0d": "m", "\u0274": "n", "\u1d0f": "o", "\u1d18": "p",
  "\u0280": "r", "\ua731": "s", "\u1d1b": "t", "\u1d1c": "u", "\u1d20": "v", "\u1d21": "w", "\u028f": "y",
  "\u1d22": "z", "\u0111": "d", "\u0180": "b", "\u0268": "i", "\u0142": "l", "\u00f8": "o", "\u0127": "h",
  "\u0167": "t", "\u01a5": "p", "\u0257": "d", "\u0256": "d", "\u0188": "c", "\u0253": "b", "\u0192": "f",
  "\u0266": "h", "\u0199": "k", "\u0271": "m", "\u0272": "n", "\u0273": "n", "\u0282": "s", "\u01ad": "t",
  "\u0288": "t", "\u01b4": "y", "\u0225": "z", "\u024d": "r", "\u0247": "e", "\u023c": "c", "\u0249": "j",
  "\u0110": "D", "\u0141": "L", "\u00d8": "O", "\u0126": "H", "\u0166": "T", "\u0197": "I", "\u01a4": "P",
  "\u018a": "D", "\u0187": "C", "\u0181": "B", "\u0191": "F", "\u0198": "K", "\u01ac": "T", "\u01b3": "Y",
  "\u0224": "Z", "\u024c": "R", "\u0246": "E", "\u023b": "C",
};
// Marks, format/bidi controls and invisible fillers vanish; a braille blank reads as a space.
const INVISIBLE_RE = /[\p{M}\p{Cf}\u115f\u1160\u3164\uffa0]/gu;
const MONEY_EMOJI_RE = /[\u{1F4B0}-\u{1F4B8}\u{1F911}\u{1FA99}]/gu;
/** The one fold every check uses: lowercase Latin skeleton of what a reader sees. Whitespace runs
 *  collapse to one space, as HTML renders them; that also keeps every match below linear-time. */
function foldForClaims(text: string): string {
  let t = text.normalize("NFKD").replace(INVISIBLE_RE, "").normalize("NFKC");
  t = t.replace(/\u2800/g, " ").replace(MONEY_EMOJI_RE, " $ ");
  t = t.replace(/[^\x00-\x7f]/g, (c) => LOOKALIKE[c] ?? c);
  // Split only a REAL camelCase join (a lowercase run ending, then an uppercase start): the
  // lowercase letter must not itself be sandwiched directly between two uppercase letters, else
  // "PAlD" (a single lowercased confusable inside an otherwise-capital word) would mis-split into
  // "PAl D" and never fold back to "paid" (astra r3 H1).
  return t.replace(/(?<![A-Z])([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
}
// Digit and symbol spellings, read both ways for "1" (i and l).
const LEET_I: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };
const LEET_L: Readonly<Record<string, string>> = { ...LEET_I, "1": "l", "|": "l" };
const LEET_RE = /[0134578@$!|]/g;
const HAS_LEET = /[0134578@$!|]/;
/** Every spelling view of the folded text: the digit/symbol leet views (when present), plus an
 *  l<->i confusable swap of each ("pald" reads "paid"; "settied" reads "settled"). Bounded: at
 *  most 3 leet bases x up to 2 l/i swaps = at most 9 views, each built once (still linear-time). */
const views = (f: string): string[] => {
  const base = HAS_LEET.test(f) ? [f, f.replace(LEET_RE, (c) => LEET_I[c]!), f.replace(LEET_RE, (c) => LEET_L[c]!)] : [f];
  const out = [...base];
  for (const b of base) {
    if (b.includes("l")) out.push(b.replace(/l/g, "i"));
    if (b.includes("i")) out.push(b.replace(/i/g, "l"));
  }
  return out;
};
// A run of three or more single letters split by up to three separators is read as one word ("p a i d").
// Word boundaries mean nothing inside such a run, so a claim word anywhere in it counts ("p a i d x").
const SPACED_RE = /(?<![a-z0-9])[a-z](?:[^a-z0-9]{1,3}[a-z](?![a-z0-9])){2,}/g;
const spacedRuns = (v: string): string => (v.match(SPACED_RE) ?? []).map((r) => r.replace(/[^a-z]/g, "")).join(" ");
const CUR_CODE = "usdc|usdt|usde|usd|eurc|eur|gbp|jpy|cny|rmb|inr|chf|cad|aud|krw|rub|brl|mxn|eth|weth|btc|wbtc|dai|sol|matic|pol|xrp|ltc|bnb|busd|tusd|pyusd|gusd|frax|sats?|gwei|wei" +
  "|xlm|ada|dot|avax|trx|ton|near|atom|apt|sui|shib|doge|xmr|bch|etc|fil|icp|hbar|vet|algo|xtz|eos|cro|usdp|fdusd" +
  "|hkd|sgd|nzd|sek|nok|dkk|pln|try|zar|thb|idr|myr|vnd|ils|aed|sar|ars|clp|cop|pen|egp|ngn|kes|pkr|uah|czk|huf|ron";
const CUR_WORD = "dollars?|bucks|cents?|euros?|pence|quid|yen|yuan|renminbi|rupees?|rubles?|roubles?|pesos?|francs?|satoshis?|bitcoins?|ethers?|stablecoins?";
const MAGNITUDE = "thousand|million|billion|trillion|mil|mio|mrd|mm|mn|bn|tn|k|m|b|t";
const NUMBER_WORD = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half";
const CURRENCY = `(?:\\p{Sc}|(?:${CUR_CODE}|${CUR_WORD})\\b)`;
// Every repeat is bounded and every branch starts at a rare token (a currency, a number word), so a
// hostile run of digits, spaces or hyphens costs linear time, also across a whole dashboard's prose.
// "5 USDC" is found from the currency, with a bounded look back for the number before it.
const AMOUNT_RE = new RegExp(
  `\\p{Sc} ?(?:\\d|(?:${NUMBER_WORD})\\b)` + //                                   $5, $ 5, $five
  `|${CURRENCY}(?<=\\d[\\d,._]{0,40} ?(?:${MAGNITUDE})? ?[(\\[]? ?${CURRENCY})` + //     5 USDC, 1m USDC, 5$, 1 $ USDC
  `|\\b(?:${NUMBER_WORD})\\b[ -]{0,3}(?:(?:${MAGNITUDE})\\b[ -]{0,3})?${CURRENCY}` + // one million dollars
  `|\\ban? (?:${CUR_WORD})\\b` + //                                                  a dollar
  `|\\b(?:${CUR_CODE}|${CUR_WORD})[ :=]{0,3}(?:\\d|(?:${NUMBER_WORD})\\b)`, //       USD 5, usdc:100, USDC five
  "u",
);
// Payment and verification words: English, Spanish, French, German, Italian, Portuguese, Dutch,
// Polish, Turkish and Indonesian, as folded (accents stripped, lowercase).
const CLAIM_WORDS = [
  "paid|unpaid|prepaid|repaid|overpaid|underpaid|payout|payouts|paidout|refund|refunds|refunded|reimbursed",
  "settled|verified|guaranteed|funded|charged|deposited|withdrawn|credited|debited",
  "remitted|disbursed|escrowed",
  "da thanh toan", // Vietnamese "paid", with diacritics folded to this ASCII skeleton already
  "pagad[oa]s?|pago|abonad[oa]s?|reembolsad[oa]s?|reembolso|liquidad[oa]s?|cobrad[oa]s?|acreditad[oa]s?|depositad[oa]s?",
  "verificad[oa]s?|confirmad[oa]s?|aprobad[oa]s?|aprovad[oa]s?|recibid[oa]s?|recebid[oa]s?|creditad[oa]s?|debitad[oa]s?|quitad[oa]s?|saldo",
  "payee?s?|rembourse[es]?|remboursee?s?|remboursement|credite[es]?|creditee?s?|debite[es]?|debitee?s?|verifiee?s?",
  "confirmee?s?|approuvee?s?|encaissee?s?|recue?s?|solde",
  "bezahlt|gezahlt|ausgezahlt|uberwiesen|ueberwiesen|erstattet|ruckerstattet|rueckerstattet|gutgeschrieben|abgebucht",
  "bestatigt|bestaetigt|verifiziert|genehmigt|beglichen|eingegangen|kontostand|guthaben",
  "pagat[oaie]|rimborsat[oaie]|rimborso|accreditat[oaie]|addebitat[oaie]|verificat[oaie]|confermat[oaie]|approvat[oaie]",
  "saldat[oaie]|incassat[oaie]|ricevut[oaie]",
  "betaald|terugbetaald|uitbetaald|geverifieerd|bevestigd|goedgekeurd|ontvangen|gestort",
  "zaplacon[oay]|oplacon[oay]|zwrocon[oay]|potwierdzon[oay]|zweryfikowan[oay]",
  "odendi|onaylandi|dogrulandi|iade|bakiye|dibayar|lunas|dikembalikan|terverifikasi|disetujui",
].join("|");
const CLAIM_RE = new RegExp(`\\b(?:${CLAIM_WORDS})\\b`);
const CLAIM_IN_RUN_RE = new RegExp(`(?:${CLAIM_WORDS})`);
// ── The pair rule (M4 fix): a GENERIC word (received/released/approved/confirmed/complete/...) is
// physical-workflow prose on its own ("Sample received", "Run confirmed for 9:00") and is withheld
// only when a MONEY_OR_VERIFICATION noun sits within 3 words of it, in either order ("payment
// received", "funds released", "payout approved"). "balance"/"balances" moved here as nouns, not
// generic words: a bare "Available balance" label states nothing, but "balance confirmed" does.
const GENERIC_WORDS = "received|released|approved|confirmed|complete|completed|passed|succeeded|successful|cleared|processed|accepted|sent|done";
const CLAIM_NOUNS = "payment|payments|funds|fund|money|payout|payouts|transfer|transfers|transaction|transactions|invoice|invoices|deposit|deposits|escrow|settlement|refund|refunds|balance|balances|wallet|charge|charges|fee|fees|amount|price|verification|identity|kyc|kyb|attestation|proof|audit|oracle";
const CLAIM_NOUN_GROUP = `(?:${CLAIM_NOUNS}|${CUR_CODE}|${CUR_WORD})`;
const GENERIC_GROUP = `(?:${GENERIC_WORDS})`;
// Bounded repeats only (lazy, capped at 3 intervening words) — linear-time even across a whole
// dashboard's joined prose, same discipline as the rest of this file's regexes.
const PAIR_RE = new RegExp(
  `\\b${CLAIM_NOUN_GROUP}\\b(?:\\W+\\w+){0,3}?\\W+${GENERIC_GROUP}\\b` +
  `|\\b${GENERIC_GROUP}\\b(?:\\W+\\w+){0,3}?\\W+${CLAIM_NOUN_GROUP}\\b`,
);
// Folded into the SAME `wordsIn` pass as MONEY_WORDS/NOTICE_WORDS below (one `views()` build, one
// loop) rather than a second independent pass: re-building up to 9 spelling views of a whole
// dashboard's joined prose twice over was measured to roughly 3.5x the adapt+validate time on the
// benchmark's 2,000-char-per-note worst case. PAIR_RE needs no spaced-run check (that defense is
// for single-letter-spaced words, not word-level pairing), so its "inRun" slot never matches.
const PAIR_WORDS: WordCheck = [PAIR_RE, /(?!)/];
// The same words in non-Latin scripts (Russian and Ukrainian, Chinese, Japanese, Korean, Arabic,
// Hindi), matched in the folded text with spaces removed. Each is folded like the text (lower and
// upper case), so a look-alike or all-capitals spelling still matches.
const SCRIPT_CLAIM_WORDS: readonly string[] = ["\u043e\u043f\u043b\u0430\u0447\u0435\u043d", "\u0432\u044b\u043f\u043b\u0430\u0447\u0435\u043d", "\u0441\u043f\u043b\u0430\u0447\u0435\u043d", "\u0432\u043e\u0437\u0432\u0440\u0430\u0449\u0435\u043d", "\u0432\u043e\u0437\u0432\u0440\u0430\u0442", "\u0437\u0430\u0447\u0438\u0441\u043b\u0435\u043d", "\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d", "\u043f\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043d", "\u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d", "\u043e\u0434\u043e\u0431\u0440\u0435\u043d", "\u0431\u0430\u043b\u0430\u043d\u0441", "\u043f\u043e\u043b\u0443\u0447\u0435\u043d", "\u5df2\u4ed8", "\u5df2\u652f\u4ed8", "\u652f\u4ed8\u6210\u529f", "\u9000\u6b3e", "\u5df2\u7ed3\u7b97", "\u5df2\u7d50\u7b97", "\u5df2\u786e\u8ba4", "\u5df2\u78ba\u8a8d", "\u5df2\u9a8c\u8bc1", "\u5df2\u9a57\u8b49", "\u5230\u8d26", "\u5230\u8cec", "\u4f59\u989d", "\u9918\u984d", "\u5df2\u6536\u6b3e", "\u5df2\u6279\u51c6", "\u652f\u6255\u6e08", "\u652f\u6255\u3044\u6e08", "\u652f\u6255\u5b8c\u4e86", "\u652f\u6255\u3044\u5b8c\u4e86", "\u5165\u91d1\u6e08", "\u8fd4\u91d1", "\u6c7a\u6e08\u6e08", "\u6c7a\u6e08\u5b8c\u4e86", "\u78ba\u8a8d\u6e08", "\u627f\u8a8d\u6e08", "\u6b8b\u9ad8", "\uc9c0\uae09\uc644\ub8cc", "\uacb0\uc81c\uc644\ub8cc", "\uacb0\uc81c\ub428", "\uc9c0\uae09\ub428", "\ud658\ubd88", "\uc794\uc561", "\uc785\uae08\uc644\ub8cc", "\ud655\uc778\ub428", "\uc2b9\uc778\ub428", "\u0645\u062f\u0641\u0648\u0639", "\u062a\u0645\u0627\u0644\u062f\u0641\u0639", "\u0627\u0633\u062a\u0631\u062f\u0627\u062f", "\u0631\u0635\u064a\u062f", "\u092d\u0941\u0917\u0924\u093e\u0928\u0915\u093f\u092f\u093e", "\u092d\u0941\u0917\u0924\u093e\u0928\u0939\u094b\u0917\u092f\u093e", "\u03c0\u03bb\u03b7\u03c1\u03ce\u03b8\u03b7\u03ba\u03b5", "\u03c0\u03bb\u03b7\u03c1\u03ce\u03b8\u03b7\u03ba\u03b1\u03bd", "\u03b5\u03c0\u03b9\u03c3\u03c4\u03c1\u03bf\u03c6\u03ae \u03c7\u03c1\u03b7\u03bc\u03ac\u03c4\u03c9\u03bd", "\u03c5\u03c0\u03cc\u03bb\u03bf\u03b9\u03c0\u03bf", "\u05e9\u05d5\u05dc\u05dd", "\u0e0a\u0e33\u0e23\u0e30\u0e41\u0e25\u0e49\u0e27"]
  .flatMap((w) => [foldForClaims(w), foldForClaims(w.toUpperCase())]).map((w) => w.replace(/\s+/g, ""));
const SCRIPT_CLAIM_RE = new RegExp([...new Set(SCRIPT_CLAIM_WORDS)].join("|"), "u"); // the words hold no regex syntax
const NOTICE_RE = /\bwithh[eo]ld/;
const NOTICE_IN_RUN_RE = /withh[eo]ld/;
type WordCheck = readonly [word: RegExp, inRun: RegExp];
const MONEY_WORDS: WordCheck = [CLAIM_RE, CLAIM_IN_RUN_RE];
const NOTICE_WORDS: WordCheck = [NOTICE_RE, NOTICE_IN_RUN_RE];
/** Any of the word checks in any spelling view of the folded text (views are built once). */
function wordsIn(f: string, checks: readonly WordCheck[]): boolean {
  for (const v of views(f)) {
    const runs = spacedRuns(v);
    for (const [word, inRun] of checks) if (word.test(v) || inRun.test(runs)) return true;
  }
  return false;
}
const scriptIn = (f: string): boolean => /[^\x00-\x7f]/.test(f) && SCRIPT_CLAIM_RE.test(f.replace(/ /g, ""));

/** Does the text state an amount (a currency next to a number)? */
// An IDENTIFIER (an id, a capability type) is server- or operator-chosen, and its grammar cannot
// exclude prose (a hyphenated sentence fits it). So it is ATTRIBUTED like free text (steward #5149: fix
// the property, not the detector): every displayed server value is either validated against a closed
// grammar or vocabulary that excludes prose, or shown as "reported: ...".
// Defense in depth: the pair check runs WITHOUT a word window here. A money noun or currency and a
// generic claim word ANYWHERE in it withholds it ("payment-from-the-remote-operator-received"). A single
// money noun alone does not, because real lab types use them ("liquid-transfer", "analytical-balance").
const IDENT_NOUN_RE = new RegExp(`\\b${CLAIM_NOUN_GROUP}\\b`);
const IDENT_GENERIC_RE = new RegExp(`\\b${GENERIC_GROUP}\\b`);
export function identifierText(field: string, value: string): KitText {
  if (value === "") return kitText("");
  const t = boundValueText(field, value);
  if (t === WITHHELD_FIELD) return t;
  for (const v of views(foldForClaims(value))) if (IDENT_NOUN_RE.test(v) && IDENT_GENERIC_RE.test(v)) return WITHHELD_FIELD;
  return (REPORTED_PREFIX + value) as KitText;
}
export function statesAmount(text: string): boolean { return AMOUNT_RE.test(foldForClaims(text)); }
/** Does the text state an amount or a payment or verification status? */
export function isMoneyClaim(text: string): boolean { const f = foldForClaims(text); return AMOUNT_RE.test(f) || scriptIn(f) || wordsIn(f, [MONEY_WORDS, PAIR_WORDS]); }
/** Does the text mention PCC's withheld notice ("withheld", "withhold")? Only PCC may say that. */
export function mentionsWithheld(text: string): boolean { return wordsIn(foldForClaims(text), [NOTICE_WORDS]); }
/** Agent prose that may not be shown: a money claim, or a mention of PCC's notice (one fold). */
export function isProseClaim(text: string): boolean {
  const f = foldForClaims(text);
  return AMOUNT_RE.test(f) || scriptIn(f) || wordsIn(f, [MONEY_WORDS, NOTICE_WORDS, PAIR_WORDS]);
}

// A bound RECORD status is the record's own word, never a payment fact: a job row can literally say
// "settled" with nothing paid (#313; pcc-design #3013). Any value read from a field named `status`
// (status, job.status, kernel.status) whose word is a money state gets PCC's fixed qualifier, in every
// sink (metric, run card, list badge and list meta). Narrower than CLAIM_RE on purpose ("verified",
// "approved" are not money states). Look-alikes, zero-width characters, fullwidth forms and camel,
// snake or kebab joins ("SETTLED_RELEASED", "payoutPending") are folded first.
export const RECORD_STATUS_NOTE = kitText(" - reported by the record, not confirmed by a settlement read");
const MONEY_STATE_RE = /\b(?:settled|released|paid|unpaid|payout|payouts|refund|refunded|refunds|funded|unfunded|charged|credited|debited|deposited|withdrawn|escrowed)\b/;
export function isMoneyState(value: string): boolean {
  return MONEY_STATE_RE.test(foldForClaims(value).replace(/[^a-z0-9]+/g, " "));
}
export function recordValueText(field: string, value: string): KitText {
  return (value !== "" && /(^|\.)status$/.test(field) && isMoneyState(value) ? value + RECORD_STATUS_NOTE : value) as KitText;
}

// ── A CLOSED safe vocabulary for bound status values (astra r3 H1) ───────────────────────
// The OLD rule failed OPEN: any status word that wasn't independently recognised as a claim was
// shown bare — so "Verification passed" (not in the lexicon) rendered verbatim. The new rule fails
// CLOSED: a status is shown bare ONLY when it normalizes EXACTLY to a word on this list. No payment
// or money-movement word may be in it (checked by a test). Same list as #313's (pcc-design #3013,
// job-status terms); this file is dependency-free, so it is duplicated here rather than imported.
export const SAFE_STATUS_WORDS: ReadonlySet<string> = new Set([
  "RUNNING", "IN_PROGRESS", "PROGRESS", "STREAMING", "BUILDING", "CONNECTING", "PENDING", "QUEUED", "WAITING", "PAUSED",
  "REVIEW", "CONFIRM", "NEEDS_INPUT", "NEEDS_YOU", "ERROR", "FAILED", "DENIED", "CANCELLED", "CANCELED", "REJECTED",
  "DONE", "COMPLETE", "COMPLETED", "OK", "SUCCESS", "SUCCEEDED", "RESOLVED", "READY", "DISPATCHED", "ACCEPTED",
  "PREPARING", "EXECUTING", "COLLECTING_EVIDENCE", "AWAITING_PICKUP", "TIMED_OUT", "ONLINE", "OFFLINE", "MAINTENANCE",
  "SUSPENDED", "HEALTHY", "DEGRADED", "UNKNOWN", "BIDDING", "ASSIGNED", "PROPOSED", "OVER_BUDGET", "NO_PATH_FOUND",
  "APPROVED", "EXPIRED", "ACTIVE", "INACTIVE", "REVOKED", "IDLE", "BUSY", "DRAFT", "DEPRECATED", "RESERVED",
  "LIVE", "STUB", "PLANNED", "TRUE", "FALSE",
]);
/** Normalize a status value for the closed-vocabulary check: fold confusables/case/joins first
 *  (same discipline as isMoneyState), then uppercase and collapse any run of non-alphanumerics to
 *  one underscore (so "in progress", "in-progress" and "IN_PROGRESS" all normalize alike). */
function normalizeStatusWord(value: string): string {
  return foldForClaims(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function isSafeStatusWord(value: string): boolean { return SAFE_STATUS_WORDS.has(normalizeStatusWord(value)); }

// ── Bound values (astra r2 F2; astra r3 H1 fail-closed status) ───────────────────────────
// A fetched value is data, but a free field still carries words: a capability NAMED "Paid $1M -
// verified" would read as a payment fact in a list title or a card. Every bound value the view shows
// passes boundValueText. A status field is CLOSED (4 cases, checked in order): (1) a value that
// states an amount or mentions the notice is WITHHELD_FIELD; (2) a SAFE_STATUS_WORDS word is shown
// bare; (3) a money state (isMoneyState) gets RECORD_STATUS_NOTE; (4) ANY other value gets
// RECORD_CLAIM_NOTE — never shown bare just because it wasn't independently recognised as a claim.
// A non-status field is unchanged: a claim becomes WITHHELD_FIELD, using the stronger detector. Only
// a PCC card's own money fields (the price and its currency) show money, and they never pass through
// here — they are now type-validated instead (dashboard-ir-renderer.ts readField).
export const RECORD_CLAIM_NOTE = kitText(" - reported by the record, not confirmed by PCC");
export const WITHHELD_FIELD = kitText("withheld: stated money or verification");
/** The CLOSED status treatment (4 cases, checked in order) — factored out of `boundValueText` so
 *  it can be applied BY ROLE (astra r4 finding 1): any value the caller already knows is a status
 *  WORD by its list field KIND (LIST_FIELD_KINDS below, "status"), wherever that field appears —
 *  title, meta or statusFrom — gets this, not only a field whose NAME happens to end in "status".
 *  (1) a value that states an amount or mentions the notice is WITHHELD_FIELD; (2) a
 *  SAFE_STATUS_WORDS word is shown bare; (3) a money state (isMoneyState) gets RECORD_STATUS_NOTE;
 *  (4) ANY other value gets RECORD_CLAIM_NOTE — never shown bare just because it wasn't
 *  independently recognised as a claim. */
export function boundStatusText(value: string): KitText {
  if (value === "") return kitText("");
  if (statesAmount(value) || mentionsWithheld(value)) return WITHHELD_FIELD; // 1
  if (isSafeStatusWord(value)) return value as KitText; // 2
  if (isMoneyState(value)) return (value + RECORD_STATUS_NOTE) as KitText; // 3
  return (value + RECORD_CLAIM_NOTE) as KitText; // 4 - fail closed, not "bare unless recognised"
}
export function boundValueText(field: string, value: string): KitText {
  if (value === "") return kitText("");
  if (/(^|\.)status$/.test(field)) return boundStatusText(value);
  return isMoneyClaim(value) || mentionsWithheld(value) ? WITHHELD_FIELD : value as KitText;
}

// ── Attributed free text (astra r5 F1; same rule astra accepted on #313's F12) ───────────
// A free-text value is never shown as PCC's OWN fact, even when the lexical detector doesn't
// independently catch it (the pair rule only looks 3 words either side — "payment from the
// remote operator received" is 4 words apart and passes isMoneyClaim unchanged). So every
// TEXT-kind bound value is explicitly attributed to the record that reported it — structural,
// not merely a backstop. A value the lexical detector DOES catch is still WITHHELD_FIELD (the
// detector remains defense in depth underneath this, never replaced by it).
export const REPORTED_PREFIX = kitText("reported: ");
export function reportedFieldText(field: string, value: string): KitText {
  return boundValueText(field, value) === WITHHELD_FIELD ? WITHHELD_FIELD : (REPORTED_PREFIX + value) as KitText;
}

// ── PCC-owned list field profiles (PX-5 review #2504) ────────────────────────────────────
// A list may show ONLY these fields of each allowlisted collection route; a selector is never
// "safe because it parses". Money amounts, prices and payment state are not listable: they
// appear only in schema cards. Escrow is not a list route at all.
// `rows` is the route's own array key (genui review of #344 r5, derived from the real producers by
// route inject): GET /api/jobs answers { jobs: [...] }, /api/kernels { kernels: [...] }, and
// /api/capabilities { items: [...] }. The binder used to guess `.items`, so job and kernel lists
// never showed a row.
// `location.label` removed (astra r5 F5): genui measured it by route inject over the seeded
// store and found it present in 0/8 real kernel rows and 0/19 real capability rows (real data
// carries `location: {lat, lng}`, never a `.label`) — dead surface, never exercised by a real
// producer. Also removed from LIST_FIELD_KINDS (below) and LIST_FIELD_LABELS (dashboard-ir-
// renderer.ts).
export const LIST_PROFILES: Readonly<Record<string, { rows: string; title: readonly string[]; meta: readonly string[]; status: readonly string[] }>> = {
  "/api/jobs": { rows: "jobs", title: ["id", "capabilityId"], meta: ["id", "capabilityId", "kernelId", "status", "createdAt", "updatedAt"], status: ["status"] },
  "/api/kernels": { rows: "kernels", title: ["name", "id"], meta: ["id", "status", "version", "capabilityCount"], status: ["status"] },
  "/api/capabilities": { rows: "items", title: ["name", "id"], meta: ["id", "type", "kernelId"], status: ["available"] },
};
/** The rows of a list response, read ONLY by the route's PCC-owned rows key (an own property;
 * never a manifest selector, never a bare top-level array — astra r5 F3). Returns **null** when
 * there is no collection at all: the path has no LIST_PROFILES entry; `data` is not a non-null,
 * non-array object; the route's own rows key is not an OWN property of `data`; or its value is
 * not an array. Returns `[]` ONLY when the route's own rows key holds an empty array — the
 * source explicitly returned an empty collection. A caller must never treat null as []: an
 * off-contract envelope is unavailable, never a fresh "none" (astra 28e H1: absence is not
 * evidence). */
export function listRowsOf(path: string, data: unknown): unknown[] | null {
  const key = Object.prototype.hasOwnProperty.call(LIST_PROFILES, path) ? LIST_PROFILES[path]!.rows : undefined;
  if (!key) return null; // no LIST_PROFILES entry for this path
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null; // not a non-null, non-array object
  if (!Object.prototype.hasOwnProperty.call(data, key)) return null; // the route's own rows key is not an own property
  const v = (data as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return null; // present but not an array
  return v; // [] here means the source explicitly returned an empty collection
}

// ── A closed TYPE for every list field (the structural boundary; astra r4 on #344) ───────
// The list row stops relying on selector NAMES: every field ANY LIST_PROFILES entry allows
// (title, meta or status) gets exactly one KIND here, read and validated by the renderer's
// readListField BY THAT KIND, whatever role it plays (title, meta or statusFrom — finding 1). The
// map is exhaustive over LIST_PROFILES in both directions (checked by a test): a field that is not
// here cannot be listed at all — listProfileViolation already refuses it before the renderer ever
// sees it, so an entry here with no profile use would be dead, and a profile field with no entry
// here would have no validated kind.
export type ListFieldKind = "id" | "text" | "status" | "bool" | "time" | "version" | "count" | "capType";
export const LIST_FIELD_KINDS: Readonly<Record<string, ListFieldKind>> = {
  id: "id", capabilityId: "id", kernelId: "id",
  name: "text",
  status: "status",
  available: "bool",
  createdAt: "time", updatedAt: "time",
  version: "version",
  capabilityCount: "count",
  type: "capType",
};

function listProfileViolation(path: string, props: Record<string, unknown>): string | null {
  const prof = LIST_PROFILES[path];
  if (!prof) return `no list field profile for ${path}`;
  if (typeof props.rowTitle !== "string" || !prof.title.includes(props.rowTitle)) return `list title field not in the ${path} profile`;
  const meta = Array.isArray(props.rowMeta) ? props.rowMeta : [];
  for (const m of meta) if (typeof m !== "string" || !prof.meta.includes(m)) return `list meta field not in the ${path} profile`;
  if (props.statusFrom !== undefined && (typeof props.statusFrom !== "string" || !prof.status.includes(props.statusFrom))) return `list status field not in the ${path} profile`;
  return null;
}

// The ONE fixed PCC-owned approval sentence. B renders exactly this — never manifest prose.
const APPROVAL_NOTICE = kitText("This action is confirmed only on the authenticated PCC surface.");

// ── Governed bindings — EXACT, end-anchored routes pinned to the REAL route table ──
// Deny-by-default. Each RegExp is a specific verified read endpoint.
const PATH_GRAMMAR = /^\/api\/[A-Za-z0-9._~\-/]+$/; // root-relative /api; no scheme/host/query/fragment/{}
const SSE_GRAMMAR = /^\/sse\/[A-Za-z0-9._~\-/]+$/;
const SELECT_GRAMMAR = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const OP_ID_GRAMMAR = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/; // typed op id (discarded in B, still grammared)

// ── The collision defense (sol R3-R6): an ID_SEG is one path segment that is NOT a
// bare lowercase-alpha(-hyphen) word. PCC resource ids carry a DIGIT / underscore /
// uppercase / 0x-prefix (uuids, cap-1, kernel_x, 0x…); the collection/status/verb
// route NAMES that collide with a detail template — types, status, graph-stats,
// lit-status, submit, submit-from-discovery, … — are pure lowercase-alpha(-hyphen).
// So a `:` template matcher REJECTS THAT WHOLE CLASS by construction, robust to new
// sibling routes, instead of depending on a hand-maintained blocklist being complete.
const ID_SEG = "(?![a-z]+(?:-[a-z]+)*(?:/|$))[A-Za-z0-9_~.-]+";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Compile a route template; ":" marks an ID_SEG. e.g. "/api/jobs/:/status". */
function route(template: string): RegExp {
  return new RegExp("^" + template.split("/").map((s) => (s === ":" ? ID_SEG : escRe(s))).join("/") + "$");
}
/** Same, but ":" becomes a CAPTURE group (for sse↔path id correlation). */
function routeCap(template: string): RegExp {
  return new RegExp("^" + template.split("/").map((s) => (s === ":" ? "(" + ID_SEG + ")" : escRe(s))).join("/") + "$");
}
// Secondary explicit denylist: the id-grammar above catches every pure-alpha sibling;
// this is belt-and-suspenders for any DIGIT-bearing reserved word the grammar can't
// (none currently) + a documented record of the known collisions found by sol.
const RESERVED_EXACT: ReadonlySet<string> = new Set([
  "/api/capabilities/types", "/api/capabilities/templates", "/api/capabilities/search",
  "/api/capabilities/graph-stats", "/api/capabilities/graph-search",
  "/api/settlement/status", "/api/settlement/epochs", "/api/settlement/flush",
  "/api/settlement/submit", "/api/settlement/release",
  "/api/evidence/lit-status", "/api/evidence/archive", "/api/evidence/embed", "/api/evidence/search",
  "/api/jobs/submit", "/api/jobs/submit-from-discovery",
  "/api/kernels/marketplace", "/api/kernels/register", "/api/escrow/chain",
]);
export type BindSchema = "capability-summary-v1" | "run-summary-v1";
interface BindPolicy {
  // Provenance (PX-4): the class, schema and freshness budget of the data this route serves.
  // Server-owned, like the routes themselves; a manifest can never choose any of these.
  // Bound data is only ever A (authoritative) or B (accepted), never C/D/E.
  sourceClass: BoundSourceClass;
  schemaId: string;
  maxAgeMs: number; // older than this at render time => visibly stale
  routes: RegExp[];
  // Query parameters a manifest may pass, per exact route path. Anything else (including any
  // credential-like name) is refused: a binding URL never carries a token (review #2504).
  queryByRoute?: Readonly<Record<string, readonly string[]>>;
  needsSelect?: boolean;
  sse?: RegExp[];
  correlate?: { pathRe: RegExp; sseRe: RegExp };

  schema?: BindSchema;
}
const BIND_POLICY: Record<string, BindPolicy> = {
  // metric: object-returning read + a REQUIRED scalar `select` (else the whole object shows).
  // Only NON-money, non-settlement-timestamp scalar routes are allowed. REMOVED:
  //  - /api/settlement/:, /api/escrow/: (settlement/payment STATE → "Payment received");
  //  - /api/fiat-ramp/.../wallet/:/balance (an ARBITRARY address's usdc, no ownership → a
  //    manifest could label it "Payment received");
  //  - /api/jobs/:id detail (exposes updatedAt/completedAt-derived + escrow amounts → "Settled at").
  // jobs/:id/status + kernels/:id expose no money amount / settlement timestamp. The real
  // gate is the METRIC_SELECT_LABEL allowlist (PCC-owned label per allowlisted selector) — a
  // manifest can neither select a money/timestamp scalar NOR supply a payment/settlement label.
  metric: {
    sourceClass: "authoritative", schemaId: "metric-scalar-v1", maxAgeMs: 120_000,
    routes: [route("/api/jobs/:/status"), route("/api/kernels/:")],
    needsSelect: true,
  },
  // capability card: a fixed PCC-owned SUMMARY (name/type/price/tiers/availability),
  // rendered from the KNOWN CapabilityDTO schema — the manifest supplies NO selectors.
  capability: { sourceClass: "authoritative", schemaId: "capability-summary-v1", maxAgeMs: 3_600_000, routes: [route("/api/capabilities/:")], schema: "capability-summary-v1" }, // ID_SEG excludes types/templates/search/graph-*
  // NOTE: `receipt` has NO bind policy — the settlement record is a STATIC POINTER (no
  // fetch). A public read GET cannot reach settlement (auth-gated) and, worse, the
  // endpoint reports `settled` for a merely-completed job and exposes the PHYSICAL
  // completion time as `settledAt` — so a fetched "Settled at" label would affirmatively
  // assert a settlement that never occurred. The authoritative receipt is the out-of-band
  // Surface-B signed receipt (VCR); B only points at it. (See the receipt case below.)
  // list: collection reads whose rows are listable ONLY through a PCC-owned field profile
  // (LIST_PROFILES). Escrow is NOT listable: money state appears only in schema cards.
  list: {
    sourceClass: "authoritative", schemaId: "collection-v1", maxAgeMs: 300_000,
    routes: [route("/api/jobs"), route("/api/kernels"), route("/api/capabilities")],
    queryByRoute: {
      "/api/jobs": ["kernelId", "status", "offset", "limit"],
      "/api/kernels": ["status"],
      "/api/capabilities": ["type", "offset", "limit"],
    },
  },
  // run card: a fixed PCC-owned SUMMARY (status/progress) read from the KNOWN job
  // schema. The manifest's statusFrom/latestFrom are validated but IGNORED at render
  // (they may never relabel an arbitrary field as "Status" — PCC owns the meaning).
  run: {
    sourceClass: "authoritative", schemaId: "run-summary-v1", maxAgeMs: 60_000,
    routes: [route("/api/jobs/:"), route("/api/jobs/:/status")],
    sse: [route("/sse/stream/job/:")],
    correlate: { pathRe: new RegExp("^/api/jobs/(" + ID_SEG + ")(?:/status)?$"), sseRe: routeCap("/sse/stream/job/:") },
    schema: "run-summary-v1",
  },
  // approval in B is a STATIC notice — no live bind (live approval state is C+D out-of-band).
};

export interface IrBind { path: string; select?: string; query?: Record<string, string | number | boolean>; pollMs?: number; sse?: string; schema?: BindSchema }
export interface IrNode { type: IrNodeType; id: string; props?: Record<string, string | number | boolean | string[]>; bind?: IrBind; children?: IrNode[]; untrusted?: true }
export interface IrDoc { ir: "pcc-dashboard-ir/v1"; title: IrNode; root: IrNode }
export type IrResult = { ok: true; doc: IrDoc } | { ok: false; reason: string };

// ── Safe primitives (REJECT, never strip) ────────────────────────────────────────
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Plain object whose prototype is exactly Object.prototype or null (rejects
 * Object.create(evil), poisoned prototypes, class instances). */
function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
function strictStr(v: unknown, max: number = LIM.str): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
/** Own-key allowlist over ALL own keys (enumerable + non-enumerable + symbol).
 * Rejects: any symbol own key, any string own key outside `allowed`, and any
 * NON-ENUMERABLE own key even with an allowed name (a hidden data-shaped prop). */
function onlyKeys(o: object, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  for (const k of Reflect.ownKeys(o)) {
    if (typeof k === "symbol") return false;
    if (!set.has(k)) return false;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !d.enumerable) return false;
  }
  return true;
}
const INDEX_KEY = /^(0|[1-9][0-9]*)$/;
/** Recursively require plain objects/arrays/finite scalars and reject prototype /
 * symbol / non-enumerable / non-index own keys ANYWHERE (over Reflect.ownKeys).
 * BUDGETED: a shared node counter fails fast so a hostile wide/deep object cannot
 * force full traversal before rejection (browser-side validateIr availability). */
function deepClean(v: unknown, depth = 0, budget: { n: number } = { n: LIM.cleanNodes }): boolean {
  if (depth > LIM.inputDepth) return false;
  if (--budget.n < 0) return false;
  const t = typeof v;
  if (v === null || t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v as number);
  if (Array.isArray(v)) {
    for (const k of Reflect.ownKeys(v)) { // reject symbol / extra / non-index own keys on the array itself
      if (typeof k === "symbol") return false;
      if (k !== "length" && !INDEX_KEY.test(k)) return false;
    }
    for (const e of v) if (!deepClean(e, depth + 1, budget)) return false;
    return true;
  }
  if (!isPlain(v)) return false;
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k === "symbol" || PROTO_KEYS.has(k)) return false;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !d.enumerable) return false;
    if (!deepClean((v as Record<string, unknown>)[k], depth + 1, budget)) return false;
  }
  return true;
}
/** Dotted selector with NO prototype segment. */
function isSelector(s: unknown): s is string {
  if (typeof s !== "string" || !SELECT_GRAMMAR.test(s) || s.length > LIM.select) return false;
  for (const seg of s.split(".")) if (PROTO_KEYS.has(seg)) return false;
  return true;
}
/** Read path: grammar + no `..` and no single-dot segment. */
function isReadPath(s: unknown, grammar: RegExp = PATH_GRAMMAR): s is string {
  if (typeof s !== "string" || !grammar.test(s) || s.length > LIM.path) return false;
  for (const seg of s.split("/")) if (seg === ".." || seg === ".") return false;
  return true;
}
// Credential-named field DETECTION (normalized: lowercase, strip separators) — for
// form field labels. Exact-match set avoids "author"/"shipping" false positives;
// the short substring set catches compounds (userPassword, client_secret).
const CRED_EXACT: ReadonlySet<string> = new Set([
  "password", "secret", "token", "credential", "apikey", "privatekey", "authorization",
  "bearer", "accesstoken", "refreshtoken", "clientsecret", "sessiontoken", "otp", "cvv",
  "pin", "mnemonic", "seedphrase", "passphrase", "privkey", "signingkey",
]);
const CRED_SUBSTR = ["password", "secret", "privatekey", "apikey", "credential", "passphrase"];
function isCredentialName(k: string): boolean {
  const n = k.toLowerCase().replace(/[_\-\s]/g, "");
  if (CRED_EXACT.has(n)) return true;
  return CRED_SUBSTR.some((t) => n.includes(t));
}
// PCC-OWNED metric PROFILE (sol finding 3 durable fix + envelope correctness). Per metric
// route, the allowlisted selectors → { PCC label, actual SOURCE path in that route's response
// envelope }. PCC owns the label so a manifest can never frame a scalar as a payment/settlement
// ("Payment received", "Funds received at"); and only these selectors are bindable, so a money
// amount or settlement/heartbeat timestamp (usdc, lastHeartbeat, updatedAt, totalAmount) is not
// selectable at all. A closed (route, selector) map beats a denylist (which leaks "Disbursement
// time"). The `source` handles per-route unwrapping: GET /api/kernels/:id returns { kernel: … },
// so "reputation" reads "kernel.reputation" — else the metric would bind but stay inert.
// validateIr MIRRORS this (stat label + bind.select-as-source must match a profile entry).
// Closed value kind per metric field (astra r5 F2) — mirrors ListFieldKind's discipline (a
// fetched stat is validated by its KIND, never shown merely because it happened to parse as a
// string/number/boolean). "percent" (not "capType") replaces the one list-only kind: no metric
// field needs a capability-type grammar. Picked from each field's real producer:
//  - jobs/:id/status (routes/job-submit.ts GET): status is the job's status word; progress is
//    the DB's `integer("progress")` column, seeded 0..100 (packages/db/src/schema/jobs.ts).
//  - kernels/:id (routes/kernels.ts GET, KernelHealthSnapshot): status is the kernel's status
//    word; reputation is ReputationService.computeEffectiveReputation's Math.round(...) output,
//    a non-negative integer (count); uptimePercent is populateKernelHealthSnapshot's
//    computeUptimePercent, one of 0/50/100/undefined (percent); capabilityCount/
//    totalJobsCompleted/activeJobCount are all non-negative integer counts.
export type MetricFieldKind = "status" | "percent" | "count" | "bool" | "time" | "id" | "text" | "version";
interface MetricField { label: KitText; source: string; kind: MetricFieldKind }
const METRIC_PROFILE: ReadonlyArray<{ route: RegExp; fields: Readonly<Record<string, MetricField>> }> = [
  { route: route("/api/jobs/:/status"), fields: { // top-level envelope
    status: { label: kitText("Status"), source: "status", kind: "status" },
    progress: { label: kitText("Progress"), source: "progress", kind: "percent" },
  } },
  { route: route("/api/kernels/:"), fields: { // GET /api/kernels/:id → { kernel: KernelHealthSnapshot }
    status: { label: kitText("Status"), source: "kernel.status", kind: "status" },
    reputation: { label: kitText("Reputation"), source: "kernel.reputation", kind: "count" },
    uptimePercent: { label: kitText("Uptime"), source: "kernel.uptimePercent", kind: "percent" },
    capabilityCount: { label: kitText("Capabilities"), source: "kernel.capabilityCount", kind: "count" },
    totalJobsCompleted: { label: kitText("Jobs completed"), source: "kernel.totalJobsCompleted", kind: "count" },
    activeJobCount: { label: kitText("Active jobs"), source: "kernel.activeJobCount", kind: "count" },
  } },
];
/** Adapter side: (route, logical selector) → the field profile (label + real source + kind), or null. */
function metricFieldForSelect(path: string, select: unknown): MetricField | null {
  if (typeof select !== "string") return null;
  for (const p of METRIC_PROFILE) if (p.route.test(path)) return hasOwn(p.fields, select) ? p.fields[select] : null;
  return null;
}
/** Shared lookup: (route, SOURCE path already in bind.select) → the field profile, or null. Both
 * the label lookup (validateIr) and the kind lookup (bindScalar) are one route match away. */
function metricFieldForSource(path: string, source: unknown): MetricField | null {
  if (typeof source !== "string") return null;
  for (const p of METRIC_PROFILE) if (p.route.test(path)) {
    for (const k of Object.keys(p.fields)) if (p.fields[k].source === source) return p.fields[k];
    return null;
  }
  return null;
}
/** Validator side: (route, SOURCE path already in bind.select) → the expected PCC label, or null. */
function metricLabelForSource(path: string, source: unknown): KitText | null {
  return metricFieldForSource(path, source)?.label ?? null;
}
/** Renderer side (astra r5 F2): (route, SOURCE path already in bind.select) → the field's closed
 * value kind, or null when the pair isn't an allowlisted metric field at all. bindScalar uses
 * this to validate the fetched value BY KIND before any content check — off-kind is UNAVAILABLE,
 * never shown merely because it happened to parse as some other type. */
export function metricKindForSource(path: string, source: unknown): MetricFieldKind | null {
  return metricFieldForSource(path, source)?.kind ?? null;
}
/** Closed typed-op descriptor grammar (submit/execute/approve/deny/action). Its
 * content is DISCARDED in B, but a malformed shape is REJECTED, never stripped. */
function isOpDescriptor(v: unknown): boolean {
  if (!isPlain(v) || !onlyKeys(v, ["id", "label", "confirm", "intentText", "operation_id", "arguments"])) return false;
  if (v.operation_id !== undefined && (typeof v.operation_id !== "string" || !OP_ID_GRAMMAR.test(v.operation_id))) return false;
  if (v.id !== undefined && strictStr(v.id, LIM.title) === null) return false;
  if (v.label !== undefined && strictStr(v.label, LIM.title) === null) return false;
  if (v.intentText !== undefined && strictStr(v.intentText, LIM.str) === null) return false;
  // Real Action.confirm is the enum "inline"|"approval" (spec/ui-artifact.ts), NOT boolean.
  if (v.confirm !== undefined && v.confirm !== "inline" && v.confirm !== "approval") return false;
  if (v.arguments !== undefined && !isPlain(v.arguments)) return false; // deepClean already ran
  return true;
}

// ── Shared bind gate — the ONE policy check both adapter and validator call ────────
// ── Effect review of every bindable read (PX-5 review #2504: GET-only is not effect-free) ─────
// Each route a manifest can bind was read at its handler (2026-09-24, master ac86a404; re-read
// 2026-09-29 for astra r2 F3). None changes PCC business state: no job, kernel, capability, money,
// approval or registry write. They are NOT free of operational effects, and each entry names its own:
//  - every facade read runs through BaseFacade.execute, which emits one telemetry event
//    (facades/base.facade.ts emitTelemetry -> telemetry.ts emit: an in-memory per-job event buffer and
//    rate counter, a StreamHub publish to SSE subscribers, a Sentry breadcrumb);
//  - with PCC_FUNNEL_ENABLED=true, a 2xx GET under /api/capabilities records a "discover" funnel stage
//    once per request trace (services/funnel-tracker.ts): a durable audit row, a PostHog event and an
//    OTel span event, so a polling dashboard adds audit rows. The flag is off unless exactly "true".
// The browser binder sends no credentials (credentials:"omit"), so its reads never resolve an API key
// and never meter API-key usage (auth/api-key-auth.ts increments usage on each token resolution).
// Other /mcp/apps calls that do carry a key (the typed quote op, the proxy tools) are metered: whether
// a read-only app call should meter is an auth-policy question for the gateway owner, not settled here.
// The SSE job stream is authenticated and never opened by the browser kit (no SSE transport).
// A test pins this list to BIND_POLICY: a new bindable route needs a new entry, i.e. a new review.
const FACADE_READ = "no business-state write; one telemetry event (facade read)";
const FUNNEL = "; with PCC_FUNNEL_ENABLED=true a 'discover' funnel audit row + PostHog event per request trace";
export const EFFECT_REVIEWED_READS: ReadonlyArray<{ route: string; handler: string; effect: string }> = [
  { route: "/api/jobs", handler: "routes/jobs.ts GET /api/jobs -> JobFacade.list", effect: FACADE_READ },
  { route: "/api/jobs/:", handler: "routes/jobs.ts GET /api/jobs/:jobId -> JobFacade.getById", effect: FACADE_READ },
  { route: "/api/jobs/:/status", handler: "routes/job-submit.ts GET /api/jobs/:jobId/status -> JobFacade.getStatus", effect: FACADE_READ },
  { route: "/api/kernels", handler: "routes/kernels.ts GET /api/kernels -> KernelFacade.list", effect: FACADE_READ },
  { route: "/api/kernels/:", handler: "routes/kernels.ts GET /api/kernels/:kernelId -> KernelFacade.getById", effect: FACADE_READ },
  { route: "/api/capabilities", handler: "routes/capabilities.ts GET /api/capabilities -> CapabilityFacade list", effect: FACADE_READ + FUNNEL },
  { route: "/api/capabilities/:", handler: "routes/capabilities.ts GET /api/capabilities/:capId -> CapabilityFacade.getById", effect: FACADE_READ + FUNNEL },
  { route: "/sse/stream/job/:", handler: "sse/topic-sse.ts GET /sse/stream/job/:jobId (auth + ownership check, topic subscribe)", effect: "no business-state write; per-IP connection counter; never opened by the browser kit" },
];
/** Regex sources of every route (and SSE route) BIND_POLICY lets a manifest bind. */
export function bindPolicyRouteSources(): string[] {
  const out = new Set<string>();
  for (const p of Object.values(BIND_POLICY)) { for (const re of p.routes) out.add(re.source); for (const re of p.sse ?? []) out.add(re.source); }
  return [...out].sort();
}
/** The regex source a reviewed template compiles to (same compiler as BIND_POLICY). */
export function reviewedRouteSource(template: string): string { return route(template).source; }

function bindMatchesPolicy(bind: IrBind, key: string): string | null {
  const policy = BIND_POLICY[key];
  if (!policy) return `no bind policy for ${key}`;
  if (!isReadPath(bind.path)) return "bind.path grammar";
  if (RESERVED_EXACT.has(bind.path)) return "bind.path is a reserved/collection route";
  if (!policy.routes.some((re) => re.test(bind.path))) return `bind.path outside ${key} allowlist`;
  if (bind.select !== undefined && !isSelector(bind.select)) return "bind.select grammar";
  if (policy.needsSelect && bind.select === undefined) return `${key} requires a scalar select`;
  if (!policy.needsSelect && bind.select !== undefined) return `${key} may not select`;
  if (bind.query !== undefined) {
    if (!isPlain(bind.query) || Object.keys(bind.query).length > LIM.queryKeys) return "bind.query shape";
    const allowedQuery = policy.queryByRoute?.[bind.path] ?? [];
    for (const [k, v] of Object.entries(bind.query)) {
      if (!isSelector(k)) return "query key grammar";
      if (isCredentialName(k) || !allowedQuery.includes(k)) return `query key "${k}" not allowed for ${bind.path}`;
      const t = typeof v;
      if (!(t === "string" && (v as string).length <= LIM.str) && t !== "boolean" && !(t === "number" && Number.isFinite(v))) return "query value type";
    }
  }
  if (bind.pollMs !== undefined && (typeof bind.pollMs !== "number" || !Number.isFinite(bind.pollMs) || bind.pollMs < LIM.pollMinMs || bind.pollMs > LIM.pollMaxMs)) return "bind.pollMs range";
  if (bind.sse !== undefined) {
    if (!policy.sse) return `${key} may not stream`;
    if (!isReadPath(bind.sse, SSE_GRAMMAR) || !policy.sse.some((re) => re.test(bind.sse as string))) return "bind.sse outside allowlist";
    if (policy.correlate) {
      const mp = policy.correlate.pathRe.exec(bind.path);
      const ms = policy.correlate.sseRe.exec(bind.sse);
      if (!mp || !ms || mp[1] !== ms[1]) return "sse/path identity mismatch";
    }
  }
  if (policy.schema) { if (bind.schema !== policy.schema) return `bind.schema must be ${policy.schema}`; }
  else if (bind.schema !== undefined) return "unexpected bind.schema";
  return null;
}

/** True only when `path` (no query string) is a route the closed IR can BIND to: one of
 *  BIND_POLICY's reviewed read routes, passing the same read-path grammar, and not a reserved
 *  route. The gateway's CORS delegator (middleware/security-hardening.ts) uses it. The governed
 *  GenUI view runs at the MCP App domain or a host's sandbox origin and fetches with
 *  credentials:"omit", so it gets credential-less read access to EXACTLY these public routes
 *  and to nothing else (row 37; operator item 109(b)). */
export function isIrBindablePath(path: string): boolean {
  if (!isReadPath(path) || RESERVED_EXACT.has(path)) return false;
  return Object.values(BIND_POLICY).some((policy) => policy.routes.some((re) => re.test(path)));
}

/** What the closed IR READS from a bindable route, for the server-side projection
 *  (mcp/dashboard-ir-read-projection.ts):
 *  - the list profile's row fields under its rows key;
 *  - the metric profile's source paths;
 *  - the bind schemas whose fixed card fields apply (ordered alternatives, resolved by the
 *    projection exactly as the renderer resolves them);
 *  - `asOf`, always.
 *  No page metadata (total, offset, limit, hasMore): no closed-IR sink reads it (astra #562 r2 F2).
 *  Returns null for a path the IR cannot bind. A cross-origin (CORS wildcard) response carries
 *  ONLY these fields, never the raw body. Client-side projection is not a confidentiality
 *  boundary (astra #562 r1 F1). */
export function irReadShape(path: string): { rowsKey: string | null; rowFields: string[]; fields: string[]; schemas: BindSchema[] } | null {
  if (!isIrBindablePath(path)) return null;
  const lp = Object.prototype.hasOwnProperty.call(LIST_PROFILES, path) ? LIST_PROFILES[path]! : null;
  const fields = new Set<string>(["asOf"]);
  for (const m of METRIC_PROFILE) if (m.route.test(path)) for (const f of Object.values(m.fields)) fields.add(f.source);
  const schemas = new Set<BindSchema>();
  for (const policy of Object.values(BIND_POLICY)) if (policy.schema && policy.routes.some((re) => re.test(path))) schemas.add(policy.schema);
  return {
    rowsKey: lp ? lp.rows : null,
    rowFields: lp ? [...new Set([...lp.title, ...lp.meta, ...lp.status])] : [],
    fields: [...fields],
    schemas: [...schemas],
  };
}

// ── Agent prose nodes (PX-5 review #2504; astra r2 F1, F4) ─────────────────────────────
type ProseType = "heading" | "text" | "badge" | "field-label";
/** An agent-prose node: the words, marked untrusted, or PCC's withheld notice if they may not be shown. */
function proseNode(type: ProseType, id: string, words: string, fixed: Record<string, string | number> = {}): IrNode {
  const node: IrNode = { type, id, props: { ...fixed, [type === "field-label" ? "label" : "text"]: words }, untrusted: true };
  if (isProseClaim(words)) withhold(node);
  return node;
}
/** Turn an agent-prose node, in place, into PCC's structural notice: no agent words remain. */
function withhold(node: IrNode): void {
  node.props = node.type === "heading" ? { level: node.props?.level as number, withheld: true } : { withheld: true };
  delete node.untrusted;
}
/** Is this node PCC's withheld notice (a prose slot whose agent words were withheld)? */
export function isWithheldProse(node: IrNode): boolean { return node.props?.withheld === true; }
/** The agent words a node shows, or null (PCC's notice, a PCC constant, a container, bound data). */
function agentWords(node: IrNode): string | null {
  if (node.untrusted !== true || !node.props) return null;
  const w = node.type === "field-label" ? node.props.label : node.props.text;
  return typeof w === "string" ? w : null;
}
/** Every agent-prose node at or under `node`, in paint order. */
function agentProse(node: IrNode, out: IrNode[] = []): IrNode[] {
  if (agentWords(node) !== null) out.push(node);
  for (const c of node.children ?? []) agentProse(c, out);
  return out;
}
/** Do these texts, painted next to each other, state what none states alone ("$" then "100")? They
 *  are read as a reader sees separate elements: with a gap between them, so single letters spread
 *  over several labels still fold into one word ("p", "a", "i", "d"). */
function splitClaim(nodes: readonly IrNode[]): boolean {
  return nodes.length > 1 && isProseClaim(nodes.map((n) => agentWords(n) ?? "").join(" "));
}
/** A claim may not be split across prose: the whole dashboard's agent prose (title included) is also
 *  checked as ONE text. A claim found only there withholds the agent prose of each section whose own
 *  prose states it, and, if the rest still states it across sections, all remaining agent prose. A
 *  section that states a claim states it in the dashboard's text too, so a dashboard that passes needs
 *  this one check; validateIr makes the same dashboard-wide check on the finished tree. */
function withholdSplitClaims(title: IrNode, sections: readonly IrNode[]): void {
  const all = (): IrNode[] => [title, ...sections].flatMap((n) => agentProse(n));
  if (!splitClaim(all())) return;
  for (const s of sections) { const p = agentProse(s); if (splitClaim(p)) p.forEach(withhold); }
  const rest = all();
  if (splitClaim(rest)) rest.forEach(withhold);
}

// ── The adapter ─────────────────────────────────────────────────────────────────
export function dashboardManifestToIr(m: DashboardManifest | null | undefined): IrResult {
  if (!isPlain(m)) return { ok: false, reason: "manifest not a plain object" };
  if (!deepClean(m)) return { ok: false, reason: "prototype/nonfinite/symbol in manifest" };
  const mm = m as Record<string, unknown>;
  if (!onlyKeys(mm, ["csd", "title", "description", "theme", "sections"])) return { ok: false, reason: "unexpected top-level key" };
  const rawTitle = strictStr(mm.title, LIM.title);
  if (rawTitle === null) return { ok: false, reason: "title invalid" };
  if (!Array.isArray(mm.sections)) return { ok: false, reason: "sections not array" };
  if (mm.sections.length > LIM.sections) return { ok: false, reason: "too many sections" };

  let count = 0;
  const budget = (): boolean => ++count <= LIM.nodesTotal;
  let bindCount = 0;
  const bindBudget = (): boolean => ++bindCount <= LIM.boundWindowsTotal; // aggregate poll-amplification cap
  const nextId = (() => { let n = 0; return () => `n${++n}`; })();

  const sectionNodes: IrNode[] = [];
  for (const secRaw of mm.sections) {
    if (!isPlain(secRaw) || !onlyKeys(secRaw, ["heading", "windows"])) return { ok: false, reason: "bad section" };
    if (!Array.isArray(secRaw.windows)) return { ok: false, reason: "section.windows not array" };
    if (secRaw.windows.length > LIM.windowsPerSection) return { ok: false, reason: "too many windows" };
    const children: IrNode[] = [];
    if (secRaw.heading !== undefined) {
      const h = strictStr(secRaw.heading, LIM.title);
      if (h === null) return { ok: false, reason: "section.heading invalid" };
      if (!budget()) return { ok: false, reason: "node budget" };
      children.push(proseNode("heading", nextId(), h, { level: 2 }));
    }
    for (const w of secRaw.windows) { const r = mapWindow(w, nextId, budget, bindBudget); if (!r.ok) return r; children.push(r.node); }
    if (!budget()) return { ok: false, reason: "node budget" };
    sectionNodes.push({ type: "section", id: nextId(), children });
  }
  if (!budget()) return { ok: false, reason: "node budget" };
  const titleNode = proseNode("heading", nextId(), rawTitle, { level: 1 });
  withholdSplitClaims(titleNode, sectionNodes);
  if (!budget()) return { ok: false, reason: "node budget" };
  return { ok: true, doc: { ir: "pcc-dashboard-ir/v1", title: titleNode, root: { type: "root", id: nextId(), children: sectionNodes } } };
}

type MapResult = { ok: true; node: IrNode } | { ok: false; reason: string };

function mapWindow(w: unknown, nextId: () => string, budget: () => boolean, bindBudget: () => boolean): MapResult {
  if (!budget()) return { ok: false, reason: "node budget" };
  if (!isPlain(w)) return { ok: false, reason: "window not plain object" };
  const kind = w.kind;
  if (typeof kind !== "string") return { ok: false, reason: "window.kind missing" };
  const id = nextId();
  const chargeBind = (): boolean => bindBudget(); // every window that emits a live bind charges the poll budget
  switch (kind) {
    case "note":
      if (!onlyKeys(w, ["kind", "text"])) return { ok: false, reason: "note extra key" };
      { const text = strictStr(w.text); if (text === null) return { ok: false, reason: "note.text" };
        return { ok: true, node: proseNode("text", id, text) }; }
    case "metric":
      // `format` intentionally NOT accepted (see file header). select is top-level + required.
      if (!onlyKeys(w, ["kind", "label", "binding", "select"])) return { ok: false, reason: "metric extra key" };
      { // The manifest `label` is ACCEPTED but IGNORED — PCC OWNS the metric label, derived from
        // the (route, selector) PROFILE. Only allowlisted infra/execution selectors bind, and
        // bind.select is rewritten to the REAL source path (envelope-aware, e.g. kernel.reputation)
        // so the metric actually populates. `format` NOT accepted.
        const bpath = isPlain(w.binding) ? (w.binding as Record<string, unknown>).path : undefined;
        const field = typeof bpath === "string" ? metricFieldForSelect(bpath, w.select) : null;
        if (!field) return { ok: false, reason: "metric (route, select) not an allowlisted metric field" };
        const b = mapBind(w.binding, "metric", field.source); if (!b.ok) return b; // bind.select = REAL source path
        if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
        return { ok: true, node: { type: "stat", id, props: { label: field.label }, bind: b.bind } }; } // PCC-owned label → NOT untrusted
    case "capability":
      if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "capability extra key" };
      { const b = mapBind(w.binding, "capability"); if (!b.ok) return b;
        if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
        return { ok: true, node: { type: "card", id, props: { kind: "capability" }, bind: b.bind } }; }
    case "receipt":
      // STATIC settlement-record POINTER — no live bind (accepts + ignores a binding, like
      // `approval`). A public read GET can neither reach settlement (auth-gated) nor prove a
      // job status is a settlement event; the endpoint even reports `settled` for a merely
      // completed job and exposes the PHYSICAL completion time as `settledAt`. So B renders
      // ONLY the fixed read-only heading + "not proof of payment" pointer to the
      // authoritative out-of-band Surface-B signed receipt — no fetched, mislabellable data.
      if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "receipt extra key" };
      if (w.binding !== undefined && !isPlain(w.binding)) return { ok: false, reason: "receipt.binding shape" };
      return { ok: true, node: { type: "receipt", id } };
    case "list":
      if (!onlyKeys(w, ["kind", "binding", "item", "limit"])) return { ok: false, reason: "list extra key" };
      { const b = mapBind(w.binding, "list"); if (!b.ok) return b;
        if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
        const item = w.item;
        if (!isPlain(item) || !onlyKeys(item, ["title", "meta", "statusFrom"])) return { ok: false, reason: "list.item" };
        if (!isSelector(item.title)) return { ok: false, reason: "list.item.title selector" };
        const rowMeta: string[] = [];
        if (item.meta !== undefined) {
          if (!Array.isArray(item.meta) || item.meta.length > LIM.metaItems) return { ok: false, reason: "list.meta" };
          for (const mi of item.meta) { if (!isSelector(mi)) return { ok: false, reason: "list.meta selector" }; rowMeta.push(mi); }
        }
        const props: IrNode["props"] = { rowTitle: item.title, rowMeta };
        if (item.statusFrom !== undefined) { if (!isSelector(item.statusFrom)) return { ok: false, reason: "list.statusFrom selector" }; props.statusFrom = item.statusFrom; }
        const offProfile = listProfileViolation(b.bind.path, props); if (offProfile) return { ok: false, reason: offProfile };
        if (w.limit !== undefined) { if (typeof w.limit !== "number" || !Number.isInteger(w.limit) || w.limit <= 0 || w.limit > LIM.listRows) return { ok: false, reason: "list.limit" }; props.limit = w.limit; }
        return { ok: true, node: { type: "list", id, bind: b.bind, props } }; }
    case "run":
      if (!onlyKeys(w, ["kind", "binding", "statusFrom", "latestFrom"])) return { ok: false, reason: "run extra key" };
      { const b = mapBind(w.binding, "run"); if (!b.ok) return b;
        if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
        if (!isSelector(w.statusFrom) || !isSelector(w.latestFrom)) return { ok: false, reason: "run selectors" };
        return { ok: true, node: { type: "card", id, props: { kind: "run", statusFrom: w.statusFrom, latestFrom: w.latestFrom }, bind: b.bind } }; }
    case "form":
      if (!onlyKeys(w, ["kind", "schema", "submit"])) return { ok: false, reason: "form extra key" };
      if (w.submit !== undefined && !isOpDescriptor(w.submit)) return { ok: false, reason: "form.submit grammar" };
      { const labels = fieldLabels(w.schema); if (!labels.ok) return labels;
        const children: IrNode[] = [];
        for (const l of labels.labels) { if (!budget()) return { ok: false, reason: "node budget" }; children.push(proseNode("field-label", nextId(), l)); }
        return { ok: true, node: { type: "form-summary", id, children } }; }
    case "approval":
      if (!onlyKeys(w, ["kind", "binding", "approve", "deny"])) return { ok: false, reason: "approval extra key" };
      if (w.approve !== undefined && !isOpDescriptor(w.approve)) return { ok: false, reason: "approval.approve grammar" };
      if (w.deny !== undefined && !isOpDescriptor(w.deny)) return { ok: false, reason: "approval.deny grammar" };
      if (w.binding !== undefined && !isPlain(w.binding)) return { ok: false, reason: "approval.binding shape" };
      // Static notice, NO bind — live approval state is the C+D out-of-band surface.
      return { ok: true, node: { type: "approval-notice", id, props: { notice: APPROVAL_NOTICE } } };
    case "chain":
      if (!onlyKeys(w, ["kind", "composeRef", "execute"])) return { ok: false, reason: "chain extra key" };
      if (!isPlain(w.composeRef)) return { ok: false, reason: "chain.composeRef shape" };
      if (w.execute !== undefined && !isOpDescriptor(w.execute)) return { ok: false, reason: "chain.execute grammar" };
      return { ok: true, node: { type: "plan", id, props: { kind: "composition" } } };
    case "actions":
      if (!onlyKeys(w, ["kind", "actions"])) return { ok: false, reason: "actions extra key" };
      { const acts = w.actions;
        if (!Array.isArray(acts) || acts.length === 0 || acts.length > LIM.fields) return { ok: false, reason: "actions" };
        const children: IrNode[] = [];
        for (const a of acts) {
          if (!budget()) return { ok: false, reason: "node budget" };
          if (!isOpDescriptor(a)) return { ok: false, reason: "action grammar" };
          const label = strictStr((a as Record<string, unknown>).label, LIM.title); if (label === null) return { ok: false, reason: "action.label" };
          children.push(proseNode("badge", nextId(), label, { tone: "neutral" }));
        }
        return { ok: true, node: { type: "grid", id, props: { kind: "actions-readonly" }, children } }; }
    default:
      return { ok: false, reason: `unknown window kind: ${kind}` };
  }
}

function mapBind(b: unknown, key: string, topSelect?: unknown): { ok: true; bind: IrBind } | { ok: false; reason: string } {
  const policy = BIND_POLICY[key];
  if (!policy) return { ok: false, reason: `no bind policy for ${key}` };
  const allowed = policy.sse ? ["path", "query", "pollMs", "sse"] : ["path", "query", "pollMs"];
  if (!isPlain(b) || !onlyKeys(b, allowed)) return { ok: false, reason: "binding shape" };
  const bind: IrBind = { path: b.path as string };
  if (topSelect !== undefined) bind.select = topSelect as string; // metric scalar (validated by caller + policy)
  if (b.sse !== undefined) bind.sse = b.sse as string;
  if (b.pollMs !== undefined) bind.pollMs = b.pollMs as number;
  if (b.query !== undefined) {
    if (!isPlain(b.query)) return { ok: false, reason: "binding.query shape" };
    const q: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(b.query)) { if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return { ok: false, reason: "query value type" }; q[k] = v; }
    bind.query = q;
  }
  if (policy.schema) bind.schema = policy.schema;
  const reason = bindMatchesPolicy(bind, key);
  return reason ? { ok: false, reason } : { ok: true, bind };
}

/** Read-only field LABELS from a projected form schema — closed field grammar. */
function fieldLabels(schema: unknown): { ok: true; labels: string[] } | { ok: false; reason: string } {
  if (!isPlain(schema) || !onlyKeys(schema, ["type", "properties", "required"])) return { ok: false, reason: "form.schema shape" };
  if (schema.type !== undefined && schema.type !== "object") return { ok: false, reason: "form.schema.type" };
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((x) => typeof x === "string"))) return { ok: false, reason: "form.schema.required" };
  const props = schema.properties;
  if (!isPlain(props)) return { ok: false, reason: "form.schema.properties" };
  const keys = Object.keys(props);
  if (keys.length > LIM.fields) return { ok: false, reason: "too many fields" };
  const labels: string[] = [];
  for (const key of keys) {
    if (PROTO_KEYS.has(key) || isCredentialName(key)) return { ok: false, reason: "credential/proto field" };
    const def = (props as Record<string, unknown>)[key];
    if (!isPlain(def) || !onlyKeys(def, ["type", "title", "description", "enum", "format", "minimum", "maximum", "minLength", "maxLength"])) return { ok: false, reason: "form field-def shape" };
    if (def.type !== undefined && (typeof def.type !== "string" || !["string", "number", "integer", "boolean"].includes(def.type))) return { ok: false, reason: "form field type" };
    if (def.title !== undefined && strictStr(def.title, LIM.title) === null) return { ok: false, reason: "form field title" };
    const rawLabel = typeof def.title === "string" ? def.title : key;
    const s = strictStr(rawLabel, LIM.title); if (s === null) return { ok: false, reason: "field label" };
    labels.push(s);
  }
  return { ok: true, labels };
}

// ── Independent whole-tree validator — MIRRORS every adapter guarantee ─────────────
type PropT = "s400" | "s2000" | "number" | "limit" | "boolean" | "true" | "string[]" | "level" | "tone" | "card-kind" | "grid-kind" | "plan-kind" | "selector";
type PropSpec = Record<string, PropT>;
interface NodeSpec { props?: PropSpec; required?: readonly string[]; optional?: readonly string[]; bindKey?: string; needsBind?: boolean; noBind?: boolean; prose?: boolean; parentOf?: readonly IrNodeType[]; childless?: boolean; minChildren?: number; maxChildren?: number }
const NODE_SCHEMA: Record<IrNodeType, NodeSpec> = {
  root: { noBind: true, parentOf: ["section"], maxChildren: LIM.sections },
  section: { noBind: true, parentOf: ["heading", "text", "stat", "card", "receipt", "list", "grid", "approval-notice", "plan", "form-summary"] },
  heading: { props: { level: "level", text: "s400" }, required: ["level", "text"], noBind: true, prose: true, childless: true },
  text: { props: { text: "s2000" }, required: ["text"], noBind: true, prose: true, childless: true },
  stat: { props: { label: "s400" }, required: ["label"], bindKey: "metric", needsBind: true, childless: true }, // label is PCC-owned (not prose) — mirrored below
  card: { props: { kind: "card-kind", statusFrom: "selector", latestFrom: "selector" }, required: ["kind"], optional: ["statusFrom", "latestFrom"], bindKey: "capability", needsBind: true, childless: true },
  receipt: { noBind: true, childless: true }, // STATIC settlement-record pointer — no bind, no props, no children
  list: { props: { rowTitle: "selector", rowMeta: "string[]", statusFrom: "selector", limit: "limit" }, required: ["rowTitle", "rowMeta"], optional: ["statusFrom", "limit"], bindKey: "list", needsBind: true, childless: true },
  badge: { props: { text: "s400", tone: "tone" }, required: ["text", "tone"], noBind: true, prose: true, childless: true },
  grid: { props: { kind: "grid-kind" }, required: ["kind"], noBind: true, parentOf: ["badge"], minChildren: 1, maxChildren: LIM.fields },
  "approval-notice": { props: { notice: "s2000" }, required: ["notice"], noBind: true, childless: true },
  plan: { props: { kind: "plan-kind" }, required: ["kind"], noBind: true, childless: true },
  "form-summary": { noBind: true, parentOf: ["field-label"], maxChildren: LIM.fields },
  "field-label": { props: { label: "s400" }, required: ["label"], noBind: true, prose: true, childless: true },
};
/** The BIND_POLICY key a node binds under. A card resolves by its kind (run vs capability).
 *  The SINGLE resolution used by both validateIr and the provenance derivation, so they
 *  cannot drift. Null for a node type that never binds. */
export function policyKeyOf(node: IrNode): string | null {
  const spec = NODE_SCHEMA[node.type as IrNodeType];
  if (!spec || !spec.bindKey) return null;
  if (node.type === "card") return node.props && node.props.kind === "run" ? "run" : "capability";
  return spec.bindKey;
}

/** Authority class of an IR node (PX-4), DERIVED from its structure and the server-owned
 *  bind registry, never read from the node or the manifest. Prose (manifest-authored
 *  words) is always `proposed`; a bindable node takes the class its route is registered
 *  with; PCC constants (the fixed approval sentence, the static receipt pointer, the
 *  withheld notice that replaces prose) and containers are not data and return null. A
 *  forged IR cannot carry a class of its own: validateIr rejects any node key outside the
 *  closed set, and a withheld slot carries no words. */
export function sourceClassOf(node: IrNode): RenderSourceClass | null {
  const spec = NODE_SCHEMA[node.type as IrNodeType];
  if (!spec) return null;
  if (spec.prose) return isWithheldProse(node) ? null : "proposed";
  const key = policyKeyOf(node);
  const policy = key !== null && Object.prototype.hasOwnProperty.call(BIND_POLICY, key) ? BIND_POLICY[key] : undefined;
  return policy ? policy.sourceClass : null;
}

export interface BoundProvenance { sourceClass: BoundSourceClass; schemaId: string; maxAgeMs: number }
/** Provenance of a BOUND node's data (class, schema, freshness budget); null if unbound. */
export function provenanceOf(node: IrNode): BoundProvenance | null {
  if (!node.bind) return null;
  const key = policyKeyOf(node);
  const policy = key !== null && Object.prototype.hasOwnProperty.call(BIND_POLICY, key) ? BIND_POLICY[key] : undefined;
  return policy ? { sourceClass: policy.sourceClass, schemaId: policy.schemaId, maxAgeMs: policy.maxAgeMs } : null;
}

function propType(v: unknown, t: PropT): boolean {
  switch (t) {
    case "s400": return typeof v === "string" && v.length > 0 && v.length <= LIM.title;
    case "s2000": return typeof v === "string" && v.length > 0 && v.length <= LIM.str;
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "limit": return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= LIM.listRows;
    case "boolean": return typeof v === "boolean";
    case "string[]": return Array.isArray(v) && v.length <= LIM.metaItems && v.every((x) => isSelector(x));
    case "level": return v === 1 || v === 2 || v === 3;
    case "tone": return typeof v === "string" && TONE_SET.has(v);
    case "card-kind": return typeof v === "string" && CARD_KINDS.has(v);
    case "grid-kind": return typeof v === "string" && GRID_KINDS.has(v);
    case "plan-kind": return typeof v === "string" && PLAN_KINDS.has(v);
    case "true": return v === true;
    case "selector": return isSelector(v);
  }
}
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
export function validateIr(doc: unknown): { ok: true } | { ok: false; reason: string } {
  if (!isPlain(doc) || doc.ir !== "pcc-dashboard-ir/v1" || !onlyKeys(doc, ["ir", "title", "root"])) return { ok: false, reason: "not an IR doc" };
  if (!deepClean(doc)) return { ok: false, reason: "proto/nonfinite/symbol in IR" };
  if (!isPlain(doc.title) || (doc.title as Record<string, unknown>).type !== "heading" || (doc.title as any).props?.level !== 1) return { ok: false, reason: "doc.title not H1" };
  if (!isPlain(doc.root) || (doc.root as Record<string, unknown>).type !== "root") return { ok: false, reason: "doc.root not root" };
  const ids = new Set<string>();
  let count = 0;
  let bindCount = 0;
  const walk = (n: unknown, depth: number): string | null => {
    if (depth > LIM.depth) return "depth";
    if (++count > LIM.nodesTotal) return "node count";
    if (!isPlain(n)) return "node not plain";
    if (!onlyKeys(n, ["type", "id", "props", "bind", "children", "untrusted"])) return "unexpected node key";
    if (typeof n.type !== "string" || !FROZEN.has(n.type)) return `type not frozen: ${String(n.type)}`;
    if (typeof n.id !== "string" || !/^n[0-9]+$/.test(n.id) || ids.has(n.id)) return "id format/dup";
    ids.add(n.id);
    const spec = NODE_SCHEMA[n.type as IrNodeType];
    // props: exact keys, exact types, required present via own-property. A withheld prose slot is
    // PCC's structural notice: exactly its fixed keys (level for a heading, withheld), no agent words.
    const withheld = spec.prose === true && isPlain(n.props) && hasOwn(n.props, "withheld");
    const pspec: PropSpec = withheld ? (n.type === "heading" ? { level: "level", withheld: "true" } : { withheld: "true" }) : spec.props ?? {};
    if (n.props !== undefined) {
      if (!isPlain(n.props) || !onlyKeys(n.props, Object.keys(pspec))) return `props off-schema for ${n.type}`;
      for (const [k, v] of Object.entries(n.props)) if (!propType(v, pspec[k]!)) return `prop ${k} wrong type on ${n.type}`;
    }
    for (const req of withheld ? Object.keys(pspec) : spec.required ?? []) if (!n.props || !hasOwn(n.props as object, req)) return `missing prop ${req} on ${n.type}`;
    // approval-notice text is the ONE fixed PCC sentence — never manifest prose
    if (n.type === "approval-notice" && (n.props as any)?.notice !== APPROVAL_NOTICE) return "approval-notice text not the fixed PCC sentence";
    // card kind ⇒ exact companion props
    if (n.type === "card") {
      const k = (n.props as any)?.kind;
      if (k === "run") { if (!hasOwn(n.props as object, "statusFrom") || !hasOwn(n.props as object, "latestFrom")) return "run card missing selectors"; }
      else if (hasOwn((n.props ?? {}) as object, "statusFrom") || hasOwn((n.props ?? {}) as object, "latestFrom")) return "capability card has run props";
    }
    // bind: mirror BIND_POLICY exactly
    if (n.bind !== undefined) {
      if (spec.noBind || !spec.bindKey) return `${n.type} must not bind`;
      if (!isPlain(n.bind) || !onlyKeys(n.bind, ["path", "select", "query", "pollMs", "sse", "schema"])) return "bind shape";
      const bk = policyKeyOf(n as unknown as IrNode) as string; // ONE resolution, shared with provenanceOf
      const reason = bindMatchesPolicy(n.bind as unknown as IrBind, bk); if (reason) return `bind: ${reason}`;
      if (++bindCount > LIM.boundWindowsTotal) return "bound-window budget"; // poll-amplification cap (mirrors adapter)
    } else if (spec.needsBind) return `${n.type} requires a bind`;
    // stat (metric) label is PCC-OWNED — must equal the fixed label for its ALLOWLISTED
    // selector (mirror of the adapter; a directly-constructed IR cannot invent a label like
    // "Payment received" or select a non-allowlisted / money / timestamp scalar).
    if (n.type === "stat") {
      const src = (n.bind as { select?: unknown } | undefined)?.select;
      const bpath = (n.bind as { path?: unknown } | undefined)?.path;
      const expected = typeof bpath === "string" ? metricLabelForSource(bpath, src) : null;
      if (expected === null) return "stat (route, source) not an allowlisted metric field";
      if ((n.props as { label?: unknown } | undefined)?.label !== expected) return "stat label is not the PCC-owned label for its (route, source)";
    }
    // lists show only their route's PCC-owned field profile (never money fields)
    if (n.type === "list") {
      const bp = (n.bind as { path?: unknown } | undefined)?.path;
      const off = typeof bp === "string" ? listProfileViolation(bp, (n.props ?? {}) as Record<string, unknown>) : "list without a bound path";
      if (off) return off;
    }
    // prose provenance (review #2504; astra r2 F1, F4): agent words are untrusted and may not state
    // an amount or a money / verification status, nor mention PCC's notice. PCC's withheld notice
    // carries no words (the renderer paints its own constant) and is never untrusted.
    if (spec.prose) {
      if (withheld) { if (n.untrusted !== undefined) return `withheld ${n.type} is PCC's notice, never untrusted`; }
      else {
        if (n.untrusted !== true) return `prose ${n.type} not untrusted`;
        const p = (n.props ?? {}) as { text?: unknown; label?: unknown };
        const t = typeof p.text === "string" ? p.text : typeof p.label === "string" ? p.label : "";
        if (isProseClaim(t)) return `prose ${n.type} states an amount or a money/verification status, or mentions the withheld notice`;
      }
    }
    if (!spec.prose && n.untrusted !== undefined) return `non-prose ${n.type} marked untrusted`;
    // children: exact parent/child grammar; containers require an array, leaves forbid it
    if (spec.childless) { if (n.children !== undefined) return `${n.type} may not have children`; }
    else {
      if (!Array.isArray(n.children)) return `${n.type} requires children array`;
      if (spec.minChildren !== undefined && n.children.length < spec.minChildren) return `${n.type} too few children`;
      if (spec.maxChildren !== undefined && n.children.length > spec.maxChildren) return `${n.type} too many children`;
      let windowKids = 0;
      for (let i = 0; i < n.children.length; i++) {
        const c = n.children[i];
        if (!isPlain(c) || !spec.parentOf || !spec.parentOf.includes((c as Record<string, unknown>).type as IrNodeType)) return `illegal child under ${n.type}`;
        if (n.type === "section") { // ≤1 heading, only at index 0, H2; the rest are windows (≤ cap)
          const ct = (c as Record<string, unknown>).type;
          if (ct === "heading") { if (i !== 0) return "section heading must be first"; if ((c as any).props?.level !== 2) return "section heading must be H2"; }
          else if (++windowKids > LIM.windowsPerSection) return "too many windows in section";
        }
        const e = walk(c, depth + 1); if (e) return e;
      }
    }
    return null;
  };
  const e1 = walk(doc.title, 0); if (e1) return { ok: false, reason: `title: ${e1}` };
  const e2 = walk(doc.root, 0); if (e2) return { ok: false, reason: e2 };
  // a claim may not be split across prose (mirror of withholdSplitClaims) on the now well-formed tree
  const sections = (doc.root as unknown as IrNode).children ?? [];
  if (splitClaim([doc.title as unknown as IrNode, ...sections].flatMap((n) => agentProse(n)))) return { ok: false, reason: "agent prose states a claim across nodes" };
  return { ok: true };
}
