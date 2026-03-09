import React from "react";
import type { ResolvedParamGroup } from "@pcc/spec";
import { ParamField } from "./ParamField.js";

export interface ParamGroupProps {
  group: ResolvedParamGroup;
  selections: Record<string, string | number | boolean | string[]>;
  onChange: (key: string, value: string | number | boolean | string[]) => void;
}

export function ParamGroup({ group, selections, onChange }: ParamGroupProps) {
  const visibleParams = group.params.filter((p) => p.visible);
  if (visibleParams.length === 0) return null;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">{group.name}</h3>
      <div className="space-y-4">
        {visibleParams.map((param) => (
          <ParamField
            key={param.def.key}
            param={param}
            value={selections[param.def.key]}
            onChange={onChange}
          />
        ))}
      </div>
    </div>
  );
}
