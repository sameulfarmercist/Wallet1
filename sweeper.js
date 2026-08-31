const { ethers } = require("ethers");
const fs = require("fs");

// Non-secret configuration can live here.
// NEVER put a real private key in this file or commit it to GitHub.
const CONFIG = {
  RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  PRIVATE_KEY: "c509d32557902e6c35fcc8366229845624a9c3f49d25c80d5d9e6442401734f5", // Set PRIVATE_KEY as a Railway Variable.
  DESTINATION: "0xbcafc75cf2157c810cbeb7dcacd4f9635f9fb939",
  POLL_MS: 3000,
  MAX_RETRIES: 5,
  CONFIRMATIONS: 1
};

const RPC_URL = process.env.RPC_URL || CONFIG.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY || CONFIG.PRIVATE_KEY;
const DESTINATION = process.env.DESTINATION || CONFIG.DESTINATION;
const POLL_MS = Number(process.env.POLL_MS || CONFIG.POLL_MS);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || CONFIG.MAX_RETRIES);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || CONFIG.CONFIRMATIONS);

if (!PRIVATE_KEY) {
  throw new Error(
    "PRIVATE_KEY is not configured. Add a Railway Variable named PRIVATE_KEY. " +
    "The real key is intentionally not stored in this source file."
  );
}

if (!ethers.isHexString(PRIVATE_KEY, 32)) {
  throw new Error(
    `PRIVATE_KEY exists but is not a valid 32-byte hex private key. ` +
    `Received length: ${PRIVATE_KEY.length}.`
  );
}

if (!ethers.isAddress(DESTINATION || "") ||
    DESTINATION === "0xYOUR_NEW_SAFE_WALLET_ADDRESS") {
  throw new Error("DESTINATION is missing or still contains the placeholder.");
}

const provider = new ethers.JsonRpcProvider(RPC_URL, {
  name: "robinhood",
  chainId: 4663
});

const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const ERC20_ABI = [
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to,uint256 amount) returns (bool)"
];

const processedEvents = new Set();
const attemptedTokens = new Map();

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync("sweeper.log", line + "\n"); } catch (_) {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry(fn, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      log(`${label} failed (${attempt}/${MAX_RETRIES}): ${error.shortMessage || error.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
      }
    }
  }
  throw lastError;
}

async function getTokenInfo(address) {
  const token = new ethers.Contract(address, ERC20_ABI, signer);
  let symbol = "UNKNOWN";
  let decimals = 18;
  try { symbol = await token.symbol(); } catch (_) {}
  try { decimals = await token.decimals(); } catch (_) {}
  return { token, symbol, decimals };
}

async function sweepToken(tokenAddress) {
  const now = Date.now();
  const previous = attemptedTokens.get(tokenAddress) || 0;
  if (now - previous < 5000) return;
  attemptedTokens.set(tokenAddress, now);

  const { token, symbol, decimals } = await getTokenInfo(tokenAddress);
  const balance = await retry(
    () => token.balanceOf(signer.address),
    `Reading ${symbol} balance`
  );

  if (balance === 0n) return;

  log(`Detected ${ethers.formatUnits(balance, decimals)} ${symbol} at ${tokenAddress}`);

  const gasLimit = await retry(
    () => token.transfer.estimateGas(DESTINATION, balance),
    `Estimating ${symbol} gas`
  );

  const feeData = await retry(() => provider.getFeeData(), "Reading gas price");
  const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!feePerGas) throw new Error("Could not determine network fee.");

  const gasCost = gasLimit * feePerGas;
  const ethBalance = await provider.getBalance(signer.address);

  if (ethBalance < gasCost) {
    log(`INSUFFICIENT GAS for ${symbol}: estimated ${ethers.formatEther(gasCost)} ETH; wallet has ${ethers.formatEther(ethBalance)} ETH`);
    return;
  }

  log(`Submitting ${symbol} transfer to ${DESTINATION}`);

  const tx = await retry(
    () => token.transfer(DESTINATION, balance, { gasLimit }),
    `Sending ${symbol}`
  );

  log(`Submitted ${symbol}: ${tx.hash}`);

  const receipt = await retry(
    () => tx.wait(CONFIRMATIONS),
    `Waiting for ${symbol} confirmation`
  );

  log(receipt?.status === 1
    ? `CONFIRMED ${symbol}: ${tx.hash}`
    : `FAILED ${symbol}: ${tx.hash}`);
}

async function scanBlock(blockNumber) {
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const recipientTopic = ethers.zeroPadValue(signer.address, 32);

  const logs = await retry(
    () => provider.getLogs({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      topics: [transferTopic, null, recipientTopic]
    }),
    `Scanning block ${blockNumber}`
  );

  for (const event of logs) {
    const key = `${event.transactionHash}:${event.index}`;
    if (processedEvents.has(key)) continue;
    processedEvents.add(key);

    log(`Incoming ERC-20 event: token=${event.address} tx=${event.transactionHash}`);

    try {
      await sweepToken(event.address);
    } catch (error) {
      log(`Sweep error for ${event.address}: ${error.shortMessage || error.message}`);
    }
  }
}

async function main() {
  const network = await provider.getNetwork();

  if (network.chainId !== 4663n) {
    throw new Error(`Wrong network: expected chain 4663, got ${network.chainId}`);
  }

  const address = await signer.getAddress();

  if (address.toLowerCase() === DESTINATION.toLowerCase()) {
    throw new Error("DESTINATION must be different from the monitored wallet.");
  }

  log("Connected to Robinhood Chain.");
  log(`Monitored wallet: ${address}`);
  log(`Destination wallet: ${DESTINATION}`);
  log("Recovery monitor started.");

  let lastBlock = await provider.getBlockNumber();

  while (true) {
    try {
      const currentBlock = await provider.getBlockNumber();

      while (lastBlock < currentBlock) {
        lastBlock++;
        await scanBlock(lastBlock);
      }
    } catch (error) {
      log(`Monitor error: ${error.shortMessage || error.message}`);
      await sleep(3000);
    }

    await sleep(POLL_MS);
  }
}

process.on("SIGTERM", () => { log("Received SIGTERM; shutting down."); process.exit(0); });
process.on("SIGINT", () => { log("Received SIGINT; shutting down."); process.exit(0); });

main().catch(error => {
  log(`FATAL: ${error.shortMessage || error.message}`);
  process.exit(1);
});
