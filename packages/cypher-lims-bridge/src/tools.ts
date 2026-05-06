/**
 * @pcc/cypher-lims-bridge — MCP-style tool handlers
 *
 * Six handlers wrapping the most useful Cypher LIMS + federation operations
 * for an operator agent. Each handler is a function `(client, args) => result`
 * AND has a `definition` property describing the tool's name, input schema,
 * and endpoint mapping (for cross-listing in the PCC agent package).
 *
 * The handlers are factored to take `client` as a parameter (rather than
 * closing over a singleton) so that the same definitions can be reused with
 * different keys / base URLs in multi-tenant scenarios.
 */

import type { CypherClient } from './client.js';
import type {
  CypherApiResponse,
  CypherFederationService,
  CypherLimsMeasurementBatch,
  CypherLimsMeasurementDataPoint,
  CypherLimsRequest,
  CypherLimsStep,
  JsonSchemaDraft07,
  McpToolDefinition,
} from './types.js';

// ---------------------------------------------------------------------------
// Tool handler type
// ---------------------------------------------------------------------------

export interface CypherToolHandler<Args, Result> {
  (client: CypherClient, args: Args): Promise<Result>;
  definition: McpToolDefinition;
}

// ---------------------------------------------------------------------------
// 1. cypher_browse_federation_catalog
// ---------------------------------------------------------------------------

const browseFederationSchema: JsonSchemaDraft07 = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

interface BrowseFederationResult {
  services: CypherFederationService[];
}

export const cypherBrowseFederationCatalog: CypherToolHandler<
  Record<string, never>,
  BrowseFederationResult
> = Object.assign(
  async (client: CypherClient): Promise<BrowseFederationResult> => {
    const res = await client.browseFederationCatalogPublic();
    return { services: res.data };
  },
  {
    definition: {
      name: 'cypher_browse_federation_catalog',
      description:
        'Browse the public Cypher Bio federation catalog. Returns the list of providers (e.g. WayBio, Flock Bio) with their pricing, turnaround, and order form schemas. No auth required.',
      input_schema: browseFederationSchema,
      endpoint: { method: 'GET', path: '/api/federation/services/public' },
      source: 'cypher',
    } as McpToolDefinition,
  },
);

// ---------------------------------------------------------------------------
// 2. cypher_list_lims_requests
// ---------------------------------------------------------------------------

const listLimsRequestsSchema: JsonSchemaDraft07 = {
  type: 'object',
  properties: {
    limit: { type: 'number', minimum: 1, maximum: 200, default: 50 },
    offset: { type: 'number', minimum: 0, default: 0 },
    workType: {
      type: 'string',
      description: 'Filter by Cypher workType (e.g. "plasmid_prep", "library_prep"). Optional.',
    },
  },
  additionalProperties: false,
};

interface ListLimsRequestsArgs {
  limit?: number;
  offset?: number;
  workType?: string;
}

export const cypherListLimsRequests: CypherToolHandler<
  ListLimsRequestsArgs,
  CypherApiResponse<CypherLimsRequest[]>
> = Object.assign(
  async (client: CypherClient, args: ListLimsRequestsArgs) => {
    return client.listLimsRequests(args ?? {});
  },
  {
    definition: {
      name: 'cypher_list_lims_requests',
      description:
        'List Cypher LIMS requests visible to this LIMS-scoped key. Supports limit/offset pagination and a workType filter. Use to discover work items the operator can fulfil.',
      input_schema: listLimsRequestsSchema,
      endpoint: { method: 'GET', path: '/api/lims/requests' },
      source: 'cypher',
    } as McpToolDefinition,
  },
);

// ---------------------------------------------------------------------------
// 3. cypher_get_lims_request
// ---------------------------------------------------------------------------

const getLimsRequestSchema: JsonSchemaDraft07 = {
  type: 'object',
  required: ['requestNumber'],
  properties: {
    requestNumber: {
      type: 'string',
      description: 'Human-readable LIMS request identifier (e.g. "REQ-20260506-0001").',
    },
  },
  additionalProperties: false,
};

interface GetLimsRequestArgs {
  requestNumber: string;
}

export const cypherGetLimsRequest: CypherToolHandler<
  GetLimsRequestArgs,
  CypherApiResponse<CypherLimsRequest>
> = Object.assign(
  async (client: CypherClient, args: GetLimsRequestArgs) => {
    return client.getLimsRequest(args.requestNumber);
  },
  {
    definition: {
      name: 'cypher_get_lims_request',
      description:
        'Fetch a single LIMS request by its requestNumber. Returns full request body including workType, status, and any attached files.',
      input_schema: getLimsRequestSchema,
      endpoint: { method: 'GET', path: '/api/lims/requests/:requestNumber' },
      source: 'cypher',
    } as McpToolDefinition,
  },
);

// ---------------------------------------------------------------------------
// 4. cypher_advance_step
// ---------------------------------------------------------------------------

const advanceStepSchema: JsonSchemaDraft07 = {
  type: 'object',
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      description: 'Step name (e.g. "init", "prep", "measure", "complete").',
    },
    requestId: { type: 'string', description: 'Parent LIMS request _id.' },
    workflowId: { type: 'string', description: 'Workflow _id this step belongs to.' },
    workflowLineageId: { type: 'string', description: 'Lineage ID for cross-version tracking.' },
    data: {
      type: 'object',
      additionalProperties: true,
      description: 'Free-form step data. Cypher accepts arbitrary fields here.',
    },
  },
  additionalProperties: true,
};

