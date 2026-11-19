const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Seeds a small multi-category catalog (property / vehicle / yacht) on the live
// factory so the web demo showcases every rental type the platform supports.
//
//   npx hardhat run scripts/seed-catalog.js --network sepolia
//
// Idempotent: templates and properties are matched by name and skipped if they
// already exist, so it is safe to re-run.
const DAY = 86400;

// category templates: [name, category, minDays, maxDays, depositBps, lateBps, cancelBps, requiresInsurance, allowsEarlyTermination]
const TEMPLATES = [
  ["Daily Car Rental", "vehicle", 1, 30, 2000, 500, 1000, true, true],
  ["Yacht Charter", "yacht", 1, 14, 5000, 1000, 3000, true, false],
];

// properties: [name, category, location, ethPerDay, templateName]
const PROPERTIES = [
  ["City Hatchback", "vehicle", "Berlin, DE", "0.0003", "Daily Car Rental"],
  ["Catamaran 44ft", "yacht", "Split, HR", "0.0009", "Yacht Charter"],
];

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const factory = await ethers.getContractAt(
    "RentalAgreementFactory",
    record.contracts.RentalAgreementFactory.address
  );

  // index existing templates by name -> id
  const tByName = {};
  const tCount = Number(await factory.templateCounter());
  for (let id = 1; id <= tCount; id++) {
    const t = await factory.rentalTemplates(id);
    tByName[t.name] = id;
  }

  for (const [name, cat, minD, maxD, dep, late, cancel, ins, early] of TEMPLATES) {
    if (tByName[name]) {
      console.log(`template "${name}" exists as #${tByName[name]}`);
      continue;
    }
    const tx = await factory.createRentalTemplate(
      name, cat, minD * DAY, maxD * DAY, dep, late, cancel, ins, early
    );
    await tx.wait();
    const id = Number(await factory.templateCounter());
    tByName[name] = id;
    console.log(`created template #${id} "${name}" (${cat})`);
  }

  // index existing properties by name
  const pNames = new Set();
  const pCount = Number(await factory.propertyCounter());
  for (let id = 1; id <= pCount; id++) {
    pNames.add((await factory.properties(id)).name);
  }

  for (const [name, cat, loc, rate, tplName] of PROPERTIES) {
    if (pNames.has(name)) {
      console.log(`property "${name}" already registered`);
      continue;
    }
    const tx = await factory.registerProperty(
      name, cat, loc, ethers.parseEther(rate), tByName[tplName], "ipfs://demo"
    );
    await tx.wait();
    const id = Number(await factory.propertyCounter());
    console.log(`registered property #${id} "${name}" (${cat}) @ ${rate} ETH/day`);
  }

  console.log("\nDone. Templates:", Number(await factory.templateCounter()),
    "| Properties:", Number(await factory.propertyCounter()));
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
