import "reflect-metadata";
import { Balance, TokenId, UInt64 } from "@proto-kit/library";
import { PrivateKey, Provable, PublicKey, UInt64 as O1UInt64 } from "o1js";
import { fromRuntime } from "../../testing-appchain";
import { config, modules } from "../../../src/runtime";
import { TokenIdPath, LBP, errors } from "../../../src/runtime/lbp/lbp";
import { KaupangTestingAppChain, drip } from "../../helpers";
import { PoolKey } from "../../../src/runtime/lbp/pool-key";
import { TokenPair } from "../../../src/runtime/lbp/token-pair";
import { LPTokenId } from "../../../src/runtime/lbp/lp-token-id";
import { MAX_TOKEN_ID } from "../../../src/runtime/token-registry";
import { FeeLBP } from "../../../src/runtime/lbp/pool-lbp";

describe("lbp", () => {
  const alicePrivateKey = PrivateKey.random();
  const alice = alicePrivateKey.toPublicKey();

  const bobPrivateKey = PrivateKey.random();
  const bob = bobPrivateKey.toPublicKey();

  const tokenAId = TokenId.from(0);
  const tokenBId = TokenId.from(1);
  const tokenAInitialLiquidity = Balance.from(1_000_000);
  const tokenBInitialLiquidity = Balance.from(1_000_000);
  const start = UInt64.from(10);
  const end = UInt64.from(1010);
  // 80 %
  const initialWeight = UInt64.from(80_000_000);
  // 20 %
  const finalWeight = UInt64.from(20_000_000);
  const feeLBP = new FeeLBP({ fee0: UInt64.from(2), fee1: UInt64.from(2) });
  const repayTarget = UInt64.from(1000);

  const lpTokenId = LPTokenId.fromTokenPair(TokenPair.from(tokenAId, tokenBId));

  let appChain: ReturnType<typeof fromRuntime<typeof modules>>;
  let lbp: LBP;

  let nonce = 0;

  async function createPoolSigned(
    appChain: KaupangTestingAppChain,
    senderPrivateKey: PrivateKey,
    tokenAId: TokenId,
    tokenBId: TokenId,
    tokenAAmount: Balance,
    tokenBAmount: Balance,
    start: UInt64,
    end: UInt64,
    initialWeight: UInt64,
    finalWeight: UInt64,
    fee: FeeLBP,
    feeCollector: PublicKey,
    repayTarget: UInt64,
    options?: { nonce: number }
  ) {
    const lbp = appChain.runtime.resolve("LBP");
    appChain.setSigner(senderPrivateKey);

    const tx = await appChain.transaction(
      senderPrivateKey.toPublicKey(),
      () => {
        console.log("start", start.toString());
        console.log("end", end.toString());
        lbp.createPoolSigned(tokenAId, tokenBId, tokenAAmount, tokenBAmount, start, end, initialWeight, finalWeight, fee, feeCollector, repayTarget);
      },
      options
    );

    await tx.sign();
    await tx.send();

    return tx;
  }

  // async function sellPathSigned(
  //   appChain: KaupangTestingAppChain,
  //   senderPrivateKey: PrivateKey,
  //   path: TokenIdPath,
  //   amountIn: Balance,
  //   amountOutMinLimit: Balance,
  //   options?: { nonce: number }
  // ) {
  //   const xyk = appChain.runtime.resolve("XYK");
  //   appChain.setSigner(senderPrivateKey);

  //   const tx = await appChain.transaction(
  //     senderPrivateKey.toPublicKey(),
  //     () => {
  //       xyk.sellPathSigned(path, amountIn, amountOutMinLimit);
  //     },
  //     options
  //   );

  //   await tx.sign();
  //   await tx.send();

  //   return tx;
  // }

  async function queryPool(
    appChain: KaupangTestingAppChain,
    tokenAId: TokenId,
    tokenBId: TokenId
  ) {
    const address = PoolKey.fromTokenPair(TokenPair.from(tokenAId, tokenBId));
    return {
      pool: await appChain.query.runtime.LBP.pools.get(address),
      liquidity: {
        tokenA: await appChain.query.runtime.Balances.balances.get({
          address,
          tokenId: tokenAId,
        }),
        tokenB: await appChain.query.runtime.Balances.balances.get({
          address,
          tokenId: tokenBId,
        }),
      },
    };
  }

  async function queryBalance(
    appChain: KaupangTestingAppChain,
    tokenId: TokenId,
    address: PublicKey
  ) {
    return {
      balance: await appChain.query.runtime.Balances.balances.get({
        tokenId,
        address,
      }),
    };
  }

  describe("create pool", () => {
    beforeAll(async () => {
      appChain = fromRuntime(modules);

      appChain.configurePartial({
        Runtime: config,
      });

      await appChain.start();
      appChain.setSigner(alicePrivateKey);

      lbp = appChain.runtime.resolve("LBP");
    });

    it("should create a pool", async () => {
      await drip(appChain, alicePrivateKey, tokenAId, tokenAInitialLiquidity, {
        nonce: nonce++,
      });
      await drip(appChain, alicePrivateKey, tokenBId, tokenBInitialLiquidity, {
        nonce: nonce++,
      });

      await createPoolSigned(
        appChain,
        alicePrivateKey,
        tokenAId,
        tokenBId,
        tokenAInitialLiquidity,
        tokenBInitialLiquidity,
        start,
        end,
        initialWeight,
        finalWeight,
        feeLBP,
        bob,
        repayTarget,
        { nonce: nonce++ }
      );

      await appChain.produceBlock();

      const { pool, liquidity } = await queryPool(appChain, tokenAId, tokenBId);
      const { balance: aliceLpBalance } = await queryBalance(
        appChain,
        lpTokenId,
        alice
      );

      expect(pool).toBeDefined();
      expect(liquidity.tokenA?.toString()).toEqual(
        tokenAInitialLiquidity.toString()
      );
      expect(liquidity.tokenB?.toString()).toEqual(
        tokenBInitialLiquidity.toString()
      );
      expect(aliceLpBalance?.toString()).toEqual(
        tokenAInitialLiquidity.toString()
      );
    });

    it("should not create a pool if the pool already exists", async () => {
      await createPoolSigned(
        appChain,
        alicePrivateKey,
        tokenAId,
        tokenBId,
        tokenAInitialLiquidity,
        tokenBInitialLiquidity,
        start,
        end,
        initialWeight,
        finalWeight,
        feeLBP,
        bob,
        repayTarget,
        { nonce: nonce++ }
      );

      const block = await appChain.produceBlock();
      const tx = block?.transactions[0];

      expect(tx?.status.toBoolean()).toBe(false);
      expect(tx?.statusMessage).toBe(errors.poolAlreadyExists());
    });
  });

  // describe("sell", () => {
  //   beforeAll(async () => {
  //     nonce = 0;
  //     appChain = fromRuntime(modules);

  //     appChain.configurePartial({
  //       Runtime: config,
  //     });

  //     await appChain.start();
  //     appChain.setSigner(alicePrivateKey);

  //     xyk = appChain.runtime.resolve("XYK");

  //     await drip(
  //       appChain,
  //       alicePrivateKey,
  //       tokenAId,
  //       Balance.from(tokenAInitialLiquidity.toBigInt() * 2n),
  //       {
  //         nonce: nonce++,
  //       }
  //     );
  //     await drip(
  //       appChain,
  //       alicePrivateKey,
  //       tokenBId,
  //       Balance.from(tokenBInitialLiquidity.toBigInt() * 2n),
  //       {
  //         nonce: nonce++,
  //       }
  //     );

  //     await createPoolSigned(
  //       appChain,
  //       alicePrivateKey,
  //       tokenAId,
  //       tokenBId,
  //       tokenAInitialLiquidity,
  //       tokenBInitialLiquidity,
  //       { nonce: nonce++ }
  //     );
  //   });

  //   it("should sell tokens for tokens out", async () => {
  //     const path = new TokenIdPath({
  //       path: [tokenAId, tokenBId, TokenId.from(MAX_TOKEN_ID)],
  //     });

  //     await sellPathSigned(
  //       appChain,
  //       alicePrivateKey,
  //       path,
  //       Balance.from(100),
  //       Balance.from(1),
  //       { nonce: nonce++ }
  //     );

  //     const block = await appChain.produceBlock();
  //     Provable.log("block", block);

  //     const { balance: balanceA } = await queryBalance(
  //       appChain,
  //       tokenAId,
  //       alice
  //     );

  //     const { balance: balanceB } = await queryBalance(
  //       appChain,
  //       tokenBId,
  //       alice
  //     );

  //     expect(balanceA?.toString()).toEqual("999900");
  //     expect(balanceB?.toString()).toEqual("1000099");

  //     Provable.log("balances", {
  //       balanceA,
  //       balanceB,
  //     });
  //   });
  // });
});
