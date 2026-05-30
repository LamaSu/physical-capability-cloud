import { openSqliteStore, type Store } from "@pcc/workflow";

let _store: Store | null = null;

export function getWorkflowStore(): Store {
  if (!_store) {
    const path = process.env.WORKFLOW_DB_PATH ?? "./data/workflow.sqlite";
    _store = openSqliteStore({ path });
  }
  return _store;
}

export function closeWorkflowStore(): void {
  _store?.close();
  _store = null;
}
