import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Binds an app login to its Unlink (shielded) address.
 *
 * This is the authorization root for `POST /unlink/authorization-token`: that
 * token grants read access to an address's balances and transaction history, so
 * we have to be able to prove the requesting session owns the address.
 *
 * See the `User.unlinkAddress` comment in `schema.prisma` for why this linkage
 * does not deanonymize trades.
 */
@Injectable()
export class UnlinkIdentityService {
  private readonly log = new Logger(UnlinkIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record `unlinkAddress` as belonging to `userId`.
   *
   * Idempotent for the same pair, because registration is idempotent on Engine's
   * side and clients are expected to retry it freely (e.g. on every sign-in).
   *
   * Rebinding a *different* address to an existing user is rejected. Unlink
   * identity is derived deterministically from the user's key, so a change means
   * either a different passkey or a changed `appId`/`chainId` — in both cases
   * silently repointing would strand every execution account under the old
   * address, including unclaimed winnings.
   */
  async bind(userId: string, unlinkAddress: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { unlinkAddress: true },
    });

    if (user?.unlinkAddress && user.unlinkAddress !== unlinkAddress) {
      this.log.error(`User ${userId} attempted to rebind to a different Unlink address.`);
      throw new ConflictException(
        'This account is already bound to a different Unlink address. ' +
          'That usually means a different passkey was used, or the app configuration changed.',
      );
    }

    if (user?.unlinkAddress === unlinkAddress) return;

    try {
      await this.prisma.user.update({ where: { id: userId }, data: { unlinkAddress } });
    } catch (err) {
      // P2002 on the unique index: this address is already bound to someone else.
      // Two distinct logins deriving one Unlink address should be impossible, so
      // surface it loudly rather than letting the second user read the first's data.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.log.error(`Unlink address already bound to another user (requested by ${userId}).`);
        throw new ConflictException('That Unlink address is already bound to another account.');
      }
      throw err;
    }
  }

  /** Whether `userId` owns `unlinkAddress`. Never throws — a miss is just `false`. */
  async owns(userId: string, unlinkAddress: string): Promise<boolean> {
    // Guard the empty case explicitly. Without it, an unbound user (null) compared
    // against a null/empty argument compares equal and authorizes the request. The
    // controller's DTO rejects such values today, but this is the authorization
    // primitive itself — it must not depend on a caller validating first.
    if (!unlinkAddress) return false;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { unlinkAddress: true },
    });
    return Boolean(user?.unlinkAddress) && user?.unlinkAddress === unlinkAddress;
  }
}
