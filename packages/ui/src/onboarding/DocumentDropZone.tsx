import React from "react";
import { cn } from "../utils.js";

export interface DocumentDropZoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  isAnalyzing?: boolean;
  className?: string;
}

export function DocumentDropZone({
  onFilesSelected,
  accept = ".pdf,.doc,.docx,.txt,.csv,.xlsx,.jpg,.png",
  multiple = true,
  isAnalyzing = false,
  className,
}: DocumentDropZoneProps) {
  const [dragOver, setDragOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFilesSelected(files);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFilesSelected(files);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "relative rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-all",
        dragOver
          ? "border-green-400/40 bg-green-500/[0.06] shadow-[0_0_20px_rgba(124,179,66,0.15)]"
          : "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15] hover:bg-white/[0.04]",
        isAnalyzing && "pointer-events-none opacity-60",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        className="hidden"
      />

      {isAnalyzing ? (
        <div className="space-y-3">
          <div className="w-8 h-8 mx-auto border-2 border-green-400/30 border-t-green-400 rounded-full animate-spin" />
          <p className="text-sm text-green-400/70">AI analyzing documents...</p>
        </div>
      ) : (
        <div className="space-y-3">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="mx-auto text-white/20">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
          <div>
            <p className="text-sm text-white/50">
              Drop files here or <span className="text-green-400/70 underline underline-offset-2">browse</span>
            </p>
            <p className="text-[10px] text-white/20 mt-1">
              PDF, images, spreadsheets, text files
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
