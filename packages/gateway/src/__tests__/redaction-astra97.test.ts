/**
 * astra's verdict on pack 97 (WP-D's redactor, fde33cfd): DO-NOT-SHIP, 4 HIGH and
 * 2 MEDIUM. Every test here asserts the EXACT sanitized output, so it fails on a
 * partial redaction (`password=[REDACTED]$sw0rd!rest`), on a redactor that removes
 * nothing, and on one that removes too much. "The whole secret is gone" is not
 * enough: the text around a secret must come through byte for byte.
 *
 * F1  a labelled credential is consumed whole, by its enclosing format's delimiters
 * F2  names written in percent-encoding or JSON escapes are decoded before the match
 * F3  a valid BIP-39 mnemonic is redacted however few distinct words it has
 * F4  a valid JWT with a short payload; a short Bearer token; a wrapped hex key
 * F5  repeated `authorization=` labels cost linear time
 * F6  (the strengthened assertions live here and in redaction-deep.test.ts)
 *
 * No backslash-u escape is typed in this file: BS is a backslash, so the text under
 * test holds the literal six characters of an escape and nothing rewrites them.
 */

import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { english, generateMnemonic } from "viem/accounts";
import { redactSecretsDeep, redactSecrets, REDACTED_VALUE as R } from "../redaction.js";

const BS = String.fromCharCode(92);
const BOM = String.fromCharCode(0xfeff);

/** The deep-redacted text, which must equal the same text one level down in an object. */
function sanitize(text: string): string {
  const direct = redactSecretsDeep(text);
  const nested = (redactSecretsDeep({ body: { note: text } }) as { body: { note: string } }).body.note;
  expect(nested, "the same text under an object key").toBe(direct);
  return direct;
}

describe("F1: a labelled credential is consumed whole, by the delimiters of its enclosing format", () => {
  it.each<[string, string, string]>([
    ["a password with $ and !", "password=$uperSecret!77", `password=${R}`],
    ["a password that $ and ! used to cut short", "password=pa$sw0rd!rest", `password=${R}`],
    ["a value on the next, more indented line", "password:\n  opaque-value-77", `password:\n  ${R}`],
    [
      "a percent-encoded URL query value",
      "https://cb.test/?access_token=%6fpaqueValue77&state=1",
      `https://cb.test/?access_token=${R}&state=1`,
    ],
    ["a connection-string Pwd alias", "Server=db;User ID=svc;Pwd=$uperSecret!77;", `Server=db;User ID=svc;Pwd=${R};`],
  ])("the verdict's input: %s", (_name, input, expected) => {
    expect(sanitize(input)).toBe(expected);
  });

  it.each<[string, string, string]>([
    [
      "a URL fragment parameter (OAuth implicit flow)",
      "https://cb.test/cb#access_token=a%20b$c&token_type=bearer&state=9",
      `https://cb.test/cb#access_token=${R}&token_type=bearer&state=9`,
    ],
    ["a URL value that ends at a #", "https://cb.test/?token=abc!def#section", `https://cb.test/?token=${R}#section`],
    ["a form body, the secret first", "password=a$b!c&scope=openid", `password=${R}&scope=openid`],
    [
      "a form body, the secret in the middle",
      "grant_type=password&password=a$b!c&scope=x",
      `grant_type=password&password=${R}&scope=x`,
    ],
    ["a pair that ends at whitespace", "set password=hu!nter2 now", `set password=${R} now`],
    ["a pair in backticks", "set `password=hu!nter2` now", `set \`password=${R}\` now`],
    ["a pair followed by a comma and another pair", "user=bob,password=hu!nter2,ip=1.2.3.4", `user=bob,password=${R},ip=1.2.3.4`],
    ["a header line, to the end of the line", "X-Api-Key: ab c$d!e\nAccept: */*", `X-Api-Key: ${R}\nAccept: */*`],
    ["a header line ending in CRLF", "X-Api-Key: ab$c\r\nAccept: */*", `X-Api-Key: ${R}\r\nAccept: */*`],
    ["a label: value pair, to the end of the line", "password: pa$$ w0rd!\nuser: bob", `password: ${R}\nuser: bob`],
    [
      "an Authorization value holding characters a token cannot",
      "Authorization: Bearer ab$cd!ef\nAccept: x",
      `Authorization: Bearer ${R}\nAccept: x`,
    ],
    [
      "an Authorization header inside a quoted curl argument",
      "curl -H 'Authorization: Basic ab$c' https://api.test",
      `curl -H 'Authorization: Basic ${R}' https://api.test`,
    ],
    ["a double-quoted value with spaces, ; and &", 'password="a b;c&d!" tail', `password="${R}" tail`],
    ["a double-quoted value with an escaped quote", 'password="a' + BS + '"b!c" tail', `password="${R}" tail`],
    ["a single-quoted connection-string value", "Pwd='x;y!z';Database=db", `Pwd='${R}';Database=db`],
    ["a doubled quote inside a quoted value", "Pwd='it''s$ecret';Next=1", `Pwd='${R}';Next=1`],
    [
      "a connection string with no closing semicolon",
      "Server=db; User ID=svc; Pwd=sp ace$",
      `Server=db; User ID=svc; Pwd=${R}`,
    ],
    [
      "a connection string whose first field is the password",
      "Password=my pass!;Server=db",
      `Password=${R};Server=db`,
    ],
    [
      "a JSON fragment with an unquoted value",
      '{"password": hu!nter2, "user": "bob"} tail',
      `{"password": ${R}, "user": "bob"} tail`,
    ],
    ["a blank line between the label and its value", "password:\n\n   opaque-value-77\nafter", `password:\n\n   ${R}\nafter`],
    ["a YAML block scalar", "password: |\n  line one\n  line two\nnext: x", `password: |\n  ${R}\nnext: x`],
  ])("keeps the safe context around %s", (_name, input, expected) => {
    expect(sanitize(input)).toBe(expected);
  });

  it("fails closed: a quote that never closes, and a structured value, are redacted to the end of the line", () => {
    expect(sanitize('password="abc def\nnext line')).toBe(`password="${R}\nnext line`);
    expect(sanitize('{"password":{"a":"b"},"user":"x"} tail\nnext')).toBe(`{"password":${R}\nnext`);
  });

  it("a label with no value, or whose next line is not more indented, redacts nothing", () => {
    for (const same of ["password:\nnext: x", "  password:\n  next: x", "password=\nnext=1", "password:"]) {
      expect(sanitize(same), same).toBe(same);
    }
  });

  it("Pwd is a password alias in a connection string, not the PWD working-directory variable", () => {
    expect(sanitize("PWD=/home/user\nServer=db;Pwd=abc;")).toBe(`PWD=/home/user\nServer=db;Pwd=${R};`);
    expect(redactSecretsDeep({ pwd: "abc", cwd: "/home/user" })).toEqual({ pwd: R, cwd: "/home/user" });
  });
});

