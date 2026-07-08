/**
 * MAINNET PREFLIGHT — run before enabling trading.
 *
 *   npm run preflight
 *
 * Because we go straight to mainnet with no testnet dry-run, this asserts the
 * ground truth our constants assume:
 *   1. The RPC really is chain 4663.
 *   2. Bytecode exists at every contract we're about to call.
 *   3. Solana RPC is reachable.
 *   4. (if configured) the gas-tank wallet exists and its balance is sane.
 *
 * Exits non-zero on any failure so it can gate a deploy.
 */
import { rhPublic } from "../chain/rhchain.js";
import { RH_CHAIN_ID, REQUIRED_CODE_AT, ADDR } from "../chain/constants.js";
import { solana } from "../chain/solana.js";
import { config } from "../config.js";
import { formatEther } from "viem";

let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const fail = (m: string) => {
  console.log(`  ✗ ${m}`);
  failures++;
};

async function main() {
  console.log("\n=== xchain-memebot preflight (MAINNET) ===\n");

  // 1. Chain id
  console.log("Robinhood Chain RPC:");
  try {
    const id = await rhPublic.getChainId();
    if (id === RH_CHAIN_ID) pass(`chainId == ${RH_CHAIN_ID} (0x1237)`);
    else fail(`chainId mismatch: RPC says ${id}, expected ${RH_CHAIN_ID}. WRONG NETWORK.`);
    const block = await rhPublic.getBlockNumber();
    pass(`latest block ${block}`);
  } catch (e) {
    fail(`cannot reach RH RPC: ${(e as Error).message}`);
  }

  // 2. Contracts have code
  console.log("\nContract bytecode:");
  for (const c of REQUIRED_CODE_AT) {
    try {
      const code = await rhPublic.getCode({ address: c.address });
      if (code && code.length > 2) pass(`${c.name} has code @ ${c.address}`);
      else fail(`${c.name} has NO code @ ${c.address} — address wrong or not deployed.`);
    } catch (e) {
      fail(`${c.name} check failed: ${(e as Error).message}`);
    }
  }
  // EntryPoint is optional for MVP (only needed for the future paymaster path).
  try {
    const ep = await rhPublic.getCode({ address: ADDR.ENTRYPOINT_V07 });
    if (ep && ep.length > 2) pass(`EntryPoint v0.7 present (enables gasless-sell v2)`);
    else console.log(`  ~ EntryPoint v0.7 not found — fine for MVP (JIT gas path).`);
  } catch { /* non-fatal */ }

  // 3. Solana
  console.log("\nSolana RPC:");
  try {
    const slot = await solana.getSlot();
    pass(`reachable, slot ${slot}`);
  } catch (e) {
    fail(`cannot reach Solana RPC: ${(e as Error).message}`);
  }

  // 4. Gas tank (optional until you provide the key)
  console.log("\nGas tank:");
  if (!config.GAS_TANK_PRIVATE_KEY) {
    console.log("  ~ GAS_TANK_PRIVATE_KEY not set — sell-gas path disabled until provided.");
  } else {
    try {
      const { getGasTankWallet } = await import("../chain/rhchain.js");
      const { account } = getGasTankWallet();
      const bal = await rhPublic.getBalance({ address: account.address });
      pass(`gas tank ${account.address} balance ${formatEther(bal)} ETH`);
      if (bal === 0n) fail("gas tank has 0 ETH — cannot fund user sells.");
    } catch (e) {
      fail(`gas tank check failed: ${(e as Error).message}`);
    }
  }

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
