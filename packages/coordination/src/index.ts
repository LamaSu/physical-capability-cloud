// @pcc/coordination — PCC autonomous-org coordination backend (vertical slice).
// Public API re-exports. Implementation lives in subdirectories:
//   - ./brain        — external-scheduler-driven supervisor (draft-first, kill switch)
//   - ./snapshot      — read-only tap of gateway facades -> one org-snapshot object
//   - ./events        — org.* message-bus wrapper + AG-UI watch projection
//   - ./reactions     — declarative {match(event) -> action} rule engine
//   - ./queue         — durable human-in-the-loop queue + OrgApprovalItem contract
//   - ./alerts        — console/log alert channel
//   - ./dispatch      — on-approve @pcc/workflow dispatch + broker seam

export * from "./brain/supervisor.js";
export * from "./snapshot/facade-snapshot.js";
export * from "./events/org-bus.js";
export * from "./events/org-watch.js";
export * from "./reactions/rule-engine.js";
export * from "./queue/human-queue.js";
export * from "./queue/org-approval-item.js";
export * from "./alerts/channel.js";
export * from "./dispatch/workflow-dispatch.js";