describe("F2: encoded field names are decoded, then the complete original value is replaced", () => {
  it.each<[string, string, string]>([
    [
      "a percent-encoded URL parameter name",
      "https://cb.test/?access%5ftoken=opaqueValue77&state=1",
      `https://cb.test/?access%5ftoken=${R}&state=1`,
    ],
    ["a percent-encoded first letter", "https://cb.test/?%61pi_key=opaqueValue77&z=1", `https://cb.test/?%61pi_key=${R}&z=1`],
    ["a percent-encoded bracketed name", "user%5Bpassword%5D=opaqueValue77&b=1", `user%5Bpassword%5D=${R}&b=1`],
    [
      "a JSON-escaped name in a fragment inside prose",
      `the config is {"api${BS}u005fkey":"opaqueValue77"} end`,
      `the config is {"api${BS}u005fkey":"${R}"} end`,
    ],
    [
      "a JSON-escaped first letter",
      `x {"${BS}u0070assword":"opaqueValue77","ok":1} y`,
      `x {"${BS}u0070assword":"${R}","ok":1} y`,
    ],
    [
      "a JSON-escaped name beside an ordinary encoded one",
      `{"u${BS}u0073er":"bob","api${BS}u005fkey":"k1"} z`,
      `{"u${BS}u0073er":"bob","api${BS}u005fkey":"${R}"} z`,
    ],
    ["an encoded name that is not a secret, beside one that is", "?st%61te=1&access%5ftoken=v1&x=2", `?st%61te=1&access%5ftoken=${R}&x=2`],
  ])("%s", (_name, input, expected) => {
    expect(sanitize(input)).toBe(expected);
  });
});

