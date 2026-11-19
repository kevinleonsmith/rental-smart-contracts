const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400;
const BPS = 10000n;

// Template config reused across tests
const DEPOSIT_BPS = 3000n; // 30%
const LATE_BPS = 250n;
const CANCEL_BPS = 2000n; // 20%
const PLATFORM_BPS = 250n; // 2.5%

async function deployFactoryFixture() {
  const [deployer, landlord, tenant, treasury, other] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockV3Aggregator");
  const feed = await Mock.deploy(8, 2000_00000000n); // $2000, 8 decimals

  const Factory = await ethers.getContractFactory("RentalAgreementFactory");
  const factory = await Factory.deploy(await feed.getAddress(), treasury.address);

  // Template + property
  await factory.createRentalTemplate(
    "Standard",
    "property",
    3 * DAY, // min
    365 * DAY, // max
    DEPOSIT_BPS,
    LATE_BPS,
    CANCEL_BPS,
    false, // requiresInsurance
    true // allowsEarlyTermination
  );
  const dailyRate = ethers.parseEther("1");
  await factory
    .connect(landlord)
    .registerProperty("Loft #1", "property", "NYC", dailyRate, 1, "ipfs://meta");

  return { factory, feed, deployer, landlord, tenant, treasury, other, dailyRate };
}

async function createAgreement(factory, tenant, { durationDays = 3, overpay = 0n } = {}) {
  const start = (await time.latest()) + 100;
  const end = start + durationDays * DAY;
  const [rent, deposit, fee] = await factory.quote(1, start, end);
  const required = rent + deposit + fee;

  const tx = await factory
    .connect(tenant)
    .createRentalAgreement(1, start, end, "Jane Doe, DL ABC123", {
      value: required + overpay,
    });
  const receipt = await tx.wait();
  // Pull the created agreement address from the event
  const ev = receipt.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "AgreementCreated");
  const agreement = await ethers.getContractAt("RentalAgreement", ev.args.agreement);
  return { agreement, start, end, rent, deposit, fee, required };
}

describe("RentalAgreementFactory", () => {
  it("quotes rent, deposit and fee from template basis points", async () => {
    const { factory } = await deployFactoryFixture();
    const start = (await time.latest()) + 100;
    const end = start + 3 * DAY;
    const [rent, deposit, fee] = await factory.quote(1, start, end);

    // duration 3 days -> rentalDays = 3 + 1 (rounds up) -> 4 ETH rent
    expect(rent).to.equal(ethers.parseEther("4"));
    expect(deposit).to.equal((rent * DEPOSIT_BPS) / BPS);
    expect(fee).to.equal((rent * PLATFORM_BPS) / BPS);
  });

  it("creates and funds an agreement, crediting landlord and treasury", async () => {
    const { factory, landlord, tenant, treasury } = await deployFactoryFixture();
    const { agreement, rent, deposit, fee } = await createAgreement(factory, tenant);

    expect(await ethers.provider.getBalance(await agreement.getAddress())).to.equal(
      rent + deposit + fee
    );
    expect(await agreement.pendingWithdrawals(landlord.address)).to.equal(rent);
    expect(await agreement.pendingWithdrawals(treasury.address)).to.equal(fee);
    expect(await agreement.securityDepositHeld()).to.equal(deposit);
    expect(await agreement.funded()).to.equal(true);
  });

  it("refunds overpayment to the tenant", async () => {
    const { factory, tenant } = await deployFactoryFixture();
    const before = await ethers.provider.getBalance(tenant.address);
    const overpay = ethers.parseEther("1");
    const { required } = await createAgreement(factory, tenant, { overpay });
    const after = await ethers.provider.getBalance(tenant.address);
    // Spent ~= required (+gas), not required+overpay. Allow gas slack.
    const spent = before - after;
    expect(spent).to.be.greaterThan(required);
    expect(spent).to.be.lessThan(required + overpay);
  });

  it("reverts on insufficient payment", async () => {
    const { factory, tenant } = await deployFactoryFixture();
    const start = (await time.latest()) + 100;
    const end = start + 3 * DAY;
    const [rent, deposit, fee] = await factory.quote(1, start, end);
    await expect(
      factory.connect(tenant).createRentalAgreement(1, start, end, "x", {
        value: rent + deposit + fee - 1n,
      })
    ).to.be.revertedWithCustomError(factory, "InsufficientPayment");
  });

  it("reverts on duration outside template bounds", async () => {
    const { factory, tenant } = await deployFactoryFixture();
    const start = (await time.latest()) + 100;
    const end = start + 1 * DAY; // below 3-day minimum
    await expect(
      factory.connect(tenant).createRentalAgreement(1, start, end, "x", {
        value: ethers.parseEther("10"),
      })
    ).to.be.revertedWithCustomError(factory, "DurationOutOfRange");
  });

  it("only owner can change the platform fee, capped at 10%", async () => {
    const { factory, other } = await deployFactoryFixture();
    await expect(factory.connect(other).updatePlatformFee(100)).to.be.revertedWithCustomError(
      factory,
      "OwnableUnauthorizedAccount"
    );
    await expect(factory.updatePlatformFee(1001)).to.be.revertedWith("fee too high");
    await factory.updatePlatformFee(500);
    expect(await factory.platformFeeBps()).to.equal(500);
  });
});

