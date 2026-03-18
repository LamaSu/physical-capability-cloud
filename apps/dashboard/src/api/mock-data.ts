/**
 * Mock data — EMPTY.
 *
 * All exports return empty arrays/objects. Pages that still import from this
 * file will render empty states instead of fake data. As pages are migrated
 * to use the TanStack Query hooks in api/hooks/use-pcc-data.ts, they will
 * stop importing from here entirely.
 *
 * The gateway API at /api/* is the source of truth for real data.
 */

export const mockKernels: any[] = [];
export const mockJobs: any[] = [];
export const mockEscrows: any[] = [];
export const allCapabilities: any[] = [];
export const mockDevices: any[] = [];
export const jobMeta: Record<string, any> = {};