describe("F3: a valid BIP-39 mnemonic is redacted whatever its distinct words (checksum, not distinctness)", () => {
  const rep = (word: string, n: number) => Array.from({ length: n }, () => word);
  // The published all-zero and all-one entropy vectors (Trezor's BIP-39 test set).
  const VALID: Array<[string, string[]]> = [
    ["12 words: abandon x11, about", [...rep("abandon", 11), "about"]],
    ["15 words: abandon x14, address", [...rep("abandon", 14), "address"]],
    ["18 words: abandon x17, agent", [...rep("abandon", 17), "agent"]],
    ["21 words: abandon x20, admit", [...rep("abandon", 20), "admit"]],
    ["24 words: abandon x23, art", [...rep("abandon", 23), "art"]],
    ["12 words: zoo x11, wrong", [...rep("zoo", 11), "wrong"]],
    ["24 words: zoo x23, vote", [...rep("zoo", 23), "vote"]],
    ["12 words, 9 distinct", "legal winner thank year wave sausage worth useful legal winner thank yellow".split(" ")],
    ["12 words, 9 distinct", "letter advice cage absurd amount doctor acoustic avoid letter advice cage above".split(" ")],
  ];

  it.each(VALID)("redacts %s", (_name, words) => {
    const phrase = words.join(" ");
    expect(sanitize(`zzqx ${phrase} zzqx`)).toBe(`zzqx ${R} zzqx`);
    expect(sanitize(phrase)).toBe(R);
    expect(sanitize(`${phrase},`)).toBe(`${R},`); // trailing punctuation is not part of the phrase
  });

  it("redacts the verdict's reproduction exactly", () => {
    expect(redactSecretsDeep("abandon ".repeat(11) + "about")).toBe(R);
  });

  it("redacts every random mnemonic of every length (a checksum written independently of the redactor)", () => {
    for (const strength of [128, 160, 192, 224, 256]) {
      for (let i = 0; i < 25; i += 1) {
        const phrase = generateMnemonic(english, strength);
        // 'zzqx' frames the phrase: ordinary words around it, such as follow and end, are wordlist words too.
        expect(sanitize(`zzqx ${phrase} zzqx`), phrase).toBe(`zzqx ${R} zzqx`);
      }
    }
  });

  it("a valid window inside a longer run is redacted and the rest of the run is not", () => {
    // 'abandon' x12 is not valid, but dropping its first word leaves 'abandon' x11, 'about'.
    expect(sanitize(`${"abandon ".repeat(12)}about!`)).toBe(`abandon ${R}!`);
  });

  it("keeps a 12-word ordinary sentence of wordlist words whose checksum fails (the false-positive guard)", () => {
    const sentence = "what they want they never know until they know what they want";
    const words = sentence.split(" ");
    expect(words).toHaveLength(12);
    expect(words.every((w) => english.includes(w))).toBe(true);
    expect(new Set(words).size).toBeLessThan(10); // not a mnemonic by the distinct-word rule either
    expect(redactSecretsDeep(`they said: ${sentence}.`)).toBe(`they said: ${sentence}.`);
    expect(redactSecretsDeep(sentence)).toBe(sentence);
  });

  it("keeps a repeated-word run no window of which passes the checksum", () => {
    const run = "abandon ".repeat(40);
    expect(redactSecretsDeep(run)).toBe(run);
  });
});

describe("F4: a valid JWT whose payload is short", () => {
  const b64url = (v: string) => Buffer.from(v).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url("{}");
  const signature = createHmac("sha256", "a-made-up-test-key").update(`${header}.${payload}`).digest("base64url");
  const jwt = `${header}.${payload}.${signature}`;

  it("builds the token the verdict describes: payload segment e30", () => {
    expect(payload).toBe("e30");
    expect(signature).toHaveLength(43);
  });

  it("removes a real HS256 token over {} completely", () => {
    expect(sanitize(`token ${jwt} end`)).toBe(`token ${R} end`);
    expect(sanitize(jwt)).toBe(R);
    expect(sanitize(`Bearer ${jwt}`)).toBe(`Bearer ${R}`);
    expect(redactSecrets(`got ${jwt} back`)).toBe("got [redacted-jwt] back");
  });

  it("removes the verdict's literal token", () => {
    expect(redactSecretsDeep("eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJlLWJ5dGVzLWhlcmU")).toBe(R);
  });

  it("still redacts a long-payload token, and leaves segments that cannot be a JWT alone", () => {
    expect(redactSecretsDeep("a eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvci0xIn0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU b")).toBe(`a ${R} b`);
    const notJwt = [
      "eyJhbGciOiJIUzI1NiJ9.abc.c2lnbmF0dXJl", // payload bytes are not a JSON object
      "eyJhbGciOiJIUzI1NiJ9.e3.c2lnbmF0dXJl", // payload too short to hold {}
      "eyJhbGciOiJIUzI1NiJ9.abcde.c2lnbmF0dXJl", // 5 characters: still has to be JSON
      "eyJhbGciOiJIUzI1NiJ9.e30.abc", // signature too short
    ];
    for (const text of notJwt) expect(redactSecretsDeep(`x ${text} y`), text).toBe(`x ${text} y`);
  });
});

