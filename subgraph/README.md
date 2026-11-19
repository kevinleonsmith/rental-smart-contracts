# Subgraph — rental escrow on Sepolia

A [The Graph](https://thegraph.com) subgraph that indexes the `RentalAgreementFactory`
and **every agreement clone it deploys**, so a frontend can query all rentals and their
full lifecycle (status, deductions, disputes, arbitration, insurance) with one GraphQL
call instead of scanning logs and reading each contract one at a time.

> The live demo at the repo root works **without** this subgraph — it indexes the same
> events client-side straight from an RPC, so the page has no external dependency. This
> package is the production-grade version of that indexing: deploy it yourself and point a
> frontend at the resulting GraphQL endpoint.

## How it's built

- **`schema.graphql`** — `Agreement`, `Deduction`, `Dispute`, `Template`, `Property`, and a
  `Platform` singleton with running totals.
- **`subgraph.yaml`** — one static data source (the factory) plus a **template** data source
  for `RentalAgreement`. The factory's `handleAgreementCreated` calls
  `RentalAgreementTemplate.create(address)` to spin up a dynamic data source for each new
  clone, so no agreement address is hard-coded.
- **`src/factory.ts` / `src/agreement.ts`** — the mapping handlers (AssemblyScript).

One deliberate detail: `AgreementFunded` is emitted *before* `AgreementCreated` in the same
transaction, so a data source created on `AgreementCreated` can't backfill it. The factory
handler therefore reads the funded terms (and the template id) directly from the new clone
with a contract call, and the dynamic data source takes over for all later lifecycle events.

## Build it

```bash
cd subgraph
npm install
npm run codegen      # generate types from schema + ABIs
npm run build        # compile mappings to WASM
```

`codegen` reads the two ABIs in `abis/` (exported from the Hardhat artifacts) and the
`schema.graphql`; `build` type-checks and compiles `src/*.ts`.

## Deploy it (Graph Studio / decentralized network)

The Graph's free hosted service was retired, so a public endpoint means your own subgraph
in [Graph Studio](https://thegraph.com/studio/):

```bash
# 1. create a subgraph named "rental-smart-contracts" in Graph Studio, then:
graph auth <your-studio-deploy-key>
npm run deploy
```

Addresses and the start block live in `networks.json` (and `subgraph.yaml`). After
publishing, query the endpoint:

```graphql
{
  agreements(orderBy: createdAt, orderDirection: desc) {
    id
    tenant
    landlord
    status
    totalRent
    securityDeposit
    insured
    insurancePremium
    deductions { reason amount approved disputed resolved }
    disputes { raiser reason raisedAt }
  }
  platform(id: "platform") {
    agreementCount
    totalEscrowed
    totalInsurancePremiums
  }
}
```

## Local graph-node (optional)

With a local `graph-node` + IPFS (see The Graph docs), `npm run create-local` then
`npm run deploy-local`.
