import {
  RuntimeModule,
  runtimeMethod,
  runtimeModule,
  state,
} from "@proto-kit/module";
import { StateMap, assert } from "@proto-kit/protocol";
import { PoolKey } from "./pool-key";
import { Provable, PublicKey, Struct, UInt64 as O1UInt64, Bool } from "o1js";
import { inject } from "tsyringe";
import { Balance, TokenId, UInt64 } from "@proto-kit/library";
import { TokenPair } from "./token-pair";
import { LPTokenId } from "./lp-token-id";
import { MAX_TOKEN_ID, TokenRegistry } from "../token-registry";
import { Balances } from "../balances";
import { FeeLBP, PoolLBP, WeightCurveType } from "./pool-lbp";
import { FeeCollectorAssetKey } from "./fee-collector-asset-key";
import { FeeCollectorAsset } from "./fee-collector-asset";



export const errors = {
  tokensNotDistinct: () => `Tokens must be different`,
  poolAlreadyExists: () => `Pool already exists`,
  poolDoesNotExist: () => `Pool does not exist`,
  amountAIsZero: () => `Amount A must be greater than zero`,
  amountALimitInsufficient: () => `Amount A limit is insufficient`,
  amountBLimitInsufficient: () => `Amount B limit is insufficient`,
  reserveAIsZero: () => `Reserve A must be greater than zero`,
  lpTokenSupplyIsZero: () => `LP token supply is zero`,
  amountOutIsInsufficient: () => `Amount out is insufficient`,
  feeCollectorWithAssetAlreadyUsed: () => `Not more than one fee collector per asset id`,
  InvalidBlockRange: () => `Invalid block range`,
  MaxSaleDurationExceeded: () => `Duration of the LBP sale should not exceed 2 weeks`,
  InvalidWeight: () => `Invalid weight`,
  FeeAmountInvalid: () => `Invalid fee amount`
};

// we need a placeholder pool value until protokit supports value-less dictonaries or state arrays
export const placeholderPoolValue = Bool(true);

export const MAX_PATH_LENGTH = 3;
/// Max weight corresponds to 100%
export const MAX_WEIGHT: O1UInt64 = O1UInt64.from(100_000_000);
/// Max sale duration is 14 days
export const MAX_SALE_DURATION: O1UInt64 = O1UInt64.from(60 * 60 * 24 * 14);

export class TokenIdPath extends Struct({
  path: Provable.Array(TokenId, MAX_PATH_LENGTH),
}) {
  public static from(path: TokenId[]) {
    return new TokenIdPath({ path });
  }
}

export interface LBPConfig {
  feeDivider: bigint;
  fee: bigint;
}

/**
 * Runtime module responsible for providing trading/management functionalities for LBP pools.
 */
@runtimeModule()
export class LBP extends RuntimeModule<LBPConfig> {
  // all existing pools in the system
  @state() public pools = StateMap.from<PoolKey, PoolLBP>(PoolKey, PoolLBP);
  @state() public feeCollectorWithAsset = StateMap.from<FeeCollectorAssetKey, Bool>(FeeCollectorAssetKey, Bool);

  /**
   * Provide access to the underlying Balances runtime to manipulate balances
   * for both pools and users
   */
  public constructor(
    @inject("Balances") public balances: Balances,
    @inject("TokenRegistry") public tokenRegistry: TokenRegistry
  ) {
    super();
  }

  public poolExists(poolKey: PoolKey) {
    return this.pools.get(poolKey).isSome;
  }

  public feeCollectorWithAssetExists(feeCollectorAssetKey: FeeCollectorAssetKey) {
    return this.feeCollectorWithAsset.get(feeCollectorAssetKey).isSome;
  }

