/**
 * CsdInvariantEvaluator — evaluates CSD invariant expressions.
 *
 * Invariants are boolean expressions that must always hold.
 * They are checked AFTER selections are made, not as constraint actions.
 *
 * Supported syntax:
 *   Comparison:  ==, !=, <, >, <=, >=
 *   Logic:       and, or, not
 *   Property:    param.field (dot-path access)
 *   String lit:  'value' or "value"
 *   Number lit:  123, 3.14
 *   Boolean lit: true, false
 *   Array:       includes('value') — called on an array property
 *   Grouping:    ( ... )
 *
 * Examples:
 *   "mediaSize != 'custom' or device.capabilities.includes('iso_a3_297x420mm')"
 *   "surfaceFinish != 'mirror' or tolerance == 'high-precision'"
 */

// ── Token types ────────────────────────────────────────────────────

type Token =
  | { type: "identifier"; value: string }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "operator"; value: string }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "dot" }
  | { type: "call"; name: string };

// ── Tokenizer ──────────────────────────────────────────────────────

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }

    // String literal (single or double quotes)
    if (expr[i] === "'" || expr[i] === '"') {
      const quote = expr[i];
      let str = "";
      i++;
      while (i < expr.length && expr[i] !== quote) {
        str += expr[i];
        i++;
      }
      i++; // consume closing quote
      tokens.push({ type: "string", value: str });
      continue;
    }

    // Number literal
    if (/\d/.test(expr[i]) || (expr[i] === "-" && /\d/.test(expr[i + 1] ?? ""))) {
      let num = "";
      if (expr[i] === "-") { num += "-"; i++; }
      while (i < expr.length && /[\d.]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      tokens.push({ type: "number", value: parseFloat(num) });
      continue;
    }

    // Two-char operators
    const two = expr.slice(i, i + 2);
    if (["==", "!=", "<=", ">="].includes(two)) {
      tokens.push({ type: "operator", value: two });
      i += 2;
      continue;
    }

    // Single-char operators
    if (["<", ">"].includes(expr[i])) {
      tokens.push({ type: "operator", value: expr[i] });
      i++;
      continue;
    }

    // Parentheses
    if (expr[i] === "(") { tokens.push({ type: "lparen" }); i++; continue; }
    if (expr[i] === ")") { tokens.push({ type: "rparen" }); i++; continue; }

    // Dot
    if (expr[i] === ".") { tokens.push({ type: "dot" }); i++; continue; }

    // Identifier (includes keywords: and, or, not, true, false, includes)
    if (/[a-zA-Z_]/.test(expr[i])) {
      let id = "";
      while (i < expr.length && /[a-zA-Z0-9_\-]/.test(expr[i])) {
        id += expr[i];
        i++;
      }

      // Check for function call syntax: identifier(
      if (expr[i] === "(") {
        tokens.push({ type: "call", name: id });
        continue; // leave the '(' for the caller to handle inside argument parsing
      }

      if (id === "true") { tokens.push({ type: "boolean", value: true }); continue; }
      if (id === "false") { tokens.push({ type: "boolean", value: false }); continue; }
      tokens.push({ type: "identifier", value: id });
      continue;
    }

    // Unknown character — skip
    i++;
  }

  return tokens;
}

// ── AST types ──────────────────────────────────────────────────────

type AstNode =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "property"; path: string[] }
  | { kind: "binary"; op: string; left: AstNode; right: AstNode }
  | { kind: "unary"; op: "not"; operand: AstNode }
  | { kind: "call"; method: string; target: AstNode; args: AstNode[] };

