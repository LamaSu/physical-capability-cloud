import type { RecheckDeployment } from "./types.js";

/** All committed records, retained across redeployments; never selected by env. */
export const KNOWN_DEPLOYMENTS: readonly Readonly<RecheckDeployment>[] = Object.freeze([
  Object.freeze({
    "network": "base-sepolia",
    "chainId": 84532,
    "recordSha256": "f0fd711084755608ab6b96e499ff41049e401c342d4777e4d4dda343f3e3bd5c",
    "factory": "0xa31938e1a57e569e1d34f55e7f7a92be1467c6d7",
    "implementation": "0x0a6811ba19c56dcaa95c4337364cb09d7b3ccbec",
    "implementationCodehash": "0xbd51ba2e486cafcca85e4fd374ba5065792c8afc77275f94ed3a163efedcff5e",
    "usdc": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    "recordBlockNumber": 48179681,
    "scheduleId": "vnext-testnet-short-v1",
    "scheduleTestnetOnly": true,
    "challengeWindowSec": 600,
    "appealWindowSec": 1500,
    "backupWindowSec": 600,
    "emergencyReviewWindowSec": 1500,
    "readSurface": "vnext-read-v1"
  }),
]);
