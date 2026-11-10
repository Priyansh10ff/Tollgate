import {
  ReceiptError,
  verifyReceipt,
  normalizeBaseUrl,
  WELL_KNOWN_PATH,
  type HubKeys,
  type ReceiptClaims,
} from "@tollgate/protocol";

/** Remembers which receipts were already used. Swap in Redis or similar when running several servers. */
export interface ReplayStore {
  /** Marks the receipt as used. Returns false if it was used before. */
  consume(receiptId: string, expiresAt: number): boolean | Promise<boolean>;
}

/** In-memory replay store that forgets receipts once they expire. */
export class MemoryReplayStore implements ReplayStore {
  private used = new Map<string, number>();
  private lastSweep = 0;

  consume(receiptId: string, expiresAt: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastSweep > 60) {
      for (const [id, exp] of this.used) if (exp + 60 < now) this.used.delete(id);
      this.lastSweep = now;
    }
    if (this.used.has(receiptId)) return false;
    this.used.set(receiptId, expiresAt);
    return true;
  }
}

export interface VerifierOptions {
  hubUrl: string;
  /** Default seller id to check receipts against. Can be overridden per call. */
  sellerId?: string;
  replayStore?: ReplayStore;
  fetch?: typeof fetch;
  /** How long to cache the hub's public keys, in ms. */
  keyCacheMs?: number;
}

/**
 * Verifies receipts offline using the hub's published public keys.
 * The only network call is fetching those keys (cached), never one per request.
 */
export class ReceiptVerifier {
  private keys = new Map<string, JsonWebKey>();
  private fetchedAt = 0;
  private pending?: Promise<void>;
  private replay: ReplayStore;
  readonly hubUrl: string;

  constructor(private options: VerifierOptions) {
    this.hubUrl = options.hubUrl.replace(/\/+$/, "");
    this.replay = options.replayStore ?? new MemoryReplayStore();
  }

  async verify(token: string, expected: { resource: string; minAmount: number; sellerId?: string }): Promise<ReceiptClaims> {
    const seller = expected.sellerId ?? this.options.sellerId;
    if (!seller) throw new Error("ReceiptVerifier: no seller id to verify against");
    await this.ensureKeys(false);
    const check = () =>
      verifyReceipt(token, {
        keys: this.keys,
        issuer: this.hubUrl,
        seller,
        resource: expected.resource,
        minAmount: expected.minAmount,
      });

    let claims: ReceiptClaims;
    try {
      claims = check();
    } catch (err) {
      // The hub may have rotated its key: refresh once and retry.
      if (err instanceof ReceiptError && err.code === "unknown_key") {
        await this.ensureKeys(true);
        claims = check();
      } else throw err;
    }

    if (!(await this.replay.consume(claims.jti, claims.exp))) {
      throw new ReceiptError("replayed", "This receipt was already used");
    }
    return claims;
  }

  private async ensureKeys(force: boolean): Promise<void> {
    const fresh = Date.now() - this.fetchedAt < (this.options.keyCacheMs ?? 10 * 60_000);
    if (!force && fresh && this.keys.size > 0) return;
    this.pending ??= (async () => {
      try {
        const res = await (this.options.fetch ?? fetch)(`${this.hubUrl}${WELL_KNOWN_PATH}`);
        if (!res.ok) throw new Error(`Hub returned HTTP ${res.status}`);
        const data = (await res.json()) as HubKeys;
        if (normalizeBaseUrl(data.hub) !== normalizeBaseUrl(this.hubUrl)) {
          throw new Error(`Hub at ${this.hubUrl} identifies as ${data.hub}`);
        }
        this.keys = new Map(data.keys.map((k) => [k.kid, k.jwk]));
        this.fetchedAt = Date.now();
      } finally {
        this.pending = undefined;
      }
    })();
    await this.pending;
  }
}