// ── Parser ─────────────────────────────────────────────────────────

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  parse(): AstNode {
    const node = this.parseOr();
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    return this.tokens[this.pos++];
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();

    while (
      this.peek()?.type === "identifier" &&
      (this.peek() as { type: "identifier"; value: string }).value === "or"
    ) {
      this.consume();
      const right = this.parseAnd();
      left = { kind: "binary", op: "or", left, right };
    }

    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();

    while (
      this.peek()?.type === "identifier" &&
      (this.peek() as { type: "identifier"; value: string }).value === "and"
    ) {
      this.consume();
      const right = this.parseNot();
      left = { kind: "binary", op: "and", left, right };
    }

    return left;
  }

  private parseNot(): AstNode {
    if (
      this.peek()?.type === "identifier" &&
      (this.peek() as { type: "identifier"; value: string }).value === "not"
    ) {
      this.consume();
      const operand = this.parseComparison();
      return { kind: "unary", op: "not", operand };
    }
    return this.parseComparison();
  }

  private parseComparison(): AstNode {
    const left = this.parsePostfix();

    const op = this.peek();
    if (op?.type === "operator") {
      this.consume();
      const right = this.parsePostfix();
      return { kind: "binary", op: op.value, left, right };
    }

    return left;
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary();

    // Handle dot-chained property access and method calls
    while (this.peek()?.type === "dot") {
      this.consume(); // consume '.'

      const next = this.peek();
      if (!next) break;

      if (next.type === "call") {
        // Method call: node.methodName(args)
        const callToken = this.consume() as { type: "call"; name: string };
        const methodName = callToken.name;

        // Consume the '(' that was left
        if (this.peek()?.type === "lparen") {
          this.consume();
        }

        const args: AstNode[] = [];
        // Parse arguments until ')'
        while (this.peek() && this.peek()?.type !== "rparen") {
          args.push(this.parsePrimary());
          // skip comma if present (simple handling)
        }
        if (this.peek()?.type === "rparen") {
          this.consume();
        }

        node = { kind: "call", method: methodName, target: node, args };
      } else if (next.type === "identifier") {
        // Property access: extend the path
        const identifier = this.consume() as { type: "identifier"; value: string };
        if (node.kind === "property") {
          node = { kind: "property", path: [...node.path, identifier.value] };
        } else {
          // Shouldn't happen in practice, but handle gracefully
          node = { kind: "property", path: [identifier.value] };
        }
      } else {
        break;
      }
    }

    return node;
  }

  private parsePrimary(): AstNode {
    const token = this.peek();
    if (!token) {
      return { kind: "literal", value: false };
    }

    if (token.type === "lparen") {
      this.consume();
      const inner = this.parseOr();
      if (this.peek()?.type === "rparen") this.consume();
      return inner;
    }

    if (token.type === "string") {
      this.consume();
      return { kind: "literal", value: token.value };
    }

    if (token.type === "number") {
      this.consume();
      return { kind: "literal", value: token.value };
    }

    if (token.type === "boolean") {
      this.consume();
      return { kind: "literal", value: token.value };
    }

    if (token.type === "identifier") {
      this.consume();
      // Start a property path
      return { kind: "property", path: [token.value] };
    }

    // Fallback
    this.consume();
    return { kind: "literal", value: false };
  }
}

// ── Evaluator ──────────────────────────────────────────────────────

export class CsdInvariantEvaluator {
  /**
   * Evaluate an invariant expression against a context object.
   *
   * The context contains all user selections plus any extra fields
   * (e.g., `device` for device-level capabilities).
   *
   * Returns true if the invariant holds (expression evaluates to truthy).
   */
  evaluate(expression: string, context: Record<string, unknown>): boolean {
    // Empty expression — invariant trivially holds
    if (!expression || expression.trim() === "") return true;

    try {
      const tokens = tokenize(expression);
      if (tokens.length === 0) return true;
      const parser = new Parser(tokens);
      const ast = parser.parse();
      const result = this.evalNode(ast, context);
      return Boolean(result);
    } catch {
      // If we can't parse the expression, conservatively treat it as passing
      // (fail-open for invariants we don't understand)
      return true;
    }
  }

  private evalNode(node: AstNode, context: Record<string, unknown>): unknown {
    switch (node.kind) {
      case "literal":
        return node.value;

      case "property": {
        // Walk the dot path from context
        let obj: unknown = context;
        for (const key of node.path) {
          if (obj === null || obj === undefined) return undefined;
          obj = (obj as Record<string, unknown>)[key];
        }
        return obj;
      }

      case "binary": {
        if (node.op === "and") {
          return Boolean(this.evalNode(node.left, context)) &&
            Boolean(this.evalNode(node.right, context));
        }
        if (node.op === "or") {
          return Boolean(this.evalNode(node.left, context)) ||
            Boolean(this.evalNode(node.right, context));
        }

        const left = this.evalNode(node.left, context);
        const right = this.evalNode(node.right, context);

        switch (node.op) {
          case "==": return left === right;
          case "!=": return left !== right;
          case "<":
            return typeof left === "number" && typeof right === "number" && left < right;
          case ">":
            return typeof left === "number" && typeof right === "number" && left > right;
          case "<=":
            return typeof left === "number" && typeof right === "number" && left <= right;
          case ">=":
            return typeof left === "number" && typeof right === "number" && left >= right;
          default:
            return false;
        }
      }

      case "unary": {
        const operand = this.evalNode(node.operand, context);
        if (node.op === "not") return !Boolean(operand);
        return operand;
      }

      case "call": {
        const target = this.evalNode(node.target, context);
        const args = node.args.map((a) => this.evalNode(a, context));

        if (node.method === "includes") {
          if (Array.isArray(target)) {
            return target.includes(args[0]);
          }
          // String includes
          if (typeof target === "string") {
            return target.includes(String(args[0]));
          }
          return false;
        }

        return false;
      }
    }
  }
}
