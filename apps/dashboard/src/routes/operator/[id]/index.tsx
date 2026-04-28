/**
 * File-system style route alias used by the migration plan.
 * Actual implementation lives in `../OperatorA2APage.tsx` so the dashboard's
 * existing `useParams()`-based router (react-router-dom v7) can pick it up
 * without needing a folder-router migration.
 */
export { OperatorA2APage } from "../OperatorA2APage.js";
export { OperatorA2APage as default } from "../OperatorA2APage.js";
