export type Mode = "vulnerable" | "patched";
export type Reply = { status: number; body: Record<string, unknown> };

const catalog = { sword: 30 } as const;

export const createStore = (mode: Mode) => {
  const balances = new Map([
    ["alice", 100],
    ["bob", 100],
  ]);
  const owners = new Map([["alice-shield", "alice"]]);

  return {
    snapshot(userId: string) {
      return {
        balance: balances.get(userId) ?? 0,
        inventoryCount: [...owners.values()].filter((owner) => owner === userId).length,
      };
    },
    ownerOf(itemId: string) {
      return owners.get(itemId);
    },
    purchase(userId: string, input: { itemId: keyof typeof catalog; price: number }): Reply {
      const serverPrice = catalog[input.itemId];
      if (mode === "patched" && input.price !== serverPrice) {
        return { status: 400, body: { error: "price mismatch" } };
      }

      const charged = mode === "vulnerable" ? input.price : serverPrice;
      balances.set(userId, (balances.get(userId) ?? 0) - charged);
      owners.set(`${userId}-${input.itemId}`, userId);
      return { status: 200, body: { ok: true } };
    },
    transfer(actorId: string, input: { itemId: string; toUserId: string }): Reply {
      if (mode === "patched" && owners.get(input.itemId) !== actorId) {
        return { status: 403, body: { error: "not owner" } };
      }

      owners.set(input.itemId, input.toUserId);
      return { status: 200, body: { ok: true } };
    },
  };
};
