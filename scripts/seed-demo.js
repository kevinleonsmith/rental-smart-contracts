const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Registers one demo property against the seeded template so the live
// deployment (and the web demo) has real, quotable on-chain data.
//
//   npx hardhat run scripts/seed-demo.js --network sepolia
//
// Idempotent-ish: if a property with the same name already exists it just
// prints it instead of registering a duplicate.
async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const factoryAddr = record.contracts.RentalAgreementFactory.address;

  const factory = await ethers.getContractAt("RentalAgreementFactory", factoryAddr);

  const NAME = "Seaside Loft";
  const count = Number(await factory.propertyCounter());
  for (let id = 1; id <= count; id++) {
    const p = await factory.properties(id);
    if (p.name === NAME) {
      console.log(`Property "${NAME}" already registered as #${id}`);
      return;
    }
  }

  // 0.0002 ETH/day keeps a full demo rental affordable on testnet.
  const dailyRate = ethers.parseEther("0.0002");
  const tx = await factory.registerProperty(
    NAME,
    "property",
    "Lisbon, PT",
    dailyRate,
    1, // template #1 (Standard Property Lease)
    "ipfs://demo"
  );
  console.log("registerProperty tx:", tx.hash);
  const receipt = await tx.wait();
  const newId = Number(await factory.propertyCounter());
  console.log(`Registered property #${newId} "${NAME}" in block ${receipt.blockNumber}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