  /**
   * Zero weight at the beginning or at the end of a sale may cause a problem in the price calculation
   * Minimum allowed weight is 2%. The exponentiation used in the math can overflow when the ration between the weights is higher than 98/2.
   */
  public isValidWeight(weight: O1UInt64) {
    return weight.greaterThanOrEqual(MAX_WEIGHT.div(50)).and(weight.lessThan(MAX_WEIGHT));
  }
  /**
   * Creates an LBP pool if one doesnt exist yet, and if the creator has
   * sufficient balance to do so.
   *
   * @param creator
   * @param tokenAId
   * @param tokenBId
   * @param tokenASupply
   * @param tokenBSupply
   */
  public createPool(
    creator: PublicKey,
    owner: PublicKey,
    tokenAId: TokenId,
    tokenBId: TokenId,
    tokenAAmount: Balance,
    tokenBAmount: Balance,
    start: O1UInt64,
    end: O1UInt64,
    initialWeight: O1UInt64,
    finalWeight: O1UInt64,
    weightCurve: WeightCurveType,
    fee: FeeLBP,
    feeCollector: PublicKey,
    repayTarget: O1UInt64
  ) {
    const tokenPair = TokenPair.from(tokenAId, tokenBId);
    const poolKey = PoolKey.fromTokenPair(tokenPair);
    const feeCollectorAsset = FeeCollectorAsset.from(feeCollector, tokenAId);
    const feeCollectorAssetKey = FeeCollectorAssetKey.fromFeeCollectorAsset(feeCollectorAsset);
    const areTokensDistinct = tokenAId.equals(tokenBId).not();
    const poolDoesNotExist = this.poolExists(poolKey).not();
    const feeCollectorAssetDoesNotExist = this.feeCollectorWithAssetExists(feeCollectorAssetKey).not();
    const now = this.network.block.height;
    const nowLessThanStart = now.lessThan(start);
    const startLessThanEnd = start.lessThan(end);
    const max2Weeks = end.sub(start).lessThanOrEqual(MAX_SALE_DURATION);
    const validInitialWeight = this.isValidWeight(initialWeight);
    const validFinalWeight = this.isValidWeight(finalWeight);
    const validFeeAmount = fee.fee1.greaterThan(O1UInt64.zero);

    // TODO: add check for minimal liquidity in pools
    assert(areTokensDistinct, errors.tokensNotDistinct());
    assert(poolDoesNotExist, errors.poolAlreadyExists());
    assert(feeCollectorAssetDoesNotExist, errors.feeCollectorWithAssetAlreadyUsed());
    assert(nowLessThanStart, errors.InvalidBlockRange());
    assert(startLessThanEnd, errors.InvalidBlockRange());
    assert(max2Weeks, errors.MaxSaleDurationExceeded());
    assert(validInitialWeight, errors.InvalidWeight());
    assert(validFinalWeight, errors.InvalidWeight());
    assert(validFeeAmount, errors.FeeAmountInvalid());

    // transfer liquidity from the creator to the pool
    this.balances.transfer(tokenAId, creator, poolKey, tokenAAmount);
    this.balances.transfer(tokenBId, creator, poolKey, tokenBAmount);

    // determine initial LP token supply
    const lpTokenId = LPTokenId.fromTokenPair(tokenPair);
    const initialLPTokenSupply = Balance.from(
      // if tokenA supply is greater than tokenB supply, use tokenA supply, otherwise use tokenB supply
      Provable.if(
        tokenAId.greaterThan(tokenBId),
        Balance,
        tokenAAmount,
        tokenBAmount
      ).value
    );

    this.tokenRegistry.addTokenId(lpTokenId);
    this.balances.mintAndIncrementSupply(
      lpTokenId,
      creator,
      initialLPTokenSupply
    );

    const poolLBP = new PoolLBP({ owner, start, end, initialWeight, finalWeight, weightCurve, fee, feeCollector, repayTarget });
    this.pools.set(poolKey, poolLBP);
    this.feeCollectorWithAsset.set(feeCollectorAssetKey, Bool(true));
  }


  public calculateTokenOutAmountFromReserves(
    reserveIn: Balance,
    reserveOut: Balance,
    amountIn: Balance
  ) {
    const numerator = amountIn.mul(reserveOut);
    const denominator = reserveIn.add(amountIn);

    // TODO: extract to safemath
    const adjustedDenominator = Balance.from(
      Provable.if(denominator.equals(0), Balance, Balance.from(1), denominator)
        .value
    );

    assert(denominator.equals(adjustedDenominator), "denominator is zero");

    return numerator.div(adjustedDenominator);
  }

  public calculateTokenOutAmount(
    tokenIn: TokenId,
    tokenOut: TokenId,
    amountIn: Balance
  ) {
    const tokenPair = TokenPair.from(tokenIn, tokenOut);
    const pool = PoolKey.fromTokenPair(tokenPair);

    const reserveIn = this.balances.getBalance(tokenIn, pool);
    const reserveOut = this.balances.getBalance(tokenOut, pool);

    return this.calculateTokenOutAmountFromReserves(
      reserveIn,
      reserveOut,
      amountIn
    );
  }

