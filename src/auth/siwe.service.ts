import { Injectable, Logger } from '@nestjs/common';
import { recoverMessageAddress } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { AppConfigService } from '../config/app-config.service';

export interface PreparedSiwe {
  message: string;
  nonce: string;
  expiresAt: Date;
}

export interface SiweVerification {
  ok: boolean;
  address?: string; // recovered + message address (lowercase), only when ok
  nonce?: string;
  reason?: string;
}

/**
 * Builds and verifies EIP-4361 (Sign-In With Ethereum) messages using viem's
 * native SIWE utilities. Verification is fully offline (ECDSA recover) so login
 * never depends on an RPC round-trip — this is the auth hot path.
 *
 * Security model: the signature proves control of the address embedded in the
 * message; a single-use, address-bound nonce (checked by AuthService against
 * Redis) prevents replay. Domain + chainId are pinned to our config.
 */
@Injectable()
export class SiweService {
  private readonly logger = new Logger(SiweService.name);

  constructor(private readonly cfg: AppConfigService) {}

  private get domain(): string {
    return new URL(this.cfg.app.url).host;
  }

  /** Build a fresh SIWE message + nonce for `address` to sign. */
  prepare(address: `0x${string}`): PreparedSiwe {
    const nonce = generateSiweNonce();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.cfg.auth.nonceTtlSeconds * 1000);
    const message = createSiweMessage({
      address,
      chainId: this.cfg.auth.chainId,
      domain: this.domain,
      uri: this.cfg.app.url,
      nonce,
      statement: this.cfg.auth.siweStatement,
      version: '1',
      issuedAt,
      expirationTime: expiresAt,
    });
    return { message, nonce, expiresAt };
  }

  /**
   * Verify a signed SIWE message. Checks the signature recovers to the message
   * address and that domain/chainId match our config. The nonce is returned to
   * the caller (AuthService) to check single-use against Redis — kept out of
   * here so this service stays pure/stateless and unit-testable.
   */
  async verify(message: string, signature: `0x${string}`): Promise<SiweVerification> {
    let fields: ReturnType<typeof parseSiweMessage>;
    try {
      fields = parseSiweMessage(message);
    } catch {
      return { ok: false, reason: 'malformed SIWE message' };
    }

    if (!fields.address) return { ok: false, reason: 'missing address' };
    if (!fields.nonce) return { ok: false, reason: 'missing nonce' };
    if (fields.domain !== this.domain) return { ok: false, reason: 'domain mismatch' };
    if (fields.chainId !== this.cfg.auth.chainId) {
      return { ok: false, reason: 'chainId mismatch' };
    }
    if (fields.expirationTime && fields.expirationTime.getTime() < Date.now()) {
      return { ok: false, reason: 'message expired' };
    }

    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message, signature });
    } catch {
      return { ok: false, reason: 'invalid signature' };
    }

    if (recovered.toLowerCase() !== fields.address.toLowerCase()) {
      return { ok: false, reason: 'signature does not match address' };
    }

    return { ok: true, address: fields.address.toLowerCase(), nonce: fields.nonce };
  }
}
