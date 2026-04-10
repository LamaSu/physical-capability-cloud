import type {
  transferGraphs,
  transferNodes,
  transferEdges,
  samples,
  sampleMovements,
  instrumentWorkflows,
  instrumentSteps,
  resourceClaims,
} from "../schema/index.js";

export type GraphRow = typeof transferGraphs.$inferSelect;
export type GraphInsert = typeof transferGraphs.$inferInsert;
export type NodeRow = typeof transferNodes.$inferSelect;
export type NodeInsert = typeof transferNodes.$inferInsert;
export type EdgeRow = typeof transferEdges.$inferSelect;
export type EdgeInsert = typeof transferEdges.$inferInsert;
export type SampleRow = typeof samples.$inferSelect;
export type SampleInsert = typeof samples.$inferInsert;
export type SampleMovementRow = typeof sampleMovements.$inferSelect;
export type SampleMovementInsert = typeof sampleMovements.$inferInsert;
export type InstrumentWorkflowRow = typeof instrumentWorkflows.$inferSelect;
export type InstrumentWorkflowInsert = typeof instrumentWorkflows.$inferInsert;
export type InstrumentStepRow = typeof instrumentSteps.$inferSelect;
export type InstrumentStepInsert = typeof instrumentSteps.$inferInsert;
export type ResourceClaimRow = typeof resourceClaims.$inferSelect;
export type ResourceClaimInsert = typeof resourceClaims.$inferInsert;

export interface IOrchestratorRepository {
  // Transfer Graphs
  findAllGraphs(): GraphRow[];
  findGraphByKernel(kernelId: string): GraphRow | undefined;
  findGraphById(id: string): GraphRow | undefined;
  insertGraph(graph: GraphInsert): GraphRow | undefined;
  updateGraph(id: string, data: Partial<GraphInsert>): GraphRow | undefined;
  // Nodes
  findNodesByGraph(graphId: string): NodeRow[];
  findNodesByKernel(kernelId: string): NodeRow[];
  findNodeById(id: string): NodeRow | undefined;
  insertNode(node: NodeInsert): NodeRow | undefined;
  insertNodes(nodes: NodeInsert[]): NodeRow[];
  // Edges
  findEdgesByGraph(graphId: string): EdgeRow[];
  insertEdge(edge: EdgeInsert): EdgeRow | undefined;
  insertEdges(edges: EdgeInsert[]): EdgeRow[];
  // Samples
  findAllSamples(): SampleRow[];
  findSampleById(id: string): SampleRow | undefined;
  findSamplesByJob(jobId: string): SampleRow[];
  insertSample(sample: SampleInsert): SampleRow | undefined;
  updateSample(id: string, data: Partial<SampleInsert>): SampleRow | undefined;
  // Sample Movements
  findMovementsBySample(sampleId: string): SampleMovementRow[];
  insertMovement(movement: SampleMovementInsert): SampleMovementRow | undefined;
  // Workflows
  findAllWorkflows(): InstrumentWorkflowRow[];
  findWorkflowById(id: string): InstrumentWorkflowRow | undefined;
  findWorkflowsByStatus(status: string): InstrumentWorkflowRow[];
  insertWorkflow(workflow: InstrumentWorkflowInsert): InstrumentWorkflowRow | undefined;
  updateWorkflowStatus(id: string, status: string): InstrumentWorkflowRow | undefined;
  // Instrument Steps
  findStepsByWorkflow(workflowId: string): InstrumentStepRow[];
  insertInstrumentStep(step: InstrumentStepInsert): InstrumentStepRow | undefined;
  insertInstrumentSteps(steps: InstrumentStepInsert[]): InstrumentStepRow[];
  // Resource Claims
  findActiveClaims(): ResourceClaimRow[];
  findClaimsByNode(nodeId: string): ResourceClaimRow[];
  insertClaim(claim: ResourceClaimInsert): ResourceClaimRow | undefined;
  releaseClaim(id: string): ResourceClaimRow | undefined;
}
