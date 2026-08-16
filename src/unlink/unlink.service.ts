import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createUnlinkAdmin, type UnlinkAdmin } from '@unlink-xyz/sdk/admin';
import { ZodError } from 'zod';
import { AppConfigService } from '../config/app-config.service';
import { parseRegistrationPayload, type RegistrationPayloadWireInput } from './registration-payload';

/**
 * Server-side Unlink control plane.
 *
 * Holds the **admin API key**, which carries project-scoped authority and must
 * never reach a browser bundle. Browsers get short-lived authorization tokens
 * minted here instead.
 *
 * Deliberately built on `createUnlinkAdmin` rather than the SDK's
 * `createUnlinkAuthRoutes` helper: that helper returns handlers over web-standard
 * `Request`/`Response`, which in Nest/Express would need a conversion layer on
 * both sides and would bypass DTO validation, Swagger and our exception filters.
 * `admin.users.register` / `admin.authorizationTokens.issue` are the same calls
 * the helper makes.
 *
 * When Unlink is disabled the service constructs cleanly and every call raises
 * 503 — so the rest of the API boots and serves markets with no credentials.
 */
@Injectable()
export class UnlinkService {
  private readonly log = new Logger(UnlinkService.name);
  private admin: UnlinkAdmin | null = null;

  constructor(private readonly cfg: AppConfigService) {
    const { enabled, apiKey, environment, engineUrl } = this.cfg.unlink;
    if (!enabled) {
      this.log.warn('Unlink is disabled — private trading is unavailable (UNLINK_ENABLED=false).');
      return;
    }
    // `environment` and `engineUrl` are mutually exclusive at the SDK boundary;
    // AppConfigService already collapses them to exactly one.
    this.admin = createUnlinkAdmin({ apiKey, ...(engineUrl ? { engineUrl } : { environment }) });
    this.log.log(`Unlink enabled (${engineUrl ?? environment}).`);
  }

  get isEnabled(): boolean {
    return this.admin !== null;
  }

  /** The environment name browsers should bind their client to. */
  get environmentName(): string | undefined {
    return this.cfg.unlink.environment;
  }

  private require(): UnlinkAdmin {
    if (!this.admin) {
      throw new ServiceUnavailableException(
        'Private trading is not configured on this deployment (Unlink is disabled).',
      );
    }
    return this.admin;
  }

  /**
   * Register a user's Unlink keys with Engine. Idempotent — the same key
   * material re-registers successfully, so a client may safely retry.
   *
   * The payload is validated before it leaves our process: it originates in the
   * browser, and a malformed body should fail here with a 400 rather than as an
   * opaque vendor error.
   */
  async register(payload: unknown): Promise<{ address: string; index: number }> {
    const admin = this.require();
    let wire: RegistrationPayloadWireInput;
    try {
      wire = parseRegistrationPayload(payload);
    } catch (err) {
      throw new BadRequestException(
        `Malformed Unlink registration payload: ${err instanceof ZodError ? err.issues.map((i) => i.path.join('.')).join(', ') : 'invalid shape'}`,
      );
    }
    try {
      return await admin.users.register(wire);
    } catch (err) {
      // Registration is idempotent for the *same* project — verified against the
      // live API: re-registering identical key material returns the same address
      // and index. So ALREADY_EXISTS can only mean the address is held by a
      // different Unlink project, and we will never be able to mint tokens for it.
      //
      // Effectively impossible in practice, because `appId` is folded into the
      // derivation salt and namespaces our addresses. But the raw vendor error
      // ("user already exists: unlink1qq…") reads as "you already signed up",
      // which is the opposite of what happened.
      if ((err as { code?: string })?.code === 'ALREADY_EXISTS') {
        this.log.error('Unlink address is registered to a different project.');
        throw new ConflictException(
          'This shielded identity is registered to a different Unlink project and cannot be used here.',
        );
      }
      throw err;
    }
  }

  /**
   * Mint a short-lived authorization token for one Unlink address.
   *
   * Callers **must** have already established that the requesting session owns
   * this address — the token grants read access to that address's balances and
   * transaction history.
   */
  async issueAuthorizationToken(unlinkAddress: string) {
    const admin = this.require();
    return admin.authorizationTokens.issue({
      unlinkAddress,
      expiresInSeconds: this.cfg.unlink.tokenTtlSeconds,
    });
  }

  /** Engine environment info (chain id, pool + permit2 addresses, EA config). */
  async environment() {
    return this.require().environment();
  }
}