describe("F4: Bearer tokens that are short, and a private key wrapped over two lines", () => {
  it("a short Bearer token is a credential wherever a credential can sit", () => {
    expect(sanitize("Bearer short123")).toBe(`Bearer ${R}`);
    expect(sanitize("Authorization: Bearer short123")).toBe(`Authorization: Bearer ${R}`);
    expect(sanitize("got Bearer abc123 back")).toBe(`got Bearer ${R} back`);
    expect(sanitize('sent "Bearer opaque" to the api')).toBe(`sent "Bearer ${R}" to the api`);
    expect(sanitize("x=Bearer opaque y")).toBe(`x=Bearer ${R} y`);
  });

  it("prose that merely says Bearer is left alone", () => {
    const prose = "The Bearer token expires. Bearer bonds are paper. Bearer tokens go in the header.";
    expect(redactSecretsDeep(prose)).toBe(prose);
  });

  const hex = "ab12cd34".repeat(8);
  it.each<[string, string, string]>([
    ["two 32-digit lines", `${hex.slice(0, 32)}\n${hex.slice(32)}`, R],
    ["two 32-digit lines, CRLF", `${hex.slice(0, 32)}\r\n${hex.slice(32)}`, R],
    ["an indented continuation", `${hex.slice(0, 32)}\n    ${hex.slice(32)}`, R],
    ["a 60 + 4 digit split (xxd -p)", `${hex.slice(0, 60)}\n${hex.slice(60)}`, R],
    ["three lines", `${hex.slice(0, 22)}\n${hex.slice(22, 43)}\n${hex.slice(43)}`, R],
    ["a 0x prefix", `0x${hex.slice(0, 32)}\n${hex.slice(32)}`, R],
    [
      "a key in the middle of text",
      `the private key follows\n${hex.slice(0, 32)}\n${hex.slice(32)}\nthat was all`,
      `the private key follows\n${R}\nthat was all`,
    ],
  ])("joins a hex key wrapped as %s", (_name, input, expected) => {
    expect(sanitize(input)).toBe(expected);
  });

  it("does not join hex lines that are not exactly 64 digits together", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567"; // 40 digits, a git commit
    for (const text of [`${sha}\n${sha}`, `${hex.slice(0, 32)}\n${hex.slice(0, 33)}`, `${hex.slice(0, 32)}\n\n${hex.slice(32)}`]) {
      expect(redactSecretsDeep(text), text).toBe(text);
    }
  });

  it("keeps a wrapped digest when the caller asked to keep digests", () => {
    const wrapped = `${hex.slice(0, 32)}\n${hex.slice(32)}`;
    expect(redactSecretsDeep(wrapped, undefined, { keepDigests: true })).toBe(wrapped);
  });
});

describe("spans that touch are one secret", () => {
  it("a private-key block and a 64-digit hex key with nothing between them become ONE marker", () => {
    const pem = ["-----BEGIN ", "PRIVATE KEY-----", "\nMC4CAQAw\n", "-----END ", "PRIVATE KEY-----"].join("");
    expect(sanitize(`${pem}${"ab12cd34".repeat(8)} end`)).toBe(`${R} end`);
  });
});

