/**
 * Device Populator — the explicit, credential-free view of a device row that the
 * registration endpoints answer with (N71, operator item 86).
 *
 * A device row holds `adapterConfig`: the connection config the device registered
 * with (hosts, tokens, API keys). It is read for dispatch and never returned. A
 * registration response used to be the row itself (POST /api/setup/register-device,
 * which on an update returns the PRESERVED stored config to a caller that omitted it)
 * or the row minus adapterConfig (POST /api/devices/register, a rest-spread: a column
 * added later would have become public). Both now answer with this view.
 *
 * The view is an allow-list. Every field is named; a field the row does not have today,
 * or gets tomorrow, is not in the response until someone decides it should be.
 *
 * It is not the seven-field public view of GET /api/devices/:kernelId and
 * GET /api/kernels/:kernelId/devices: a registering client also gets the kernel the
 * device is on, its firmware, timestamps and emitter manifest back.
 */

import type { IRepositories } from "@pcc/store";

/** A row of kernel_devices, as the repository returns it. */
type DeviceRow = NonNullable<ReturnType<IRepositories["kernels"]["findDeviceById"]>>;

export interface DeviceRegistrationDTO {
  id: DeviceRow["id"];
  kernelId: DeviceRow["kernelId"];
  type: DeviceRow["type"];
  model: DeviceRow["model"];
  firmware: DeviceRow["firmware"];
  status: DeviceRow["status"];
  healthStatus: DeviceRow["healthStatus"];
  adapterType: DeviceRow["adapterType"];
  capabilities: DeviceRow["capabilities"];
  contributesToCapabilities: DeviceRow["contributesToCapabilities"];
  lastUpdated: DeviceRow["lastUpdated"];
  lastHealthCheck: DeviceRow["lastHealthCheck"];
  emits: DeviceRow["emits"];
}

/**
 * The registration view of a device row: every column except `adapterConfig`, picked by
 * name. Nullable columns are always present (null when unset) so the shape is stable.
 * No row (an insert that returned nothing) stays no device, as before.
 */
export function populateDeviceRegistrationDTO(
  row: DeviceRow | null | undefined,
): DeviceRegistrationDTO | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    kernelId: row.kernelId,
    type: row.type,
    model: row.model,
    firmware: row.firmware,
    status: row.status,
    healthStatus: row.healthStatus,
    adapterType: row.adapterType ?? null,
    capabilities: row.capabilities ?? null,
    contributesToCapabilities: row.contributesToCapabilities,
    lastUpdated: row.lastUpdated,
    lastHealthCheck: row.lastHealthCheck ?? null,
    emits: row.emits ?? null,
  };
}
