# Rental Smart Contracts

[![CI](https://github.com/kevinleonsmith/rental-smart-contracts/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinleonsmith/rental-smart-contracts/actions/workflows/ci.yml)

On-chain rental agreements with **escrowed security deposits**, automated fees, and a dispute window — built on a **factory pattern** so a single platform can issue agreements for property, vehicle, and yacht rentals and collect a fee on each.

Written in Solidity `0.8.24`, tested with Hardhat, built on OpenZeppelin v5.

```bash
npm install
npx hardhat compile
npx hardhat test          # 28 passing
npx hardhat run scripts/deploy.js   # local deploy with a mock price feed
```

---

## Live demo

**▶ [kevinleonsmith.github.io/rental-smart-contracts](https://kevinleonsmith.github.io/rental-smart-contracts)** — a browser dapp that reads these contracts **live** from Sepolia. It shows the on-chain template and listed property, prices a rental through the real `quote()` call (with a USD figure from the Chainlink ETH/USD feed), and — with a wallet on Sepolia — creates a funded escrow agreement end to end. No wallet needed to look around.

## Live on Sepolia

Deployed and running on the Ethereum **Sepolia** testnet:

| Contract | Address |
|---|---|
| `RentalAgreementFactory` | [`0x1940729Ab1351EbEDDf4c427d78e72fdebaF9D90`](https://sepolia.etherscan.io/address/0x1940729Ab1351EbEDDf4c427d78e72fdebaF9D90) |
| `RentalInsuranceManager` | [`0x21857F6365b701d3cFCd214921ea39c24236AE80`](https://sepolia.etherscan.io/address/0x21857F6365b701d3cFCd214921ea39c24236AE80) |
| `PropertyRentalAgreement` (impl) | [`0xe76A25956C048815279293c138991e0fe88b7C00`](https://sepolia.etherscan.io/address/0xe76A25956C048815279293c138991e0fe88b7C00) |
| `VehicleRentalAgreement` (impl) | [`0xcbEA05a90576FB14Dfb0D930f44A4d23f702575B`](https://sepolia.etherscan.io/address/0xcbEA05a90576FB14Dfb0D930f44A4d23f702575B) |
| `YachtRentalAgreement` (impl) | [`0x1529be9bBDC92Bf9A594Bd9D537Ecd09E8679C8d`](https://sepolia.etherscan.io/address/0x1529be9bBDC92Bf9A594Bd9D537Ecd09E8679C8d) |

All contracts are **source-verified** on Etherscan — click an address and open the
**Contract** tab to read the actual Solidity, not bytecode. The factory clones the right
per-category implementation (property / vehicle / yacht) for each rental, is seeded with
three templates and three demo properties, and uses the Chainlink ETH/USD feed at
`0x694AA1769357215DE4FAC081bf1f309aDC325306`. The insurance manager is wired into the
factory, so renting an insurance-required template (the vehicle and yacht demos) mints a
real policy on-chain in the same transaction.

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

### Contested-claim arbitration
Deposit deductions used to be approvable by *anyone* once the 7-day window passed — so a tenant who disagreed had no real recourse. Each agreement now carries a neutral **arbiter** (written in at creation; defaulted and owner-updatable on the factory). The tenant can `disputeDeduction()` within the window, which blocks the timeout auto-approval and routes the claim to the arbiter, who settles it with `resolveDeduction(id, awardToLandlord)` — the landlord receives the awarded portion and the remainder is refunded to the tenant. An unresolved dispute never locks funds: at the 30-day long-stop the contested amount releases to the tenant. Approval and resolution are both refused once the deposit has been released, closing a double-credit path.

### Insurance wired into the rental flow
`RentalInsuranceManager` used to be a standalone contract. Now, when a template is flagged `requiresInsurance`, creating a rental **mints a policy in the same transaction**. The factory derives the terms from the rental economics (coverage = rent + deposit, 5% deductible, `"comprehensive"`), `quote()` surfaces the premium as a fourth amount so the tenant pays escrow **plus** premium in one call, and the factory forwards the premium to the shared claims pool via `createPolicy` and links the policy to the new agreement. If a template requires insurance but no manager is configured, creation reverts rather than silently skipping cover.

> The **live Sepolia** factory above has the insurance manager wired in: the vehicle and yacht demo templates are flagged `requiresInsurance`, so renting one mints a real policy on-chain and the quote shows the premium as a separate line.

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

RentalInsuranceManager ─ policies, claims, pool-funded pull settlement (factory mints a policy per insured rental)
```

| Contract | Responsibility |
|---|---|
| `RentalAgreementFactory` | Owner-managed rental **templates** (deposit %, late/cancellation fees, duration bounds) and user-registered **properties**; deploys one escrow contract per rental and routes the 2.5% platform fee. |
| `RentalAgreement` | Holds funds; credits rent to landlord and fee to treasury; manages the security deposit with a 7-day deduction dispute window and timed release; pull-based withdrawals. |
| `PropertyRentalAgreement` | Residential/commercial lease extension. |
| `VehicleRentalAgreement` | Car rental; excess-mileage, refuelling and traffic-fine charges settled against the deposit. |
| `YachtRentalAgreement` | Maritime rental; usage logging, safety compliance, damage reports. |
| `RentalInsuranceManager` | Insurance pool: premium quoting, policy minting (the factory mints one per insured rental), claim filing, operator approval, pool-funded pull settlement. |

## Rental lifecycle

1. **Platform owner** creates a template (`createRentalTemplate`).
2. **Landlord** registers a property against a template (`registerProperty`).
3. **Tenant** calls `quote()`, then `createRentalAgreement{value: rent + deposit + fee + insurancePremium}()`. The factory clones and funds a dedicated `RentalAgreement`; rent → landlord, fee → treasury, deposit → escrow; if the template requires insurance the premium is forwarded to the insurance pool and a policy is minted against the new agreement; overpayment is refunded.
4. During/after the term: deductions (`requestDeduction` → tenant `approveDeduction`, or anyone after the 7-day window), early termination with a cancellation fee, or disputes.
5. **Settlement**: after the grace period the remaining deposit is credited to the tenant; every party calls `withdraw()`.

## Tests

`test/RentalAgreement.test.js` — 28 passing specs covering quoting math, the fund/refund flow, pull withdrawals, deposit release, tenant- and timeout-based deduction approval, contested-claim arbitration, early-termination fees, access control, the clone/implementation registry, the vehicle mileage charge via a factory clone, insurance minted inline with a rental, and an end-to-end insurance claim.

## Roadmap

Honest view of what's done and what's next:

- ✅ **Category-specific escrow at deploy time** *(done, live)*. The factory selects the agreement implementation by the template's `category` and deploys it as an EIP-1167 clone — see [Per-category agreements via minimal-proxy clones](#per-category-agreements-via-minimal-proxy-clones). Live on Sepolia with all three implementations registered and verified.
- ✅ **Contested-claim arbitration** *(done, live)*. A neutral arbiter resolves disputed deductions, and the tenant can contest a claim within the window to block timeout-approval — see [Contested-claim arbitration](#contested-claim-arbitration). Live on the Sepolia factory above.
- ✅ **Insurance wired into the rental flow** *(done, live)*. A template flagged `requiresInsurance` mints a policy as part of `createRentalAgreement`, and `quote()` surfaces the premium — see [Insurance wired into the rental flow](#insurance-wired-into-the-rental-flow). Live on the Sepolia factory above; the vehicle and yacht demos mint a real policy on each rental.
- **Subgraph + richer frontend.** Index `AgreementCreated` events so the demo lists real agreements and their lifecycle, rather than reading one address at a time.

## Security notes & scope

- Pull payments, checks-effects-interactions, `ReentrancyGuard`, `Pausable`, custom errors, OpenZeppelin `Ownable` v5.
- **Not audited.** This is a reference/portfolio implementation. Deposit deductions settle by tenant consent, a timeout, or — when contested — a neutral arbiter; a production system would likely decentralise that arbiter (a panel, a bonded escrow-oracle, or a Kleros-style court) rather than the single configurable address used here.
- Operating a real rental-payment platform may trigger money-transmission, insurance-licensing, and local tenancy-law obligations. Get legal review before mainnet.

## License

MIT
