/** Build-time input shapes, not gateway wire types. No I/O or runtime state. */
interface Phase {
  id: string;
  file: string;
  goal: string;
  doneWhen: string[];
  asksHuman: string[];
  next: string | null;
}

interface Event {
  trigger: string;
  do: string;
  file?: string;
  section?: string | null;
  report?: { phase: string; outcome: string } | null;
}

interface Action {
  tool: string | null;
  method: string;
  route: string;
  auth: string;
  request: string;
  /** Shell lines rendered verbatim as one bash block after the request. */
  recipe?: string[];
  responseFields: string[];
  /** Secret-bearing response fields: kept in a private file, never read into the conversation. */
  storeOnlyFields?: string[];
  response?: string;
  sources: string[];
}

export interface AgentMdSources {
  runbook: {
    title: string;
    status: string;
    target: { rule: string };
    askingRule: string;
    phases: Phase[];
    reporting: { tool: string; rule: string };
  };
  index: { about: string; events: Record<string, Event> };
  buyer: {
    title: string;
    quoteLimit: string;
    steps: Array<{
      id: string;
      goal: string;
      actions: Action[];
      doneWhen: string[];
      asksHuman: string[];
      terminal?: boolean;
    }>;
    events: Record<string, Event>;
    reporting: Action;
  };
  agentPackage: {
    attempt_reporting: { tool: string; endpoint: { method: string; path: string } };
  };
}

const github = "https://github.com/LamaSu/physical-capability-cloud/blob/master/";
const link = (path: string) => `[${path}](${github}${path})`;
const sourceLink = (path: string) => `[${path.split("/").at(-1)}](${github}${path})`;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
/** A <…> run that rendered Markdown would read as an HTML tag (a letter after "<"); "a < b > c" stays prose. */
const placeholders = (text: string) => text.replace(/<(\/?[A-Za-z][^<>\n]*)>/g, "`<$1>`");
/** A method and route; a sentence-final "." stays outside the span. */
const http = (text: string) => text.replace(
  /\b(GET|POST|PUT|PATCH|DELETE)\s+(?:\$PCC_BASE|<gateway>)?\/[^\s`"|,;)]*[^\s`"|,;).]/g,
  (route) => `\`${route}\``,
);
/**
 * Prose outside code spans: wrap routes, then placeholders outside the new route spans. An existing
 * code span passes through whole; an odd number of backticks is an unbalanced span and throws.
 */
const prose = (text: string) => {
  const parts = text.split("`");
  if (parts.length % 2 === 0) throw new Error(`Unbalanced backticks in agent.md source text: ${text}`);
  return parts.map((part, index) => (index % 2 ? part : http(part).split("`")
    .map((piece, inner) => (inner % 2 ? piece : placeholders(piece))).join("`"))).join("`");
};

function renderAction(action: Action): string[] {
  if (action.recipe?.some((line) => line.includes("```"))) throw new Error(`A recipe line for ${action.route} would close its code block`);
  return [
    `${action.tool ? `Tool: \`${action.tool}\`` : "Direct HTTP"} → \`${action.method} ${action.route}\`. Auth: ${prose(action.auth)}.`,
    `Request: ${prose(action.request)}`,
    ...(action.recipe?.length ? ["", "```bash", ...action.recipe, "```", ""] : []),
    `Read response fields: ${action.responseFields.length ? action.responseFields.join(", ") : "none"}.${action.response ? ` ${prose(action.response)}` : ""}`,
    ...(action.storeOnlyFields?.length ? [`Store only, never read into the conversation: ${action.storeOnlyFields.join(", ")}.`] : []),
    `Gateway source: ${[...new Set(action.sources)].map(sourceLink).join(", ")}.`,
    "",
  ];
}

