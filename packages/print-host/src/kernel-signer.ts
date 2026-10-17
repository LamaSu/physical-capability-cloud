// The kernel barrel imports server.js, which instantiates adapters and logs at
// import time. Use its existing built signer module so key custody never starts
// a shop runtime or writes anything to the CLI's public JSON output. This private
// workspace import can become a public subpath when the toolkit exposes one.
export { makeKernelEd25519Signer } from "../../kernel/dist/printer-job.js";
