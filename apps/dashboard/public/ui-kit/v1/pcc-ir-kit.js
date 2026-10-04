/* GENERATED from packages/gateway/src/mcp/dashboard-ir-browser-entry.ts by
   scripts/build-dashboard-ir-kit.mjs — DO NOT EDIT. Regenerate with `pnpm build:ir-kit`. */
"use strict";
(() => {
  // src/mcp/dashboard-ir.ts
  var IR_NODE_TYPES = [
    "root",
    "section",
    "heading",
    "text",
    "stat",
    "card",
    "receipt",
    "list",
    "badge",
    "grid",
    "approval-notice",
    "plan",
    "form-summary",
    "field-label"
  ];
  var FROZEN = new Set(IR_NODE_TYPES);
  var BADGE_TONES = ["neutral", "info", "positive", "warning", "danger"];
  var TONE_SET = new Set(BADGE_TONES);
  var CARD_KINDS = /* @__PURE__ */ new Set(["capability", "run"]);
  var GRID_KINDS = /* @__PURE__ */ new Set(["actions-readonly"]);
  var PLAN_KINDS = /* @__PURE__ */ new Set(["composition"]);
  var LIM = {
    sections: 24,
    windowsPerSection: 32,
    nodesTotal: 2e3,
    depth: 8,
    inputDepth: 16,
    str: 2e3,
    listRows: 200,
    fields: 64,
    metaItems: 12,
    queryKeys: 16,
    path: 512,
    select: 256,
    title: 400,
    pollMinMs: 5e3,
    pollMaxMs: 36e5,
    boundWindowsTotal: 64,
    // poll-amplification cap (sol R5)
    cleanNodes: 5e4
    // deepClean traversal budget — >> any legit manifest/IR, kills wide-object DoS (sol R6)
  };
  var LIST_ROW_CAP = LIM.listRows;
  var WITHHELD_PROSE = "Agent text withheld: it stated an amount or a payment or verification status. Money facts appear only in PCC cards.";
  var LOOKALIKE = {
    // Cyrillic
    "\u0430": "a",
    "\u0435": "e",
    "\u043E": "o",
    "\u0440": "p",
    "\u0441": "c",
    "\u0443": "y",
    "\u0445": "x",
    "\u0456": "i",
    "\u0458": "j",
    "\u0455": "s",
    "\u0501": "d",
    "\u04BB": "h",
    "\u051B": "q",
    "\u051D": "w",
    "\u04CF": "l",
    "\u0410": "A",
    "\u0412": "B",
    "\u0415": "E",
    "\u041A": "K",
    "\u041C": "M",
    "\u041D": "H",
    "\u041E": "O",
    "\u0420": "P",
    "\u0421": "C",
    "\u0422": "T",
    "\u0425": "X",
    "\u0406": "I",
    "\u0408": "J",
    "\u0405": "S",
    "\u04AE": "Y",
    "\u051A": "Q",
    "\u051C": "W",
    "\u04C0": "I",
    // Greek
    "\u0391": "A",
    "\u0392": "B",
    "\u0395": "E",
    "\u0396": "Z",
    "\u0397": "H",
    "\u0399": "I",
    "\u039A": "K",
    "\u039C": "M",
    "\u039D": "N",
    "\u039F": "O",
    "\u03A1": "P",
    "\u03A4": "T",
    "\u03A5": "Y",
    "\u03A7": "X",
    "\u03BF": "o",
    "\u03B1": "a",
    "\u03C1": "p",
    "\u03BD": "v",
    "\u03B9": "i",
    "\u03BA": "k",
    "\u03C5": "u",
    "\u03C7": "x",
    "\u03B5": "e",
    "\u03C4": "t",
    // Latin letters with no compatibility decomposition: dotless i and j, IPA, small capitals, strokes, hooks
    "\u0131": "i",
    "\u0237": "j",
    "\u0251": "a",
    "\u0261": "g",
    "\u0269": "i",
    "\u1D00": "a",
    "\u0299": "b",
    "\u1D04": "c",
    "\u1D05": "d",
    "\u1D07": "e",
    "\uA730": "f",
    "\u0262": "g",
    "\u029C": "h",
    "\u026A": "i",
    "\u1D0A": "j",
    "\u1D0B": "k",
    "\u029F": "l",
    "\u1D0D": "m",
    "\u0274": "n",
    "\u1D0F": "o",
    "\u1D18": "p",
    "\u0280": "r",
    "\uA731": "s",
    "\u1D1B": "t",
    "\u1D1C": "u",
    "\u1D20": "v",
    "\u1D21": "w",
    "\u028F": "y",
    "\u1D22": "z",
    "\u0111": "d",
    "\u0180": "b",
    "\u0268": "i",
    "\u0142": "l",
    "\xF8": "o",
    "\u0127": "h",
    "\u0167": "t",
    "\u01A5": "p",
    "\u0257": "d",
    "\u0256": "d",
    "\u0188": "c",
    "\u0253": "b",
    "\u0192": "f",
    "\u0266": "h",
    "\u0199": "k",
    "\u0271": "m",
    "\u0272": "n",
    "\u0273": "n",
    "\u0282": "s",
    "\u01AD": "t",
    "\u0288": "t",
    "\u01B4": "y",
    "\u0225": "z",
    "\u024D": "r",
    "\u0247": "e",
    "\u023C": "c",
    "\u0249": "j",
    "\u0110": "D",
    "\u0141": "L",
    "\xD8": "O",
    "\u0126": "H",
    "\u0166": "T",
    "\u0197": "I",
    "\u01A4": "P",
    "\u018A": "D",
    "\u0187": "C",
    "\u0181": "B",
    "\u0191": "F",
    "\u0198": "K",
    "\u01AC": "T",
    "\u01B3": "Y",
    "\u0224": "Z",
    "\u024C": "R",
    "\u0246": "E",
    "\u023B": "C"
  };
  var INVISIBLE_RE = /[\p{M}\p{Cf}\u115f\u1160\u3164\uffa0]/gu;
  var MONEY_EMOJI_RE = /[\u{1F4B0}-\u{1F4B8}\u{1F911}\u{1FA99}]/gu;
  function foldForClaims(text) {
    let t = text.normalize("NFKD").replace(INVISIBLE_RE, "").normalize("NFKC");
    t = t.replace(/\u2800/g, " ").replace(MONEY_EMOJI_RE, " $ ");
    t = t.replace(/[^\x00-\x7f]/g, (c) => LOOKALIKE[c] ?? c);
    return t.replace(/(?<![A-Z])([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
  }
  var LEET_I = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };
  var LEET_L = { ...LEET_I, "1": "l", "|": "l" };
  var LEET_RE = /[0134578@$!|]/g;
  var HAS_LEET = /[0134578@$!|]/;
  var views = (f) => {
    const base = HAS_LEET.test(f) ? [f, f.replace(LEET_RE, (c) => LEET_I[c]), f.replace(LEET_RE, (c) => LEET_L[c])] : [f];
    const out = [...base];
    for (const b of base) {
      if (b.includes("l")) out.push(b.replace(/l/g, "i"));
      if (b.includes("i")) out.push(b.replace(/i/g, "l"));
    }
    return out;
  };
  var SPACED_RE = /(?<![a-z0-9])[a-z](?:[^a-z0-9]{1,3}[a-z](?![a-z0-9])){2,}/g;
  var spacedRuns = (v) => (v.match(SPACED_RE) ?? []).map((r) => r.replace(/[^a-z]/g, "")).join(" ");
  var CUR_CODE = "usdc|usdt|usde|usd|eurc|eur|gbp|jpy|cny|rmb|inr|chf|cad|aud|krw|rub|brl|mxn|eth|weth|btc|wbtc|dai|sol|matic|pol|xrp|ltc|bnb|busd|tusd|pyusd|gusd|frax|sats?|gwei|wei|xlm|ada|dot|avax|trx|ton|near|atom|apt|sui|shib|doge|xmr|bch|etc|fil|icp|hbar|vet|algo|xtz|eos|cro|usdp|fdusd|hkd|sgd|nzd|sek|nok|dkk|pln|try|zar|thb|idr|myr|vnd|ils|aed|sar|ars|clp|cop|pen|egp|ngn|kes|pkr|uah|czk|huf|ron";
  var CUR_WORD = "dollars?|bucks|cents?|euros?|pence|quid|yen|yuan|renminbi|rupees?|rubles?|roubles?|pesos?|francs?|satoshis?|bitcoins?|ethers?|stablecoins?";
  var MAGNITUDE = "thousand|million|billion|trillion|mil|mio|mrd|mm|mn|bn|tn|k|m|b|t";
  var NUMBER_WORD = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half";
  var CURRENCY = `(?:\\p{Sc}|(?:${CUR_CODE}|${CUR_WORD})\\b)`;
  var AMOUNT_RE = new RegExp(
    `\\p{Sc} ?(?:\\d|(?:${NUMBER_WORD})\\b)|${CURRENCY}(?<=\\d[\\d,._]{0,40} ?(?:${MAGNITUDE})? ?[(\\[]? ?${CURRENCY})|\\b(?:${NUMBER_WORD})\\b[ -]{0,3}(?:(?:${MAGNITUDE})\\b[ -]{0,3})?${CURRENCY}|\\ban? (?:${CUR_WORD})\\b|\\b(?:${CUR_CODE}|${CUR_WORD})[ :=]{0,3}(?:\\d|(?:${NUMBER_WORD})\\b)`,
    //       USD 5, usdc:100, USDC five
    "u"
  );
  var CLAIM_WORDS = [
    "paid|unpaid|prepaid|repaid|overpaid|underpaid|payout|payouts|paidout|refund|refunds|refunded|reimbursed",
    "settled|verified|guaranteed|funded|charged|deposited|withdrawn|credited|debited",
    "remitted|disbursed|escrowed",
    "da thanh toan",
    // Vietnamese "paid", with diacritics folded to this ASCII skeleton already
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
    "odendi|onaylandi|dogrulandi|iade|bakiye|dibayar|lunas|dikembalikan|terverifikasi|disetujui"
  ].join("|");
  var CLAIM_RE = new RegExp(`\\b(?:${CLAIM_WORDS})\\b`);
  var CLAIM_IN_RUN_RE = new RegExp(`(?:${CLAIM_WORDS})`);
  var GENERIC_WORDS = "received|released|approved|confirmed|complete|completed|passed|succeeded|successful|cleared|processed|accepted|sent|done";
  var CLAIM_NOUNS = "payment|payments|funds|fund|money|payout|payouts|transfer|transfers|transaction|transactions|invoice|invoices|deposit|deposits|escrow|settlement|refund|refunds|balance|balances|wallet|charge|charges|fee|fees|amount|price|verification|identity|kyc|kyb|attestation|proof|audit|oracle";
  var CLAIM_NOUN_GROUP = `(?:${CLAIM_NOUNS}|${CUR_CODE}|${CUR_WORD})`;
  var GENERIC_GROUP = `(?:${GENERIC_WORDS})`;
  var PAIR_RE = new RegExp(
    `\\b${CLAIM_NOUN_GROUP}\\b(?:\\W+\\w+){0,3}?\\W+${GENERIC_GROUP}\\b|\\b${GENERIC_GROUP}\\b(?:\\W+\\w+){0,3}?\\W+${CLAIM_NOUN_GROUP}\\b`
  );
  var PAIR_WORDS = [PAIR_RE, /(?!)/];
  var SCRIPT_CLAIM_WORDS = ["\u043E\u043F\u043B\u0430\u0447\u0435\u043D", "\u0432\u044B\u043F\u043B\u0430\u0447\u0435\u043D", "\u0441\u043F\u043B\u0430\u0447\u0435\u043D", "\u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0435\u043D", "\u0432\u043E\u0437\u0432\u0440\u0430\u0442", "\u0437\u0430\u0447\u0438\u0441\u043B\u0435\u043D", "\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D", "\u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D", "\u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D", "\u043E\u0434\u043E\u0431\u0440\u0435\u043D", "\u0431\u0430\u043B\u0430\u043D\u0441", "\u043F\u043E\u043B\u0443\u0447\u0435\u043D", "\u5DF2\u4ED8", "\u5DF2\u652F\u4ED8", "\u652F\u4ED8\u6210\u529F", "\u9000\u6B3E", "\u5DF2\u7ED3\u7B97", "\u5DF2\u7D50\u7B97", "\u5DF2\u786E\u8BA4", "\u5DF2\u78BA\u8A8D", "\u5DF2\u9A8C\u8BC1", "\u5DF2\u9A57\u8B49", "\u5230\u8D26", "\u5230\u8CEC", "\u4F59\u989D", "\u9918\u984D", "\u5DF2\u6536\u6B3E", "\u5DF2\u6279\u51C6", "\u652F\u6255\u6E08", "\u652F\u6255\u3044\u6E08", "\u652F\u6255\u5B8C\u4E86", "\u652F\u6255\u3044\u5B8C\u4E86", "\u5165\u91D1\u6E08", "\u8FD4\u91D1", "\u6C7A\u6E08\u6E08", "\u6C7A\u6E08\u5B8C\u4E86", "\u78BA\u8A8D\u6E08", "\u627F\u8A8D\u6E08", "\u6B8B\u9AD8", "\uC9C0\uAE09\uC644\uB8CC", "\uACB0\uC81C\uC644\uB8CC", "\uACB0\uC81C\uB428", "\uC9C0\uAE09\uB428", "\uD658\uBD88", "\uC794\uC561", "\uC785\uAE08\uC644\uB8CC", "\uD655\uC778\uB428", "\uC2B9\uC778\uB428", "\u0645\u062F\u0641\u0648\u0639", "\u062A\u0645\u0627\u0644\u062F\u0641\u0639", "\u0627\u0633\u062A\u0631\u062F\u0627\u062F", "\u0631\u0635\u064A\u062F", "\u092D\u0941\u0917\u0924\u093E\u0928\u0915\u093F\u092F\u093E", "\u092D\u0941\u0917\u0924\u093E\u0928\u0939\u094B\u0917\u092F\u093E", "\u03C0\u03BB\u03B7\u03C1\u03CE\u03B8\u03B7\u03BA\u03B5", "\u03C0\u03BB\u03B7\u03C1\u03CE\u03B8\u03B7\u03BA\u03B1\u03BD", "\u03B5\u03C0\u03B9\u03C3\u03C4\u03C1\u03BF\u03C6\u03AE \u03C7\u03C1\u03B7\u03BC\u03AC\u03C4\u03C9\u03BD", "\u03C5\u03C0\u03CC\u03BB\u03BF\u03B9\u03C0\u03BF", "\u05E9\u05D5\u05DC\u05DD", "\u0E0A\u0E33\u0E23\u0E30\u0E41\u0E25\u0E49\u0E27"].flatMap((w) => [foldForClaims(w), foldForClaims(w.toUpperCase())]).map((w) => w.replace(/\s+/g, ""));
  var SCRIPT_CLAIM_RE = new RegExp([...new Set(SCRIPT_CLAIM_WORDS)].join("|"), "u");
  var NOTICE_RE = /\bwithh[eo]ld/;
  var NOTICE_IN_RUN_RE = /withh[eo]ld/;
  var MONEY_WORDS = [CLAIM_RE, CLAIM_IN_RUN_RE];
  var NOTICE_WORDS = [NOTICE_RE, NOTICE_IN_RUN_RE];
  function wordsIn(f, checks) {
    for (const v of views(f)) {
      const runs = spacedRuns(v);
      for (const [word, inRun] of checks) if (word.test(v) || inRun.test(runs)) return true;
    }
    return false;
  }
  var scriptIn = (f) => /[^\x00-\x7f]/.test(f) && SCRIPT_CLAIM_RE.test(f.replace(/ /g, ""));
  var IDENT_NOUN_RE = new RegExp(`\\b${CLAIM_NOUN_GROUP}\\b`);
  var IDENT_GENERIC_RE = new RegExp(`\\b${GENERIC_GROUP}\\b`);
  function identifierText(field, value) {
    if (value === "") return value;
    const t = boundValueText(field, value);
    if (t === WITHHELD_FIELD) return t;
    for (const v of views(foldForClaims(value))) if (IDENT_NOUN_RE.test(v) && IDENT_GENERIC_RE.test(v)) return WITHHELD_FIELD;
    return REPORTED_PREFIX + value;
  }
  function statesAmount(text) {
    return AMOUNT_RE.test(foldForClaims(text));
  }
  function isMoneyClaim(text) {
    const f = foldForClaims(text);
    return AMOUNT_RE.test(f) || scriptIn(f) || wordsIn(f, [MONEY_WORDS, PAIR_WORDS]);
  }
  function mentionsWithheld(text) {
    return wordsIn(foldForClaims(text), [NOTICE_WORDS]);
  }
  function isProseClaim(text) {
    const f = foldForClaims(text);
    return AMOUNT_RE.test(f) || scriptIn(f) || wordsIn(f, [MONEY_WORDS, NOTICE_WORDS, PAIR_WORDS]);
  }
  var RECORD_STATUS_NOTE = " - reported by the record, not confirmed by a settlement read";
  var MONEY_STATE_RE = /\b(?:settled|released|paid|unpaid|payout|payouts|refund|refunded|refunds|funded|unfunded|charged|credited|debited|deposited|withdrawn|escrowed)\b/;
  function isMoneyState(value) {
    return MONEY_STATE_RE.test(foldForClaims(value).replace(/[^a-z0-9]+/g, " "));
  }
  var SAFE_STATUS_WORDS = /* @__PURE__ */ new Set([
    "RUNNING",
    "IN_PROGRESS",
    "PROGRESS",
    "STREAMING",
    "BUILDING",
    "CONNECTING",
    "PENDING",
    "QUEUED",
    "WAITING",
    "PAUSED",
    "REVIEW",
    "CONFIRM",
    "NEEDS_INPUT",
    "NEEDS_YOU",
    "ERROR",
    "FAILED",
    "DENIED",
    "CANCELLED",
    "CANCELED",
    "REJECTED",
    "DONE",
    "COMPLETE",
    "COMPLETED",
    "OK",
    "SUCCESS",
    "SUCCEEDED",
    "RESOLVED",
    "READY",
    "DISPATCHED",
    "ACCEPTED",
    "PREPARING",
    "EXECUTING",
    "COLLECTING_EVIDENCE",
    "AWAITING_PICKUP",
    "TIMED_OUT",
    "ONLINE",
    "OFFLINE",
    "MAINTENANCE",
    "SUSPENDED",
    "HEALTHY",
    "DEGRADED",
    "UNKNOWN",
    "BIDDING",
    "ASSIGNED",
    "PROPOSED",
    "OVER_BUDGET",
    "NO_PATH_FOUND",
    "APPROVED",
    "EXPIRED",
    "ACTIVE",
    "INACTIVE",
    "REVOKED",
    "IDLE",
    "BUSY",
    "DRAFT",
    "DEPRECATED",
    "RESERVED",
    "LIVE",
    "STUB",
    "PLANNED",
    "TRUE",
    "FALSE"
  ]);
  function normalizeStatusWord(value) {
    return foldForClaims(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  function isSafeStatusWord(value) {
    return SAFE_STATUS_WORDS.has(normalizeStatusWord(value));
  }
  var RECORD_CLAIM_NOTE = " - reported by the record, not confirmed by PCC";
  var WITHHELD_FIELD = "withheld: stated money or verification";
  function boundStatusText(value) {
    if (value === "") return value;
    if (statesAmount(value) || mentionsWithheld(value)) return WITHHELD_FIELD;
    if (isSafeStatusWord(value)) return value;
    if (isMoneyState(value)) return value + RECORD_STATUS_NOTE;
    return value + RECORD_CLAIM_NOTE;
  }
  function boundValueText(field, value) {
    if (value === "") return value;
    if (/(^|\.)status$/.test(field)) return boundStatusText(value);
    return isMoneyClaim(value) || mentionsWithheld(value) ? WITHHELD_FIELD : value;
  }
  var REPORTED_PREFIX = "reported: ";
  function reportedFieldText(field, value) {
    return boundValueText(field, value) === WITHHELD_FIELD ? WITHHELD_FIELD : REPORTED_PREFIX + value;
  }
  var LIST_PROFILES = {
    "/api/jobs": { rows: "jobs", title: ["id", "capabilityId"], meta: ["id", "capabilityId", "kernelId", "status", "createdAt", "updatedAt"], status: ["status"] },
    "/api/kernels": { rows: "kernels", title: ["name", "id"], meta: ["id", "status", "version", "capabilityCount"], status: ["status"] },
    "/api/capabilities": { rows: "items", title: ["name", "id"], meta: ["id", "type", "kernelId"], status: ["available"] }
  };
  function listRowsOf(path, data) {
    const key = Object.prototype.hasOwnProperty.call(LIST_PROFILES, path) ? LIST_PROFILES[path].rows : void 0;
    if (!key) return null;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    if (!Object.prototype.hasOwnProperty.call(data, key)) return null;
    const v = data[key];
    if (!Array.isArray(v)) return null;
    return v;
  }
  var LIST_FIELD_KINDS = {
    id: "id",
    capabilityId: "id",
    kernelId: "id",
    name: "text",
    status: "status",
    available: "bool",
    createdAt: "time",
    updatedAt: "time",
    version: "version",
    capabilityCount: "count",
    type: "capType"
  };
  function listProfileViolation(path, props) {
    const prof = LIST_PROFILES[path];
    if (!prof) return `no list field profile for ${path}`;
    if (typeof props.rowTitle !== "string" || !prof.title.includes(props.rowTitle)) return `list title field not in the ${path} profile`;
    const meta = Array.isArray(props.rowMeta) ? props.rowMeta : [];
    for (const m of meta) if (typeof m !== "string" || !prof.meta.includes(m)) return `list meta field not in the ${path} profile`;
    if (props.statusFrom !== void 0 && (typeof props.statusFrom !== "string" || !prof.status.includes(props.statusFrom))) return `list status field not in the ${path} profile`;
    return null;
  }
  var APPROVAL_NOTICE = "This action is confirmed only on the authenticated PCC surface.";
  var PATH_GRAMMAR = /^\/api\/[A-Za-z0-9._~\-/]+$/;
  var SSE_GRAMMAR = /^\/sse\/[A-Za-z0-9._~\-/]+$/;
  var SELECT_GRAMMAR = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
  var OP_ID_GRAMMAR = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
  var ID_SEG = "(?![a-z]+(?:-[a-z]+)*(?:/|$))[A-Za-z0-9_~.-]+";
  var escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function route(template) {
    return new RegExp("^" + template.split("/").map((s) => s === ":" ? ID_SEG : escRe(s)).join("/") + "$");
  }
  function routeCap(template) {
    return new RegExp("^" + template.split("/").map((s) => s === ":" ? "(" + ID_SEG + ")" : escRe(s)).join("/") + "$");
  }
  var RESERVED_EXACT = /* @__PURE__ */ new Set([
    "/api/capabilities/types",
    "/api/capabilities/templates",
    "/api/capabilities/search",
    "/api/capabilities/graph-stats",
    "/api/capabilities/graph-search",
    "/api/settlement/status",
    "/api/settlement/epochs",
    "/api/settlement/flush",
    "/api/settlement/submit",
    "/api/settlement/release",
    "/api/evidence/lit-status",
    "/api/evidence/archive",
    "/api/evidence/embed",
    "/api/evidence/search",
    "/api/jobs/submit",
    "/api/jobs/submit-from-discovery",
    "/api/kernels/marketplace",
    "/api/kernels/register",
    "/api/escrow/chain"
  ]);
  var BIND_POLICY = {
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
      sourceClass: "authoritative",
      schemaId: "metric-scalar-v1",
      maxAgeMs: 12e4,
      routes: [route("/api/jobs/:/status"), route("/api/kernels/:")],
      needsSelect: true
    },
    // capability card: a fixed PCC-owned SUMMARY (name/type/price/tiers/availability),
    // rendered from the KNOWN CapabilityDTO schema — the manifest supplies NO selectors.
    capability: { sourceClass: "authoritative", schemaId: "capability-summary-v1", maxAgeMs: 36e5, routes: [route("/api/capabilities/:")], schema: "capability-summary-v1" },
    // ID_SEG excludes types/templates/search/graph-*
    // NOTE: `receipt` has NO bind policy — the settlement record is a STATIC POINTER (no
    // fetch). A public read GET cannot reach settlement (auth-gated) and, worse, the
    // endpoint reports `settled` for a merely-completed job and exposes the PHYSICAL
    // completion time as `settledAt` — so a fetched "Settled at" label would affirmatively
    // assert a settlement that never occurred. The authoritative receipt is the out-of-band
    // Surface-B signed receipt (VCR); B only points at it. (See the receipt case below.)
    // list: collection reads whose rows are listable ONLY through a PCC-owned field profile
    // (LIST_PROFILES). Escrow is NOT listable: money state appears only in schema cards.
    list: {
      sourceClass: "authoritative",
      schemaId: "collection-v1",
      maxAgeMs: 3e5,
      routes: [route("/api/jobs"), route("/api/kernels"), route("/api/capabilities")],
      queryByRoute: {
        "/api/jobs": ["kernelId", "status", "offset", "limit"],
        "/api/kernels": ["status"],
        "/api/capabilities": ["type", "offset", "limit"]
      }
    },
    // run card: a fixed PCC-owned SUMMARY (status/progress) read from the KNOWN job
    // schema. The manifest's statusFrom/latestFrom are validated but IGNORED at render
    // (they may never relabel an arbitrary field as "Status" — PCC owns the meaning).
    run: {
      sourceClass: "authoritative",
      schemaId: "run-summary-v1",
      maxAgeMs: 6e4,
      routes: [route("/api/jobs/:"), route("/api/jobs/:/status")],
      sse: [route("/sse/stream/job/:")],
      correlate: { pathRe: new RegExp("^/api/jobs/(" + ID_SEG + ")(?:/status)?$"), sseRe: routeCap("/sse/stream/job/:") },
      schema: "run-summary-v1"
    }
    // approval in B is a STATIC notice — no live bind (live approval state is C+D out-of-band).
  };
  var PROTO_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
  function isPlain(v) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  }
  function strictStr(v, max = LIM.str) {
    return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
  }
  function onlyKeys(o, allowed) {
    const set = new Set(allowed);
    for (const k of Reflect.ownKeys(o)) {
      if (typeof k === "symbol") return false;
      if (!set.has(k)) return false;
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!d || !d.enumerable) return false;
    }
    return true;
  }
  var INDEX_KEY = /^(0|[1-9][0-9]*)$/;
  function deepClean(v, depth = 0, budget = { n: LIM.cleanNodes }) {
    if (depth > LIM.inputDepth) return false;
    if (--budget.n < 0) return false;
    const t = typeof v;
    if (v === null || t === "string" || t === "boolean") return true;
    if (t === "number") return Number.isFinite(v);
    if (Array.isArray(v)) {
      for (const k of Reflect.ownKeys(v)) {
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
      if (!deepClean(v[k], depth + 1, budget)) return false;
    }
    return true;
  }
  function isSelector(s) {
    if (typeof s !== "string" || !SELECT_GRAMMAR.test(s) || s.length > LIM.select) return false;
    for (const seg of s.split(".")) if (PROTO_KEYS.has(seg)) return false;
    return true;
  }
  function isReadPath(s, grammar = PATH_GRAMMAR) {
    if (typeof s !== "string" || !grammar.test(s) || s.length > LIM.path) return false;
    for (const seg of s.split("/")) if (seg === ".." || seg === ".") return false;
    return true;
  }
  var CRED_EXACT = /* @__PURE__ */ new Set([
    "password",
    "secret",
    "token",
    "credential",
    "apikey",
    "privatekey",
    "authorization",
    "bearer",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "sessiontoken",
    "otp",
    "cvv",
    "pin",
    "mnemonic",
    "seedphrase",
    "passphrase",
    "privkey",
    "signingkey"
  ]);
  var CRED_SUBSTR = ["password", "secret", "privatekey", "apikey", "credential", "passphrase"];
  function isCredentialName(k) {
    const n = k.toLowerCase().replace(/[_\-\s]/g, "");
    if (CRED_EXACT.has(n)) return true;
    return CRED_SUBSTR.some((t) => n.includes(t));
  }
  var METRIC_PROFILE = [
    { route: route("/api/jobs/:/status"), fields: {
      // top-level envelope
      status: { label: "Status", source: "status", kind: "status" },
      progress: { label: "Progress", source: "progress", kind: "percent" }
    } },
    { route: route("/api/kernels/:"), fields: {
      // GET /api/kernels/:id → { kernel: KernelHealthSnapshot }
      status: { label: "Status", source: "kernel.status", kind: "status" },
      reputation: { label: "Reputation", source: "kernel.reputation", kind: "count" },
      uptimePercent: { label: "Uptime", source: "kernel.uptimePercent", kind: "percent" },
      capabilityCount: { label: "Capabilities", source: "kernel.capabilityCount", kind: "count" },
      totalJobsCompleted: { label: "Jobs completed", source: "kernel.totalJobsCompleted", kind: "count" },
      activeJobCount: { label: "Active jobs", source: "kernel.activeJobCount", kind: "count" }
    } }
  ];
  function metricFieldForSelect(path, select) {
    if (typeof select !== "string") return null;
    for (const p of METRIC_PROFILE) if (p.route.test(path)) return hasOwn(p.fields, select) ? p.fields[select] : null;
    return null;
  }
  function metricFieldForSource(path, source) {
    if (typeof source !== "string") return null;
    for (const p of METRIC_PROFILE) if (p.route.test(path)) {
      for (const k of Object.keys(p.fields)) if (p.fields[k].source === source) return p.fields[k];
      return null;
    }
    return null;
  }
  function metricLabelForSource(path, source) {
    return metricFieldForSource(path, source)?.label ?? null;
  }
  function metricKindForSource(path, source) {
    return metricFieldForSource(path, source)?.kind ?? null;
  }
  function isOpDescriptor(v) {
    if (!isPlain(v) || !onlyKeys(v, ["id", "label", "confirm", "intentText", "operation_id", "arguments"])) return false;
    if (v.operation_id !== void 0 && (typeof v.operation_id !== "string" || !OP_ID_GRAMMAR.test(v.operation_id))) return false;
    if (v.id !== void 0 && strictStr(v.id, LIM.title) === null) return false;
    if (v.label !== void 0 && strictStr(v.label, LIM.title) === null) return false;
    if (v.intentText !== void 0 && strictStr(v.intentText, LIM.str) === null) return false;
    if (v.confirm !== void 0 && v.confirm !== "inline" && v.confirm !== "approval") return false;
    if (v.arguments !== void 0 && !isPlain(v.arguments)) return false;
    return true;
  }
  var FACADE_READ = "no business-state write; one telemetry event (facade read)";
  var FUNNEL = "; with PCC_FUNNEL_ENABLED=true a 'discover' funnel audit row + PostHog event per request trace";
  var EFFECT_REVIEWED_READS = [
    { route: "/api/jobs", handler: "routes/jobs.ts GET /api/jobs -> JobFacade.list", effect: FACADE_READ },
    { route: "/api/jobs/:", handler: "routes/jobs.ts GET /api/jobs/:jobId -> JobFacade.getById", effect: FACADE_READ },
    { route: "/api/jobs/:/status", handler: "routes/job-submit.ts GET /api/jobs/:jobId/status -> JobFacade.getStatus", effect: FACADE_READ },
    { route: "/api/kernels", handler: "routes/kernels.ts GET /api/kernels -> KernelFacade.list", effect: FACADE_READ },
    { route: "/api/kernels/:", handler: "routes/kernels.ts GET /api/kernels/:kernelId -> KernelFacade.getById", effect: FACADE_READ },
    { route: "/api/capabilities", handler: "routes/capabilities.ts GET /api/capabilities -> CapabilityFacade list", effect: FACADE_READ + FUNNEL },
    { route: "/api/capabilities/:", handler: "routes/capabilities.ts GET /api/capabilities/:capId -> CapabilityFacade.getById", effect: FACADE_READ + FUNNEL },
    { route: "/sse/stream/job/:", handler: "sse/topic-sse.ts GET /sse/stream/job/:jobId (auth + ownership check, topic subscribe)", effect: "no business-state write; per-IP connection counter; never opened by the browser kit" }
  ];
  function bindMatchesPolicy(bind, key) {
    const policy = BIND_POLICY[key];
    if (!policy) return `no bind policy for ${key}`;
    if (!isReadPath(bind.path)) return "bind.path grammar";
    if (RESERVED_EXACT.has(bind.path)) return "bind.path is a reserved/collection route";
    if (!policy.routes.some((re) => re.test(bind.path))) return `bind.path outside ${key} allowlist`;
    if (bind.select !== void 0 && !isSelector(bind.select)) return "bind.select grammar";
    if (policy.needsSelect && bind.select === void 0) return `${key} requires a scalar select`;
    if (!policy.needsSelect && bind.select !== void 0) return `${key} may not select`;
    if (bind.query !== void 0) {
      if (!isPlain(bind.query) || Object.keys(bind.query).length > LIM.queryKeys) return "bind.query shape";
      const allowedQuery = policy.queryByRoute?.[bind.path] ?? [];
      for (const [k, v] of Object.entries(bind.query)) {
        if (!isSelector(k)) return "query key grammar";
        if (isCredentialName(k) || !allowedQuery.includes(k)) return `query key "${k}" not allowed for ${bind.path}`;
        const t = typeof v;
        if (!(t === "string" && v.length <= LIM.str) && t !== "boolean" && !(t === "number" && Number.isFinite(v))) return "query value type";
      }
    }
    if (bind.pollMs !== void 0 && (typeof bind.pollMs !== "number" || !Number.isFinite(bind.pollMs) || bind.pollMs < LIM.pollMinMs || bind.pollMs > LIM.pollMaxMs)) return "bind.pollMs range";
    if (bind.sse !== void 0) {
      if (!policy.sse) return `${key} may not stream`;
      if (!isReadPath(bind.sse, SSE_GRAMMAR) || !policy.sse.some((re) => re.test(bind.sse))) return "bind.sse outside allowlist";
      if (policy.correlate) {
        const mp = policy.correlate.pathRe.exec(bind.path);
        const ms = policy.correlate.sseRe.exec(bind.sse);
        if (!mp || !ms || mp[1] !== ms[1]) return "sse/path identity mismatch";
      }
    }
    if (policy.schema) {
      if (bind.schema !== policy.schema) return `bind.schema must be ${policy.schema}`;
    } else if (bind.schema !== void 0) return "unexpected bind.schema";
    return null;
  }
  function proseNode(type, id, words, fixed = {}) {
    const node = { type, id, props: { ...fixed, [type === "field-label" ? "label" : "text"]: words }, untrusted: true };
    if (isProseClaim(words)) withhold(node);
    return node;
  }
  function withhold(node) {
    node.props = node.type === "heading" ? { level: node.props?.level, withheld: true } : { withheld: true };
    delete node.untrusted;
  }
  function isWithheldProse(node) {
    return node.props?.withheld === true;
  }
  function agentWords(node) {
    if (node.untrusted !== true || !node.props) return null;
    const w = node.type === "field-label" ? node.props.label : node.props.text;
    return typeof w === "string" ? w : null;
  }
  function agentProse(node, out = []) {
    if (agentWords(node) !== null) out.push(node);
    for (const c of node.children ?? []) agentProse(c, out);
    return out;
  }
  function splitClaim(nodes) {
    return nodes.length > 1 && isProseClaim(nodes.map((n) => agentWords(n) ?? "").join(" "));
  }
  function withholdSplitClaims(title, sections) {
    const all = () => [title, ...sections].flatMap((n) => agentProse(n));
    if (!splitClaim(all())) return;
    for (const s of sections) {
      const p = agentProse(s);
      if (splitClaim(p)) p.forEach(withhold);
    }
    const rest = all();
    if (splitClaim(rest)) rest.forEach(withhold);
  }
  function dashboardManifestToIr(m) {
    if (!isPlain(m)) return { ok: false, reason: "manifest not a plain object" };
    if (!deepClean(m)) return { ok: false, reason: "prototype/nonfinite/symbol in manifest" };
    const mm = m;
    if (!onlyKeys(mm, ["csd", "title", "description", "theme", "sections"])) return { ok: false, reason: "unexpected top-level key" };
    const rawTitle = strictStr(mm.title, LIM.title);
    if (rawTitle === null) return { ok: false, reason: "title invalid" };
    if (!Array.isArray(mm.sections)) return { ok: false, reason: "sections not array" };
    if (mm.sections.length > LIM.sections) return { ok: false, reason: "too many sections" };
    let count = 0;
    const budget = () => ++count <= LIM.nodesTotal;
    let bindCount = 0;
    const bindBudget = () => ++bindCount <= LIM.boundWindowsTotal;
    const nextId = /* @__PURE__ */ (() => {
      let n = 0;
      return () => `n${++n}`;
    })();
    const sectionNodes = [];
    for (const secRaw of mm.sections) {
      if (!isPlain(secRaw) || !onlyKeys(secRaw, ["heading", "windows"])) return { ok: false, reason: "bad section" };
      if (!Array.isArray(secRaw.windows)) return { ok: false, reason: "section.windows not array" };
      if (secRaw.windows.length > LIM.windowsPerSection) return { ok: false, reason: "too many windows" };
      const children = [];
      if (secRaw.heading !== void 0) {
        const h = strictStr(secRaw.heading, LIM.title);
        if (h === null) return { ok: false, reason: "section.heading invalid" };
        if (!budget()) return { ok: false, reason: "node budget" };
        children.push(proseNode("heading", nextId(), h, { level: 2 }));
      }
      for (const w of secRaw.windows) {
        const r = mapWindow(w, nextId, budget, bindBudget);
        if (!r.ok) return r;
        children.push(r.node);
      }
      if (!budget()) return { ok: false, reason: "node budget" };
      sectionNodes.push({ type: "section", id: nextId(), children });
    }
    if (!budget()) return { ok: false, reason: "node budget" };
    const titleNode = proseNode("heading", nextId(), rawTitle, { level: 1 });
    withholdSplitClaims(titleNode, sectionNodes);
    if (!budget()) return { ok: false, reason: "node budget" };
    return { ok: true, doc: { ir: "pcc-dashboard-ir/v1", title: titleNode, root: { type: "root", id: nextId(), children: sectionNodes } } };
  }
  function mapWindow(w, nextId, budget, bindBudget) {
    if (!budget()) return { ok: false, reason: "node budget" };
    if (!isPlain(w)) return { ok: false, reason: "window not plain object" };
    const kind = w.kind;
    if (typeof kind !== "string") return { ok: false, reason: "window.kind missing" };
    const id = nextId();
    const chargeBind = () => bindBudget();
    switch (kind) {
      case "note":
        if (!onlyKeys(w, ["kind", "text"])) return { ok: false, reason: "note extra key" };
        {
          const text = strictStr(w.text);
          if (text === null) return { ok: false, reason: "note.text" };
          return { ok: true, node: proseNode("text", id, text) };
        }
      case "metric":
        if (!onlyKeys(w, ["kind", "label", "binding", "select"])) return { ok: false, reason: "metric extra key" };
        {
          const bpath = isPlain(w.binding) ? w.binding.path : void 0;
          const field = typeof bpath === "string" ? metricFieldForSelect(bpath, w.select) : null;
          if (!field) return { ok: false, reason: "metric (route, select) not an allowlisted metric field" };
          const b = mapBind(w.binding, "metric", field.source);
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          return { ok: true, node: { type: "stat", id, props: { label: field.label }, bind: b.bind } };
        }
      // PCC-owned label → NOT untrusted
      case "capability":
        if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "capability extra key" };
        {
          const b = mapBind(w.binding, "capability");
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          return { ok: true, node: { type: "card", id, props: { kind: "capability" }, bind: b.bind } };
        }
      case "receipt":
        if (!onlyKeys(w, ["kind", "binding"])) return { ok: false, reason: "receipt extra key" };
        if (w.binding !== void 0 && !isPlain(w.binding)) return { ok: false, reason: "receipt.binding shape" };
        return { ok: true, node: { type: "receipt", id } };
      case "list":
        if (!onlyKeys(w, ["kind", "binding", "item", "limit"])) return { ok: false, reason: "list extra key" };
        {
          const b = mapBind(w.binding, "list");
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          const item = w.item;
          if (!isPlain(item) || !onlyKeys(item, ["title", "meta", "statusFrom"])) return { ok: false, reason: "list.item" };
          if (!isSelector(item.title)) return { ok: false, reason: "list.item.title selector" };
          const rowMeta = [];
          if (item.meta !== void 0) {
            if (!Array.isArray(item.meta) || item.meta.length > LIM.metaItems) return { ok: false, reason: "list.meta" };
            for (const mi of item.meta) {
              if (!isSelector(mi)) return { ok: false, reason: "list.meta selector" };
              rowMeta.push(mi);
            }
          }
          const props = { rowTitle: item.title, rowMeta };
          if (item.statusFrom !== void 0) {
            if (!isSelector(item.statusFrom)) return { ok: false, reason: "list.statusFrom selector" };
            props.statusFrom = item.statusFrom;
          }
          const offProfile = listProfileViolation(b.bind.path, props);
          if (offProfile) return { ok: false, reason: offProfile };
          if (w.limit !== void 0) {
            if (typeof w.limit !== "number" || !Number.isInteger(w.limit) || w.limit <= 0 || w.limit > LIM.listRows) return { ok: false, reason: "list.limit" };
            props.limit = w.limit;
          }
          return { ok: true, node: { type: "list", id, bind: b.bind, props } };
        }
      case "run":
        if (!onlyKeys(w, ["kind", "binding", "statusFrom", "latestFrom"])) return { ok: false, reason: "run extra key" };
        {
          const b = mapBind(w.binding, "run");
          if (!b.ok) return b;
          if (!chargeBind()) return { ok: false, reason: "bound-window budget" };
          if (!isSelector(w.statusFrom) || !isSelector(w.latestFrom)) return { ok: false, reason: "run selectors" };
          return { ok: true, node: { type: "card", id, props: { kind: "run", statusFrom: w.statusFrom, latestFrom: w.latestFrom }, bind: b.bind } };
        }
      case "form":
        if (!onlyKeys(w, ["kind", "schema", "submit"])) return { ok: false, reason: "form extra key" };
        if (w.submit !== void 0 && !isOpDescriptor(w.submit)) return { ok: false, reason: "form.submit grammar" };
        {
          const labels = fieldLabels(w.schema);
          if (!labels.ok) return labels;
          const children = [];
          for (const l of labels.labels) {
            if (!budget()) return { ok: false, reason: "node budget" };
            children.push(proseNode("field-label", nextId(), l));
          }
          return { ok: true, node: { type: "form-summary", id, children } };
        }
      case "approval":
        if (!onlyKeys(w, ["kind", "binding", "approve", "deny"])) return { ok: false, reason: "approval extra key" };
        if (w.approve !== void 0 && !isOpDescriptor(w.approve)) return { ok: false, reason: "approval.approve grammar" };
        if (w.deny !== void 0 && !isOpDescriptor(w.deny)) return { ok: false, reason: "approval.deny grammar" };
        if (w.binding !== void 0 && !isPlain(w.binding)) return { ok: false, reason: "approval.binding shape" };
        return { ok: true, node: { type: "approval-notice", id, props: { notice: APPROVAL_NOTICE } } };
      case "chain":
        if (!onlyKeys(w, ["kind", "composeRef", "execute"])) return { ok: false, reason: "chain extra key" };
        if (!isPlain(w.composeRef)) return { ok: false, reason: "chain.composeRef shape" };
        if (w.execute !== void 0 && !isOpDescriptor(w.execute)) return { ok: false, reason: "chain.execute grammar" };
        return { ok: true, node: { type: "plan", id, props: { kind: "composition" } } };
      case "actions":
        if (!onlyKeys(w, ["kind", "actions"])) return { ok: false, reason: "actions extra key" };
        {
          const acts = w.actions;
          if (!Array.isArray(acts) || acts.length === 0 || acts.length > LIM.fields) return { ok: false, reason: "actions" };
          const children = [];
          for (const a of acts) {
            if (!budget()) return { ok: false, reason: "node budget" };
            if (!isOpDescriptor(a)) return { ok: false, reason: "action grammar" };
            const label = strictStr(a.label, LIM.title);
            if (label === null) return { ok: false, reason: "action.label" };
            children.push(proseNode("badge", nextId(), label, { tone: "neutral" }));
          }
          return { ok: true, node: { type: "grid", id, props: { kind: "actions-readonly" }, children } };
        }
      default:
        return { ok: false, reason: `unknown window kind: ${kind}` };
    }
  }
  function mapBind(b, key, topSelect) {
    const policy = BIND_POLICY[key];
    if (!policy) return { ok: false, reason: `no bind policy for ${key}` };
    const allowed = policy.sse ? ["path", "query", "pollMs", "sse"] : ["path", "query", "pollMs"];
    if (!isPlain(b) || !onlyKeys(b, allowed)) return { ok: false, reason: "binding shape" };
    const bind = { path: b.path };
    if (topSelect !== void 0) bind.select = topSelect;
    if (b.sse !== void 0) bind.sse = b.sse;
    if (b.pollMs !== void 0) bind.pollMs = b.pollMs;
    if (b.query !== void 0) {
      if (!isPlain(b.query)) return { ok: false, reason: "binding.query shape" };
      const q = {};
      for (const [k, v] of Object.entries(b.query)) {
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return { ok: false, reason: "query value type" };
        q[k] = v;
      }
      bind.query = q;
    }
    if (policy.schema) bind.schema = policy.schema;
    const reason = bindMatchesPolicy(bind, key);
    return reason ? { ok: false, reason } : { ok: true, bind };
  }
  function fieldLabels(schema) {
    if (!isPlain(schema) || !onlyKeys(schema, ["type", "properties", "required"])) return { ok: false, reason: "form.schema shape" };
    if (schema.type !== void 0 && schema.type !== "object") return { ok: false, reason: "form.schema.type" };
    if (schema.required !== void 0 && (!Array.isArray(schema.required) || !schema.required.every((x) => typeof x === "string"))) return { ok: false, reason: "form.schema.required" };
    const props = schema.properties;
    if (!isPlain(props)) return { ok: false, reason: "form.schema.properties" };
    const keys = Object.keys(props);
    if (keys.length > LIM.fields) return { ok: false, reason: "too many fields" };
    const labels = [];
    for (const key of keys) {
      if (PROTO_KEYS.has(key) || isCredentialName(key)) return { ok: false, reason: "credential/proto field" };
      const def = props[key];
      if (!isPlain(def) || !onlyKeys(def, ["type", "title", "description", "enum", "format", "minimum", "maximum", "minLength", "maxLength"])) return { ok: false, reason: "form field-def shape" };
      if (def.type !== void 0 && (typeof def.type !== "string" || !["string", "number", "integer", "boolean"].includes(def.type))) return { ok: false, reason: "form field type" };
      if (def.title !== void 0 && strictStr(def.title, LIM.title) === null) return { ok: false, reason: "form field title" };
      const rawLabel = typeof def.title === "string" ? def.title : key;
      const s = strictStr(rawLabel, LIM.title);
      if (s === null) return { ok: false, reason: "field label" };
      labels.push(s);
    }
    return { ok: true, labels };
  }
  var NODE_SCHEMA = {
    root: { noBind: true, parentOf: ["section"], maxChildren: LIM.sections },
    section: { noBind: true, parentOf: ["heading", "text", "stat", "card", "receipt", "list", "grid", "approval-notice", "plan", "form-summary"] },
    heading: { props: { level: "level", text: "s400" }, required: ["level", "text"], noBind: true, prose: true, childless: true },
    text: { props: { text: "s2000" }, required: ["text"], noBind: true, prose: true, childless: true },
    stat: { props: { label: "s400" }, required: ["label"], bindKey: "metric", needsBind: true, childless: true },
    // label is PCC-owned (not prose) — mirrored below
    card: { props: { kind: "card-kind", statusFrom: "selector", latestFrom: "selector" }, required: ["kind"], optional: ["statusFrom", "latestFrom"], bindKey: "capability", needsBind: true, childless: true },
    receipt: { noBind: true, childless: true },
    // STATIC settlement-record pointer — no bind, no props, no children
    list: { props: { rowTitle: "selector", rowMeta: "string[]", statusFrom: "selector", limit: "limit" }, required: ["rowTitle", "rowMeta"], optional: ["statusFrom", "limit"], bindKey: "list", needsBind: true, childless: true },
    badge: { props: { text: "s400", tone: "tone" }, required: ["text", "tone"], noBind: true, prose: true, childless: true },
    grid: { props: { kind: "grid-kind" }, required: ["kind"], noBind: true, parentOf: ["badge"], minChildren: 1, maxChildren: LIM.fields },
    "approval-notice": { props: { notice: "s2000" }, required: ["notice"], noBind: true, childless: true },
    plan: { props: { kind: "plan-kind" }, required: ["kind"], noBind: true, childless: true },
    "form-summary": { noBind: true, parentOf: ["field-label"], maxChildren: LIM.fields },
    "field-label": { props: { label: "s400" }, required: ["label"], noBind: true, prose: true, childless: true }
  };
  function policyKeyOf(node) {
    const spec = NODE_SCHEMA[node.type];
    if (!spec || !spec.bindKey) return null;
    if (node.type === "card") return node.props && node.props.kind === "run" ? "run" : "capability";
    return spec.bindKey;
  }
  function sourceClassOf(node) {
    const spec = NODE_SCHEMA[node.type];
    if (!spec) return null;
    if (spec.prose) return isWithheldProse(node) ? null : "proposed";
    const key = policyKeyOf(node);
    const policy = key !== null && Object.prototype.hasOwnProperty.call(BIND_POLICY, key) ? BIND_POLICY[key] : void 0;
    return policy ? policy.sourceClass : null;
  }
  function provenanceOf(node) {
    if (!node.bind) return null;
    const key = policyKeyOf(node);
    const policy = key !== null && Object.prototype.hasOwnProperty.call(BIND_POLICY, key) ? BIND_POLICY[key] : void 0;
    return policy ? { sourceClass: policy.sourceClass, schemaId: policy.schemaId, maxAgeMs: policy.maxAgeMs } : null;
  }
  function propType(v, t) {
    switch (t) {
      case "s400":
        return typeof v === "string" && v.length > 0 && v.length <= LIM.title;
      case "s2000":
        return typeof v === "string" && v.length > 0 && v.length <= LIM.str;
      case "number":
        return typeof v === "number" && Number.isFinite(v);
      case "limit":
        return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= LIM.listRows;
      case "boolean":
        return typeof v === "boolean";
      case "string[]":
        return Array.isArray(v) && v.length <= LIM.metaItems && v.every((x) => isSelector(x));
      case "level":
        return v === 1 || v === 2 || v === 3;
      case "tone":
        return typeof v === "string" && TONE_SET.has(v);
      case "card-kind":
        return typeof v === "string" && CARD_KINDS.has(v);
      case "grid-kind":
        return typeof v === "string" && GRID_KINDS.has(v);
      case "plan-kind":
        return typeof v === "string" && PLAN_KINDS.has(v);
      case "true":
        return v === true;
      case "selector":
        return isSelector(v);
    }
  }
  var hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function validateIr(doc) {
    if (!isPlain(doc) || doc.ir !== "pcc-dashboard-ir/v1" || !onlyKeys(doc, ["ir", "title", "root"])) return { ok: false, reason: "not an IR doc" };
    if (!deepClean(doc)) return { ok: false, reason: "proto/nonfinite/symbol in IR" };
    if (!isPlain(doc.title) || doc.title.type !== "heading" || doc.title.props?.level !== 1) return { ok: false, reason: "doc.title not H1" };
    if (!isPlain(doc.root) || doc.root.type !== "root") return { ok: false, reason: "doc.root not root" };
    const ids = /* @__PURE__ */ new Set();
    let count = 0;
    let bindCount = 0;
    const walk = (n, depth) => {
      if (depth > LIM.depth) return "depth";
      if (++count > LIM.nodesTotal) return "node count";
      if (!isPlain(n)) return "node not plain";
      if (!onlyKeys(n, ["type", "id", "props", "bind", "children", "untrusted"])) return "unexpected node key";
      if (typeof n.type !== "string" || !FROZEN.has(n.type)) return `type not frozen: ${String(n.type)}`;
      if (typeof n.id !== "string" || !/^n[0-9]+$/.test(n.id) || ids.has(n.id)) return "id format/dup";
      ids.add(n.id);
      const spec = NODE_SCHEMA[n.type];
      const withheld = spec.prose === true && isPlain(n.props) && hasOwn(n.props, "withheld");
      const pspec = withheld ? n.type === "heading" ? { level: "level", withheld: "true" } : { withheld: "true" } : spec.props ?? {};
      if (n.props !== void 0) {
        if (!isPlain(n.props) || !onlyKeys(n.props, Object.keys(pspec))) return `props off-schema for ${n.type}`;
        for (const [k, v] of Object.entries(n.props)) if (!propType(v, pspec[k])) return `prop ${k} wrong type on ${n.type}`;
      }
      for (const req of withheld ? Object.keys(pspec) : spec.required ?? []) if (!n.props || !hasOwn(n.props, req)) return `missing prop ${req} on ${n.type}`;
      if (n.type === "approval-notice" && n.props?.notice !== APPROVAL_NOTICE) return "approval-notice text not the fixed PCC sentence";
      if (n.type === "card") {
        const k = n.props?.kind;
        if (k === "run") {
          if (!hasOwn(n.props, "statusFrom") || !hasOwn(n.props, "latestFrom")) return "run card missing selectors";
        } else if (hasOwn(n.props ?? {}, "statusFrom") || hasOwn(n.props ?? {}, "latestFrom")) return "capability card has run props";
      }
      if (n.bind !== void 0) {
        if (spec.noBind || !spec.bindKey) return `${n.type} must not bind`;
        if (!isPlain(n.bind) || !onlyKeys(n.bind, ["path", "select", "query", "pollMs", "sse", "schema"])) return "bind shape";
        const bk = policyKeyOf(n);
        const reason = bindMatchesPolicy(n.bind, bk);
        if (reason) return `bind: ${reason}`;
        if (++bindCount > LIM.boundWindowsTotal) return "bound-window budget";
      } else if (spec.needsBind) return `${n.type} requires a bind`;
      if (n.type === "stat") {
        const src = n.bind?.select;
        const bpath = n.bind?.path;
        const expected = typeof bpath === "string" ? metricLabelForSource(bpath, src) : null;
        if (expected === null) return "stat (route, source) not an allowlisted metric field";
        if (n.props?.label !== expected) return "stat label is not the PCC-owned label for its (route, source)";
      }
      if (n.type === "list") {
        const bp = n.bind?.path;
        const off = typeof bp === "string" ? listProfileViolation(bp, n.props ?? {}) : "list without a bound path";
        if (off) return off;
      }
      if (spec.prose) {
        if (withheld) {
          if (n.untrusted !== void 0) return `withheld ${n.type} is PCC's notice, never untrusted`;
        } else {
          if (n.untrusted !== true) return `prose ${n.type} not untrusted`;
          const p = n.props ?? {};
          const t = typeof p.text === "string" ? p.text : typeof p.label === "string" ? p.label : "";
          if (isProseClaim(t)) return `prose ${n.type} states an amount or a money/verification status, or mentions the withheld notice`;
        }
      }
      if (!spec.prose && n.untrusted !== void 0) return `non-prose ${n.type} marked untrusted`;
      if (spec.childless) {
        if (n.children !== void 0) return `${n.type} may not have children`;
      } else {
        if (!Array.isArray(n.children)) return `${n.type} requires children array`;
        if (spec.minChildren !== void 0 && n.children.length < spec.minChildren) return `${n.type} too few children`;
        if (spec.maxChildren !== void 0 && n.children.length > spec.maxChildren) return `${n.type} too many children`;
        let windowKids = 0;
        for (let i = 0; i < n.children.length; i++) {
          const c = n.children[i];
          if (!isPlain(c) || !spec.parentOf || !spec.parentOf.includes(c.type)) return `illegal child under ${n.type}`;
          if (n.type === "section") {
            const ct = c.type;
            if (ct === "heading") {
              if (i !== 0) return "section heading must be first";
              if (c.props?.level !== 2) return "section heading must be H2";
            } else if (++windowKids > LIM.windowsPerSection) return "too many windows in section";
          }
          const e = walk(c, depth + 1);
          if (e) return e;
        }
      }
      return null;
    };
    const e1 = walk(doc.title, 0);
    if (e1) return { ok: false, reason: `title: ${e1}` };
    const e2 = walk(doc.root, 0);
    if (e2) return { ok: false, reason: e2 };
    const sections = doc.root.children ?? [];
    if (splitClaim([doc.title, ...sections].flatMap((n) => agentProse(n)))) return { ok: false, reason: "agent prose states a claim across nodes" };
    return { ok: true };
  }

  // src/mcp/dashboard-ir-renderer.ts
  var CLS = {
    root: "pcc-ir",
    section: "pcc-section",
    heading: "pcc-heading",
    text: "pcc-text",
    stat: "pcc-stat",
    card: "pcc-card",
    receipt: "pcc-receipt",
    list: "pcc-list",
    badge: "pcc-badge",
    grid: "pcc-grid",
    "approval-notice": "pcc-approval",
    plan: "pcc-plan",
    "form-summary": "pcc-form",
    "field-label": "pcc-field",
    fieldname: "pcc-fieldname",
    untrusted: "pcc-untrusted",
    agent: "pcc-agent",
    withheld: "pcc-withheld",
    invalid: "pcc-invalid",
    value: "pcc-value",
    row: "pcc-row",
    meta: "pcc-meta",
    note: "pcc-note",
    schemaCard: "pcc-schema-card",
    field: "pcc-fieldlabel",
    fresh: "pcc-fresh",
    stale: "pcc-stale",
    unavail: "pcc-unavail",
    empty: "pcc-empty",
    timeUnknown: "pcc-time-unknown",
    absent: "pcc-absent"
  };
  var STATE_CLASSES = ["pcc-stale", "pcc-unavail", "pcc-time-unknown"];
  function withState(host, cls) {
    const base = host.className.split(" ").filter((c) => c !== "" && !STATE_CLASSES.includes(c)).join(" ");
    host.className = cls ? base + " " + cls : base;
  }
  function stamp(iso) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
    return m ? m[1] + " " + m[2] + "Z" : "unknown time";
  }
  function readOwnPath(obj, sel) {
    let cur = obj;
    for (const seg of sel.split(".")) {
      if (seg === "__proto__" || seg === "constructor" || seg === "prototype") return void 0;
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return void 0;
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return void 0;
      cur = cur[seg];
    }
    return cur;
  }
  function el(doc, cls, text, untrusted) {
    const n = doc.createElement("div");
    n.className = untrusted ? cls + " " + CLS.untrusted : cls;
    if (text !== void 0) n.textContent = text;
    return n;
  }
  var UNAVAILABLE = "\u2014";
  var SCHEMA_FIELDS = Object.freeze({
    "capability-summary-v1": Object.freeze({
      heading: "Capability",
      fields: Object.freeze([
        { label: "Name", key: "name", kind: "text", required: true },
        { label: "Type", key: "type", kind: "capType", required: true },
        { label: "Base cost", key: "pricing.baseCost", kind: "amount", money: true },
        { label: "Currency", key: "pricing.currency", kind: "currency", money: true },
        { label: "Assurance tiers", key: "assuranceTiers", kind: "tiers" },
        { label: "Available", key: "available", kind: "bool" }
      ])
    }),
    "run-summary-v1": Object.freeze({
      heading: "Run",
      // Dual-shape: the /status route returns top-level status/progress; the /jobs/:id detail
      // route returns them under `job`. Both are the KNOWN server shapes — PCC-owned fixed
      // keys (NOT a manifest selector); first present wins.
      fields: Object.freeze([
        { label: "Status", key: ["status", "job.status"], kind: "status", required: true },
        { label: "Progress", key: ["progress", "job.progress"], kind: "percent" }
      ])
    })
  });
  var SETTLEMENT_NOTICE = Object.freeze({
    heading: "Settlement record (read-only)",
    note: "Not proof of payment; verify on the authenticated PCC surface."
  });
  var CAP_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  var AMOUNT_STR_RE = /^\d{1,15}(\.\d{1,18})?$/;
  var CURRENCY_ENUM = /* @__PURE__ */ new Set(["USDC", "ETH", "DAI", "SOL"]);
  function readField(data, f) {
    const keys = Array.isArray(f.key) ? f.key : [f.key];
    let raw;
    let foundKey = null;
    for (const k of keys) {
      const v = readOwnPath(data, k);
      if (v !== void 0) {
        raw = v;
        foundKey = k;
        break;
      }
    }
    if (foundKey === null) return { ok: true, text: UNAVAILABLE };
    switch (f.kind) {
      case "text":
        return typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? { ok: true, text: reportedFieldText(foundKey, raw) } : { ok: false };
      case "capType":
        return typeof raw === "string" && CAP_TYPE_RE.test(raw) ? { ok: true, text: identifierText(foundKey, raw) } : { ok: false };
      case "status":
        return typeof raw === "string" && raw.length > 0 ? { ok: true, text: boundValueText(foundKey, raw) } : { ok: false };
      case "amount":
        if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && AMOUNT_STR_RE.test(String(raw))) return { ok: true, text: String(raw) };
        if (typeof raw === "string" && AMOUNT_STR_RE.test(raw)) return { ok: true, text: raw };
        return { ok: false };
      case "currency":
        return typeof raw === "string" && CURRENCY_ENUM.has(raw) ? { ok: true, text: raw } : { ok: false };
      case "tiers":
        return Array.isArray(raw) && raw.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 3) ? { ok: true, text: raw.join(", ") } : { ok: false };
      case "bool":
        return typeof raw === "boolean" ? { ok: true, text: raw ? "Yes" : "No" } : { ok: false };
      case "percent":
        return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 100 ? { ok: true, text: String(raw) } : { ok: false };
      default:
        return { ok: false };
    }
  }
  function readSchemaCard(schema, data) {
    const spec = SCHEMA_FIELDS[schema];
    if (!spec) return null;
    const reads = spec.fields.map((f) => readField(data, f));
    const missingRequired = spec.fields.some((f, i) => f.required && reads[i].ok && reads[i].text === UNAVAILABLE);
    return { reads, missingRequired };
  }
  function bindSchemaCard(schema, data, slots) {
    const r = readSchemaCard(schema, data);
    if (!r) return false;
    const { reads, missingRequired } = r;
    const allOk = !missingRequired && reads.every((x) => x.ok);
    reads.forEach((x, i) => {
      const slot = slots[i];
      if (!slot) return;
      slot.textContent = allOk && x.ok ? x.text : UNAVAILABLE;
    });
    return allOk;
  }
  function schemaCardFailure(schema, data) {
    const r = readSchemaCard(schema, data);
    if (!r) return "unknown schema";
    if (r.missingRequired) return "missing required fields";
    if (r.reads.some((x) => !x.ok)) return "mistyped field";
    return null;
  }
  function paintChildren(doc, node, into) {
    if (node.children) for (const c of node.children) into.appendChild(paintNode(doc, c));
  }
  function paintSchemaCard(doc, rootCls, schema) {
    const spec = SCHEMA_FIELDS[schema];
    const e = el(doc, rootCls + " " + CLS.schemaCard);
    e.appendChild(el(doc, CLS.heading, spec.heading));
    if (spec.note) e.appendChild(el(doc, CLS.note, spec.note));
    for (const f of spec.fields) {
      const row = el(doc, CLS.row);
      row.appendChild(el(doc, CLS.field, f.label));
      row.appendChild(el(doc, CLS.value, UNAVAILABLE, true));
      e.appendChild(row);
    }
    return e;
  }
  function paintProse(doc, cls, n, key) {
    if (n.props?.withheld === true) return el(doc, cls + " " + CLS.withheld, WITHHELD_PROSE);
    return el(doc, cls + " " + CLS.agent, String(n.props?.[key] ?? ""), true);
  }
  var PAINTERS = Object.freeze({
    root: (d, n) => {
      const e = el(d, CLS.root);
      paintChildren(d, n, e);
      return e;
    },
    section: (d, n) => {
      const e = el(d, CLS.section);
      paintChildren(d, n, e);
      return e;
    },
    heading: (d, n) => paintProse(d, CLS.heading, n, "text"),
    text: (d, n) => paintProse(d, CLS.text, n, "text"),
    stat: (d, n) => {
      const e = el(d, CLS.stat);
      e.appendChild(el(d, CLS.heading, String(n.props?.label ?? "")));
      e.appendChild(el(d, CLS.value, UNAVAILABLE, true));
      return e;
    },
    card: (d, n) => {
      const rootCls = CLS.card + (n.props?.kind === "run" ? " pcc-card-run" : " pcc-card-cap");
      const schema = n.bind?.schema;
      if (schema === "capability-summary-v1" || schema === "run-summary-v1") return paintSchemaCard(d, rootCls, schema);
      return el(d, rootCls);
    },
    receipt: (d) => {
      const e = el(d, CLS.receipt);
      e.appendChild(el(d, CLS.heading, SETTLEMENT_NOTICE.heading));
      e.appendChild(el(d, CLS.note, SETTLEMENT_NOTICE.note));
      return e;
    },
    list: (d) => {
      const e = el(d, CLS.list);
      return e;
    },
    // rows appended by bindList
    badge: (d, n) => {
      const e = paintProse(d, CLS.badge, n, "text");
      e.setAttr("data-tone", String(n.props?.tone ?? "neutral"));
      return e;
    },
    grid: (d, n) => {
      const e = el(d, CLS.grid);
      paintChildren(d, n, e);
      return e;
    },
    "approval-notice": (d, n) => el(d, CLS["approval-notice"], String(n.props?.notice ?? "")),
    plan: (d) => el(d, CLS.plan, "Composition (view-only)"),
    "form-summary": (d, n) => {
      const e = el(d, CLS["form-summary"]);
      paintChildren(d, n, e);
      return e;
    },
    "field-label": (d, n) => paintProse(d, CLS["field-label"], n, "label")
  });
  function paintNode(doc, node) {
    const p = PAINTERS[node.type];
    if (!p) {
      return el(doc, CLS.invalid, "");
    }
    const e = p(doc, node);
    const src = sourceClassOf(node);
    if (src !== null) {
      e.setAttr("data-source", src);
      e.className = e.className + " pcc-src-" + src;
    }
    return e;
  }
  function applyFreshness(host, meta, asOf, stale) {
    host.setAttr("data-as-of", asOf);
    withState(host, stale ? CLS.stale : null);
    meta.className = CLS.fresh;
    meta.textContent = "source read " + stamp(asOf) + (stale ? " \xB7 stale" : "");
  }
  function applyUnknownTime(host, meta, receivedIso) {
    if (host.removeAttr) host.removeAttr("data-as-of");
    withState(host, CLS.timeUnknown);
    meta.className = CLS.fresh;
    meta.textContent = "source time not reported \xB7 received " + stamp(receivedIso);
  }
  function applyUnavailable(host, meta, why) {
    if (host.removeAttr) host.removeAttr("data-as-of");
    withState(host, CLS.unavail);
    meta.className = CLS.fresh;
    meta.textContent = "unavailable \xB7 " + why;
  }
  function renderIrDoc(doc, mount, ir) {
    while (mount.children.length) mount.children.pop();
    mount.appendChild(paintNode(doc, ir.title));
    mount.appendChild(paintNode(doc, ir.root));
  }
  var LIST_FIELD_LABELS = {
    id: "ID",
    name: "Name",
    capabilityId: "Capability",
    kernelId: "Kernel",
    status: "Status",
    createdAt: "Created",
    updatedAt: "Updated",
    version: "Version",
    capabilityCount: "Capabilities",
    type: "Type",
    available: "Available"
  };
  function listFieldLabel(field) {
    return LIST_FIELD_LABELS[field] ?? field;
  }
  var LIST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  var LIST_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
  function timeRoundTrips(s) {
    const m = LIST_TIME_RE.exec(s);
    if (!m) return false;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
    const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
    if (year < 2e3 || year > 2100) return false;
    const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day && d.getUTCHours() === hour && d.getUTCMinutes() === minute && d.getUTCSeconds() === second && d.getUTCMilliseconds() === ms;
  }
  var LIST_VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
  function readListField(row, field) {
    const raw = readOwnPath(row, field);
    if (raw === void 0 || raw === null) return { ok: true, text: "", raw };
    const kind = LIST_FIELD_KINDS[field];
    switch (kind) {
      case "id":
        return typeof raw === "string" && LIST_ID_RE.test(raw) ? { ok: true, text: identifierText(field, raw), raw } : { ok: false };
      case "text":
        return typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? { ok: true, text: reportedFieldText(field, raw), raw } : { ok: false };
      case "status":
        return typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? { ok: true, text: boundStatusText(raw), raw } : { ok: false };
      case "bool":
        return typeof raw === "boolean" ? { ok: true, text: raw ? "Yes" : "No", raw } : { ok: false };
      case "time":
        return typeof raw === "string" && timeRoundTrips(raw) ? { ok: true, text: raw, raw } : { ok: false };
      case "version":
        return typeof raw === "string" && LIST_VERSION_RE.test(raw) ? { ok: true, text: raw, raw } : { ok: false };
      case "count":
        return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1e6 ? { ok: true, text: String(raw), raw } : { ok: false };
      case "capType":
        return typeof raw === "string" && CAP_TYPE_RE.test(raw) ? { ok: true, text: identifierText(field, raw), raw } : { ok: false };
      default:
        return { ok: false };
    }
  }
  function bindListRows(doc, listEl, node, rows) {
    const rowTitle = String(node.props?.rowTitle ?? "");
    const rowMeta = Array.isArray(node.props?.rowMeta) ? node.props.rowMeta : [];
    const statusFrom = typeof node.props?.statusFrom === "string" ? node.props.statusFrom : "";
    const limit = Math.min(typeof node.props?.limit === "number" ? node.props.limit : LIST_ROW_CAP, LIST_ROW_CAP);
    const isStatusKind = (field) => LIST_FIELD_KINDS[field] === "status";
    let shown = 0;
    for (const row of rows) {
      if (shown >= limit) break;
      if (row === null || typeof row !== "object") continue;
      const titleRead = readListField(row, rowTitle);
      if (titleRead.ok && titleRead.text === "") continue;
      const isAbsent = (c) => c.read.ok && c.read.text === "";
      const metaCells = rowMeta.map((field) => ({ field, read: readListField(row, field) }));
      const statusReadRaw = statusFrom ? readListField(row, statusFrom) : null;
      const statusCell = statusReadRaw ? { field: statusFrom, read: statusReadRaw } : null;
      const titleCell = { field: rowTitle, read: titleRead };
      const allCells = statusCell ? [titleCell, ...metaCells, statusCell] : [titleCell, ...metaCells];
      const rowOk = allCells.every((c) => c.read.ok);
      const texts = new Map(allCells.map((c) => [c, rowOk && c.read.ok ? c.read.text : UNAVAILABLE]));
      if (rowOk) {
        const rawOf = (c) => {
          const r = c.read.ok ? c.read.raw : void 0;
          return typeof r === "string" ? r : null;
        };
        const present = allCells.filter((c) => !isAbsent(c));
        const nonStatusCells = present.filter((c) => !isStatusKind(c.field));
        const statusRaw = present.filter((c) => isStatusKind(c.field)).map(rawOf).filter((r) => r !== null);
        const nonStatusDisplayed = nonStatusCells.filter((c) => texts.get(c) !== WITHHELD_FIELD);
        const isAttributedKind = (field) => {
          const k = LIST_FIELD_KINDS[field];
          return k === "text" || k === "id" || k === "capType";
        };
        const joinTextOf = (c) => isAttributedKind(c.field) ? rawOf(c) ?? texts.get(c) : texts.get(c);
        const joined = [...nonStatusDisplayed.map(joinTextOf), ...statusRaw];
        const nonStatusClaim = nonStatusDisplayed.length > 1 && isMoneyClaim(nonStatusDisplayed.map(joinTextOf).join(" "));
        const crossClaim = statusRaw.length > 0 && isMoneyClaim(joined.join(" ")) && !isMoneyClaim(statusRaw.join(" "));
        if (nonStatusClaim || crossClaim) for (const c of nonStatusCells) texts.set(c, WITHHELD_FIELD);
      }
      const line = el(doc, CLS.row);
      line.appendChild(el(doc, CLS.fieldname, listFieldLabel(rowTitle) + ":"));
      line.appendChild(el(doc, CLS.heading, texts.get(titleCell), true));
      for (const c of metaCells) {
        line.appendChild(el(doc, CLS.fieldname, listFieldLabel(c.field) + ":"));
        line.appendChild(rowOk && isAbsent(c) ? el(doc, CLS.meta + " " + CLS.absent, "not reported") : el(doc, CLS.meta, texts.get(c), true));
      }
      if (statusCell) {
        line.appendChild(el(doc, CLS.fieldname, listFieldLabel(statusFrom) + ":"));
        line.appendChild(rowOk && isAbsent(statusCell) ? el(doc, CLS.badge + " " + CLS.absent, "not reported") : el(doc, CLS.badge, texts.get(statusCell), true));
      }
      listEl.appendChild(line);
      shown++;
    }
    if (rows.length === 0) listEl.appendChild(el(doc, CLS.empty, "none"));
    return shown;
  }
  function listRowsReadable(node, rows) {
    const rowTitle = String(node.props?.rowTitle ?? "");
    for (const row of rows.slice(0, LIST_ROW_CAP)) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
      const read = readListField(row, rowTitle);
      if (!read.ok || read.text === "") return false;
    }
    return true;
  }
  function bindScalar(node, data) {
    const sel = node.bind?.select;
    const path = node.bind?.path;
    if (typeof sel !== "string" || typeof path !== "string") return UNAVAILABLE;
    const kind = metricKindForSource(path, sel);
    if (!kind) return UNAVAILABLE;
    const raw = readOwnPath(data, sel);
    switch (kind) {
      case "status":
        return typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? boundStatusText(raw) : UNAVAILABLE;
      case "text":
        return typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? reportedFieldText(sel, raw) : UNAVAILABLE;
      case "bool":
        return typeof raw === "boolean" ? raw ? "Yes" : "No" : UNAVAILABLE;
      case "percent":
        return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 100 ? String(raw) : UNAVAILABLE;
      case "count":
        return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? String(raw) : UNAVAILABLE;
      case "id":
        return typeof raw === "string" && LIST_ID_RE.test(raw) ? identifierText(sel, raw) : UNAVAILABLE;
      case "time":
        return typeof raw === "string" && timeRoundTrips(raw) ? raw : UNAVAILABLE;
      case "version":
        return typeof raw === "string" && LIST_VERSION_RE.test(raw) ? raw : UNAVAILABLE;
      default:
        return UNAVAILABLE;
    }
  }
  function bootIrView(doc, mount, rawDoc, validate) {
    if (!validate(rawDoc).ok) {
      while (mount.children.length) mount.children.pop();
      mount.appendChild(el(doc, CLS.invalid, "This dashboard could not be verified and was not rendered."));
      return false;
    }
    renderIrDoc(doc, mount, rawDoc);
    return true;
  }

  // src/mcp/dashboard-ir-binder.ts
  var BINDER_LIM = { maxBytes: 512 * 1024, maxRows: 200, minPollMs: 5e3, maxPollMs: 36e5, defaultPollMs: 3e4, sessionMs: 30 * 60 * 1e3 };
  function bindUrl(origin, bind) {
    const p = bind.path;
    if (typeof p !== "string" || p.length < 2) return null;
    if (p[0] !== "/" || p[1] === "/") return null;
    if (p.indexOf("..") !== -1) return null;
    if (/[\s<>"'`\\?#]/.test(p)) return null;
    if (p.indexOf("/api/") !== 0) return null;
    let qs = "";
    if (bind.query) {
      const parts = [];
      for (const k of Object.keys(bind.query)) {
        if (!Object.prototype.hasOwnProperty.call(bind.query, k)) continue;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(bind.query[k])));
      }
      if (parts.length) qs = "?" + parts.join("&");
    }
    return origin + p + qs;
  }
  function channelFor(bind) {
    return bind.sse ? "sse" : "poll";
  }
  function clampPoll(bind) {
    const ms = typeof bind.pollMs === "number" && Number.isFinite(bind.pollMs) ? bind.pollMs : BINDER_LIM.defaultPollMs;
    return Math.max(BINDER_LIM.minPollMs, Math.min(ms, BINDER_LIM.maxPollMs));
  }
  var ASOF_MAX_SKEW_MS = 12e4;
  var ASOF_MIN_YEAR = 2020;
  var ASOF_MAX_YEAR = 2100;
  var ASOF_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;
  function sourceAsOf(json, nowMs) {
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
    if (!Object.prototype.hasOwnProperty.call(json, "asOf")) return null;
    const raw = json.asOf;
    if (typeof raw !== "string") return null;
    const m = ASOF_RE.exec(raw);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), hh = Number(m[4]), mi = Number(m[5]), ss = Number(m[6]);
    if (y < ASOF_MIN_YEAR || y > ASOF_MAX_YEAR) return null;
    const calendarMs = Date.UTC(y, mo - 1, d, hh, mi, ss);
    const check = new Date(calendarMs);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== hh || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== ss) return null;
    const ms = m[7] ? Number((m[7].slice(1) + "000").slice(0, 3)) : 0;
    const t = calendarMs + ms;
    if (!Number.isFinite(t) || t > nowMs + ASOF_MAX_SKEW_MS) return null;
    return new Date(t).toISOString();
  }
  function isStale(asOfIso, maxAgeMs, nowMs) {
    const t = Date.parse(asOfIso);
    return !Number.isFinite(t) || nowMs - t > maxAgeMs;
  }
  function acceptsNewer(currentAsOf, incomingAsOf, currentFingerprint, incomingFingerprint) {
    if (currentAsOf === null) return true;
    const cur = Date.parse(currentAsOf), inc = Date.parse(incomingAsOf);
    if (inc > cur) return true;
    if (inc < cur) return false;
    if (incomingFingerprint === null) return true;
    return incomingFingerprint === currentFingerprint;
  }
  function startBind(node, deps, onData, onStale, onEnded) {
    const bind = node.bind;
    let stopped = false;
    let pollTimer = null;
    let sse = null;
    let sessionTimer = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== null) {
        deps.clearTimer(pollTimer);
        pollTimer = null;
      }
      if (sessionTimer !== null) {
        deps.clearTimer(sessionTimer);
        sessionTimer = null;
      }
      if (sse) {
        sse.close();
        sse = null;
      }
    };
    if (!bind) return { stop };
    const url = bindUrl(deps.origin, bind);
    if (url === null) {
      stop();
      return { stop };
    }
    sessionTimer = deps.setTimer(() => {
      if (stopped) return;
      stop();
      if (onEnded) onEnded("updates stopped");
    }, BINDER_LIM.sessionMs);
    if (channelFor(bind) === "sse" && deps.openSse && bind.sse) {
      const sseUrl = deps.origin + bind.sse;
      sse = deps.openSse(sseUrl, (d) => {
        if (!stopped) onData(d);
      }, () => {
        if (!stopped && onStale) onStale("stream error");
        stop();
      });
    } else {
      let fails = 0;
      const nextDelay = () => Math.min(clampPoll(bind) * Math.pow(2, fails < 6 ? fails : 6), BINDER_LIM.maxPollMs);
      const tick = () => {
        if (stopped) return;
        deps.getJson(url, deps.makeSignal()).then((r) => {
          if (stopped) return;
          const clean = r.ok !== false && r.status === 200 && !r.redirected && !r.bytesOver && r.json !== null && typeof r.json === "object";
          if (clean) {
            fails = 0;
            onData(r.json);
          } else {
            fails++;
            if (onStale) onStale(r.reason ?? (r.redirected ? "redirected" : r.bytesOver ? "response too large" : r.status !== 200 ? "HTTP " + r.status : "empty response"));
          }
          pollTimer = deps.setTimer(tick, nextDelay());
        }).catch(() => {
          if (stopped) return;
          fails++;
          if (onStale) onStale("network error");
          pollTimer = deps.setTimer(tick, nextDelay());
        });
      };
      tick();
    }
    return { stop };
  }

  // src/mcp/dashboard-ir-browser-entry.ts
  var CAP = {
    docChars: 256 * 1024,
    // bounded manifest preflight: total string + key chars
    maxNodes: 2e4,
    // bounded manifest preflight: total DISTINCT nodes visited
    maxFanout: 4096,
    // bounded manifest preflight: per-container children
    maxPending: 1e5,
    // bounded manifest preflight: max enqueued (stack) references
    respBytes: 512 * 1024,
    // per-response byte cap (incremental)
    concurrent: 6,
    // global max in-flight binds
    reqTimeoutMs: 3e4,
    protocol: "2026-01-26",
    initId: 1
  };
  var MOUNT_ID = "pcc-ir-root";
  function pccApiOrigin() {
    const o = window.__PCC_IR_ORIGIN__;
    return typeof o === "string" && /^https:\/\/[a-z0-9.-]+$/i.test(o) ? o : null;
  }
  function wrapEl(real) {
    const children = [];
    const w = {
      _el: real,
      children,
      get textContent() {
        return real.textContent ?? "";
      },
      set textContent(v) {
        real.textContent = v;
      },
      get className() {
        return real.className;
      },
      set className(v) {
        real.className = v;
      },
      setAttr(n, v) {
        real.setAttribute(n, v);
      },
      removeAttr(n) {
        real.removeAttribute(n);
      },
      appendChild(c) {
        real.appendChild(c._el);
        children.push(c);
        return c;
      }
    };
    return w;
  }
  var rdoc = { createElement: (tag) => wrapEl(document.createElement(tag)) };
  function inert(mount, msg) {
    const p = document.createElement("p");
    p.className = "pcc-invalid";
    p.textContent = msg;
    mount.replaceChildren(p);
  }
  function tooLarge(root) {
    const seen = /* @__PURE__ */ new WeakSet();
    let nodes = 0, chars = 0, pending = 1;
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      pending--;
      if (++nodes > CAP.maxNodes) return true;
      if (typeof v === "string") {
        chars += v.length;
        if (chars > CAP.docChars) return true;
        continue;
      }
      if (!v || typeof v !== "object") continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (Array.isArray(v)) {
        if (v.length > CAP.maxFanout || pending + v.length > CAP.maxPending) return true;
        for (let i = 0; i < v.length; i++) {
          stack.push(v[i]);
          pending++;
        }
      } else {
        let kn = 0;
        for (const k in v) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
          if (++kn > CAP.maxFanout || pending + 1 > CAP.maxPending) return true;
          chars += k.length;
          if (chars > CAP.docChars) return true;
          stack.push(v[k]);
          pending++;
        }
      }
    }
    return false;
  }
  var inFlight = 0;
  var waiters = [];
  function acquire(signal) {
    if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    if (inFlight < CAP.concurrent) {
      inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = { wake: () => {
      }, onAbort: () => {
      } };
      w.onAbort = () => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new DOMException("aborted", "AbortError"));
      };
      w.wake = () => {
        signal.removeEventListener("abort", w.onAbort);
        resolve();
      };
      signal.addEventListener("abort", w.onAbort, { once: true });
      waiters.push(w);
    });
  }
  function release() {
    const n = waiters.shift();
    if (n) n.wake();
    else inFlight--;
  }
  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  async function realGetJson(url, signal) {
    const resp = await fetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { accept: "application/json" }, signal });
    const redirected = resp.redirected;
    const ct = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (resp.status !== 200 || redirected || ct !== "application/json") {
      try {
        await resp.body?.cancel();
      } catch {
      }
      const reason = resp.status !== 200 ? "HTTP " + resp.status : redirected ? "redirected" : "unexpected content type";
      return { status: resp.status, redirected, bytesOver: false, json: null, ok: false, reason };
    }
    const reader = resp.body ? resp.body.getReader() : null;
    const chunks = [];
    let received = 0;
    if (reader) {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.length;
          if (received > CAP.respBytes) {
            try {
              await reader.cancel();
            } catch {
            }
            return { status: 200, redirected: false, bytesOver: true, json: null, ok: false, reason: "response too large" };
          }
          chunks.push(value);
        }
      }
    }
    let json = null;
    try {
      json = JSON.parse(new TextDecoder().decode(concat(chunks, received)));
    } catch {
      return { status: 200, redirected: false, bytesOver: false, json: null, ok: false, reason: "unreadable response" };
    }
    if (json === null || typeof json !== "object") return { status: 200, redirected: false, bytesOver: false, json: null, ok: false, reason: "empty response" };
    return { status: 200, redirected: false, bytesOver: false, json, ok: true };
  }
  var rendered = false;
  var disposed = false;
  var boundHandles = [];
  var genController = null;
  var liveDoc = null;
  var liveRoot = null;
  function collectBound(doc) {
    const stats = [], lists = [], schemaCards = [];
    const walk = (n) => {
      if (n.bind) {
        if (n.type === "stat") stats.push(n);
        else if (n.type === "list") lists.push(n);
        else if (n.type === "card") schemaCards.push(n);
      }
      if (n.children) for (const c of n.children) walk(c);
    };
    walk(doc.root);
    return { stats, lists, schemaCards };
  }
  var MISSING = /* @__PURE__ */ Symbol("missing-field");
  function selectPath(data, select) {
    let cur = data;
    for (const seg of select.split(".")) {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return MISSING;
      cur = cur[seg];
    }
    return cur;
  }
  function shapeOf(n) {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType === 1) {
      const e = n;
      const attrs = Array.from(e.attributes).map((a) => [a.name, a.value]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      return [e.tagName, attrs, ...Array.from(e.childNodes).map(shapeOf)];
    }
    return null;
  }
  var provStates = /* @__PURE__ */ new Map();
  function provenanced(node, el2, prepare, clear, fingerprint) {
    const prov = provenanceOf(node);
    const host = wrapEl(el2);
    let st = provStates.get(node.id);
    if (!st) {
      const metaReal = document.createElement("div");
      if (el2.parentNode) el2.parentNode.insertBefore(metaReal, el2.nextSibling);
      st = { meta: metaReal, watermark: null, fingerprint: null, shown: false, timeKnown: false, expiry: null };
      provStates.set(node.id, st);
    }
    const state = st;
    const meta = wrapEl(state.meta);
    const disarm = () => {
      if (state.expiry !== null) {
        clearTimeout(state.expiry);
        state.expiry = null;
      }
    };
    const markFresh = () => {
      disarm();
      if (!state.shown || !state.timeKnown || state.watermark === null || !prov) return;
      const now = Date.now();
      const stale = isStale(state.watermark, prov.maxAgeMs, now);
      applyFreshness(host, meta, state.watermark, stale);
      if (!stale) {
        const left = Date.parse(state.watermark) + prov.maxAgeMs - now;
        state.expiry = setTimeout(() => {
          state.expiry = null;
          if (state.shown && state.watermark) applyFreshness(host, meta, state.watermark, true);
        }, Math.max(0, left) + 1);
      }
    };
    const failed = (why) => {
      disarm();
      clear();
      state.shown = false;
      applyUnavailable(host, meta, why);
    };
    markFresh();
    return {
      onData: (data) => {
        const now = Date.now();
        const src = sourceAsOf(data, now);
        const prepared = prepare(data, src);
        if (typeof prepared === "string") {
          failed(prepared);
          return;
        }
        const incomingFingerprint = fingerprint(data);
        if (state.watermark !== null && (src === null || !acceptsNewer(state.watermark, src, state.fingerprint, incomingFingerprint))) return;
        prepared();
        state.shown = true;
        state.fingerprint = incomingFingerprint;
        if (src !== null) {
          state.watermark = src;
          state.timeKnown = true;
          markFresh();
        } else {
          disarm();
          state.timeKnown = false;
          applyUnknownTime(host, meta, new Date(now).toISOString());
        }
      },
      onStale: failed,
      onEnded: failed
    };
  }
  function startBinds(doc, root) {
    const origin = pccApiOrigin();
    if (!origin) {
      const { stats: stats2, lists: lists2, schemaCards: schemaCards2 } = collectBound(doc);
      const els = (cls) => Array.from(root.querySelectorAll("." + cls));
      const mark = (nodes, cls) => nodes.forEach((node, i) => {
        const el2 = els(cls)[i];
        if (el2) provenanced(node, el2, () => "no live data source", () => {
        }, () => null).onStale("no live data source");
      });
      mark(stats2, "pcc-stat");
      mark(lists2, "pcc-list");
      mark(schemaCards2, "pcc-schema-card");
      return;
    }
    const gen = new AbortController();
    genController = gen;
    const deps = {
      origin,
      // The signal is the GENERATION signal; per request we add a timeout + gen-link on a
      // fresh controller and clean BOTH up when the request settles (no leaked timer/listener).
      getJson: async (url, sig) => {
        const s = sig;
        await acquire(s);
        const ctrl = new AbortController();
        const onGen = () => ctrl.abort(new DOMException("generation aborted", "AbortError"));
        let timer = null;
        try {
          if (s.aborted) ctrl.abort();
          else s.addEventListener("abort", onGen, { once: true });
          timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), CAP.reqTimeoutMs);
          return await realGetJson(url, ctrl.signal);
        } finally {
          if (timer !== null) clearTimeout(timer);
          s.removeEventListener("abort", onGen);
          release();
        }
      },
      // NO openSse: SSE transport intentionally absent — run cards bind via GET poll only.
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h),
      makeSignal: () => gen.signal
    };
    const { stats, lists, schemaCards } = collectBound(doc);
    const byClass = (cls) => Array.from(root.querySelectorAll("." + cls));
    const statEls = byClass("pcc-stat"), listEls = byClass("pcc-list"), schemaEls = byClass("pcc-schema-card");
    const push = (h) => boundHandles.push(h);
    stats.forEach((node, i) => {
      const el2 = statEls[i];
      const slot = el2?.querySelector(".pcc-value");
      if (!el2 || !slot) return;
      const select = String(node.bind?.select ?? "");
      const pv = provenanced(node, el2, (data) => {
        const cur = selectPath(data, select);
        if (cur === MISSING) return "missing field";
        const text = bindScalar(node, data);
        if (text === UNAVAILABLE) return "mistyped field";
        return () => {
          slot.textContent = text;
        };
      }, () => {
        slot.textContent = "";
      }, (data) => {
        const cur = selectPath(data, select);
        if (cur === MISSING) return null;
        return bindScalar(node, data) === UNAVAILABLE ? null : JSON.stringify(cur);
      });
      push(startBind(node, deps, pv.onData, pv.onStale, pv.onEnded));
    });
    schemaCards.forEach((node, i) => {
      const el2 = schemaEls[i];
      if (!el2) return;
      const schema = node.bind?.schema;
      if (!schema) return;
      const slots = Array.from(el2.querySelectorAll(".pcc-value"));
      const pv = provenanced(node, el2, (data) => {
        const staging = slots.map(() => ({ textContent: "" }));
        if (!bindSchemaCard(schema, data, staging)) return schemaCardFailure(schema, data) ?? "payload does not match schema";
        return () => {
          staging.forEach((s, j) => {
            const sl = slots[j];
            if (sl) sl.textContent = s.textContent;
          });
        };
      }, () => {
        for (const sl of slots) sl.textContent = "";
      }, (data) => {
        const staging = slots.map(() => ({ textContent: "" }));
        return bindSchemaCard(schema, data, staging) ? JSON.stringify(staging.map((s) => s.textContent)) : null;
      });
      push(startBind(node, deps, pv.onData, pv.onStale, pv.onEnded));
    });
    lists.forEach((node, i) => {
      const el2 = listEls[i];
      if (!el2) return;
      const pv = provenanced(node, el2, (data, src) => {
        const rows = listRowsOf(String(node.bind?.path ?? ""), data);
        if (rows === null) return "unexpected response shape";
        if (!listRowsReadable(node, rows)) return "partial collection";
        if (rows.length === 0 && src === null) return "empty result without a source time";
        const staging = document.createElement("div");
        bindListRows(rdoc, wrapEl(staging), node, rows);
        return () => el2.replaceChildren(...Array.from(staging.childNodes));
      }, () => {
        el2.replaceChildren();
      }, (data) => {
        const rows = listRowsOf(String(node.bind?.path ?? ""), data);
        if (rows === null) return null;
        if (!listRowsReadable(node, rows)) return null;
        const staging = document.createElement("div");
        bindListRows(rdoc, wrapEl(staging), node, rows);
        return JSON.stringify(shapeOf(staging));
      });
      push(startBind(node, deps, pv.onData, pv.onStale, pv.onEnded));
    });
  }
  function stopBinds() {
    for (const h of boundHandles) h.stop();
    boundHandles = [];
    if (genController) {
      genController.abort();
      genController = null;
    }
  }
  function renderManifest(manifest) {
    if (disposed || rendered) return;
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (tooLarge(manifest)) {
      rendered = true;
      inert(mount, "This dashboard is too large and was not rendered.");
      return;
    }
    let r;
    try {
      r = dashboardManifestToIr(manifest);
    } catch {
      r = { ok: false, reason: "adapter threw" };
    }
    if (!r.ok) {
      rendered = true;
      inert(mount, "This dashboard could not be verified and was not rendered.");
      return;
    }
    rendered = true;
    const container = wrapEl(document.createElement("div"));
    let painted = false;
    try {
      painted = bootIrView(rdoc, container, r.doc, validateIr);
    } catch {
      inert(mount, "This dashboard could not be verified and was not rendered.");
      return;
    }
    mount.replaceChildren(container._el);
    if (painted) {
      liveDoc = r.doc;
      liveRoot = container._el;
      startBinds(r.doc, container._el);
    }
  }
  function boot() {
    const parent = window.parent;
    let state = "init";
    window.addEventListener("message", (ev) => {
      if (ev.source !== parent) return;
      const d = ev.data;
      if (!d || typeof d !== "object" || d.jsonrpc !== "2.0") return;
      if (d.method === "ui/resource-teardown" && "id" in d) {
        if (!disposed) {
          disposed = true;
          stopBinds();
        }
        try {
          parent.postMessage({ jsonrpc: "2.0", id: d.id, result: {} }, "*");
        } catch {
        }
        return;
      }
      if (disposed) return;
      if (state === "init" && d.id === CAP.initId && d.result && typeof d.result === "object") {
        if (d.result.protocolVersion !== CAP.protocol) return;
        state = "ready";
        parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
        return;
      }
      if (state === "ready" && d.method === "ui/notifications/tool-result") {
        const params = d.params;
        const structured = params && typeof params === "object" ? params.structuredContent : null;
        const manifest = structured && typeof structured === "object" ? structured.manifest : null;
        if (manifest != null) renderManifest(manifest);
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (disposed) return;
      if (document.hidden) stopBinds();
      else if (liveDoc && liveRoot) {
        stopBinds();
        startBinds(liveDoc, liveRoot);
      }
    });
    window.addEventListener("pagehide", stopBinds);
    window.addEventListener("pageshow", () => {
      if (disposed) return;
      if (!document.hidden && liveDoc && liveRoot) {
        stopBinds();
        startBinds(liveDoc, liveRoot);
      }
    });
    parent.postMessage({ jsonrpc: "2.0", id: CAP.initId, method: "ui/initialize", params: { protocolVersion: CAP.protocol, appInfo: { name: "pcc-dashboard-ir", version: "1" }, appCapabilities: {} } }, "*");
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") boot();
})();