interface AdvanceStepArgs {
  name: string;
  requestId?: string;
  workflowId?: string;
  workflowLineageId?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export const cypherAdvanceStep: CypherToolHandler<
  AdvanceStepArgs,
  CypherApiResponse<CypherLimsStep>
> = Object.assign(
  async (client: CypherClient, args: AdvanceStepArgs) => {
    return client.advanceStep(args);
  },
  {
    definition: {
      name: 'cypher_advance_step',
      description:
        'Advance a Cypher LIMS workflow step. POSTs to /api/lims/steps. Cypher accepts arbitrary additional fields beyond name/requestId/workflowId; pass them through `data` or as top-level args.',
      input_schema: advanceStepSchema,
      endpoint: { method: 'POST', path: '/api/lims/steps' },
      source: 'cypher',
    } as McpToolDefinition,
  },
);

// ---------------------------------------------------------------------------
// 5. cypher_post_measurement
// ---------------------------------------------------------------------------

const postMeasurementSchema: JsonSchemaDraft07 = {
  type: 'object',
  properties: {
    stepId: { type: 'string', description: 'Anchor measurement to a step.' },
    sampleId: { type: 'string', description: 'Anchor measurement to a sample.' },
    uploadBatchId: { type: 'string', description: 'Anchor measurement to an upload batch.' },
    fileId: { type: 'string', description: 'Pre-uploaded file _id from /api/files/upload.' },
    csvData: { type: 'string', description: 'Inline CSV content. Routes to /from-csv.' },
    dataPoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sampleId: { type: 'string' },
          containerId: { type: 'string' },
          stepId: { type: 'string' },
          value: {},
          unit: { type: 'string' },
          metric: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      description: 'Inline structured measurement points. Routes to /preview.',
    },
  },
  additionalProperties: true,
};

interface PostMeasurementArgs {
  stepId?: string;
  sampleId?: string;
  uploadBatchId?: string;
  fileId?: string;
  csvData?: string;
  dataPoints?: CypherLimsMeasurementDataPoint[];
}

interface PostMeasurementResult {
  ok: boolean;
  status: number;
  /** Which Cypher endpoint we routed to. */
  routedTo: 'preview' | 'from-csv';
  data: unknown;
}

export const cypherPostMeasurement: CypherToolHandler<
  PostMeasurementArgs,
  PostMeasurementResult
> = Object.assign(
  async (
    client: CypherClient,
    args: PostMeasurementArgs,
  ): Promise<PostMeasurementResult> => {
    const body: CypherLimsMeasurementBatch = { ...args };
    if (args.dataPoints && args.dataPoints.length > 0) {
      const res = await client.postMeasurementBatchPreview(body);
      return { ok: res.ok, status: res.status, routedTo: 'preview', data: res.data };
    }
    if (args.csvData || args.fileId) {
      const res = await client.postMeasurementsFromCsv(body);
      return { ok: res.ok, status: res.status, routedTo: 'from-csv', data: res.data };
    }
    throw new Error(
      'cypher_post_measurement: must supply at least one of dataPoints, csvData, or fileId',
    );
  },
  {
    definition: {
      name: 'cypher_post_measurement',
      description:
        'Post a measurement batch to Cypher LIMS. Routes to /api/lims/measurements/batches/preview when `dataPoints` is supplied, or /api/lims/measurements/batches/from-csv when `csvData` or `fileId` is supplied. At least one of the three is required.',
      input_schema: postMeasurementSchema,
      endpoint: { method: 'POST', path: '/api/lims/measurements/batches/preview' },
      source: 'cypher',
    } as McpToolDefinition,
  },
);

// ---------------------------------------------------------------------------
// 6. cypher_record_work
// ---------------------------------------------------------------------------

const recordWorkSchema: JsonSchemaDraft07 = {
  type: 'object',
  required: ['stepId', 'payload'],
  properties: {
    stepId: { type: 'string', description: 'Step _id this work record refers to.' },
    payload: {
      type: 'object',
      additionalProperties: true,
      description: 'Free-form work record (notes, durations, materials consumed, etc.).',
    },
    operatorId: {
      type: 'string',
      description:
        'Optional operator identifier — defaults to CYPHER_OPERATOR_ID env if the calling layer wires it.',
    },
  },
  additionalProperties: false,
};

interface RecordWorkArgs {
  stepId: string;
  payload: Record<string, unknown>;
  operatorId?: string;
}

export const cypherRecordWork: CypherToolHandler<
  RecordWorkArgs,
  CypherApiResponse<unknown>
> = Object.assign(
  async (client: CypherClient, args: RecordWorkArgs) => {
    return client.recordWork(args);
  },
  {
    definition: {
      name: 'cypher_record_work',
      description:
        'Record operator work against a Cypher LIMS step. POSTs to /api/lims/record-work with stepId + payload. Use to log operator clock-in/out, materials consumed, or step completion notes.',
      input_schema: recordWorkSchema,
      endpoint: { method: 'POST', path: '/api/lims/record-work' },
      source: 'cypher',
    } as McpToolDefinition,
  },
);

// ---------------------------------------------------------------------------
// All tool definitions, exported as an array for easy agent-package builds.
// ---------------------------------------------------------------------------

export const cypherToolDefinitions: McpToolDefinition[] = [
  cypherBrowseFederationCatalog.definition,
  cypherListLimsRequests.definition,
  cypherGetLimsRequest.definition,
  cypherAdvanceStep.definition,
  cypherPostMeasurement.definition,
  cypherRecordWork.definition,
];

export const cypherToolHandlers = {
  cypher_browse_federation_catalog: cypherBrowseFederationCatalog,
  cypher_list_lims_requests: cypherListLimsRequests,
  cypher_get_lims_request: cypherGetLimsRequest,
  cypher_advance_step: cypherAdvanceStep,
  cypher_post_measurement: cypherPostMeasurement,
  cypher_record_work: cypherRecordWork,
} as const;
