import { useEffect, useState, type ReactElement } from "react";
import { getRole, setRole, type Role } from "./storage/secure-api-key.js";

export interface RoleSwitchProps {
  /** Optional override of the persisted role (mostly for tests / Storybook). */
  initialRole?: Role;
  /** Fired when the role changes. The persisted value is updated first. */
  onChange?: (role: Role) => void;
  /** Visual variant. "compact" hides the helper text. */
  variant?: "compact" | "full";
}

/**
 * Toggle between user and operator roles.
 *
 * - Initial value comes from secure-api-key.getRole() (defaults to "user")
 * - On change we await setRole() so the secure store is updated BEFORE
 *   onChange fires. The shell can rely on storage being consistent when
 *   the callback runs.
 * - The component is stateful but the source of truth is the storage —
 *   App.tsx subscribes to storage changes via the onChange callback.
 */
export function RoleSwitch({
  initialRole,
  onChange,
  variant = "full",
}: RoleSwitchProps): ReactElement {
  const [role, setLocalRole] = useState<Role | null>(initialRole ?? null);

  useEffect(() => {
    if (initialRole) return;
    let cancelled = false;
    void getRole().then((r) => {
      if (!cancelled) setLocalRole(r);
    });
    return () => {
      cancelled = true;
    };
  }, [initialRole]);

  const change = async (next: Role) => {
    setLocalRole(next);
    await setRole(next);
    onChange?.(next);
  };

  // Render an explicit loading placeholder until the persisted role resolves
  // so we never render "user" when the user actually had "operator" set.
  if (role === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          display: "inline-flex",
          padding: "6px 12px",
          fontSize: 13,
          opacity: 0.6,
        }}
      >
        Loading role…
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      data-testid="role-switch"
    >
      <div
        role="radiogroup"
        aria-label="Mobile role"
        style={{
          display: "inline-flex",
          padding: 4,
          borderRadius: 12,
          backgroundColor: "rgba(16, 185, 129, 0.08)",
          border: "1px solid rgba(16, 185, 129, 0.2)",
        }}
      >
        {(["user", "operator"] as const).map((value) => {
          const isActive = role === value;
          return (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={isActive}
              onClick={() => void change(value)}
              data-active={isActive ? "true" : "false"}
              style={{
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                backgroundColor: isActive ? "#10B981" : "transparent",
                color: isActive ? "#0A1A0F" : "#E5F4EA",
                textTransform: "capitalize",
                transition: "background-color 120ms ease",
              }}
            >
              {value}
            </button>
          );
        })}
      </div>
      {variant === "full" && (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: "#A8C5B7",
            lineHeight: 1.4,
          }}
        >
          {role === "operator"
            ? "Operator mode — receive inbound jobs, capture evidence."
            : "User mode — request capabilities, approve agent actions."}
        </p>
      )}
    </div>
  );
}