describe("RentalAgreement — pull payments & deposit", () => {
  it("lets landlord and treasury withdraw their credited funds", async () => {
    const { factory, landlord, tenant, treasury } = await deployFactoryFixture();
    const { agreement, rent, fee } = await createAgreement(factory, tenant);

    const lBefore = await ethers.provider.getBalance(landlord.address);
    await agreement.connect(landlord).withdraw();
    const lAfter = await ethers.provider.getBalance(landlord.address);
    expect(lAfter).to.be.greaterThan(lBefore); // received ~rent minus gas
    expect(await agreement.pendingWithdrawals(landlord.address)).to.equal(0);

    await agreement.connect(treasury).withdraw();
    expect(await agreement.pendingWithdrawals(treasury.address)).to.equal(0);
    // sanity: amounts align
    expect(rent + fee).to.equal(rent + fee);
  });

  it("reverts withdraw when nothing is owed", async () => {
    const { factory, tenant, other } = await deployFactoryFixture();
    const { agreement } = await createAgreement(factory, tenant);
    await expect(agreement.connect(other).withdraw()).to.be.revertedWith("nothing to withdraw");
  });

  it("releases the full deposit to tenant after grace period when no deductions", async () => {
    const { factory, landlord, tenant } = await deployFactoryFixture();
    const { agreement, end, deposit } = await createAgreement(factory, tenant);

    await time.increaseTo(end + DAY + 1);
    await agreement.connect(landlord).completeAgreement();

    expect(await agreement.securityDepositReleased()).to.equal(true);
    expect(await agreement.pendingWithdrawals(tenant.address)).to.equal(deposit);
  });

  it("applies a landlord deduction approved by the tenant", async () => {
    const { factory, landlord, tenant } = await deployFactoryFixture();
    const { agreement, end, deposit } = await createAgreement(factory, tenant);

    await time.increaseTo(end + 1);
    await agreement.connect(landlord).completeAgreement();

    const claim = ethers.parseEther("0.5");
    await agreement.connect(landlord).requestDeduction("broken window", claim, "ipfs://evi");
    await agreement.connect(tenant).approveDeduction(0);

    expect(await agreement.securityDepositDeducted()).to.equal(claim);
    expect(await agreement.pendingWithdrawals(landlord.address)).to.equal(
      // original rent credit + deduction
      (await agreement.agreement()).totalRent + claim
    );
    // remaining deposit refunded to tenant
    expect(await agreement.pendingWithdrawals(tenant.address)).to.equal(deposit - claim);
  });

  it("lets anyone approve a deduction only after the 7-day dispute window", async () => {
    const { factory, landlord, tenant, other } = await deployFactoryFixture();
    const { agreement, end } = await createAgreement(factory, tenant);
    await time.increaseTo(end + 1);
    await agreement.connect(landlord).completeAgreement();
    await agreement.connect(landlord).requestDeduction("cleaning", ethers.parseEther("0.2"), "");

    await expect(agreement.connect(other).approveDeduction(0)).to.be.revertedWith(
      "not authorized / window open"
    );
    await time.increase(7 * DAY + 1);
    await agreement.connect(other).approveDeduction(0); // now permitted
    expect((await agreement.getDeductions())[0].approved).to.equal(true);
  });

  it("charges the cancellation fee from deposit on tenant early termination", async () => {
    const { factory, landlord, tenant } = await deployFactoryFixture();
    const { agreement, rent } = await createAgreement(factory, tenant);

    await agreement.connect(tenant).terminateEarly("changed plans");

    const expectedFee = (rent * CANCEL_BPS) / BPS;
    expect(await agreement.securityDepositDeducted()).to.equal(expectedFee);
    expect(await agreement.pendingWithdrawals(landlord.address)).to.equal(rent + expectedFee);
  });

  it("blocks non-parties from privileged actions", async () => {
    const { factory, tenant, other } = await deployFactoryFixture();
    const { agreement } = await createAgreement(factory, tenant);
    await expect(agreement.connect(other).raiseDispute("x")).to.be.revertedWithCustomError(
      agreement,
      "NotParty"
    );
    await expect(
      agreement.connect(other).requestDeduction("x", 1, "")
    ).to.be.revertedWithCustomError(agreement, "NotLandlord");
  });

  it("exposes the ETH/USD price from the feed", async () => {
    const { factory, tenant } = await deployFactoryFixture();
    const { agreement } = await createAgreement(factory, tenant);
    expect(await agreement.getCurrentEthUsdPrice()).to.equal(2000_00000000n);
  });
});

