// DuplicateOrderProtection — prevents duplicate live orders
// Uses idempotency keys and position tracking

import { v4 as uuidv4 } from "uuid";

interface OrderFingerprint {
  symbol: string;
  direction: string;
  strategy: string;
  timestamp: number;
  price: number;
}

interface PendingOrder {
  idempotencyKey: string;
  fingerprint: OrderFingerprint;
  createdAt: Date;
  status: "pending" | "submitted" | "filled" | "rejected" | "cancelled";
}

class DuplicateOrderProtectionImpl {
  private pendingOrders = new Map<string, PendingOrder>();
  private recentFills = new Map<string, Date>();

  generateIdempotencyKey(): string {
    return uuidv4();
  }

  isDuplicate(fingerprint: OrderFingerprint): { isDuplicate: boolean; reason?: string } {
    const key = this.makeKey(fingerprint);

    // Check pending orders
    for (const [, order] of this.pendingOrders) {
      if (order.status === "pending" || order.status === "submitted") {
        const orderKey = this.makeKey(order.fingerprint);
        if (orderKey === key) {
          return { isDuplicate: true, reason: "Identical order already pending" };
        }
      }
    }

    // Check recent fills (within 60 seconds)
    const lastFill = this.recentFills.get(key);
    if (lastFill && Date.now() - lastFill.getTime() < 60_000) {
      return { isDuplicate: true, reason: "Same order filled within 60 seconds" };
    }

    return { isDuplicate: false };
  }

  registerPending(fingerprint: OrderFingerprint): string {
    const key = this.generateIdempotencyKey();
    this.pendingOrders.set(key, {
      idempotencyKey: key,
      fingerprint,
      createdAt: new Date(),
      status: "pending",
    });
    return key;
  }

  markSubmitted(key: string): void {
    const order = this.pendingOrders.get(key);
    if (order) order.status = "submitted";
  }

  markFilled(key: string): void {
    const order = this.pendingOrders.get(key);
    if (order) {
      order.status = "filled";
      this.recentFills.set(this.makeKey(order.fingerprint), new Date());
    }
  }

  markRejected(key: string): void {
    const order = this.pendingOrders.get(key);
    if (order) order.status = "rejected";
  }

  markCancelled(key: string): void {
    const order = this.pendingOrders.get(key);
    if (order) order.status = "cancelled";
  }

  private makeKey(fp: OrderFingerprint): string {
    return `${fp.symbol}|${fp.direction}|${fp.strategy}|${Math.round(fp.price)}`;
  }

  cleanup(): void {
    const cutoff = Date.now() - 300_000; // 5 minutes
    for (const [key, order] of this.pendingOrders) {
      if (order.createdAt.getTime() < cutoff && order.status !== "pending" && order.status !== "submitted") {
        this.pendingOrders.delete(key);
      }
    }
    for (const [key, date] of this.recentFills) {
      if (date.getTime() < cutoff) {
        this.recentFills.delete(key);
      }
    }
  }
}

export const duplicateOrderProtection = new DuplicateOrderProtectionImpl();
