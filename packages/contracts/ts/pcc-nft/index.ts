/**
 * PCC Native NFT — barrel exports.
 *
 * Custom Solana program client for soulbound capability certificates.
 * Zero protocol fees. Full PCC control.
 */

export { PCCNFTClient } from "./pcc-nft-client.js";

export type {
  PCCAsset,
  PCCCollection,
  MintParams,
  UpdateParams,
  BurnParams,
  CreateCollectionParams,
  PCCNFTClientConfig,
} from "./types.js";