/** Deterministic markdown from committed source data; used by script and drift test. */
export function renderAgentMd({ runbook, index, buyer, agentPackage }: AgentMdSources): string {
  const lines = [
    "# PCC agent golden path",
    "",
    "For a coding agent helping a human buy physical work or put an instrument on PCC. Choose buy or supply, then follow the steps in order. Use the gateway the human supplied as PCC_BASE.",
    "",
    `Generated from ${link("starter/buyer/buyer-path.json")}, ${link("starter/runbook/runbook.json")}, ${link("starter/runbook/index.json")} and ${link("apps/dashboard/public/agent-package.json")}. Do not edit the generated artifact.`,
    "",
    "## Rules before either path",
    "",
    runbook.target.rule,
    "",
    runbook.askingRule,
    "",
    "Never claim success until the relevant doneWhen checks are verified against actual responses or the device. A listing, an HTTP 200, a mock run or a hand-written evidence bundle does not prove physical completion. Report blocked or failed checks honestly.",
    "",
    "Never execute a composition, submit a job, fund escrow or spend through a payment challenge without the human's explicit approval of the plan, price, scope and evidence requirements. The automatic buyer path ends at STOP. Keep API keys, private keys and transcripts out of logs, chat, reports and version control.",
    "",
    "## Buy: plan, read back, hand off",
    "",
    buyer.title,
    "",
    buyer.quoteLimit,
    "",
  ];

  buyer.steps.forEach((step, number) => {
    lines.push(`### ${number + 1}. ${step.terminal ? "STOP — " : ""}${step.id}`, "", step.goal, "");
    if (step.asksHuman.length) {
      lines.push(step.terminal ? "Human handoff; approval is required before any further action:" : "Ask the human only for missing facts:", "", ...step.asksHuman.map((ask) => `- ${ask}`), "");
    } else lines.push("Ask the human only for missing facts: none.", "");
    for (const action of step.actions) lines.push(...renderAction(action));
    lines.push("Done when:", "", ...step.doneWhen.map((check) => `- ${prose(check)}`), "");
  });

  lines.push(
    "## Supply: follow the starter runbook",
    "",
    runbook.title,
    `Source status: ${runbook.status}.`,
    "",
    `Use ${link("starter/AGENTS.md")} and work through these phase files in order. Each file contains the commands and checks. Wait for its required human approval. When a phase's doneWhen says it reports blocked, report it blocked and continue to its next phase; later phases and the final session report still run. Do not skip checks or call a blocked phase successful.`,
    "",
  );
  runbook.phases.forEach((phase, number) => {
    lines.push(
      `### ${number}. ${phase.id} — ${link(`starter/runbook/${phase.file}`)}`,
      "",
      `Goal: ${phase.goal}`,
      "Done when:", "", ...phase.doneWhen.map((check) => `- ${prose(check)}`), "",
      `Ask the human: ${phase.asksHuman.length ? phase.asksHuman.join("; ") : "nothing"}. Next: ${phase.next ?? "stop after the session report"}.`,
      "",
    );
  });

  lines.push("## Named events: recover or report", "", prose(index.about), "",
    "| Event id | Trigger | What to do |", "| --- | --- | --- |");
  for (const [id, event] of Object.entries(buyer.events))
    lines.push(`| ${cell(id)} | ${cell(prose(event.trigger))} | ${cell(prose(event.do))} |`);
  for (const [id, event] of Object.entries(index.events)) {
    const source = event.file ? ` Read ${link(`starter/runbook/${event.file}`)}${event.section ? `, section “${event.section}”` : ""}.` : "";
    const report = event.report ? ` Report ${event.report.phase} ${event.report.outcome}.` : "";
    lines.push(`| ${cell(id)} | ${cell(prose(event.trigger))} | ${cell(prose(event.do))}${cell(source)}${cell(report)} |`);
  }
  lines.push("", "## Report the attempt", "",
    "For buyer friction, a missing binding quote or a failed check, send a redacted report:", "",
    ...renderAction(buyer.reporting),
    `Supply reporting rule: ${runbook.reporting.rule}`, "",
    `Tool: \`${agentPackage.attempt_reporting.tool}\` → \`${agentPackage.attempt_reporting.endpoint.method} ${agentPackage.attempt_reporting.endpoint.path}\`. Follow ${link("starter/bin/pcc-report")} from the starter directory; it wraps that reporting contract and keeps attempt state locally. Report every phase and one final session even when blocked.`,
    "",
    'From the starter directory, run `bin/pcc-report <phase> <outcome> "<redacted summary>"` after each phase, then `bin/pcc-report session <outcome> "<redacted roll-up>"`.',
    "",
    "Include the route, status, named error, expected check and observed result. Never include secrets or a transcript. A feedback receipt acknowledges the report; it does not verify physical success.",
    "",
  );
  return lines.join("\n");
}
