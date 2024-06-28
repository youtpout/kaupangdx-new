import {
  RuntimeModule,
  runtimeMethod,
  runtimeModule,
  state,
} from "@proto-kit/module";
import { State, StateMap, assert } from "@proto-kit/protocol";
import { Provable, PublicKey, Struct, UInt64 as O1UInt64, Bool, Field, Empty } from "o1js";
import { inject } from "tsyringe";
import { Balance, TokenId, UInt64 } from "@proto-kit/library";


/**
 * Pool information for LBP
 */
export class StorageInfo extends Struct({
  owner: PublicKey,
  amount: UInt64,
  block: UInt64,
  index: UInt64
}) {
}


/**
 * Test struct storage
 */
@runtimeModule()
export class LBP extends RuntimeModule<Empty> {
  @state() public storageDatas = StateMap.from<UInt64, StorageInfo>(UInt64, StorageInfo);
  @state() public lastIndex = State.from<UInt64>(UInt64);

  /**
   * Provide access to the underlying Balances runtime to manipulate balances
   * for both pools and users
   */
  public constructor(
  ) {
    super();
  }

  public storageExists(index: UInt64) {
    return this.storageDatas.get(index).isSome;
  }




  @runtimeMethod()
  public createPoolSigned(
    tokenAId: TokenId,
    tokenBId: TokenId,
    tokenAAmount: Balance,
    tokenBAmount: Balance,
    start: UInt64,
    end: UInt64,
    initialWeight: UInt64,
    finalWeight: UInt64,
    feeCollector: PublicKey,
    repayTarget: UInt64
  ) {
  }



  @runtimeMethod()
  public sellPathSigned(
    amountIn: Balance,
    amountOutMinLimit: Balance
  ) {

  }

}
