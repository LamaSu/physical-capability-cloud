/**
 * Thin wrapper around kleur for consistent terminal styling.
 *
 * One file so every CLI module imports `term.xxx` rather than reaching
 * into kleur directly — easier to swap or strip if we ever want a no-color
 * fallback. kleur respects NO_COLOR / FORCE_COLOR out of the box.
 */

import kleur from "kleur";

export const term = {
  bold: (s: string): string => kleur.bold(s),
  dim: (s: string): string => kleur.dim(s),
  green: (s: string): string => kleur.green(s),
  red: (s: string): string => kleur.red(s),
  yellow: (s: string): string => kleur.yellow(s),
  blue: (s: string): string => kleur.blue(s),
  magenta: (s: string): string => kleur.magenta(s),
  cyan: (s: string): string => kleur.cyan(s),
  gray: (s: string): string => kleur.gray(s),
};

/** Print a section header with a green chevron. */
export function header(text: string): void {
  process.stdout.write(`\n${term.green("›")} ${term.bold(text)}\n`);
}

/** Print a labeled key: value line in dim grey. */
export function kv(key: string, value: string): void {
  process.stdout.write(`  ${term.dim(key + ":")} ${value}\n`);
}

/** Print the assistant's response with a chat-style prefix. */
export function assistantSay(text: string): void {
  process.stdout.write(`\n${term.cyan("agent")} ${term.dim("›")} ${text}\n`);
}

/** Print a tool-call trace line in dim grey. */
export function toolTrace(name: string, status: number, durationMs: number): void {
  const color = status >= 200 && status < 300 ? term.green : status >= 400 ? term.red : term.yellow;
  process.stdout.write(
    `  ${term.dim("→")} ${term.gray(name)} ${color(String(status))} ${term.dim(`${durationMs}ms`)}\n`,
  );
}

/** Print the user prompt cursor. */
export function userPrompt(): void {
  process.stdout.write(`\n${term.magenta("you")} ${term.dim("›")} `);
}

/** Print an error and exit. */
export function fatal(message: string, code = 1): never {
  process.stderr.write(`${term.red("error")} ${message}\n`);
  process.exit(code);
}