  public calculateAmountIn(
    tokenIn: TokenId,
    tokenOut: TokenId,
    amountOut: Balance
  ) {
    const tokenPair = TokenPair.from(tokenIn, tokenOut);
    const pool = PoolKey.fromTokenPair(tokenPair);

    const reserveIn = this.balances.getBalance(tokenIn, pool);
    const reserveOut = this.balances.getBalance(tokenOut, pool);

    return this.calculateAmountInFromReserves(reserveIn, reserveOut, amountOut);
  }

  public calculateAmountInFromReserves(
    reserveIn: Balance,
    reserveOut: Balance,
    amountOut: Balance
  ) {
    const numerator = reserveIn.mul(amountOut);
    const denominator = reserveOut.sub(amountOut);

    // TODO: extract to safemath
    const adjustedDenominator = Balance.from(
      Provable.if(denominator.equals(0), Balance, Balance.from(1), denominator)
        .value
    );

    assert(denominator.equals(adjustedDenominator), "denominator is zero");

    return numerator.div(adjustedDenominator);
  }

  public sellPath(
    seller: PublicKey,
    { path }: TokenIdPath,
    amountIn: Balance,
    amountOutMinLimit: Balance
  ) {
    const initialTokenPair = TokenPair.from(path[0], path[1]);
    const initialPoolKey = PoolKey.fromTokenPair(initialTokenPair);
    const pathBeginswWithExistingPool = this.poolExists(initialPoolKey);

    assert(pathBeginswWithExistingPool, errors.poolDoesNotExist());

    let amountOut = Balance.zero;
    let lastPoolKey = PoolKey.empty();
    let sender = seller;
    // TODO: better handling of dummy tokens
    let lastTokenOut = TokenId.from(MAX_TOKEN_ID);

    // TODO: figure out if there are path variation edge cases
    // if yes, make the whole trade fail if the path is not valid
    for (let i = 0; i < MAX_PATH_LENGTH - 1; i++) {
      const tokenIn = path[i];
      const tokenOut = path[i + 1];

      const tokenPair = TokenPair.from(tokenIn, tokenOut);
      const poolKey = PoolKey.fromTokenPair(tokenPair);
      const poolExists = this.poolExists(poolKey);

      const calculatedAmountOut = this.calculateTokenOutAmount(
        tokenIn,
        tokenOut,
        Balance.from(amountIn)
      );

      const amoutOutWithoutFee = calculatedAmountOut.sub(
        calculatedAmountOut.mul(3n).div(100000n)
      );

      lastTokenOut = Provable.if(poolExists, TokenId, tokenOut, lastTokenOut);

      lastPoolKey = Provable.if(poolExists, PoolKey, poolKey, lastPoolKey);

      amountOut = Balance.from(
        Provable.if(poolExists, Balance, amoutOutWithoutFee, amountOut).value
      );

      amountIn = UInt64.from(
        Provable.if(poolExists, Balance, amountIn, Balance.zero).value
      );

      this.balances.transfer(tokenIn, sender, lastPoolKey, amountIn);

      sender = lastPoolKey;
      amountIn = amountOut;
    }

    const isAmountOutMinLimitSufficient =
      amountOut.greaterThanOrEqual(amountOutMinLimit);

    assert(isAmountOutMinLimitSufficient, errors.amountOutIsInsufficient());

    this.balances.transfer(lastTokenOut, lastPoolKey, seller, amountOut);
  }

  @runtimeMethod()
  public createPoolSigned(
    owner: PublicKey,
    tokenAId: TokenId,
    tokenBId: TokenId,
    tokenAAmount: Balance,
    tokenBAmount: Balance,
    start: O1UInt64,
    end: O1UInt64,
    initialWeight: O1UInt64,
    finalWeight: O1UInt64,
    weightCurve: WeightCurveType,
    fee: FeeLBP,
    feeCollector: PublicKey,
    repayTarget: O1UInt64
  ) {
    const creator = this.transaction.sender.value;
    this.createPool(creator, owner, tokenAId, tokenBId, tokenAAmount, tokenBAmount, start, end, initialWeight, finalWeight, weightCurve, fee, feeCollector, repayTarget);
  }



  @runtimeMethod()
  public sellPathSigned(
    path: TokenIdPath,
    amountIn: Balance,
    amountOutMinLimit: Balance
  ) {
    this.sellPath(
      this.transaction.sender.value,
      path,
      amountIn,
      amountOutMinLimit
    );
  }
}
