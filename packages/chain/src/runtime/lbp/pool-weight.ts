import { TokenId } from "@proto-kit/library";
import { Provable, Struct } from "o1js";
import { UInt64 } from "o1js/dist/node/provable/field-bigint";

/**
 * Represents a pair of tokens, ordered by their token ids.
 */
export class PoolWeight extends Struct({
  initial_weight: UInt64,
  final_weight: UInt64,
  actual_weight: UInt64
}) {
}
