import React from "react";
import { useNavigate } from "react-router-dom";
import { KernelCard } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { mockKernels } from "../api/mock-data.js";

export function KernelsPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const navigate = useNavigate();
  React.useEffect(() => { setPageMeta("Kernels", "Shop kernel status and capability overview"); }, [setPageMeta]);

  return (
    <div className="grid grid-cols-3 gap-4">
      {mockKernels.map((kernel) => (
        <KernelCard
          key={kernel.id}
          kernel={kernel}
          onClick={() => navigate(`/kernels/${kernel.id}`)}
        />
      ))}
    </div>
  );
}
