/**
 * MADSci lab discovery.
 *
 * Given a Workcell Manager base URL, lists all registered nodes and
 * surfaces them as a flat capability list a PCC kernel can announce.
 */

import { MadsciClient, type MadsciClientOptions } from "./client.js";
import { madsciNodeToPccDevice, type PccDeviceRegistration } from "./translator.js";

export interface DiscoveryResult {
  kernelId: string;
  nodeCount: number;
  devices: PccDeviceRegistration[];
  capabilityTypes: string[];
}

/**
 * Discover MADSci nodes and emit PCC-ready device registrations.
 * Pure transformation — no side effects on the gateway. Caller decides
 * whether to POST the resulting devices to PCC.
 */
export async function discoverMadsciLab(
  clientOpts: MadsciClientOptions,
  pccKernelId: string,
): Promise<DiscoveryResult> {
  const client = new MadsciClient(clientOpts);
  const nodes = await client.listNodes();
  const devices = nodes.map((n) => madsciNodeToPccDevice(n, pccKernelId));
  const capabilityTypes = Array.from(
    new Set(devices.flatMap((d) => d.capabilities)),
  );
  return {
    kernelId: pccKernelId,
    nodeCount: nodes.length,
    devices,
    capabilityTypes,
  };
}
