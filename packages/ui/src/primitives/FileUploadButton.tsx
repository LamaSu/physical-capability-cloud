import React from "react";
import { cn } from "../utils.js";

export interface FileUploadButtonProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  label?: string;
  className?: string;
}

export function FileUploadButton({
  onFilesSelected,
  accept,
  multiple = false,
  label = "Upload File",
  className,
}: FileUploadButtonProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFilesSelected(files);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} onChange={handleChange} className="hidden" />
      <button
        onClick={() => inputRef.current?.click()}
        className={cn(
          "px-4 py-2 rounded-lg text-sm font-medium",
          "bg-white/[0.04] border border-white/[0.08] text-white/50",
          "hover:bg-white/[0.08] hover:text-white/70 transition-all",
          className,
        )}
      >
        {label}
      </button>
    </>
  );
}
