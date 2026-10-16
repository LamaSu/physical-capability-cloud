import { useEffect, useRef, useState } from "react";
import type { JobExecutionDTO } from "@pcc/spec";
import { JobFlowCard } from "../components/JobFlowCard.js";
import { parseJobExecutionSnapshot } from "../lib/job-flow-snapshot.js";

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error());
    reader.onerror = () => reject(new Error());
    reader.readAsText(file);
  });
}

export function JobFlowPage() {
  const [dto, setDto] = useState<JobExecutionDTO | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const selection = useRef(0);
  useEffect(() => () => { selection.current += 1; }, []);

  async function load(file: File | undefined) {
    const current = ++selection.current;
    setDto(null);
    setMessage(null);
    if (!file) return;
    try {
      const snapshot = parseJobExecutionSnapshot(await readFile(file));
      if (current === selection.current) setDto(snapshot);
    } catch (error) {
      if (current === selection.current) {
        setMessage(error instanceof Error && error.message.startsWith("Unsupported snapshot schema")
          ? "Unsupported snapshot schema. Expected pcc.job-execution/v1."
          : "Snapshot could not be read. Pick a complete job execution JSON file.");
      }
    }
  }

  return (
    <div className="space-y-4 max-w-4xl mx-auto p-4">
      <h1 className="text-xl text-white/80">Job flow snapshot</h1>
      <label className="block text-sm text-white/60">
        Choose a job execution JSON file
        <input type="file" accept=".json,application/json" className="block mt-2" onChange={(event) => void load(event.target.files?.[0])} />
      </label>
      {message && <p role="alert" className="text-sm text-white/60">{message}</p>}
      {dto && <>
        <p className="text-sm text-white/60">Snapshot read at {dto.asOf}</p>
        <JobFlowCard dto={dto} stale={true} />
      </>}
    </div>
  );
}
