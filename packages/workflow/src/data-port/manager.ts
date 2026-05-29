/**
 * DataManager — locality-aware transfer routing + durable provenance.
 *
 * See design §5.6 and §4.5.
 *
 * v0.1 semantics:
 *   - registerPath() inserts a data_locations row.
 *   - getSourceLocation() returns the preferred-kernel match, or the cheapest
 *     by scheme (p2p > ipfs > storacha > http > onchain > fs).
 *   - transferData() INSERTs a destination row with source_location_id set,
 *     then (in v0.1) immediately marks it available — physical transfer logic
 *     is the caller's responsibility. A future DataConnector dispatch plugs
 *     in here.
 *   - invalidateLocation() flips data_type to 'invalid'.
 */

import type { DataLocation } from '../shared/types.js';
import { TransferFailedError } from '../shared/types.js';
import type { DataLocationStore, Store } from '../store/types.js';
import type { DataScheme, DataType, TokenTag } from './types.js';

const SCHEME_PRIORITY: Record<DataScheme, number> = {
  p2p: 1,
  fs: 2,
  ipfs: 3,
  storacha: 4,
  http: 5,
  onchain: 6,
};

export interface DataManager {
  getDataLocations(portId: string): Promise<DataLocation[]>;
  registerPath(args: {
    portId: string;
    kernelId: string;
    scheme: DataScheme;
    path: string;
    dataType: DataType;
    sizeBytes?: number;
    checksum?: string;
    runId?: string;
    tokenTag?: TokenTag;
    service?: string;
    available?: boolean;
  }): Promise<DataLocation>;
  transferData(
    src: DataLocation,
    dst: Pick<DataLocation, 'kernelId' | 'scheme' | 'path'> & { portId?: string; service?: string },
  ): Promise<DataLocation>;
  getSourceLocation(portId: string, preferredKernel?: string): Promise<DataLocation | null>;
  invalidateLocation(locationId: string): Promise<void>;
  registerRelation(srcLocationId: string, dstLocationId: string): Promise<void>;
}

class DataManagerImpl implements DataManager {
  constructor(private readonly locations: DataLocationStore) {}

  async getDataLocations(portId: string): Promise<DataLocation[]> {
    return this.locations.getByPort(portId);
  }

  async registerPath(args: Parameters<DataManager['registerPath']>[0]): Promise<DataLocation> {
    return this.locations.register({
      portId: args.portId,
      kernelId: args.kernelId,
      scheme: args.scheme,
      path: args.path,
      dataType: args.dataType,
      available: args.available ?? true,
      ...(args.sizeBytes !== undefined ? { sizeBytes: args.sizeBytes } : {}),
      ...(args.checksum !== undefined ? { checksum: args.checksum } : {}),
      ...(args.runId !== undefined ? { runId: args.runId } : {}),
      ...(args.tokenTag !== undefined ? { tokenTag: args.tokenTag } : {}),
      ...(args.service !== undefined ? { service: args.service } : {}),
    });
  }

  async transferData(
    src: DataLocation,
    dst: Pick<DataLocation, 'kernelId' | 'scheme' | 'path'> & { portId?: string; service?: string },
  ): Promise<DataLocation> {
    if (src.dataType === 'invalid') {
      throw new TransferFailedError(`Cannot transfer from invalid source ${src.locationId}`);
    }
    const portId = dst.portId ?? src.portId ?? '(unknown-port)';
    const created = await this.locations.register({
      portId,
      kernelId: dst.kernelId,
      scheme: dst.scheme,
      path: dst.path,
      dataType: 'primary',
      available: false,
      sourceLocationId: src.locationId,
      ...(src.sizeBytes !== undefined ? { sizeBytes: src.sizeBytes } : {}),
      ...(src.checksum !== undefined ? { checksum: src.checksum } : {}),
      ...(src.tokenTag !== undefined ? { tokenTag: src.tokenTag } : {}),
      ...(dst.service !== undefined ? { service: dst.service } : {}),
      ...(src.runId !== undefined ? { runId: src.runId } : {}),
    });
    // v0.1: caller performs the physical transfer externally, then we mark
    // available. Without an explicit connector the operation is considered
    // complete.
    await this.locations.markAvailable(created.locationId);
    const final = await this.locations.get(created.locationId);
    return final ?? created;
  }

  async getSourceLocation(portId: string, preferredKernel?: string): Promise<DataLocation | null> {
    const rows = await this.locations.getByPort(portId);
    const available = rows.filter((r) => r.available && r.dataType === 'primary');
    if (available.length === 0) return null;
    if (preferredKernel) {
      const exact = available.find((r) => r.kernelId === preferredKernel);
      if (exact) return exact;
    }
    available.sort((a, b) => SCHEME_PRIORITY[a.scheme] - SCHEME_PRIORITY[b.scheme]);
    return available[0]!;
  }

  async invalidateLocation(locationId: string): Promise<void> {
    await this.locations.invalidate(locationId);
  }

  async registerRelation(srcLocationId: string, dstLocationId: string): Promise<void> {
    await this.locations.addLineage(srcLocationId, dstLocationId);
  }
}

export function createDataManager(opts: { store: Store }): DataManager {
  return new DataManagerImpl(opts.store.dataLocations);
}
