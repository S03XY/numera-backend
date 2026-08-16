import { privateKeyToAccount } from 'viem/accounts';
import { AppConfigService } from '../config/app-config.service';
import { SiweService } from './siwe.service';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(PK);

function makeConfig(overrides: Partial<{ url: string; chainId: number }> = {}): AppConfigService {
  return {
    app: { url: overrides.url ?? 'http://localhost:3000' },
    auth: {
      chainId: overrides.chainId ?? 10143,
      siweStatement: 'Sign in to test.',
      nonceTtlSeconds: 300,
    },
  } as unknown as AppConfigService;
}

describe('SiweService', () => {
  const svc = new SiweService(makeConfig());

  it('prepares a message that the wallet can sign and verify (positive)', async () => {
    const prepared = svc.prepare(account.address);
    expect(prepared.message).toContain('localhost:3000');
    expect(prepared.nonce).toBeTruthy();

    const signature = await account.signMessage({ message: prepared.message });
    const result = await svc.verify(prepared.message, signature);

    expect(result.ok).toBe(true);
    expect(result.address).toBe(account.address.toLowerCase());
    expect(result.nonce).toBe(prepared.nonce);
  });

  it('rejects a tampered signature (negative)', async () => {
    const prepared = svc.prepare(account.address);
    const signature = await account.signMessage({ message: prepared.message });
    // Corrupt a nibble inside the r component so recovery yields a different signer.
    const flip = signature[10] === 'a' ? 'b' : 'a';
    const tampered = (signature.slice(0, 10) + flip + signature.slice(11)) as `0x${string}`;
    const result = await svc.verify(prepared.message, tampered);
    expect(result.ok).toBe(false);
  });

  it('rejects a message signed for a different domain (negative)', async () => {
    const evilSvc = new SiweService(makeConfig({ url: 'http://evil.example.com' }));
    const prepared = svc.prepare(account.address); // built for localhost
    const signature = await account.signMessage({ message: prepared.message });
    const result = await evilSvc.verify(prepared.message, signature);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/domain/);
  });

  it('rejects a chainId mismatch (negative)', async () => {
    const otherChain = new SiweService(makeConfig({ chainId: 1 }));
    const prepared = svc.prepare(account.address); // chainId 10143
    const signature = await account.signMessage({ message: prepared.message });
    const result = await otherChain.verify(prepared.message, signature);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/chainId/);
  });

  it('rejects a malformed message (negative)', async () => {
    const result = await svc.verify('not a siwe message', '0xdeadbeef');
    expect(result.ok).toBe(false);
  });
});
