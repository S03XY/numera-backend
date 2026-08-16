import { z } from 'zod';

/**
 * Runtime validation for the Unlink registration payload posted by the browser.
 *
 * The SDK's `assertRegistrationPayloadWire` looks like it would do this job, but
 * it does not: its signature is
 * `(payload: RegistrationPayload | RegistrationPayloadWire) => payload is RegistrationPayloadWire`
 * — a *discriminator between two already-typed shapes*, not a guard over unknown
 * input. Feeding it `req.body` would neither typecheck nor validate anything.
 *
 * So the shape is validated here instead, at the trust boundary, before anything
 * is forwarded to Engine under our project's admin key.
 */

/** Decimal-string bigint, as the wire format encodes curve scalars. */
const decimalString = z
  .string()
  .min(1)
  .max(80)
  .regex(/^\d+$/, 'must be a decimal-string bigint');

/** Lowercase hex with no `0x` prefix. */
const bareHex = (bytes: number) =>
  z
    .string()
    .length(bytes * 2)
    .regex(/^[0-9a-f]+$/, 'must be lowercase hex without a 0x prefix');

export const registrationPayloadWireSchema = z
  .object({
    /** The user's canonical bech32m Unlink address. */
    address: z.string().min(8).max(200),
    /** Baby Jubjub point, each coordinate a decimal-string bigint. */
    spendingPublicKey: z.tuple([decimalString, decimalString]),
    /**
     * The viewing key is genuinely private-but-shared: Engine needs it to decrypt
     * the user's notes on their behalf. It grants *read* visibility only — it
     * cannot authorise a spend, which requires the spending key that never leaves
     * the client.
     */
    viewingPrivateKey: bareHex(32),
    nullifyingKey: decimalString,
  })
  // Reject unknown keys rather than forwarding them: this body is relayed to a
  // vendor under our admin credential, so it should carry nothing we did not read.
  .strict();

export type RegistrationPayloadWireInput = z.infer<typeof registrationPayloadWireSchema>;

/** Parse-or-throw, returning a typed payload. Throws `ZodError` on bad input. */
export function parseRegistrationPayload(input: unknown): RegistrationPayloadWireInput {
  return registrationPayloadWireSchema.parse(input);
}
