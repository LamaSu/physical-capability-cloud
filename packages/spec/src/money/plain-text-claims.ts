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
const INVISIBLE_RE = /[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}\u115f\u1160\u3164\uffa0]/gu;
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

/** Raw direction controls can reverse claims or PCC's own qualifier. Never strip them. */
export function hasBidiControl(text: string): boolean { return /\p{Bidi_Control}/u.test(text) || text.includes(String.fromCodePoint(0x070f)); }
// Unicode 17 DerivedBidiClass R/AL (including unassigned @missing defaults).
// https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedBidiClass.txt
// ECMAScript has no Bidi_Class property escape; keep this dependency-free mirror in both kits.
const STRONG_RTL_RE = /[\u{5be}\u{5c0}\u{5c3}\u{5c6}\u{5d0}-\u{5ea}\u{5ef}-\u{5f4}\u{608}\u{60b}\u{60d}\u{61b}-\u{64a}\u{66d}-\u{66f}\u{671}-\u{6d5}\u{6e5}-\u{6e6}\u{6ee}-\u{6ef}\u{6fa}-\u{70d}\u{70f}-\u{710}\u{712}-\u{72f}\u{74d}-\u{7a5}\u{7b1}\u{7c0}-\u{7ea}\u{7f4}-\u{7f5}\u{7fa}\u{7fe}-\u{815}\u{81a}\u{824}\u{828}\u{830}-\u{83e}\u{840}-\u{858}\u{85e}\u{860}-\u{86a}\u{870}-\u{88f}\u{8a0}-\u{8c9}\u{200f}\u{fb1d}\u{fb1f}-\u{fb28}\u{fb2a}-\u{fb36}\u{fb38}-\u{fb3c}\u{fb3e}\u{fb40}-\u{fb41}\u{fb43}-\u{fb44}\u{fb46}-\u{fbc2}\u{fbd3}-\u{fd3d}\u{fd50}-\u{fd8f}\u{fd92}-\u{fdc7}\u{fdf0}-\u{fdfc}\u{fe70}-\u{fe74}\u{fe76}-\u{fefc}\u{10800}-\u{10805}\u{10808}\u{1080a}-\u{10835}\u{10837}-\u{10838}\u{1083c}\u{1083f}-\u{10855}\u{10857}-\u{1089e}\u{108a7}-\u{108af}\u{108e0}-\u{108f2}\u{108f4}-\u{108f5}\u{108fb}-\u{1091b}\u{10920}-\u{10939}\u{1093f}-\u{10959}\u{10980}-\u{109b7}\u{109bc}-\u{109cf}\u{109d2}-\u{10a00}\u{10a10}-\u{10a13}\u{10a15}-\u{10a17}\u{10a19}-\u{10a35}\u{10a40}-\u{10a48}\u{10a50}-\u{10a58}\u{10a60}-\u{10a9f}\u{10ac0}-\u{10ae4}\u{10aeb}-\u{10af6}\u{10b00}-\u{10b35}\u{10b40}-\u{10b55}\u{10b58}-\u{10b72}\u{10b78}-\u{10b91}\u{10b99}-\u{10b9c}\u{10ba9}-\u{10baf}\u{10c00}-\u{10c48}\u{10c80}-\u{10cb2}\u{10cc0}-\u{10cf2}\u{10cfa}-\u{10d23}\u{10d4a}-\u{10d65}\u{10d6f}-\u{10d85}\u{10d8e}-\u{10d8f}\u{10e80}-\u{10ea9}\u{10ead}\u{10eb0}-\u{10eb1}\u{10ec2}-\u{10ec7}\u{10f00}-\u{10f27}\u{10f30}-\u{10f45}\u{10f51}-\u{10f59}\u{10f70}-\u{10f81}\u{10f86}-\u{10f89}\u{10fb0}-\u{10fcb}\u{10fe0}-\u{10ff6}\u{1e800}-\u{1e8c4}\u{1e8c7}-\u{1e8cf}\u{1e900}-\u{1e943}\u{1e94b}\u{1e950}-\u{1e959}\u{1e95e}-\u{1e95f}\u{1ec71}-\u{1ecb4}\u{1ed01}-\u{1ed3d}\u{1ee00}-\u{1ee03}\u{1ee05}-\u{1ee1f}\u{1ee21}-\u{1ee22}\u{1ee24}\u{1ee27}\u{1ee29}-\u{1ee32}\u{1ee34}-\u{1ee37}\u{1ee39}\u{1ee3b}\u{1ee42}\u{1ee47}\u{1ee49}\u{1ee4b}\u{1ee4d}-\u{1ee4f}\u{1ee51}-\u{1ee52}\u{1ee54}\u{1ee57}\u{1ee59}\u{1ee5b}\u{1ee5d}\u{1ee5f}\u{1ee61}-\u{1ee62}\u{1ee64}\u{1ee67}-\u{1ee6a}\u{1ee6c}-\u{1ee72}\u{1ee74}-\u{1ee77}\u{1ee79}-\u{1ee7c}\u{1ee7e}\u{1ee80}-\u{1ee89}\u{1ee8b}-\u{1ee9b}\u{1eea1}-\u{1eea3}\u{1eea5}-\u{1eea9}\u{1eeab}-\u{1eebb}]|(?=\p{Cn})[\u{590}-\u{8ff}\u{fb1d}-\u{fdcf}\u{fdf0}-\u{fdff}\u{fe70}-\u{feff}\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/gu;
function claimIn(text: string, checks: readonly WordCheck[]): boolean {
  const f = foldForClaims(text);
  if (AMOUNT_RE.test(f) || scriptIn(f) || wordsIn(f, checks)) return true;
  const stripped = text.replace(STRONG_RTL_RE, "");
  if (stripped === text) return false;
  const visual = foldForClaims(stripped);
  return AMOUNT_RE.test(visual) || scriptIn(visual) || wordsIn(visual, checks);
}
export function statesAmount(text: string): boolean { return AMOUNT_RE.test(foldForClaims(text)) || AMOUNT_RE.test(foldForClaims(text.replace(STRONG_RTL_RE, ""))); }
/** Does the text state an amount or a payment or verification status? */
export function isMoneyClaim(text: string): boolean { return hasBidiControl(text) || claimIn(text, [MONEY_WORDS, PAIR_WORDS]); }
/** Does the text mention PCC's withheld notice ("withheld", "withhold")? Only PCC may say that. */
export function mentionsWithheld(text: string): boolean {
  const stripped = text.replace(STRONG_RTL_RE, "");
  return wordsIn(foldForClaims(text), [NOTICE_WORDS]) || (stripped !== text && wordsIn(foldForClaims(stripped), [NOTICE_WORDS]));
}
/** Agent prose that may not be shown: a money claim, or a mention of PCC's notice (one fold). */
export function isProseClaim(text: string): boolean {
  return hasBidiControl(text) || claimIn(text, [MONEY_WORDS, NOTICE_WORDS, PAIR_WORDS]);
}


// Identifiers can spell prose. Match the IR's unbounded noun/generic pair rule.
const IDENT_NOUN_RE = new RegExp(`\\b${CLAIM_NOUN_GROUP}\\b`);
const IDENT_GENERIC_RE = new RegExp(`\\b${GENERIC_GROUP}\\b`);
export function isIdentifierClaim(value: string): boolean {
  if (isMoneyClaim(value) || mentionsWithheld(value)) return true;
  const stripped = value.replace(STRONG_RTL_RE, "");
  return (stripped === value ? [value] : [value, stripped]).some((text) =>
    views(foldForClaims(text)).some((v) => IDENT_NOUN_RE.test(v) && IDENT_GENERIC_RE.test(v)));
}
