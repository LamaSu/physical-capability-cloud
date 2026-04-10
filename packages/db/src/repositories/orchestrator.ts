import { eq, and } from "drizzle-orm";
import {
  transferGraphs,
  transferNodes,
  transferEdges,
  samples,
  sampleMovements,
  instrumentWorkflows,
  instrumentSteps,
  resourceClaims,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IOrchestratorRepository } from "../interfaces/IOrchestratorRepository.js";

export class OrchestratorRepository implements IOrchestratorRepository {
  constructor(private db: StoreDB) {}

  // ── Transfer Graphs ─────────────────────────────────────────────

  findAllGraphs() {
    return this.db.select().from(transferGraphs).all();
  }

  findGraphByKernel(kernelId: string) {
    return this.db.select().from(transferGraphs).where(eq(transferGraphs.kernelId, kernelId)).get();
  }

  findGraphById(id: string) {
    return this.db.select().from(transferGraphs).where(eq(transferGraphs.id, id)).get();
  }

  insertGraph(graph: typeof transferGraphs.$inferInsert) {
    return this.db.insert(transferGraphs).values(graph).returning().get();
  }

  updateGraph(id: string, data: Partial<typeof transferGraphs.$inferInsert>) {
    return this.db.update(transferGraphs).set(data).where(eq(transferGraphs.id, id)).returning().get();
  }

  // ── Nodes ───────────────────────────────────────────────────────

  findNodesByGraph(graphId: string) {
    return this.db.select().from(transferNodes).where(eq(transferNodes.graphId, graphId)).all();
  }

  findNodesByKernel(kernelId: string) {
    return this.db.select().from(transferNodes).where(eq(transferNodes.kernelId, kernelId)).all();
  }

  findNodeById(id: string) {
    return this.db.select().from(transferNodes).where(eq(transferNodes.id, id)).get();
  }

  insertNode(node: typeof transferNodes.$inferInsert) {
    return this.db.insert(transferNodes).values(node).returning().get();
  }

  insertNodes(nodes: (typeof transferNodes.$inferInsert)[]) {
    if (nodes.length === 0) return [];
    return this.db.insert(transferNodes).values(nodes).returning().all();
  }

  // ── Edges ───────────────────────────────────────────────────────

  findEdgesByGraph(graphId: string) {
    return this.db.select().from(transferEdges).where(eq(transferEdges.graphId, graphId)).all();
  }

  insertEdge(edge: typeof transferEdges.$inferInsert) {
    return this.db.insert(transferEdges).values(edge).returning().get();
  }

  insertEdges(edges: (typeof transferEdges.$inferInsert)[]) {
    if (edges.length === 0) return [];
    return this.db.insert(transferEdges).values(edges).returning().all();
  }

  // ── Samples ─────────────────────────────────────────────────────

  findAllSamples() {
    return this.db.select().from(samples).all();
  }

  findSampleById(id: string) {
    return this.db.select().from(samples).where(eq(samples.id, id)).get();
  }

  findSamplesByJob(jobId: string) {
    return this.db.select().from(samples).where(eq(samples.jobId, jobId)).all();
  }

  insertSample(sample: typeof samples.$inferInsert) {
    return this.db.insert(samples).values(sample).returning().get();
  }

  updateSample(id: string, data: Partial<typeof samples.$inferInsert>) {
    return this.db.update(samples).set(data).where(eq(samples.id, id)).returning().get();
  }

  // ── Sample Movements ────────────────────────────────────────────

  findMovementsBySample(sampleId: string) {
    return this.db.select().from(sampleMovements).where(eq(sampleMovements.sampleId, sampleId)).all();
  }

  insertMovement(movement: typeof sampleMovements.$inferInsert) {
    return this.db.insert(sampleMovements).values(movement).returning().get();
  }

  // ── Workflows ───────────────────────────────────────────────────

  findAllWorkflows() {
    return this.db.select().from(instrumentWorkflows).all();
  }

  findWorkflowById(id: string) {
    return this.db.select().from(instrumentWorkflows).where(eq(instrumentWorkflows.id, id)).get();
  }

  findWorkflowsByStatus(status: string) {
    return this.db.select().from(instrumentWorkflows).where(eq(instrumentWorkflows.status, status)).all();
  }

  insertWorkflow(workflow: typeof instrumentWorkflows.$inferInsert) {
    return this.db.insert(instrumentWorkflows).values(workflow).returning().get();
  }

  updateWorkflowStatus(id: string, status: string) {
    return this.db
      .update(instrumentWorkflows)
      .set({ status })
      .where(eq(instrumentWorkflows.id, id))
      .returning()
      .get();
  }

  // ── Instrument Steps ────────────────────────────────────────────

  findStepsByWorkflow(workflowId: string) {
    return this.db.select().from(instrumentSteps).where(eq(instrumentSteps.workflowId, workflowId)).all();
  }

  insertInstrumentStep(step: typeof instrumentSteps.$inferInsert) {
    return this.db.insert(instrumentSteps).values(step).returning().get();
  }

  insertInstrumentSteps(steps: (typeof instrumentSteps.$inferInsert)[]) {
    if (steps.length === 0) return [];
    return this.db.insert(instrumentSteps).values(steps).returning().all();
  }

  // ── Resource Claims ─────────────────────────────────────────────

  findActiveClaims() {
    return this.db.select().from(resourceClaims).where(eq(resourceClaims.released, false)).all();
  }

  findClaimsByNode(nodeId: string) {
    return this.db.select().from(resourceClaims).where(eq(resourceClaims.nodeId, nodeId)).all();
  }

  insertClaim(claim: typeof resourceClaims.$inferInsert) {
    return this.db.insert(resourceClaims).values(claim).returning().get();
  }

  releaseClaim(id: string) {
    return this.db
      .update(resourceClaims)
      .set({ released: true, releasedAt: new Date().toISOString() })
      .where(eq(resourceClaims.id, id))
      .returning()
      .get();
  }
}
