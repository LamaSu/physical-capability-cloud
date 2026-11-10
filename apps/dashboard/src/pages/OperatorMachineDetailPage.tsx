import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { useUIStore } from "../stores/ui-store.js";
import { useAuthStore } from "../stores/auth-store.js";
import { authorizedFetch } from "../lib/authorized-fetch.js";
import { kernelsOf, machineLabel } from "../lib/operator-api.js";

const LOADING = "Loading your machines.";
const UNAVAILABLE = "Your machines can't be read right now.";
const TRY_AGAIN = "Try again";
const WITHHELD = "Your machines aren't shown for this sign-in: PCC needs proof that you own them. Sign in with your wallet (or use a linked wallet) to see them here.";
const NO_MACHINE = "This sign-in has no machine with this ID.";
const MACHINE_ID = "Machine ID";
const RECORDED_STATUS = "Recorded status";
const LAST_CHECK_IN = "Last check-in";
const ONLINE = "Online";
const OFFLINE = "Offline";
const IN_MAINTENANCE = "In maintenance";
const SUSPENDED = "Suspended";
const LISTING_EXPIRED = "Listing expired";
const STATUS_UNKNOWN = "Status unknown";
const NO_CHECK_IN = "No check-in yet";
const NOT_READABLE = "Not readable";
const BACK = "← Back to Operator Dashboard";
const PAGE_TITLE = "Machine Detail";
const PAGE_SUBTITLE = "Machine management";

const RECORDED_STATUSES = new Map([
  ["online", ONLINE],
  ["offline", OFFLINE],
  ["maintenance", IN_MAINTENANCE],
  ["suspended", SUSPENDED],
  ["expired", LISTING_EXPIRED],
]);

export function OperatorMachineDetailPage() {
  const { machineId } = useParams<{ machineId: string }>();
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const keyEpoch = useAuthStore((s) => s.keyEpoch);
  const sessionEpoch = useAuthStore((s) => s.sessionEpoch);
  const address = useAuthStore((s) => s.address);
  const machines = useQuery({
    queryKey: ["operator-machine-detail", keyEpoch, sessionEpoch, address],
    queryFn: async ({ signal }) => {
      const res = await authorizedFetch("/api/agent/me", { cache: "no-store", signal });
      if (!res.ok) throw new Error(UNAVAILABLE);
      const body: unknown = await res.json();
      const kernels = kernelsOf(body);
      if (kernels === "unavailable") throw new Error(UNAVAILABLE);
      if (kernels === "withheld") return kernels;
      // kernelsOf validates these fields on every item, but returns only id/name.
      // Read the records from that same accepted reply after validation succeeds.
      const items = (body as { kernels: { items: { status?: string; last_heartbeat: string | null }[] } }).kernels.items;
      return kernels.map((machine, index) => ({
        ...machine,
        status: items[index].status,
        last_heartbeat: items[index].last_heartbeat,
      }));
    },
    retry: false,
  });
  const machine = !machines.isError && Array.isArray(machines.data)
    ? machines.data.find((item) => item.id === machineId) : undefined;

  React.useEffect(() => {
    setPageMeta(machine ? machineLabel(machine) : PAGE_TITLE, PAGE_SUBTITLE);
  }, [setPageMeta, machine]);

  if (machines.isPending) {
    return <p role="status" className="text-sm text-white/50">{LOADING}</p>;
  }
  if (machines.isError) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-white/50">{UNAVAILABLE}</p>
        <button onClick={() => void machines.refetch()} className="text-xs text-green-400/60">{TRY_AGAIN}</button>
      </div>
    );
  }
  if (machines.data === "withheld") {
    return <p role="alert" className="text-sm text-white/50">{WITHHELD}</p>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <button onClick={() => navigate("/operator")} className="text-xs text-white/30 hover:text-white/50 transition-colors">
        {BACK}
      </button>
      {machine ? (
        <>
          <h2 className="text-xl font-semibold text-white/90">{machineLabel(machine)}</h2>
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-white/40">{MACHINE_ID}</dt>
              <dd className="text-white/70 font-mono">{machine.id}</dd>
            </div>
            <div>
              <dt className="text-white/40">{RECORDED_STATUS}</dt>
              <dd className="text-white/70">{RECORDED_STATUSES.get(machine.status ?? "") ?? STATUS_UNKNOWN}</dd>
            </div>
            <div>
              <dt className="text-white/40">{LAST_CHECK_IN}</dt>
              <dd className="text-white/70">
                {machine.last_heartbeat === null ? NO_CHECK_IN
                  : Number.isFinite(Date.parse(machine.last_heartbeat))
                    ? <time dateTime={machine.last_heartbeat}>{new Date(machine.last_heartbeat).toLocaleString()}</time>
                    : NOT_READABLE}
              </dd>
            </div>
          </dl>
        </>
      ) : <p className="text-sm text-white/50">{NO_MACHINE}</p>}
    </div>
  );
}