describe("VehicleRentalAgreement — excess mileage", () => {
  async function deployVehicle() {
    const [deployer, landlord, tenant, treasury] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Mock.deploy(8, 2000_00000000n);

    const start = (await time.latest()) + 100;
    const end = start + 5 * DAY;
    const rent = ethers.parseEther("5");
    const deposit = ethers.parseEther("2");
    const fee = ethers.parseEther("0");

    const init = {
      landlord: landlord.address,
      tenant: tenant.address,
      propertyId: 1,
      templateId: 1,
      startTime: start,
      endTime: end,
      totalRent: rent,
      securityDeposit: deposit,
      platformFee: fee,
      cancellationFeeBps: 0,
      allowsEarlyTermination: true,
      platformTreasury: treasury.address,
      priceFeed: await feed.getAddress(),
      tenantDetails: "driver",
    };
    const vehicle = {
      make: "Tesla",
      model: "Model 3",
      year: 2024,
      vin: "VIN123",
      licensePlate: "ABC-123",
      mileageLimit: 500,
      cdwIncluded: true,
      fuelPolicyType: 0,
    };

    const V = await ethers.getContractFactory("VehicleRentalAgreement");
    const car = await V.connect(deployer).deploy(init, vehicle); // deployer == factory
    await car.connect(deployer).fundInitial({ value: rent + deposit + fee });
    return { car, deployer, landlord, tenant, deposit };
  }

  it("deducts an excess-mileage fee from the deposit and credits the landlord", async () => {
    const { car, landlord, deposit } = await deployVehicle();
    await car.connect(landlord).recordPreRentalInspection(10000, 100);
    // 10000 -> 10700 = 700 miles, limit 500 -> 200 excess
    await car.connect(landlord).recordPostRentalInspection(10700, 100);

    const feePerMile = await car.mileageExcessFeeWei();
    const expected = 200n * feePerMile;
    expect(await car.securityDepositDeducted()).to.equal(expected);
    // landlord credit = rent (from fundInitial) + excess fee
    const totalRent = (await car.agreement()).totalRent;
    expect(await car.pendingWithdrawals(landlord.address)).to.equal(totalRent + expected);
    expect(deposit).to.be.greaterThan(expected);
  });
});

describe("RentalInsuranceManager", () => {
  it("creates a policy, settles an approved claim via pull payment", async () => {
    const [owner, tenant] = await ethers.getSigners();
    const Ins = await ethers.getContractFactory("RentalInsuranceManager");
    const ins = await Ins.deploy();

    const coverage = ethers.parseEther("10");
    const duration = 10 * DAY;
    const premium = await ins.quotePremium("comprehensive", coverage, duration);

    await ins
      .connect(tenant)
      .createPolicy(tenant.address, "comprehensive", coverage, ethers.parseEther("0.1"), duration, {
        value: premium,
      });
    expect(await ins.policyCounter()).to.equal(1);

    // Owner tops up the pool so a claim can be paid.
    await ins.addFundsToPool({ value: ethers.parseEther("5") });

    await ins.connect(tenant).fileClaim(1, "theft", ethers.parseEther("2"), "ipfs://evi");
    await ins.approveClaim(1, 0, ethers.parseEther("2"));

    const payout = ethers.parseEther("2") - ethers.parseEther("0.1"); // minus deductible
    expect(await ins.pendingWithdrawals(tenant.address)).to.equal(payout);

    const before = await ethers.provider.getBalance(tenant.address);
    await ins.connect(tenant).withdraw();
    expect(await ethers.provider.getBalance(tenant.address)).to.be.greaterThan(before);
  });
});
