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
import { createHmac } from "node:crypto";
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