describe("F5: repeated authorization labels are scanned once", () => {
  const bestOf = (runs: number, text: string): number => {
    let best = Infinity;
    for (let i = 0; i < runs; i += 1) {
      const t0 = performance.now();
      redactSecretsDeep(text);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };

  it("t(2n) < 3.2 * t(n) on the verdict's family, with an absolute cap", () => {
    redactSecretsDeep("authorization=".repeat(100)); // compile the regexes first
    const small = bestOf(3, "authorization=".repeat(16_000));
    const large = bestOf(3, "authorization=".repeat(32_000));
    // A quadratic scan doubles to ~4x; a linear one to ~2x. A 5 ms floor keeps a
    // millisecond-sized t(n) from turning timer noise on a shared box into a failure.
    expect(large, `t(16k)=${small.toFixed(1)} ms, t(32k)=${large.toFixed(1)} ms`).toBeLessThan(3.2 * Math.max(small, 5));
    expect(large).toBeLessThan(1_000);
  }, 120_000);

  it("is linear on the sibling families too (label=, label:, quoted label)", () => {
    for (const unit of ["authorization=", "password=", "token:", "api_key=", '"password":"', "proxy-authorization: "]) {
      redactSecretsDeep(unit.repeat(100));
      const small = bestOf(3, unit.repeat(10_000));
      const large = bestOf(3, unit.repeat(20_000));
      expect(large, `${unit} t(10k)=${small.toFixed(1)} ms, t(20k)=${large.toFixed(1)} ms`).toBeLessThan(3.2 * Math.max(small, 5));
    }
  }, 120_000);

  it("still redacts the whole run", () => {
    expect(redactSecretsDeep("authorization=".repeat(3))).toBe(`authorization=${R}`);
  });
});

describe("F6: a BOM-prefixed JSON body is parsed, so structure the label scanner cannot see is removed", () => {
  it("a secret under a secret-ish PARENT (no label names it) in a BOM-prefixed body", () => {
    const text = `${BOM}{"wallet":{"key":"opaqueValue77"}}`;
    expect(sanitize(text)).toBe(`{"wallet":{"key":"${R}"}}`);
  });

  it("an escaped secret name too long for the label scanner's budget, in a BOM-prefixed body", () => {
    // 'z' and not 'a': a run of 64 or more hex digits is itself a secret shape, and would hide what this tests.
    const name = "z".repeat(400) + "_token";
    const escaped = Array.from({ length: 400 }, () => BS + "u007a").join("") + "_token";
    expect(escaped.length).toBeGreaterThan(2_000);
    expect(sanitize(`${BOM}{"${escaped}":"opaqueValue77","ok":1}`)).toBe(`{"${name}":"${R}","ok":1}`);
  });
});

// ── The rules behind the five inputs, each pinned by an exact output ─────────────────

describe("the label scanner's other delimiters and budgets", () => {
  it.each<[string, string, string]>([
    ["an unknown first word is the credential, not a scheme", "authorization=hunter2 and more", `authorization=${R} and more`],
    [
      "Digest takes its whole parameter list",
      'Authorization: Digest username="a", nonce="b"\nnext',
      `Authorization: Digest ${R}\nnext`,
    ],
    ["a scheme word, then a credential that starts with a mark", "Authorization: Bearer !x9\nok", `Authorization: Bearer ${R}\nok`],
    ["a scheme word and its token, taken from a pair", "x token=Bearer abc.def y", `x token=${R} y`],
    ["an Authorization value in quotes", 'authorization: "Bearer ab$c" tail', `authorization: "Bearer ${R}" tail`],
    [
      "a quote that closes a URL parameter inside a JSON fragment",
      'x {"url":"https://h.test/?token=abc","n":1} y',
      `x {"url":"https://h.test/?token=${R}","n":1} y`,
    ],
    ["a quote inside a URL value that closes nothing", 'https://h.test/?token=ab"cd&x=1', `https://h.test/?token=${R}&x=1`],
    ["a single quote that closes a URL parameter", "run 'https://h.test/?token=abc' now", `run 'https://h.test/?token=${R}' now`],
    [
      "JSON's null and booleans under a secret name hold nothing; a number does",
      'x {"token": null, "ok": true, "hasApiKey": false, "secret": 123456} y',
      `x {"token": null, "ok": true, "hasApiKey": false, "secret": ${R}} y`,
    ],
    ["a header inside double quotes", '"X-Api-Key: abc" rest', `"X-Api-Key: ${R}" rest`],
    ["a header inside backticks", "use `X-Api-Key: abc` now", `use \`X-Api-Key: ${R}\` now`],
    [
      "ODBC PWD in a connection string",
      "DRIVER={SQL Server};SERVER=x;UID=sa;PWD=secret;DATABASE=d",
      `DRIVER={SQL Server};SERVER=x;UID=sa;PWD=${R};DATABASE=d`,
    ],
    [
      "a ; that is part of the value, not a field separator",
      "Password=p@ss;w0rd;MultipleActiveResultSets=True",
      `Password=${R};MultipleActiveResultSets=True`,
    ],
    ["a markdown reference is not a label, a real one beside it is", "[token]: see below\npassword: x", `[token]: see below\npassword: ${R}`],
    ["a plus sign (a space) in a form name does not hide it", "?access+token=v1&x=2", `?access+token=${R}&x=2`],
    ["a JS x escape in a quoted name", `x {"api${BS}x5fkey":"v1"} y`, `x {"api${BS}x5fkey":"${R}"} y`],
    ["an unknown escape keeps its character", `x {"api${BS}_key":"v1"} y`, `x {"api${BS}_key":"${R}"} y`],
    ["a malformed percent escape does not break the name", "?pass%zzword=v1&access%5ftoken=v2", `?pass%zzword=v1&access%5ftoken=${R}`],
    ["an escape with bad hex digits is not decoded", `x {"pass${BS}u00zzword":"v1"} y`, `x {"pass${BS}u00zzword":"v1"} y`],
    ["an unterminated quote keeps the blanks before the line break", 'password="abc  \r\nnext', `password="${R}  \r\nnext`],
    ["blanks after a comma between pairs", "user=bob, password=hu!nter2, ip=1.2.3.4", `user=bob, password=${R}, ip=1.2.3.4`],
    ["a CRLF after the last ; of a connection string", "Server=db;Pwd=abc;\r\nnext", `Server=db;Pwd=${R};\r\nnext`],
    ["a ; before something that is not a field is part of the value", "password=ab;1x=3 tail", `password=${R} tail`],
    ["a 3-letter session name", "x sid=abc y", `x sid=${R} y`],
    ["a 3-letter secret name", "jwt: abc.def", `jwt: ${R}`],
    ["a session name in a URL", "?session=abc&x=1", `?session=${R}&x=1`],
    [
      "a URL fragment parameter ends at & though no field follows",
      "https://cb.test/cb#access_token=abc&x tail",
      `https://cb.test/cb#access_token=${R}&x tail`,
    ],
    ["a URL query parameter ends at & though no field follows", "https://cb.test/?token=abc&x tail", `https://cb.test/?token=${R}&x tail`],
    ["a parameter after & ends at the next & though no field follows", "a=1&token=abc&x tail", `a=1&token=${R}&x tail`],
    ["a URL value that starts with a backtick", "https://h.test/?token=`)abc&x tail", `https://h.test/?token=${R}&x tail`],
    ["a field name with a space after a ;", "Password=abc;User ID=svc", `Password=${R};User ID=svc`],
    ["a field name with an underscore after a ;", "Password=abc;Trusted_Connection=yes", `Password=${R};Trusted_Connection=yes`],
    ["a field name with a dot and a dash after a ;", "Password=abc;a.b-c=1", `Password=${R};a.b-c=1`],
    ["a value on the next line, with CRLF line ends", "password:\r\n  v1\r\nnext", `password:\r\n  ${R}\r\nnext`],
    ["a quote followed by ) closes a URL value", 'see ("https://h.test/?token=abc") now', `see ("https://h.test/?token=${R}") now`],
    ["a quote followed by > closes a URL value", '<a href="https://h.test/?token=abc">x</a>', `<a href="https://h.test/?token=${R}">x</a>`],
    ["a quote followed by ] closes a URL value", '["https://h.test/?token=abc"]', `["https://h.test/?token=${R}"]`],
    ["a quote followed by ; closes a URL value", 'u = "https://h.test/?token=abc";', `u = "https://h.test/?token=${R}";`],
  ])("%s", (_name, input, expected) => {
    expect(sanitize(input)).toBe(expected);
  });

  it("reads a name up to 64 decoded characters, and no longer", () => {
    const at = "z".repeat(55) + "_password"; // 64 characters
    const over = "z".repeat(56) + "_password"; // 65
    expect(sanitize(`${at}=v1 tail`)).toBe(`${at}=${R} tail`);
    expect(sanitize(`${over}=v1 tail`)).toBe(`${over}=v1 tail`);
  });

  it("reads a quoted name up to 192 raw characters, however much of it is escapes, and no longer", () => {
    const esc = (n: number) => Array.from({ length: n }, () => BS + "u007a").join("") + "_password"; // 6 per z
    expect(sanitize(`x {"${esc(30)}":"v1"} y`)).toBe(`x {"${esc(30)}":"${R}"} y`); // 180 + 9 = 189 raw
    expect(sanitize(`x {"${esc(33)}":"v1"} y`)).toBe(`x {"${esc(33)}":"v1"} y`); // 198 + 9 = 207 raw
  });

  it("reports each removed value exactly, as the callback's secret", () => {
    const seen: Array<{ path: string; value: string }> = [];
    const out = redactSecretsDeep({ log: "password=$uperSecret!77 and more\nServer=db;Pwd=p w;" }, (r) => seen.push({ path: r.path, value: r.value }));
    expect(out).toEqual({ log: `password=${R} and more\nServer=db;Pwd=${R};` });
    expect(seen).toEqual([
      { path: "$.log", value: "$uperSecret!77" },
      { path: "$.log", value: "p w" },
    ]);
  });

  it("a block scalar ends at the first line that is not indented deeper", () => {
    expect(sanitize("  password: >-\n    one\n\n    two\n  next: x\nlast: y")).toBe(`  password: >-\n    ${R}\n  next: x\nlast: y`);
  });

  it("a value on the next line needs a deeper indent; tabs count as one", () => {
    expect(sanitize("a:\n\tpassword:\n\t\tv1\n\tother: x")).toBe(`a:\n\tpassword:\n\t\t${R}\n\tother: x`);
    expect(sanitize("\tpassword:\n\tv1")).toBe("\tpassword:\n\tv1");
  });

  it("a line less deep than the label's own line is not its value", () => {
    expect(sanitize("a:\n    password:\n  next")).toBe("a:\n    password:\n  next");
  });
});

describe("F3 (continued): phrases the checksum rejects, and a run too long to decide", () => {
  // A reference BIP-39 checksum written for this test, so the vectors are proven valid or invalid here.
  const isValid = (words: string[]): boolean => {
    if (![12, 15, 18, 21, 24].includes(words.length)) return false;
    const bits = words.map((w) => english.indexOf(w).toString(2).padStart(11, "0")).join("");
    const checksumBits = words.length / 3;
    const entropy = Buffer.from(bits.slice(0, bits.length - checksumBits).match(/.{8}/g)!.map((b) => parseInt(b, 2)));
    const digest = createHash("sha256").update(entropy).digest();
    return digest[0].toString(2).padStart(8, "0").slice(0, checksumBits) === bits.slice(bits.length - checksumBits);
  };

  it("the reference checksum agrees with the published vectors", () => {
    expect(isValid([...Array(11).fill("abandon"), "about"])).toBe(true);
    expect(isValid(Array(12).fill("abandon"))).toBe(false);
    expect(isValid(Array(12).fill("word"))).toBe(true);
  });

  it("a mistyped phrase (the checksum fails, 10+ distinct words) is still a seed phrase", () => {
    const words = english.slice(300, 312);
    expect(isValid(words)).toBe(false);
    expect(new Set(words).size).toBe(12);
    expect(sanitize(`zzqx ${words.join(" ")} zzqx`)).toBe(`zzqx ${R} zzqx`);
  });

  it("the longest window wins: a 24-word phrase whose first 12 words are also a phrase goes whole", () => {
    const phrase = "above able abandon about above about about able above ability about above about about about ability above ability above above above above able ability";
    const words = phrase.split(" ");
    expect(words).toHaveLength(24);
    expect(isValid(words)).toBe(true);
    expect(isValid(words.slice(0, 12))).toBe(true); // a 12-word window would stop here
    expect(isValid(words.slice(12))).toBe(false); // and leave these 12 words, which are not a phrase
    expect(new Set(words).size).toBeLessThan(10); // and the distinct-word rule would not save them
    expect(sanitize(`zzqx ${phrase} zzqx`)).toBe(`zzqx ${R} zzqx`);
  });

  it("the ordinary sentence of the false-positive guard fails the checksum, so only the guard keeps it", () => {
    const words = "what they want they never know until they know what they want".split(" ");
    expect(isValid(words)).toBe(false);
  });

  it("a run too long to decide within the checksum budget fails closed: the whole run goes", () => {
    expect(redactSecretsDeep("abandon ".repeat(5_000))).toBe(`${R} `);
    // ...while 40 of the same word, decided window by window, stays (abandon x12 fails the checksum).
    expect(redactSecretsDeep("abandon ".repeat(40))).toBe("abandon ".repeat(40));
  });

  it("a word that is not on the list breaks a run; commas, line breaks and capitals do not", () => {
    const phrase = [...Array(11).fill("abandon"), "about"];
    expect(sanitize(`${phrase.slice(0, 6).join(" ")} zzqx ${phrase.slice(6).join(" ")}`)).toBe(
      `${phrase.slice(0, 6).join(" ")} zzqx ${phrase.slice(6).join(" ")}`,
    );
    expect(sanitize(phrase.join(", "))).toBe(R);
    expect(sanitize(phrase.join("\n"))).toBe(R);
    expect(sanitize(phrase.map((w) => w.toUpperCase()).join(" "))).toBe(R);
  });
});

describe("F4 (continued): JWT payload edges, Bearer edges, and the limits of a wrapped hex key", () => {
  const head = "eyJhbGciOiJIUzI1NiJ9";
  const sig = "c2lnbmF0dXJl";

  it("a 4-character payload that decodes to a JSON object is a JWT; one that decodes to an array is not", () => {
    expect(Buffer.from("eyB9", "base64url").toString()).toBe("{ }");
    expect(Buffer.from("W10", "base64url").toString()).toBe("[]");
    expect(sanitize(`x ${head}.eyB9.${sig} y`)).toBe(`x ${R} y`);
    expect(redactSecretsDeep(`x ${head}.W10.${sig} y`)).toBe(`x ${head}.W10.${sig} y`);
  });

  it("a signature of 6 characters is enough, 5 is not", () => {
    expect(sanitize(`x ${head}.e30.abcdef y`)).toBe(`x ${R} y`);
    expect(redactSecretsDeep(`x ${head}.e30.abcde y`)).toBe(`x ${head}.e30.abcde y`);
  });

  it("a Bearer token of 4+ characters with a digit is a credential in running text; shorter, or all letters, is not", () => {
    expect(sanitize("see Bearer abc12 here")).toBe(`see Bearer ${R} here`);
    expect(sanitize("see Bearer a-b_ here")).toBe(`see Bearer ${R} here`);
    const kept = "see Bearer 2.0 and Bearer abc and Bearer abcdefghijk end";
    expect(redactSecretsDeep(kept)).toBe(kept);
    expect(sanitize("see Bearer abcdefghijkl end")).toBe(`see Bearer ${R} end`); // 12 letters: no word is that long
  });

  const hex = "ab12cd34".repeat(8);
  it("joins 4 lines of 16, and not a 5th: a key wrapped over 5 lines is not joined", () => {
    expect(sanitize([16, 16, 16, 16].map((n, i) => hex.slice(i * 16, i * 16 + n)).join("\n"))).toBe(R);
    const five = [13, 13, 13, 13, 12];
    let at = 0;
    const lines = five.map((n) => hex.slice(at, (at += n)));
    expect(lines.join("")).toBe(hex);
    expect(redactSecretsDeep(lines.join("\n"))).toBe(lines.join("\n"));
  });

  it("does not join a line that has anything after its hex, or a last run of fewer than 4 digits", () => {
    for (const text of [`${hex.slice(0, 32)} foo\n${hex.slice(32)}`, `${hex.slice(0, 62)}\n${hex.slice(62)}`]) {
      expect(redactSecretsDeep(text), text).toBe(text);
    }
  });

  it("joins 33 + 31 digits, a key wrapped anywhere", () => {
    expect(sanitize(`${hex.slice(0, 33)}\n${hex.slice(33)}`)).toBe(R);
  });

  it("blanks after the first line's hex do not stop the join", () => {
    expect(sanitize(`${hex.slice(0, 32)}  \n${hex.slice(32)}`)).toBe(R);
  });

  it("a middle run that does not end its line, and 62 digits, are not a key", () => {
    const middle = `${hex.slice(0, 22)}\n${hex.slice(22, 43)} foo\n${hex.slice(43)}`;
    expect(redactSecretsDeep(middle)).toBe(middle);
    const sixtyTwo = `${hex.slice(0, 32)}\n${hex.slice(32, 62)}`;
    expect(redactSecretsDeep(sixtyTwo)).toBe(sixtyTwo);
  });
});

describe("the sink stays conservative where the deep redactor is not", () => {
  it("redacts only double-quoted JSON string fields: not pairs, single quotes or non-string values", () => {
    const untouched = "password=hunter2 {'token':'t1'} {\"api_key\": 12345}";
    expect(redactSecrets(untouched)).toBe(untouched);
    expect(redactSecrets('{"api_key": "k1", "n": 1}')).toBe('{"api_key": "[redacted]", "n": 1}');
  });

  it("a base64 run of 40 characters that mixes upper, lower and digits is key material; 39 is not", () => {
    const thirtyNine = "aB3".repeat(13);
    expect(redactSecrets(`x ${thirtyNine} y`)).toBe(`x ${thirtyNine} y`);
    expect(redactSecrets(`x ${thirtyNine}Q y`)).toBe("x [redacted-b64] y");
  });

  it("a base64 run needs a digit as well: upper and lower case alone is a word, not a key", () => {
    const noDigit = "aBcD".repeat(10); // 40 characters
    expect(redactSecrets(`x ${noDigit} y`)).toBe(`x ${noDigit} y`);
  });

  it("decodes an escaped field name as the deep redactor does", () => {
    expect(redactSecrets(`{"api${BS}u005fkey":"k1"}`)).toBe(`{"api${BS}u005fkey":"[redacted]"}`);
  });
});
