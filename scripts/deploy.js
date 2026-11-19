const { ethers, network } = require("hardhat");

// Chainlink ETH/USD feeds by network. Add more as needed.
const ETH_USD_FEEDS = {
  sepolia: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  mainnet: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address, "on", network.name);

  // On a local network, deploy a mock price feed; otherwise use the real one.
  let feedAddress = ETH_USD_FEEDS[network.name];
  if (!feedAddress) {
    const Mock = await ethers.getContractFactory("MockV3Aggregator");
    const mock = await Mock.deploy(8, 2000_00000000n);
    await mock.waitForDeployment();
    feedAddress = await mock.getAddress();
    console.log("Deployed MockV3Aggregator:", feedAddress);
  }

  const treasury = process.env.PLATFORM_TREASURY || deployer.address;

  const Factory = await ethers.getContractFactory("RentalAgreementFactory");
  const factory = await Factory.deploy(feedAddress, treasury);
  await factory.waitForDeployment();
  console.log("RentalAgreementFactory:", await factory.getAddress());

  const Insurance = await ethers.getContractFactory("RentalInsuranceManager");
  const insurance = await Insurance.deploy();
  await insurance.waitForDeployment();
  console.log("RentalInsuranceManager:", await insurance.getAddress());

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
  console.log("Seeded template #1");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
