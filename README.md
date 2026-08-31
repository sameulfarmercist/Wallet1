# Robinhood Chain Recovery Worker

A 24/7 Node.js worker for recovering ERC-20 tokens sent to a wallet you control on Robinhood Chain. It watches incoming ERC-20 `Transfer` events and, when a token arrives, attempts to transfer the wallet's current token balance to a new destination wallet.

## Important security notes

- This is for assets/wallets you own or are authorized to control.
- NEVER paste your seed phrase or private key into chat, GitHub, screenshots, or source code.
- Put the private key in Railway Variables or another secret manager.
- Use a brand-new destination wallet.
- The worker requires ETH in the compromised wallet for gas.
- The public RPC is suitable for initial testing but can be rate-limited. Robinhood recommends Alchemy for developer infrastructure.
- Test with a small amount before relying on it for recovery.

## Robinhood Chain

- Mainnet chain ID: 4663
- Native gas token: ETH
- Mainnet RPC: https://rpc.mainnet.chain.robinhood.com

## Local

```bash
npm install
cp .env.example .env
# edit .env
npm start
```

## Railway

1. Push this folder to a private GitHub repository.
2. Railway -> New Project -> Deploy from GitHub Repo.
3. Select the repository.
4. Add these service variables:
   - `RPC_URL`
   - `PRIVATE_KEY`
   - `DESTINATION`
   - `POLL_MS=3000`
   - `MAX_RETRIES=5`
   - `CONFIRMATIONS=1`
5. Deploy.
6. Open the deployment logs and confirm:
   `Connected to Robinhood Chain`
   and
   `Recovery monitor started.`

The service does not need a public domain because it is a worker.

## Railway start command

Railway should detect `npm start` from package.json. If it does not, set the service Start Command to:

```bash
npm start
```

## What it does

- Verifies chain ID 4663.
- Watches new blocks.
- Detects ERC-20 transfers whose recipient is the monitored wallet.
- Reads the token balance.
- Estimates gas.
- Checks available ETH.
- Sends the full detected token balance to `DESTINATION`.
- Retries transient failures.
- Waits for confirmation.
- Logs activity to stdout and `sweeper.log`.

## Limitations

A compromised wallet is a race: whoever gets a valid transaction accepted first can move the assets. No sweeper can guarantee recovery against an attacker who controls the same private key. For high-value assets, contact the relevant issuer/exchange and consider using a dedicated professional recovery/security provider.
