import React from "react";
import { WizardStepContent, DocumentDropZone, DocumentCard } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { mockAISuggestions } from "../../api/mock-onboarding-data.js";

export function Step2_Documentation() {
  const { documents, isAnalyzing, addDocument, setAnalyzing, setAISuggestions, nextStep, prevStep } =
    useOnboardWizardStore();

  const handleFiles = (files: File[]) => {
    for (const file of files) {
      addDocument({
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        hash: `sha256:${Math.random().toString(36).slice(2)}`,
        uploadedAt: new Date().toISOString(),
        analysisStatus: "pending",
      });
    }

    // Simulate AI analysis
    setAnalyzing(true);
    setTimeout(() => {
      setAnalyzing(false);
      setAISuggestions(mockAISuggestions);
    }, 2500);
  };

  return (
    <WizardStepContent
      title="Documentation"
      subtitle="Upload datasheets, manuals, or spec sheets. Our AI will extract capabilities automatically."
      onBack={prevStep}
      onNext={nextStep}
    >
      <div className="space-y-4 max-w-lg">
        <DocumentDropZone onFilesSelected={handleFiles} isAnalyzing={isAnalyzing} />

        {documents.length > 0 && (
          <div className="space-y-2">
            <span className="text-xs text-white/30">Uploaded Documents</span>
            {documents.map((doc) => (
              <DocumentCard
                key={doc.id}
                filename={doc.filename}
                sizeBytes={doc.sizeBytes}
                mimeType={doc.mimeType}
                analysisStatus={isAnalyzing ? "analyzing" : "complete"}
                extractedInsights={
                  !isAnalyzing
                    ? ["Build volume: 250 x 210 x 210mm", "Materials: PLA, PETG, ABS, TPU", "Layer resolution: 0.05-0.3mm"]
                    : undefined
                }
              />
            ))}
          </div>
        )}

        {documents.length === 0 && (
          <p className="text-xs text-white/20 text-center">
            No documents uploaded yet. You can skip this step and configure capabilities manually.
          </p>
        )}
      </div>
    </WizardStepContent>
  );
}
