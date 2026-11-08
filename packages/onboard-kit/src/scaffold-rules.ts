/** N303 scaffold literals and identifier rules, shared by validation and generation. */
import type { OnboardConfig } from "./types.js";

export function lit(value: unknown): string {
  return JSON.stringify(String(value));
}

export function commentText(value: unknown): string {
  return String(value).replace(/\*\//g, "* /").replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
}

export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

export function toCamelCase(str: string): string {
  return str.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
}

export function toEnvVar(str: string): string {
  return str.replace(/[-]/g, "_").toUpperCase();
}

const RESERVED_CLASS_NAMES = new Set([
  "Array", "Buffer", "Date", "Error", "EvidenceEmitter", "EvidenceEvent", "EvidenceSource", "JSON", "JobRunner",
  "MachineCommand", "MachineCommandResult", "MachineStatus", "Math", "Number", "Omit", "Promise", "Record",
  "Response", "ReturnType", "String", "TextEncoder", "Uint8Array",
]);
const RESERVED_VARIABLE_NAMES = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "implements", "interface", "let", "package", "private", "protected", "public", "static", "arguments", "eval",
  "EvidenceEmitter", "JobRunner", "capabilities", "console", "evidenceEmitter", "jobRunner", "process",
]);
const WINDOWS_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);
const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const ADAPTER_ID = /^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  // JSON objects can have a non-callable toString property.
  try { return String(value); } catch { return JSON.stringify(value); }
}

function display(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : text(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ADAPTER_ID.test(value) && !/[\r\n\u2028\u2029]/.test(value);
}

export function scaffoldRuleProblems(config: OnboardConfig): Array<{ name: string; message: string }> {
  const input = record(config), kernel = record(input.kernel);
  const adapters = Array.isArray(input.adapters) ? input.adapters.map(record) : [];
  const problems: Array<{ name: string; message: string }> = [];
  const add = (name: string, message: string) => { problems.push({ name, message }); };
  const line = (name: string, value: unknown) => {
    if (typeof value === "string" && /[\r\n\u2028\u2029]/.test(value)) {
      add(name, "contains a line break; the scaffold writes it as one line of .env.example");
    }
  };
  line("kernel.walletPrivateKeyEnvVar", kernel.walletPrivateKeyEnvVar);
  line("kernel.gatewayUrl", kernel.gatewayUrl);
  const reservedEnvNames = new Set(["GATEWAY_URL", "MOCK_MODE"]);
  if (typeof kernel.walletPrivateKeyEnvVar === "string") reservedEnvNames.add(kernel.walletPrivateKeyEnvVar);
  const validIdAdapters = adapters.filter(a => validId(a.adapterId));
  const files = new Map<string, string>(), variables = new Map<string, string>(), envNames = new Map<string, string>();

  for (const adapter of adapters) {
    const id = adapter.adapterId, className = adapter.className;
    const prefix = `adapter[${text(id)}]`;
    if (!validId(id)) {
      add(`${prefix}.adapterId`, `${display(id)} is not an adapter id the scaffold can use (a letter, then letters or digits with single "-" or "_" between them, at most 64 characters); the scaffold makes a variable and environment variables from it`);
    } else {
      const variable = toCamelCase(id), env = toEnvVar(id);
      const otherClass = validIdAdapters.find(a => a.className === variable);
      const envClash = [`${env}_URL`, `${env}_API_KEY`].find(name => reservedEnvNames.has(name));
      if (RESERVED_VARIABLE_NAMES.has(variable)) {
        add(`${prefix}.adapterId`, `${display(id)} makes the variable ${variable}, a name the generated kernel.ts already uses or JavaScript reserves`);
      } else if (otherClass) {
        add(`${prefix}.adapterId`, `${display(id)} makes the variable ${variable}, which is the class name of adapter[${text(otherClass.adapterId)}]`);
      } else if (envClash) {
        add(`${prefix}.adapterId`, `${display(id)} makes the environment variable ${envClash}, which .env.example already defines`);
      } else if (variables.has(variable)) {
        add(`${prefix}.adapterId`, `${display(id)} makes the variable ${variable}, which adapter[${variables.get(variable)}] also makes`);
      } else if (envNames.has(env)) {
        add(`${prefix}.adapterId`, `${display(id)} makes the environment variable ${env}_URL, which adapter[${envNames.get(env)}] also makes`);
      }
      if (!variables.has(variable)) variables.set(variable, id);
      if (!envNames.has(env)) envNames.set(env, id);
    }
    if (typeof className !== "string" || (!CLASS_NAME.test(className) || /[\r\n\u2028\u2029]/.test(className))) {
      add(`${prefix}.className`, `${display(className)} is not a PascalCase identifier (A-Z, then at most 63 letters or digits); the scaffold declares a class and names a file with it`);
    } else {
      const file = toKebabCase(className);
      if (RESERVED_CLASS_NAMES.has(className)) {
        add(`${prefix}.className`, `${display(className)} is a name the generated code already uses; choose another class name`);
      } else if (files.has(file)) {
        add(`${prefix}.className`, `${display(className)} makes the file src/adapters/${file}.ts, which adapter[${files.get(file)}] also makes`);
      } else if (WINDOWS_DEVICE_NAMES.has(file)) {
        add(`${prefix}.className`, `${display(className)} makes the file src/adapters/${file}.ts, a reserved device name on Windows`);
      }
      if (!files.has(file)) files.set(file, text(id));
    }
    line(`${prefix}.connectionString`, adapter.connectionString);
    const poll = adapter.pollIntervalMs;
    if (poll !== undefined && poll !== null && (typeof poll !== "number" || !Number.isFinite(poll))) {
      add(`${prefix}.pollIntervalMs`, `${display(poll)} is not a finite number; the scaffold writes it into the adapter's code`);
    }
  }
  return problems;
}
