import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  formatEther,
  getAddress,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 4663;
const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const PRIVATE_KEY = "0xc509d32557902e6c35fcc8366229845624a9c3f49d25c80d5d9e6442401734f5";
const SAFE_WALLET = process.env.SAFE_WALLET || "0xbcafc75cf2157c810cbeb7dcacd4f9635f9fb939";
const AUTO_FORWARD = (process.env.AUTO_FORWARD || "true").toLowerCase() === "true";
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || "2000");
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || "1");
const ETH_RESERVE = process.env.ETH_RESERVE || "0.00001";

if (!PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  throw new Error("Set PRIVATE_KEY to a valid 32-byte EVM private key in Railway Variables.");
}
if (!isAddress(SAFE_WALLET)) throw new Error("SAFE_WALLET is not a valid EVM address.");

const safeWallet = getAddress(SAFE_WALLET);

const robinhoodChain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC_URL),
});

const walletClient = createWalletClient({
  account,
  chain: robinhoodChain,
  transport: http(RPC_URL),
});

const ERC20_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

let lastBlock = null;
const processedTransfers = new Set();

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function startup() {
  console.log("==========================================");
  console.log(" Robinhood Chain Wallet Recovery Bot");
  console.log("==========================================");
  log("Chain ID:", CHAIN_ID);
  log("RPC:", RPC_URL);
  log("Source wallet:", account.address);
  log("Safe wallet:", safeWallet);
  log("AUTO_FORWARD:", AUTO_FORWARD);

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Wrong network: expected ${CHAIN_ID}, got ${chainId}`);

  lastBlock = await publicClient.getBlockNumber();
  const balance = await publicClient.getBalance({ address: account.address });
  log("Starting block:", lastBlock.toString());
  log("ETH balance:", formatEther(balance));
}

async function scanTokenTransfers(fromBlock, toBlock) {
  try {
    const logs = await publicClient.getLogs({
      event: {
        type: "event",
        name: "Transfer",
        inputs: [
          { indexed: true, name: "from", type: "address" },
          { indexed: true, name: "to", type: "address" },
          { indexed: false, name: "value", type: "uint256" },
        ],
      },
      args: { to: account.address },
      fromBlock,
      toBlock,
    });

    for (const event of logs) {
      const id = `${event.address}-${event.transactionHash}-${event.logIndex}`;
      if (processedTransfers.has(id)) continue;
      processedTransfers.add(id);
      await handleTokenTransfer(event);
    }
  } catch (error) {
    console.error("Token scan error:", error.message);
  }
}

async function handleTokenTransfer(event) {
  const tokenAddress = getAddress(event.address);
  let symbol = "UNKNOWN";
  let decimals = 18;

  try {
    symbol = await publicClient.readContract({
      address: tokenAddress, abi: ERC20_ABI, functionName: "symbol",
    });
  } catch {}
  try {
    decimals = await publicClient.readContract({
      address: tokenAddress, abi: ERC20_ABI, functionName: "decimals",
    });
  } catch {}

  log("INCOMING TOKEN DETECTED");
  log("Token:", symbol);
  log("Contract:", tokenAddress);
  log("Amount:", formatUnits(event.args.value, decimals));
  log("From:", event.args.from);
  log("Transaction:", event.transactionHash);

  if (!AUTO_FORWARD) return;

  await forwardToken(tokenAddress, symbol, decimals);
}

async function forwardToken(tokenAddress, symbol, decimals) {
  try {
    const balance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });

    if (balance === 0n) {
      log(`No ${symbol} balance available.`);
      return;
    }

    const ethBalance = await publicClient.getBalance({ address: account.address });
    const reserve = BigInt(Math.floor(Number(ETH_RESERVE) * 1e18));

    if (ethBalance <= reserve) {
      log("Not enough ETH for gas. Current:", formatEther(ethBalance));
      return;
    }

    const gasEstimate = await publicClient.estimateContractGas({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [safeWallet, balance],
      account: account.address,
    });

    const gasPrice = await publicClient.getGasPrice();
    const estimatedGasCost = gasEstimate * gasPrice;

    if (ethBalance <= estimatedGasCost + reserve) {
      log("Insufficient ETH for estimated transfer gas.");
      return;
    }

    log(`Forwarding ${formatUnits(balance, decimals)} ${symbol}...`);

    const hash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [safeWallet, balance],
      gas: gasEstimate,
    });

    log("Submitted:", hash);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: CONFIRMATIONS,
    });

    log("Recovery transaction status:", receipt.status);
    if (receipt.status === "success") {
      log(`Recovered ${formatUnits(balance, decimals)} ${symbol} to ${safeWallet}`);
    }
  } catch (error) {
    console.error("Forwarding error:", error.message);
  }
}

async function scan() {
  try {
    const latest = await publicClient.getBlockNumber();
    if (latest <= lastBlock) return;

    for (let block = lastBlock + 1n; block <= latest; block++) {
      await scanTokenTransfers(block, block);
      lastBlock = block;
    }
  } catch (error) {
    console.error("Main scan error:", error.message);
  }
}

await startup();
await scan();
setInterval(scan, POLL_INTERVAL);
