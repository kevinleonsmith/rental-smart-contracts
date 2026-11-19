const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Chainlink ETH/USD feeds by network. Add more as needed.
const ETH_USD_FEEDS = {
  sepolia: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  mainnet: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
};

const EXPLORERS = {
  sepolia: "https://sepolia.etherscan.io/address/",
  mainnet: "https://etherscan.io/address/",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployer account. Set PRIVATE_KEY (and SEPOLIA_RPC_URL) in .env before deploying to a live network."
    );
  }
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

  // On a local network, deploy a mock price feed; otherwise use the real one.
  let feedAddress = ETH_USD_FEEDS[network.name];
  if (!feedAddress) {
    const Mock = await ethers.getContractFactory("MockV3Aggregator");
    const mock = await Mock.deploy(8, 2000_00000000n);
    await mock.waitForDeployment();
    feedAddress = await mock.getAddress();
    console.log("MockV3Aggregator:      ", feedAddress);
  } else {
    console.log("ETH/USD price feed:    ", feedAddress, "(Chainlink)");
  }

  const treasury = process.env.PLATFORM_TREASURY || deployer.address;

  const Factory = await ethers.getContractFactory("RentalAgreementFactory");
  const factory = await Factory.deploy(feedAddress, treasury);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("RentalAgreementFactory:", factoryAddr);

  // Deploy one agreement implementation per category and register it so the
  // factory clones the right subclass (EIP-1167) for each rental.
  const implementations = {};
  for (const [contractName, category] of [
    ["PropertyRentalAgreement", "property"],
    ["VehicleRentalAgreement", "vehicle"],
    ["YachtRentalAgreement", "yacht"],
  ]) {
    const Impl = await ethers.getContractFactory(contractName);
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    const addr = await impl.getAddress();
    const tx = await factory.setImplementation(category, addr);
    await tx.wait();
    implementations[category] = addr;
    console.log(`  ${category.padEnd(8)} -> ${contractName} @ ${addr}`);
  }

  const Insurance = await ethers.getContractFactory("RentalInsuranceManager");
  const insurance = await Insurance.deploy();
  await insurance.waitForDeployment();
  const insuranceAddr = await insurance.getAddress();
  console.log("RentalInsuranceManager:", insuranceAddr);

  // Seed one example template so the deployment is immediately usable.
  const tx = await factory.createRentalTemplate(
    "Standard Property Lease",
    "property",
    3 * 86400,
    365 * 86400,
    3000, // 30% deposit
    250, // 2.5%/day late fee
    2000, // 20% cancellation
    false,
    true
  );
  await tx.wait();
  console.log("\nSeeded template #1 (Standard Property Lease)");

  // Persist addresses + constructor args for verification and the README.
  const record = {
    network: network.name,
    deployer: deployer.address,
    treasury,
    contracts: {
      RentalAgreementFactory: { address: factoryAddr, args: [feedAddress, treasury] },
      RentalInsuranceManager: { address: insuranceAddr, args: [] },
    },
    implementations,
    priceFeed: feedAddress,
    timestamp: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(record, null, 2));

  const explorer = EXPLORERS[network.name];
  if (explorer) {
    console.log("\nExplorer links:");
    console.log("  Factory:   " + explorer + factoryAddr);
    console.log("  Insurance: " + explorer + insuranceAddr);
    console.log("\nVerify with:");
    console.log(
      `  npx hardhat verify --network ${network.name} ${factoryAddr} ${feedAddress} ${treasury}`
    );
    console.log(`  npx hardhat verify --network ${network.name} ${insuranceAddr}`);
  }
  console.log(`\nSaved deployments/${network.name}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
