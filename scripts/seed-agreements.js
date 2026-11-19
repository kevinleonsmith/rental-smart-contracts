// Seeds a couple of live rental agreements so the demo's "Agreements on-chain"
// section shows real, readable lifecycle data (an uninsured property rental and
// an insured vehicle rental that mints a policy). Idempotent: if the deployer
// already has agreements, it does nothing.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [signer] = await ethers.getSigners();
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const factoryAddr = rec.contracts.RentalAgreementFactory.address;
  const factory = await ethers.getContractAt("RentalAgreementFactory", factoryAddr);

  console.log(`Network: ${network.name}`);
  console.log(`Factory: ${factoryAddr}`);
  console.log(`Signer : ${signer.address}\n`);

  const existing = await factory.getUserAgreements(signer.address);
  if (existing.length > 0) {
    console.log(`Already ${existing.length} agreement(s) for this address — nothing to seed.`);
    return;
  }

  // (propertyId, days) — property #1 is uninsured, vehicle #2 requires insurance.
  const toSeed = [
    { propertyId: 1, days: 7, label: "property (uninsured)" },
    { propertyId: 2, days: 5, label: "vehicle (insured — mints a policy)" },
  ];

  for (const s of toSeed) {
    const start = Math.floor(Date.now() / 1000) + 1800; // 30 min out
    const end = start + s.days * 86400;
    const [rent, deposit, fee, premium] = await factory.quote(s.propertyId, start, end);
    const value = rent + deposit + fee + premium;
    console.log(
      `Renting property #${s.propertyId} [${s.label}] for ${s.days}d — ` +
        `sending ${ethers.formatEther(value)} ETH` +
        (premium > 0n ? ` (incl. ${ethers.formatEther(premium)} premium)` : "")
    );
    const tx = await factory.createRentalAgreement(s.propertyId, start, end, "demo seed", { value });
    const rc = await tx.wait();
    // Pull the new agreement address out of the AgreementCreated event.
    let created = null;
    for (const log of rc.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === "AgreementCreated") created = parsed.args.agreement;
      } catch (_) {}
    }
    console.log(`  -> agreement ${created} (block ${rc.blockNumber})\n`);
  }

  const all = await factory.getUserAgreements(signer.address);
  console.log(`Done. ${all.length} agreement(s) now visible on-chain.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
