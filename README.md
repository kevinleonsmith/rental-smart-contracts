# Rental Smart Contracts

[![CI](https://github.com/kevinleonsmith/rental-smart-contracts/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinleonsmith/rental-smart-contracts/actions/workflows/ci.yml)

On-chain rental agreements with **escrowed security deposits**, automated fees, and a dispute window — built on a **factory pattern** so a single platform can issue agreements for property, vehicle, and yacht rentals and collect a fee on each.

Written in Solidity `0.8.24`, tested with Hardhat, built on OpenZeppelin v5.

```bash
npm install
npx hardhat compile
npx hardhat test          # 16 passing
npx hardhat run scripts/deploy.js   # local deploy with a mock price feed
```

---

## Live demo

**▶ [kevinleonsmith.github.io/rental-smart-contracts](https://kevinleonsmith.github.io/rental-smart-contracts)** — a browser dapp that reads these contracts **live** from Sepolia. It shows the on-chain template and listed property, prices a rental through the real `quote()` call (with a USD figure from the Chainlink ETH/USD feed), and — with a wallet on Sepolia — creates a funded escrow agreement end to end. No wallet needed to look around.

## Live on Sepolia

Deployed and running on the Ethereum **Sepolia** testnet:

| Contract | Address |
|---|---|
| `RentalAgreementFactory` | [`0x8dA519002B470af09A1eB60196c0BA9f2449BC37`](https://sepolia.etherscan.io/address/0x8dA519002B470af09A1eB60196c0BA9f2449BC37) |
| `RentalInsuranceManager` | [`0xf46db6eBc189DAB16b867ED2D66Af8b5134db9dA`](https://sepolia.etherscan.io/address/0xf46db6eBc189DAB16b867ED2D66Af8b5134db9dA) |
| `PropertyRentalAgreement` (impl) | [`0x74E178BA0d2BFe2C766a1334b85aA6afc9b02135`](https://sepolia.etherscan.io/address/0x74E178BA0d2BFe2C766a1334b85aA6afc9b02135) |
| `VehicleRentalAgreement` (impl) | [`0x472CD46AB804F3AAac4050D9Bd384b3F64Cbd32e`](https://sepolia.etherscan.io/address/0x472CD46AB804F3AAac4050D9Bd384b3F64Cbd32e) |
| `YachtRentalAgreement` (impl) | [`0x9e6B19D094EF43080c6B811221645DA780CAFC06`](https://sepolia.etherscan.io/address/0x9e6B19D094EF43080c6B811221645DA780CAFC06) |

All contracts are **source-verified** on Etherscan — click an address and open the
**Contract** tab to read the actual Solidity, not bytecode. The factory clones the right
per-category implementation (property / vehicle / yacht) for each rental, is seeded with
three templates and three demo properties, and uses the Chainlink ETH/USD feed at
`0x694AA1769357215DE4FAC081bf1f309aDC325306`.

---

## Why this design

This started as a set of draft contracts and was rebuilt to production-review standards. The decisions below are the interesting part:

### Pull-payment over push-payment
The original paid every party with `address.transfer(...)` the moment money moved. That is the classic Solidity footgun: a landlord or treasury that is a contract which reverts (or burns gas) in its `receive()` can permanently **block another party's refund**, and `.transfer()`'s hard 2300-gas stipend breaks against modern multisig/AA wallets.

Here, every payout is **credited to a ledger** (`pendingWithdrawals`) and the recipient calls `withdraw()`:

```solidity
function withdraw() external nonReentrant {
    uint256 amount = pendingWithdrawals[msg.sender];
    require(amount > 0, "nothing to withdraw");
    pendingWithdrawals[msg.sender] = 0;           // effects before interaction
    (bool ok, ) = payable(msg.sender).call{value: amount}("");
    require(ok, "withdraw failed");
    emit Withdrawal(msg.sender, amount);
}
```

One party can never grief another's funds, and `.call` works with any recipient.

### A funding path that actually works on-chain
The draft had the factory do `payable(agreement).transfer(msg.value)` into a `receive()` that itself made **several external calls**. That reverts on a real network — `.transfer` forwards only 2300 gas. The factory now deploys the agreement and calls an explicit `fundInitial{value: ...}()` with a full gas budget, splitting rent / deposit / fee atomically.

### Decoupled from the factory
The draft specialized contracts called *back into the factory* (`factory.platformTreasury()`, `factory.rentalTemplates(...)`) at runtime, which silently breaks the moment a contract is deployed outside the factory. All terms are now passed in once via a `RentalInit` struct — the agreements are self-contained and independently testable.

### Removed dead weight
- Dropped `SafeMath` — redundant and a red flag on Solidity 0.8+, which has built-in overflow checks.
- Replaced the heavyweight `@chainlink/contracts` + `ChainlinkClient` dependency with a 15-line local `IAggregatorV3` interface and a mock, keeping the price-feed feature with zero external dependency.
- Unified pragmas (the drafts mixed `0.8.19` and `0.8.30`), custom errors instead of revert strings on the hot paths, checks-effects-interactions throughout, `nonReentrant` on every value-moving function.

### Per-category agreements via minimal-proxy clones
The factory keeps a registry mapping each template `category` → an agreement **implementation** (`property` → `PropertyRentalAgreement`, `vehicle` → `VehicleRentalAgreement`, `yacht` → `YachtRentalAgreement`, with a base fallback). Creating a rental deploys an **EIP-1167 minimal-proxy clone** of the right implementation and `initialize()`s + funds it in the same transaction — so each category gets its specialised logic (mileage charges, usage logs, inspections) while deploy gas stays flat and small no matter how large the implementations grow.

Because clones run no constructor, the contracts were moved to an OpenZeppelin `Initializable` `initialize()` pattern: immutables became storage set on init, inline field initializers (which run in the constructor) moved into `initialize()`, and each implementation locks itself with `_disableInitializers()` so only clones — never the implementation — can be initialized. Initialize + fund happen atomically inside the factory call, so there is no window to front-run initialization.

> The **live Sepolia** factory above runs exactly this clone architecture: creating a vehicle or yacht rental deploys a minimal-proxy clone of the matching verified implementation.

---

## Architecture

```
RentalAgreementFactory ── registry of templates + properties + per-category implementations;
        │                   clones the right agreement, funds it, takes platform fee
        │  clone + initialize() + fundInitial()
        ▼
RentalAgreement ──────── per-rental escrow: rent payout, deposit custody, deductions, disputes, pull withdrawals
        ▲ inherits
        ├── PropertyRentalAgreement  (maintenance, inspections, utilities, occupancy)
        ├── VehicleRentalAgreement   (mileage/fuel/violation charges from deposit)
        └── YachtRentalAgreement     (usage logs, safety checks, minor-damage auto-settle)

RentalInsuranceManager ─ optional policies, claims, pool-funded pull settlement (standalone)
```

| Contract | Responsibility |
|---|---|
| `RentalAgreementFactory` | Owner-managed rental **templates** (deposit %, late/cancellation fees, duration bounds) and user-registered **properties**; deploys one escrow contract per rental and routes the 2.5% platform fee. |
| `RentalAgreement` | Holds funds; credits rent to landlord and fee to treasury; manages the security deposit with a 7-day deduction dispute window and timed release; pull-based withdrawals. |
| `PropertyRentalAgreement` | Residential/commercial lease extension. |
| `VehicleRentalAgreement` | Car rental; excess-mileage, refuelling and traffic-fine charges settled against the deposit. |
| `YachtRentalAgreement` | Maritime rental; usage logging, safety compliance, damage reports. |
| `RentalInsuranceManager` | Independent insurance: premium quoting, claim filing, operator approval, pool-funded pull settlement. |

## Rental lifecycle

1. **Platform owner** creates a template (`createRentalTemplate`).
2. **Landlord** registers a property against a template (`registerProperty`).
3. **Tenant** calls `quote()`, then `createRentalAgreement{value: rent + deposit + fee}()`. The factory deploys and funds a dedicated `RentalAgreement`; rent → landlord, fee → treasury, deposit → escrow; overpayment is refunded.
4. During/after the term: deductions (`requestDeduction` → tenant `approveDeduction`, or anyone after the 7-day window), early termination with a cancellation fee, or disputes.
5. **Settlement**: after the grace period the remaining deposit is credited to the tenant; every party calls `withdraw()`.

## Tests

`test/RentalAgreement.test.js` — 16 passing specs covering quoting math, the fund/refund flow, pull withdrawals, deposit release, tenant- and timeout-based deduction approval, early-termination fees, access control, the vehicle mileage charge, and an end-to-end insurance claim.

## Roadmap

Honest view of what's done and what's next:

- ✅ **Category-specific escrow at deploy time** *(done, live)*. The factory selects the agreement implementation by the template's `category` and deploys it as an EIP-1167 clone — see [Per-category agreements via minimal-proxy clones](#per-category-agreements-via-minimal-proxy-clones). Live on Sepolia with all three implementations registered and verified.
- **Contested-claim arbitration.** Deposit deductions are trust-minimized today (tenant consent or a timeout). A production system would add a neutral arbiter or an escrow-oracle path for disputed claims.
- **Insurance wired into the rental flow.** `RentalInsuranceManager` is standalone; a template that `requiresInsurance` could mint/attach a policy as part of `createRentalAgreement`.
- **Subgraph + richer frontend.** Index `AgreementCreated` events so the demo lists real agreements and their lifecycle, rather than reading one address at a time.

## Security notes & scope

- Pull payments, checks-effects-interactions, `ReentrancyGuard`, `Pausable`, custom errors, OpenZeppelin `Ownable` v5.
- **Not audited.** This is a reference/portfolio implementation. Deposit-deduction approval is intentionally trust-minimized (tenant consent or timeout); a production system would likely add a neutral arbiter or an escrow-oracle for contested claims.
- Operating a real rental-payment platform may trigger money-transmission, insurance-licensing, and local tenancy-law obligations. Get legal review before mainnet.

## License

MIT
