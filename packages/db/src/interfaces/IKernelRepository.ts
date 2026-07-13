import type { shopKernels, kernelDevices } from "../schema/index.js";

export type KernelRow = typeof shopKernels.$inferSelect;
export type KernelInsert = typeof shopKernels.$inferInsert;
export type DeviceRow = typeof kernelDevices.$inferSelect;
export type DeviceInsert = typeof kernelDevices.$inferInsert;

export interface IKernelRepository {
  findAll(): KernelRow[];
  findById(id: string): KernelRow | undefined;
  /** Batch lookup — one query per ≤500 ids (true N+1 prevention). Empty input → []. */
  findByIds(ids: string[]): KernelRow[];
  findByStatus(status: string): KernelRow[];
  insert(kernel: KernelInsert): KernelRow | undefined;
  update(id: string, data: Partial<KernelInsert>): KernelRow | undefined;
  /** Atomically bind an unregistered SET-ONCE signing identity. */
  bindSignerIfUnregistered(id: string, data: Partial<KernelInsert>): KernelRow | undefined;
  // Devices sub-domain
  findDevicesByKernel(kernelId: string): DeviceRow[];
  findDeviceById(id: string): DeviceRow | undefined;
  insertDevice(device: DeviceInsert): DeviceRow | undefined;
  updateDevice(id: string, data: Partial<DeviceInsert>): DeviceRow | undefined;
  findDevicesByAdapter(adapterType: string): DeviceRow[];
  updateHealth(deviceId: string, healthStatus: string, lastHealthCheck: number): DeviceRow | undefined;
  findHealthyDevices(kernelId: string): DeviceRow[];
}
