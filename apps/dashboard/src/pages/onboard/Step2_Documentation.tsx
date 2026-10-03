import React from "react";
import { WizardStepContent, DocumentDropZone } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { sha256OfBlob } from "../../lib/file-sha256.js";

// PX-10 Wave 0 (product-steward #2561). This step used to record a random
// string as each document's "sha256", pretend to run an AI analysis on a
// timer, and show the same invented specs for every file. It now records the
// real hash of the bytes (or none), and says the documents are not analyzed.

/** Hashing reads the whole file into memory, so very large files are skipped. */
export const MAX_HASH_BYTES = 64 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Step2_Documentation() {
  const { documents, addDocument, nextStep, prevStep } = useOnboardWizardStore();

  const handleFiles = async (files: File[]) => {
    for (const [index, file] of files.entries()) {
      let hash = "";
      if (file.size <= MAX_HASH_BYTES) {
        try {
          hash = (await sha256OfBlob(file)) ?? "";
        } catch {
          hash = "";
        }
      }
      addDocument({
        id: `doc-${Date.now()}-${index}-${file.name}`,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        hash,
        uploadedAt: new Date().toISOString(),
        analysisStatus: "pending",
      });
    }
  };

  return (
    <WizardStepContent
      title="Documentation"
      subtitle="Add datasheets, manuals, or spec sheets. They stay in this browser and are listed in your hand-off; automatic capability extraction isn't available here yet."
      onBack={prevStep}
      onNext={nextStep}
    >
      <div className="space-y-4 max-w-lg">
        <DocumentDropZone onFilesSelected={(files: File[]) => void handleFiles(files)} isAnalyzing={false} />

        {documents.length > 0 && (
          <div className="space-y-2">
            <span className="text-xs text-white/30">Added documents (not analyzed)</span>
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 space-y-0.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-white/70 truncate">{doc.filename}</span>
                  <span className="text-[10px] text-white/30 shrink-0">{formatSize(doc.sizeBytes)}</span>
                </div>
                <div className="text-[10px] text-white/30 font-mono truncate">
                  {doc.hash ? doc.hash : "No hash computed"}
                </div>
              </div>
            ))}
          </div>
        )}

        {documents.length === 0 && (
          <p className="text-xs text-white/20 text-center">
            No documents added. You can skip this step and describe capabilities yourself.
          </p>
        )}
      </div>
    </WizardStepContent>
  );
}
