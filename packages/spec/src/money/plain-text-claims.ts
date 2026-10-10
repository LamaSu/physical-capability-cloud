/**
 * Canonical claim detector for the plain UI kit's names, manifest labels and
 * editable string defaults. Extracted unchanged from the established IR detector.
 * The plain browser asset mirrors this module; parity exercises the same cases.
 *
 * This also withholds mentions of PCC's reserved "withheld" notice, folded spelling
 * variants, multilingual payment/verification terms and stated currency amounts.
 */
export const WITHHELD_PROSE = "Agent text withheld: it stated an amount or a payment or verification status. Money facts appear only in PCC cards.";
export const WITHHELD_FIELD = "withheld: stated money or verification";

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
export function foldForClaims(text: string): string {
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


// Identifiers can spell prose. Match the IR's unbounded noun/generic pair rule.
const IDENT_NOUN_RE = new RegExp(`\\b${CLAIM_NOUN_GROUP}\\b`);
const IDENT_GENERIC_RE = new RegExp(`\\b${GENERIC_GROUP}\\b`);
export function isIdentifierClaim(value: string): boolean {
  if (isMoneyClaim(value) || mentionsWithheld(value)) return true;
  return views(foldForClaims(value)).some((v) => IDENT_NOUN_RE.test(v) && IDENT_GENERIC_RE.test(v));
}
