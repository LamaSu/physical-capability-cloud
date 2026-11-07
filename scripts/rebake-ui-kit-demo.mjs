import { readFileSync, writeFileSync } from "node:fs";

const kitFile = new URL("../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url);
const demoFile = new URL("../apps/dashboard/public/ui-kit/v1/example-manifests/demo-snapshot.html", import.meta.url);
const kit = readFileSync(kitFile, "utf8").trim();
const page = readFileSync(demoFile, "utf8");
const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)].filter((match) => {
  const index = match.index;
  return !/\b(?:type|src)\s*=/.test(match[1]) && page.lastIndexOf("<!--", index) < page.lastIndexOf("-->", index);
});
if (scripts.length !== 1) throw new Error("Expected exactly one executable inline script");
const script = scripts[0];
const start = script.index + script[0].indexOf(">") + 1;
const end = start + script[2].length;
const leading = script[2].match(/^\s*/)[0];
const trailing = script[2].match(/\s*$/)[0];
writeFileSync(demoFile, page.slice(0, start) + leading + kit + trailing + page.slice(end));
console.log("Re-baked demo-snapshot.html with the current pcc-ui.js; surrounding markup preserved.");
