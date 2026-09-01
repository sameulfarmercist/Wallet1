# Robinhood Chain Recovery Bot

Watches the configured EVM wallet for incoming ERC-20 Transfer events and, when AUTO_FORWARD=true, forwards the current token balance to the configured safe wallet.

## Railway variables

Set these in Railway Variables:

PRIVATE_KEY=your_compromised_wallet_private_key
SAFE_WALLET=0xbcafc75cf2157c810cbeb7dcacd4f9635f9fb939
RPC_URL=https://rpc.mainnet.chain.robinhood.com
AUTO_FORWARD=true
POLL_INTERVAL=2000
CONFIRMATIONS=1
ETH_RESERVE=0.00001

Never commit a real private key to GitHub.

## Run

npm install
npm start

The source wallet is derived from PRIVATE_KEY. The bot only forwards ERC-20 tokens; it does not automatically sweep native ETH.
