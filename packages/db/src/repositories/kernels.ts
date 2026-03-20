import { eq, and } from "drizzle-orm";
import { shopKernels, kernelDevices } from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class KernelRepository {
  constructor(private db: StoreDB) {}

  findAll() {
    return this.db.select().from(shopKernels).all();
  }

  findById(id: string) {
    return this.db.select().from(shopKernels).where(eq(shopKernels.id, id)).get();
  }

  findByStatus(status: string) {
    return this.db.select().from(shopKernels).where(eq(shopKernels.status, status)).all();
  }

  insert(kernel: typeof shopKernels.$inferInsert) {
    return this.db.insert(shopKernels).values(kernel).returning().get();
  }

  update(id: string, data: Partial<typeof shopKernels.$inferInsert>) {
    return this.db.update(shopKernels).set(data).where(eq(shopKernels.id, id)).returning().get();
  }

  // ── Devices ─────────────────────────────────────────────────────

  findDevicesByKernel(kernelId: string) {
    return this.db.select().from(kernelDevices).where(eq(kernelDevices.kernelId, kernelId)).all();
  }

  findDeviceById(id: string) {
    return this.db.select().from(kernelDevices).where(eq(kernelDevices.id, id)).get();
  }

  insertDevice(device: typeof kernelDevices.$inferInsert) {
    return this.db.insert(kernelDevices).values(device).returning().get();
  }

  updateDevice(id: string, data: Partial<typeof kernelDevices.$inferInsert>) {
    return this.db.update(kernelDevices).set(data).where(eq(kernelDevices.id, id)).returning().get();
  }

  /** Find all devices that use a specific adapter type */
  findDevicesByAdapter(adapterType: string) {
    return this.db
      .select()
      .from(kernelDevices)
      .where(eq(kernelDevices.adapterType, adapterType))
      .all();
  }

  /** Update the health status and last health check timestamp for a device */
  updateHealth(deviceId: string, healthStatus: string, lastHealthCheck: number) {
    return this.db
      .update(kernelDevices)
      .set({ healthStatus, lastHealthCheck })
      .where(eq(kernelDevices.id, deviceId))
      .returning()
      .get();
  }

  /** Find all devices with "healthy" health status for a given kernel */
  findHealthyDevices(kernelId: string) {
    return this.db
      .select()
      .from(kernelDevices)
      .where(and(eq(kernelDevices.kernelId, kernelId), eq(kernelDevices.healthStatus, "healthy")))
      .all();
  }
}
