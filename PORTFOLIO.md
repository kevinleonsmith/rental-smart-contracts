# Portfolio blurbs

Copy-paste descriptions of this project for a résumé, LinkedIn, job applications, or a bio.

- **Live demo:** https://rental-smart-contracts.pages.dev
- **Code:** https://github.com/kevinleonsmith/rental-smart-contracts

---

## Résumé bullet (one line)

> Built and shipped a full-stack on-chain rental-escrow platform: factory-pattern Solidity contracts that deploy per-category escrows as EIP-1167 minimal-proxy clones (pull-payment withdrawals, reentrancy guards, contested-claim arbitration, and insurance policies minted inline with each rental), deployed and source-verified on Ethereum Sepolia, plus a live, read-only browser dapp that prices rentals through the real on-chain `quote()` and indexes every agreement from on-chain events — with a buildable The Graph subgraph for production indexing. 28 passing tests + CI. — Live: rental-smart-contracts.pages.dev · Code: github.com/kevinleonsmith/rental-smart-contracts

---

## LinkedIn / portfolio (2–3 sentences)

> On-chain rental agreements with escrowed security deposits, automated platform fees, and pull-payment settlement — built on a factory pattern so one platform can issue agreements for property, vehicle, and yacht rentals. The factory keeps a `category → implementation` registry and deploys each rental as an EIP-1167 minimal-proxy clone, so deploy gas stays flat while each category keeps its own specialised logic. Deposit deductions settle by tenant consent, a timeout, or — when contested — a neutral arbiter; insurance-required templates mint a policy in the same transaction as the rental. Solidity 0.8.24 on OpenZeppelin v5 (Initializable/Clones), deployed and source-verified on Ethereum Sepolia with Hardhat tests (28) and CI, fronted by a live, read-only browser dapp that reads the contracts over RPC, prices a rental through the real on-chain `quote()` (USD via a Chainlink feed), and indexes every agreement's live lifecycle from on-chain events (creating an agreement is done on-chain against the verified factory) — with a buildable The Graph subgraph included for production indexing. I rebuilt it from draft contracts to review quality: pull-payments over push, a funding path that actually works on-chain, and no redundant SafeMath/Chainlink dependencies.
>
> **Live demo:** rental-smart-contracts.pages.dev · **Code:** github.com/kevinleonsmith/rental-smart-contracts

---

## Job application / cover letter

> I recently took a set of draft rental smart contracts and rebuilt them to production-review standards: I replaced `address.transfer` push-payments — which let one party's reverting wallet block everyone else's refund — with a pull-payment withdrawal ledger, enforced checks-effects-interactions and reentrancy guards throughout, and fixed a factory funding path that would have reverted on mainnet due to the 2300-gas stipend. I then moved the agreements to an `Initializable` pattern so the factory can deploy each one as an EIP-1167 minimal-proxy clone chosen from a per-category implementation registry — keeping deploy gas flat and letting a category's logic be upgraded by registering a new implementation. On top of that I added contested-claim arbitration (a neutral arbiter resolves disputed deposit deductions, with a long-stop that never locks funds) and wired an insurance manager into the rental flow so an insurance-required template mints a policy in the same transaction. The contracts are deployed and source-verified on Ethereum Sepolia with full Hardhat test coverage (28 tests) and CI, and I built a live, read-only browser dapp on top that reads them over RPC, prices rentals through the on-chain `quote()`, and indexes every agreement's lifecycle from on-chain events — plus a complete, buildable The Graph subgraph for production indexing. Live demo: rental-smart-contracts.pages.dev — Code and design write-up: github.com/kevinleonsmith/rental-smart-contracts

---

## One-liner (bio / tagline / X)

> Solidity + web3 dev — built & deployed a factory-pattern rental-escrow dapp using EIP-1167 clones (pull-payments, arbitrated disputes, inline insurance, Chainlink pricing), verified on Sepolia with a live event-indexed UI + a The Graph subgraph: rental-smart-contracts.pages.dev

---

## A note on honesty

Everything above is literally true to what's in this repo: verified contracts plus a working UI anyone can click, seeded with real agreements across all three categories. The one thing to be upfront about is that this is a **Sepolia testnet demo**, not a launched product with real users, and the arbiter is a single configurable address rather than a decentralised court. If asked "is this in production?", the accurate answer is: *"It's a deployed, source-verified reference implementation with a working end-to-end demo — not a launched product."* That framing is a strength: it shows you ship complete, verifiable work.
