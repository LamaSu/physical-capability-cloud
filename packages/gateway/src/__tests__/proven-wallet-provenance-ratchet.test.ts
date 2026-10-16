/**
 * W1b r4 F-b: buyer provenance comes from reviewed server sources. A new
 * provenance source must be added here on purpose, with its review.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIELD = "provenWalletVia";
const WRITER_REVIEW_MESSAGE = "EXPECTED_WRITES: a new provenWalletVia writer needs its own review; add it to the pinned list in the same PR";
const COMMENT_FREE_PRINTER = ts.createPrinter({ removeComments: true });
const WRITER_FILES = [
  "auth/kernel-authority.ts",
  "routes/a2a-tasks.ts",
  "services/wallet-links/proven-wallet.ts",
];
const BOUNDARY_NAMES = ["authorityOf", "bindProof", "proveSelfLinkedWallet"];
// Adding a member to this closed allow-list needs review. Admin headers use the exact shape below.
const AUTHORITY_OF_ALLOWED_MEMBERS = new Set([
  "provenWallet", "provenWalletVia", "operatorId", "userId", "trim", "length",
]);

interface Write {
  file: string;
  kind: string;
  value: string;
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [filename] : [];
  }).sort();
}

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression
    && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
    return node.argumentExpression.text;
  }
  if (ts.isBindingElement(node)) {
    const property = node.propertyName ?? node.name;
    const name = ts.isComputedPropertyName(property) ? property.expression : property;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  }
  return undefined;
}

function containingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent as ts.FunctionLikeDeclaration;
  }
  return undefined;
}

function checkerFor(file: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (filename) => filename === file.fileName ? file : undefined;
  return ts.createProgram([file.fileName], options, host).getTypeChecker();
}

function roleSourceViolations(fn: ts.FunctionDeclaration, file: ts.SourceFile): string[] {
  const checker = checkerFor(file);
  const writes: ts.BinaryExpression[] = [];
  visit(fn.body!, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && memberName(node.left) === FIELD) writes.push(node);
  });
  if (writes.length !== 1) return ["bindProof must have exactly one provenance assignment"];
  const value = writes[0].right;
  if (!ts.isTemplateExpression(value) || value.head.text !== "self-link:"
    || value.templateSpans.length !== 1 || value.templateSpans[0].literal.text !== ""
    || !ts.isIdentifier(value.templateSpans[0].expression)) {
    return ["bindProof provenance must interpolate its database role"];
  }
  // Resolve the interpolated identifier to its actual declaration. A same-named
  // role in a different scope, or a body field named role, cannot satisfy this.
  const role = checker.getSymbolAtLocation(value.templateSpans[0].expression)?.valueDeclaration;
  if (!role || !ts.isVariableDeclaration(role) || !ts.isVariableDeclarationList(role.parent)
    || !(role.parent.flags & ts.NodeFlags.Const) || containingFunction(role) !== fn
    || !role.initializer || !ts.isCallExpression(role.initializer)
    || !ts.isIdentifier(role.initializer.expression)) {
    return ["bindProof role must be a const database lookup in the same function"];
  }
  const lookup = checker.getSymbolAtLocation(role.initializer.expression)?.declarations?.[0];
  if (!lookup || !ts.isImportSpecifier(lookup)
    || (lookup.propertyName ?? lookup.name).text !== "findSelfLinkedWallet") {
    return ["bindProof role must call the imported findSelfLinkedWallet"];
  }
  const imported = lookup.parent.parent.parent;
  if (!ts.isImportDeclaration(imported) || !ts.isStringLiteral(imported.moduleSpecifier)
    || imported.moduleSpecifier.text !== "./repository.js") {
    return ["bindProof role must come from the wallet-link repository"];
  }
  return [];
}

function authoritySourceViolations(fn: ts.FunctionDeclaration, file: ts.SourceFile): string[] {
  const checker = checkerFor(file);
  const parameter = fn.parameters[0];
  const violations = new Set<string>();
  visit(fn.body!, (node) => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== FIELD) return;
    const receiver = node.expression;
    const declaration = ts.isIdentifier(receiver)
      ? checker.getSymbolAtLocation(receiver)?.valueDeclaration : undefined;
    if (!declaration || !ts.isVariableDeclaration(declaration)
      || !ts.isVariableDeclarationList(declaration.parent)
      || !(declaration.parent.flags & ts.NodeFlags.Const)
      || !ts.isVariableStatement(declaration.parent.parent)
      || declaration.parent.parent.parent !== fn.body || !declaration.initializer) {
      violations.add(`authorityOf: provenance receiver ${receiver.getText(file)} must resolve to a const declared directly in its body`);
      return;
    }
    let source = declaration.initializer;
    let assertions = 0;
    while (ts.isParenthesizedExpression(source) || ts.isAsExpression(source)) {
      if (ts.isAsExpression(source)) assertions++;
      source = source.expression;
    }
    if (assertions === 0 || !ts.isIdentifier(source) || !parameter || !ts.isIdentifier(parameter.name)
      || checker.getSymbolAtLocation(source)?.valueDeclaration !== parameter) {
      violations.add(`authorityOf: provenance receiver ${receiver.getText(file)} must be an as chain over its own first parameter`);
    }
  });
  return [...violations];
}

function reviewedAdminHeaderAccess(access: ts.Node, name: string, file: ts.SourceFile): boolean {
  const member = memberName(access);
  // authorityOf already authenticates the admin using this one header.
  // Keep that existing access exact; it cannot supply buyer provenance.
  const parent = access.parent;
  const call = parent.parent;
  const adminHeader = name === "authorityOf" && member === "headers"
    && access.getText(file) === "req.headers"
    && ts.isElementAccessExpression(parent) && parent.expression === access
    && memberName(parent) === "x-admin-key"
    && ts.isCallExpression(call) && call.arguments.length === 1 && call.arguments[0] === parent
    && ts.isIdentifier(call.expression) && call.expression.text === "hasAdminSecret";
  return adminHeader;
}

function boundaryViolations(file: ts.SourceFile): string[] {
  const violations: string[] = [];
  visit(file, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.body || !node.name) return;
    const name = node.name.text;
    if (!BOUNDARY_NAMES.includes(name)) return;
    if (name === "bindProof") violations.push(...roleSourceViolations(node, file));
    if (name === "authorityOf") violations.push(...authoritySourceViolations(node, file));
    const forbidden = new Set(["body", "query", "params", "cookies"]);
    visit(node.body, (access) => {
      if (name === "authorityOf" && (
        (ts.isElementAccessExpression(access)
          && !(ts.isStringLiteral(access.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(access.argumentExpression)))
        || (ts.isBindingElement(access) && access.propertyName && ts.isComputedPropertyName(access.propertyName)
          && !(ts.isStringLiteral(access.propertyName.expression) || ts.isNoSubstitutionTemplateLiteral(access.propertyName.expression)))
      )) {
        violations.push(`authorityOf: unreviewed computed member access ${access.getText(file)}`);
        return;
      }
      const member = memberName(access);
      if (name === "authorityOf" && member && !AUTHORITY_OF_ALLOWED_MEMBERS.has(member)) {
        const adminKey = member === "x-admin-key" && ts.isElementAccessExpression(access)
          && reviewedAdminHeaderAccess(access.expression, name, file);
        if (!adminKey && !reviewedAdminHeaderAccess(access, name, file)) {
          violations.push(`authorityOf: unreviewed member access ${access.getText(file)}`);
        }
      } else if (name !== "authorityOf" && member && forbidden.has(member)) {
        violations.push(`${name}: forbidden client access ${access.getText(file)}`);
      }
      if (name !== "authorityOf" && member === "headers") {
        const parent = access.parent;
        if (!ts.isElementAccessExpression(parent) || parent.expression !== access
          || !["x-pcc-wallet", "x-admin-key"].includes(memberName(parent) ?? "")) {
          violations.push(`${name}: unreviewed header access ${parent.getText(file)}`);
        }
      }
    });
  });
  return violations;
}

function scan(source: string, filename: string) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.ESNext, true);
  const occurrences: Array<{ kind: string; text: string }> = [];
  const writes: Write[] = [];
  const boundaries: string[] = [];
  const valueLiterals: string[] = [];
  const seenWrites = new Set<ts.Node>();
  function addWrite(node: ts.Node, kind: string, value: string): void {
    if (seenWrites.has(node)) return;
    seenWrites.add(node);
    writes.push({ file: filename, kind, value });
  }
  visit(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.body && node.name
      && BOUNDARY_NAMES.includes(node.name.text)) boundaries.push(node.name.text);
    // Visiting names also sees computed string keys, destructuring keys, type
    // members, and a bare identifier on the left of an assignment. Literal type
    // references (such as Pick<..., "provenWalletVia">) are occurrences too.
    if (!(ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      || node.text !== FIELD) return;
    const parent = node.parent;
    occurrences.push({ kind: ts.SyntaxKind[parent.kind], text: parent.getText(file) });
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      let inType = false;
      for (let ancestor: ts.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) {
        if (ts.isTypeNode(ancestor)) { inType = true; break; }
      }
      if (!inType) valueLiterals.push(parent.getText(file));
    }
    for (let child: ts.Node = node, ancestor = node.parent; ancestor; child = ancestor, ancestor = ancestor.parent) {
      if (ts.isBinaryExpression(ancestor)
        && ancestor.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && ancestor.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && ancestor.left === child) {
        addWrite(ancestor, "assignment", ancestor.right.getText(file));
        break;
      }
      if ((ts.isPrefixUnaryExpression(ancestor) || ts.isPostfixUnaryExpression(ancestor))
        && ancestor.operand === child
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(ancestor.operator)) {
        addWrite(ancestor, "update", ts.tokenToString(ancestor.operator)!);
        break;
      }
      if (ts.isDeleteExpression(ancestor) && ancestor.expression === child) {
        addWrite(ancestor, "delete", "undefined");
        break;
      }
      if (ts.isStatement(ancestor) || ts.isFunctionLike(ancestor)) break;
    }
    if (ts.isPropertyAssignment(parent) && parent.name === node) {
      addWrite(parent, "object-property", parent.initializer.getText(file));
    } else if (ts.isShorthandPropertyAssignment(parent)) {
      addWrite(parent, "shorthand-property", node.getText(file));
    } else if (ts.isComputedPropertyName(parent) && ts.isPropertyAssignment(parent.parent)) {
      addWrite(parent.parent, "object-property", parent.parent.initializer.getText(file));
    } else if (ts.isPropertyDeclaration(parent) && parent.name === node) {
      addWrite(parent, "class-property", parent.initializer?.getText(file) ?? "undefined");
    } else if (ts.isVariableDeclaration(parent) && parent.name === node && parent.initializer) {
      addWrite(parent, "variable", parent.initializer.getText(file));
    } else if ((ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)
      || ts.isMethodDeclaration(parent)) && parent.name === node) {
      addWrite(parent, "member-function", parent.body?.getText(file) ?? "");
    }
  });
  return { occurrences, writes, boundaries, valueLiterals,
    commentFreeSource: COMMENT_FREE_PRINTER.printFile(file), violations: boundaryViolations(file) };
}

const EXPECTED_WRITES: Write[] = [
  {
    file: "auth/kernel-authority.ts",
    kind: "object-property",
    value: 'typeof r.provenWalletVia === "string" ? r.provenWalletVia : null',
  },
  {
    file: "routes/a2a-tasks.ts",
    kind: "object-property",
    value: 'principal.proven ? "siwe-session" : null',
  },
  {
    file: "services/wallet-links/proven-wallet.ts",
    kind: "assignment",
    value: "`self-link:${role}`",
  },
];

describe("buyer provenance source ratchet (W1b r4 F-b)", () => {
  const files = sourceFiles(SRC_ROOT).map((filename) => {
    const relative = path.relative(SRC_ROOT, filename).split(path.sep).join("/");
    const source = readFileSync(filename, "utf8");
    return { file: relative, scanned: scan(source, relative) };
  });

  it("covers every non-test gateway source and every textual provenance occurrence", () => {
    expect(files.length, WRITER_REVIEW_MESSAGE).toBeGreaterThan(100);
    expect(WRITER_FILES.every((writer) => files.some(({ file }) => file === writer)), `WRITER_FILES; ${WRITER_REVIEW_MESSAGE}`).toBe(true);
    expect(files.filter(({ scanned }) => scanned.commentFreeSource.includes(FIELD)).map(({ file }) => file), WRITER_REVIEW_MESSAGE)
      .toEqual(files.filter(({ scanned }) => scanned.occurrences.length > 0).map(({ file }) => file));
  });

  it("pins the exact set of provenance writes, including each value expression", () => {
    const writes = files.flatMap(({ scanned }) => scanned.writes);
    const unreviewed = writes.filter((write) => !EXPECTED_WRITES.some((expected) =>
      expected.file === write.file && expected.kind === write.kind && expected.value === write.value));
    const message = `${WRITER_REVIEW_MESSAGE}; unreviewed writers: ${unreviewed.map((write) =>
      `${write.file} (${write.kind}: ${write.value})`).join(", ") || "none"}`;
    expect(writes, message).toEqual(EXPECTED_WRITES);
  });

  it("rejects provenance string literals outside type nodes", () => {
    expect(files.flatMap(({ file, scanned }) => scanned.valueLiterals.map((literal) => `${file}: ${literal}`)),
      WRITER_REVIEW_MESSAGE).toEqual([]);
  });

  it("resolves the self-link role to its database binding and refuses client input at the boundaries", () => {
    // Fail closed if a rename or another declaration form would stop the
    // boundary scanner from visiting one of the three reviewed functions.
    expect(files.flatMap(({ file, scanned }) => scanned.boundaries.map((name) => ({ file, name }))), `BOUNDARY_NAMES; ${WRITER_REVIEW_MESSAGE}`)
      .toEqual([
        { file: "auth/kernel-authority.ts", name: "authorityOf" },
        { file: "services/wallet-links/proven-wallet.ts", name: "bindProof" },
        { file: "services/wallet-links/proven-wallet.ts", name: "proveSelfLinkedWallet" },
      ]);
    expect(files.flatMap(({ file, scanned }) => scanned.violations.map((violation) => `${file}: ${violation}`)), WRITER_REVIEW_MESSAGE)
      .toEqual([]);
  });

  it.each([
    ['req.provenWalletVia = req.headers["x-pcc-proof-via"]', "assignment"],
    ['req["provenWalletVia"] = "self-link:agent"', "assignment"],
    ["const value = { provenWalletVia }", "shorthand-property"],
  ])("the same scanner flags an unreviewed writer: %s", (source, kind) => {
    const scanned = scan(source, "sentinel.ts");
    expect(scanned.occurrences, WRITER_REVIEW_MESSAGE).toHaveLength(1);
    expect(scanned.writes, WRITER_REVIEW_MESSAGE).toHaveLength(1);
    expect(scanned.writes[0].kind, WRITER_REVIEW_MESSAGE).toBe(kind);
    expect(scanned.writes, WRITER_REVIEW_MESSAGE).not.toEqual(EXPECTED_WRITES);
  });

  it("the same scanner rejects authorityOf reading a client header", () => {
    const scanned = scan('function authorityOf(req) { return req.headers["x-pcc-proof-via"]; }', "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual([
      'authorityOf: unreviewed member access req.headers["x-pcc-proof-via"]',
      "authorityOf: unreviewed member access req.headers",
    ]);
  });

  it("rejects a client header read through a computed destructuring key", () => {
    const scanned = scan(`
      function authorityOf(req) {
        const { ["headers"]: h } = req;
        return h["x-pcc-proof-via"];
      }
    `, "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual([
      'authorityOf: unreviewed member access ["headers"]: h',
      'authorityOf: unreviewed member access h["x-pcc-proof-via"]',
    ]);
  });

  it("recognizes destructuring and type members without treating declarations as provenance writes", () => {
    const scanned = scan(`
      const { provenWalletVia: via } = req;
      interface Authority { provenWalletVia?: string }
      const value: { ["provenWalletVia"]: string } = source;
    `, "sentinel.ts");
    expect(scanned.occurrences.map(({ kind }) => kind), WRITER_REVIEW_MESSAGE)
      .toEqual(["BindingElement", "PropertySignature", "ComputedPropertyName"]);
    expect(scanned.writes, WRITER_REVIEW_MESSAGE).toEqual([]);
    expect(scanned.valueLiterals, WRITER_REVIEW_MESSAGE).toEqual([]);
  });

  it.each([
    'Reflect.set(req, "provenWalletVia", value)',
    'const VIA_KEY = "provenWalletVia"; req[VIA_KEY] = value',
    'const VIA_KEY = `provenWalletVia`; req[VIA_KEY] = value',
  ])("rejects a value-position provenance literal: %s", (source) => {
    expect(scan(source, "sentinel.ts").valueLiterals, WRITER_REVIEW_MESSAGE).toHaveLength(1);
  });

  it("allows provenance literals inside type nodes", () => {
    const scanned = scan('type Buyer = Pick<Authority, "provenWalletVia">;', "sentinel.ts");
    expect(scanned.occurrences, WRITER_REVIEW_MESSAGE).toHaveLength(1);
    expect(scanned.valueLiterals, WRITER_REVIEW_MESSAGE).toEqual([]);
  });

  it("resolves a parenthesized as chain to authorityOf's own first parameter", () => {
    const scanned = scan(`
      function authorityOf(incoming) {
        const r = (((incoming) as unknown) as { provenWalletVia?: string });
        return { provenWalletVia: typeof r.provenWalletVia === "string" ? r.provenWalletVia : null };
      }
    `, "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual([]);
  });

  it.each([
    "let r = req as unknown; return r.provenWalletVia;",
    "const r = req; return r.provenWalletVia;",
    "const alias = req; const r = alias as unknown; return r.provenWalletVia;",
    "const r = other as unknown; return r.provenWalletVia;",
    "const r = Object.assign({}, req) as unknown; return r.provenWalletVia;",
    "{ const r = req as unknown; return r.provenWalletVia; }",
    "function nested(req) { const r = req as unknown; return r.provenWalletVia; }",
  ])("rejects an authorityOf provenance receiver outside the reviewed request cast: %s", (body) => {
    const scanned = scan(`function authorityOf(req, other) { ${body} }`, "sentinel.ts");
    expect(scanned.violations.filter((violation) => violation.startsWith("authorityOf: provenance receiver ")),
      WRITER_REVIEW_MESSAGE).toHaveLength(1);
  });

  it.each(["url", "originalUrl", "hostname", "ip", "ips", "protocol", "host", "id", "socket", "raw"])(
    "rejects authorityOf reading unreviewed member %s", (member) => {
      for (const access of [`req.${member}`, `req["${member}"]`]) {
        const scanned = scan(`function authorityOf(req) { return ${access}; }`, "sentinel.ts");
        expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual([`authorityOf: unreviewed member access ${access}`]);
      }
    });

  it("rejects authorityOf reading an unreviewed member through an alias", () => {
    const scanned = scan(`
      function authorityOf(req) {
        const q = req as unknown as { protocol: string };
        return q.protocol;
      }
    `, "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual(["authorityOf: unreviewed member access q.protocol"]);
  });

  it.each([
    ['const k = "protocol"; return req[k];', "req[k]"],
    ['return req["pro" + "tocol"];', 'req["pro" + "tocol"]'],
    ['return req[`${"protocol"}`];', 'req[`${"protocol"}`]'],
    ['const trim = "protocol"; return req[trim];', "req[trim]"],
    ['const trim = "protocol"; const { [trim]: v } = req; return v;', "[trim]: v"],
  ])("rejects authorityOf reading a non-literal computed member: %s", (body, access) => {
    const scanned = scan(`function authorityOf(req) { ${body} }`, "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual([`authorityOf: unreviewed computed member access ${access}`]);
  });

  it("allows authorityOf's reviewed request cast, text helper, and admin header member shape", () => {
    const scanned = scan(`
      function authorityOf(req) {
        const r = req as unknown as { provenWallet?: unknown; provenWalletVia?: unknown; operatorId?: unknown; userId?: unknown };
        const text = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
        return {
          admin: hasAdminSecret(req.headers["x-admin-key"]),
          provenWallet: text(r.provenWallet),
          provenWalletVia: typeof r.provenWalletVia === "string" ? r.provenWalletVia : null,
          claimed: text(r.operatorId) ?? text(r.userId),
        };
      }
    `, "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual([]);
  });

  it("rejects a body-sourced role even when its local name stays role", () => {
    const scanned = scan(`
      function bindProof(req) {
        const role = req.body.linkRole;
        req.provenWalletVia = \`self-link:\${role}\`;
      }
    `, "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toContain("bindProof role must be a const database lookup in the same function");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toContain("bindProof: forbidden client access req.body");
  });

  it("rejects a role shadowed inside a nested function despite the same lookup text", () => {
    const scanned = scan(`
      import { findSelfLinkedWallet } from "./repository.js";
      function bindProof(req) {
        const role = findSelfLinkedWallet({});
        function nested() {
          const role = findSelfLinkedWallet({});
          req.provenWalletVia = \`self-link:\${role}\`;
        }
      }
    `, "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual(["bindProof role must be a const database lookup in the same function"]);
  });

  it("rejects an unrelated local lookup even when it is named findSelfLinkedWallet", () => {
    const scanned = scan(`
      function bindProof(req) {
        function findSelfLinkedWallet() { return "agent"; }
        const role = findSelfLinkedWallet();
        req.provenWalletVia = \`self-link:\${role}\`;
      }
    `, "sentinel.ts");
    expect(scanned.violations, WRITER_REVIEW_MESSAGE).toEqual(["bindProof role must call the imported findSelfLinkedWallet"]);
  });
});
