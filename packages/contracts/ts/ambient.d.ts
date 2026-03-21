// Ambient declarations for optional Story Protocol dependencies.
// story-ip-service.ts is a future integration — these stubs allow tsc to compile.

declare module "uuid" {
  export function v4(): string;
}

declare module "@story-protocol/core-sdk" {
  export class StoryClient {
    static newClient(config: any): StoryClient;
    ipAsset: any;
    license: any;
    royalty: any;
    dispute: any;
  }
  export type StoryConfig = any;
}
