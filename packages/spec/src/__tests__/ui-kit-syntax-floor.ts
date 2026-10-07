import ts from "typescript";
import { isIdentifier, memberName } from "./ui-kit-text-sinks-lint.js";

export interface SyntaxFloorIssue {
  file: string;
  line: number;
  column: number;
  rule: string;
}

const NEWER_APIS = new Set(["fromEntries", "flatMap", "padEnd", "padStart", "includes"]);

function isImmediateInvocation(node: ts.Node): boolean {
  let expression = node;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

/** Only code that executes under initClaimDetector's catch is an exception.
 * An IIFE in the try runs under that catch; a deferred nested helper does not. */
function insideGuardedDetectorInit(node: ts.Node): boolean {
  let guarded = false;
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause) guarded = true;
    if (ts.isFunctionLike(parent)) {
      if (ts.isFunctionDeclaration(parent) && parent.name?.text === "initClaimDetector") return guarded;
      if (!ts.isFunctionExpression(parent) || !isImmediateInvocation(parent)) return false;
    }
  }
  return false;
}

function calledMethod(node: ts.Expression): string | undefined {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  const name = memberName(node);
  if ((name === "call" || name === "apply" || name === "bind") && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return calledMethod(node.expression);
  return name;
}

function hasCodePointEscape(text: string): boolean {
  const escapes = /\\+u\{/g;
  let match: RegExpExecArray | null;
  while ((match = escapes.exec(text))) if ((match[0].length - 2) % 2 === 1) return true;
  return false;
}

/** TypeScript's parser accepts new syntax even with ScriptTarget.ES5. This
 * explicit node gate supplies the syntax proof instead of trusting that flag. */
export function lintUiKitSyntaxFloor(source: string, filename = "pcc-ui.js"): SyntaxFloorIssue[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const issues: SyntaxFloorIssue[] = [];
  const report = (node: ts.Node, rule: string) => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    issues.push({ file: filename, line: line + 1, column: character + 1, rule });
  };
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics;
  for (const diagnostic of parseDiagnostics) {
    const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    issues.push({ file: filename, line: line + 1, column: character + 1, rule: "parse error: " + ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
  }
  const detectorInits: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "initClaimDetector") detectorInits.push(node);
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped)) report(node, "ES2015 lexical declaration");
    if (ts.isArrowFunction(node)) report(node, "ES2015 arrow function");
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) report(node, "ES2015 template literal");
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node) || (ts.isParameter(node) && node.dotDotDotToken)) report(node, "ES2015 spread or rest");
    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left)))) report(node, "ES2015 destructuring");
    if (ts.isForOfStatement(node)) report(node, "ES2015 for-of");
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) report(node, "ES2015 class");
    if (ts.isParameter(node) && node.initializer) report(node, "ES2015 default parameter");
    if (ts.isCatchClause(node) && !node.variableDeclaration) report(node, "ES2019 optional catch binding");
    if ((ts.isStringLiteral(node) || ts.isIdentifier(node)) && hasCodePointEscape(node.getText(file))) report(node, "ES2015 Unicode code point escape");
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.parameters.hasTrailingComma) report(node, "ES2017 trailing parameter comma");
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.hasTrailingComma) report(node, "ES2017 trailing argument comma");
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken) report(node, "ES2020 optional chain");
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) report(node, "ES2020 nullish operator");
      if (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken || node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken) report(node, "ES2016 exponentiation");
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken || node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken) report(node, "ES2021 logical assignment");
    }
    if (ts.isComputedPropertyName(node)) report(node, "ES2015 computed property name");
    if (ts.isShorthandPropertyAssignment(node)) report(node, "ES2015 shorthand property");
    if (ts.isMethodDeclaration(node)) report(node, "ES2015 method syntax");
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.asteriskToken) report(node, "ES2015 generator");
    if (ts.isYieldExpression(node)) report(node, "ES2015 yield");
    if (ts.isAwaitExpression(node) || node.kind === ts.SyntaxKind.AsyncKeyword) report(node, "ES2017 async syntax");
    if (ts.isMetaProperty(node)) report(node, "ES2015 meta property");
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node) || node.kind === ts.SyntaxKind.ExportKeyword || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) report(node, "ES2015 module syntax");
    if (ts.isBigIntLiteral(node)) report(node, "ES2020 bigint literal");
    if (ts.isNumericLiteral(node) && /^0[bBoO]/.test(node.getText(file))) report(node, "ES2015 binary or octal literal");
    if (ts.isNumericLiteral(node) && node.getText(file).includes("_")) report(node, "ES2021 numeric separator");
    if (ts.isRegularExpressionLiteral(node)) {
      const text = node.getText(file);
      const delimiter = text.lastIndexOf("/");
      const pattern = text.slice(1, delimiter);
      const flags = text.slice(delimiter + 1);
      if (/[^gim]/.test(flags) || pattern.includes("(?<") || pattern.includes("\\p{") || pattern.includes("\\P{") || pattern.includes("\\u{")) report(node, "post-ES5 regular expression literal");
    }
    if (ts.isCallExpression(node) && NEWER_APIS.has(calledMethod(node.expression) ?? "") && !insideGuardedDetectorInit(node)) report(node, "post-ES2015 API outside guarded detector init: " + calledMethod(node.expression));
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && isIdentifier(node.expression, "RegExp") && !insideGuardedDetectorInit(node)) report(node, "RegExp construction outside guarded detector init");
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (detectorInits.length > 1) report(detectorInits[1], "detector init must have at most one definition");
  return issues;
}
