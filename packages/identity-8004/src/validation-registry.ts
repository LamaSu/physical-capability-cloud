/**
 * ERC-8004 Validation Registry Client — request and respond to agent validation.
 */

import type { PublicClient, WalletClient } from "viem";
import type { ValidationStatus, ValidationSummary } from "@pcc/spec";
import { validationRegistryAbi } from "./abis.js";
import { getRegistryAddresses } from "./constants.js";

export interface ValidationRegistryConfig {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  registryAddress?: `0x${string}`;
}

export class ValidationRegistryClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly address: `0x${string}`;

  constructor(config: ValidationRegistryConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;

    if (config.registryAddress) {
      this.address = config.registryAddress;
    } else {
      const chainId = config.publicClient.chain?.id;
      if (!chainId) throw new Error("Chain ID required");
      const addrs = getRegistryAddresses(chainId);
      if (!addrs.validationRegistry) throw new Error(`No validation registry on chain ${chainId}`);
      this.address = addrs.validationRegistry;
    }
  }

  /** Request validation from a specific validator. Only callable by agent owner. */
  async requestValidation(
    validatorAddress: `0x${string}`,
    agentId: bigint,
    requestURI: string,
    requestHash: `0x${string}`,
  ): Promise<void> {
    if (!this.walletClient) throw new Error("WalletClient required");

    const hash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account!,
      address: this.address,
      abi: validationRegistryAbi,
      functionName: "validationRequest",
      args: [validatorAddress, agentId, requestURI, requestHash],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Respond to a validation request. Only callable by the designated validator. */
  async respondToValidation(
    requestHash: `0x${string}`,
    response: number,
    responseURI?: string,
    responseHash?: `0x${string}`,
    tag?: string,
  ): Promise<void> {
    if (!this.walletClient) throw new Error("WalletClient required");
    if (response < 0 || response > 100) throw new Error("Response must be 0-100");

    const hash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account!,
      address: this.address,
      abi: validationRegistryAbi,
      functionName: "validationResponse",
      args: [
        requestHash,
        response,
        responseURI ?? "",
        responseHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
        tag ?? "",
      ],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Get the current validation status for a request. */
  async getValidationStatus(requestHash: `0x${string}`): Promise<ValidationStatus> {
    const result = await this.publicClient.readContract({
      address: this.address,
      abi: validationRegistryAbi,
      functionName: "getValidationStatus",
      args: [requestHash],
    }) as [string, bigint, number, string, string, bigint];

    return {
      validatorAddress: result[0] as `0x${string}`,
      agentId: result[1],
      response: result[2],
      responseHash: result[3] as `0x${string}`,
      tag: result[4],
      lastUpdate: result[5],
    };
  }

  /** Get aggregated validation summary for an agent. */
  async getSummary(
    agentId: bigint,
    validatorAddresses: `0x${string}`[],
    tag?: string,
  ): Promise<ValidationSummary> {
    const result = await this.publicClient.readContract({
      address: this.address,
      abi: validationRegistryAbi,
      functionName: "getSummary",
      args: [agentId, validatorAddresses, tag ?? ""],
    }) as [bigint, number];

    return {
      count: result[0],
      averageResponse: result[1],
    };
  }
}
