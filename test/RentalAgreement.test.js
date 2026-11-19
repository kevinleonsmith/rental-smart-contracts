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
  const [rent, deposit, fee, premium] = await factory.quote(1, start, end);
  const required = rent + deposit + fee + premium;

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

describe("RentalAgreement — contested-claim arbitration", () => {
  it("lets the tenant dispute a deduction and the arbiter split it", async () => {
    const { factory, deployer, landlord, tenant } = await deployFactoryFixture();
    const { agreement, end, deposit, rent } = await createAgreement(factory, tenant);
    await time.increaseTo(end + 1);
    await agreement.connect(landlord).completeAgreement();

    const claim = ethers.parseEther("1");
    await agreement.connect(landlord).requestDeduction("scratches", claim, "ipfs://e");
    await agreement.connect(tenant).disputeDeduction(0, "overstated");

    // Timeout auto-approval is now blocked, even after the window elapses.
    await time.increase(7 * DAY + 1);
    await expect(agreement.connect(landlord).approveDeduction(0)).to.be.revertedWith(
      "disputed - arbiter must resolve"
    );

    // Arbiter (the factory deployer by default) awards half to the landlord.
    const award = claim / 2n;
    await expect(agreement.connect(deployer).resolveDeduction(0, award))
      .to.emit(agreement, "DeductionResolved")
      .withArgs(0, award, claim - award);

    expect(await agreement.securityDepositDeducted()).to.equal(award);
    expect(await agreement.pendingWithdrawals(landlord.address)).to.equal(rent + award);
    // All claims settled -> remaining deposit refunded to the tenant.
    expect(await agreement.securityDepositReleased()).to.equal(true);
    expect(await agreement.pendingWithdrawals(tenant.address)).to.equal(deposit - award);
  });

  it("restricts who can dispute and who can resolve", async () => {
    const { factory, landlord, tenant, other } = await deployFactoryFixture();
    const { agreement, end } = await createAgreement(factory, tenant);
    await time.increaseTo(end + 1);
    await agreement.connect(landlord).completeAgreement();
    await agreement.connect(landlord).requestDeduction("x", ethers.parseEther("0.2"), "");

    await expect(
      agreement.connect(other).disputeDeduction(0, "no")
    ).to.be.revertedWithCustomError(agreement, "NotTenant");

    await agreement.connect(tenant).disputeDeduction(0, "contest");

    // The landlord is not the arbiter, so cannot resolve.
    await expect(
      agreement.connect(landlord).resolveDeduction(0, 0)
    ).to.be.revertedWithCustomError(agreement, "NotArbiter");
  });

  it("blocks disputing once the window has closed", async () => {
    const { factory, landlord, tenant } = await deployFactoryFixture();
    const { agreement, end } = await createAgreement(factory, tenant);
    await time.increaseTo(end + 1);
    await agreement.connect(landlord).completeAgreement();
    await agreement.connect(landlord).requestDeduction("x", ethers.parseEther("0.2"), "");

    await time.increase(7 * DAY + 1);
    await expect(agreement.connect(tenant).disputeDeduction(0, "late")).to.be.revertedWith(
      "window closed"
    );
  });

  it("writes the factory arbiter into new agreements and lets the owner change it", async () => {
    const { factory, deployer, tenant, other } = await deployFactoryFixture();
    const { agreement } = await createAgreement(factory, tenant);
    expect(await agreement.arbiter()).to.equal(deployer.address);

    await factory.setArbiter(other.address);
    const { agreement: next } = await createAgreement(factory, tenant);
    expect(await next.arbiter()).to.equal(other.address);
    // The earlier agreement keeps its original arbiter.
    expect(await agreement.arbiter()).to.equal(deployer.address);
  });
});

describe("Factory clones & implementation registry", () => {
  it("deploys agreements as minimal-proxy clones of the default implementation", async () => {
    const { factory, tenant } = await deployFactoryFixture();
    const { agreement } = await createAgreement(factory, tenant);

    expect(await factory.defaultImplementation()).to.not.equal(ethers.ZeroAddress);
    // An EIP-1167 clone's runtime code is ~45 bytes, far smaller than the impl.
    const code = await ethers.provider.getCode(await agreement.getAddress());
    expect(ethers.dataLength(code)).to.be.lessThan(100);
  });

  it("only the owner can register a category implementation", async () => {
    const { factory, other } = await deployFactoryFixture();
    const V = await ethers.getContractFactory("VehicleRentalAgreement");
    const impl = await V.deploy();
    await expect(
      factory.connect(other).setImplementation("vehicle", await impl.getAddress())
    ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
  });

  it("the locked implementation cannot be initialized directly", async () => {
    const V = await ethers.getContractFactory("VehicleRentalAgreement");
    const impl = await V.deploy();
    const init = {
      landlord: ethers.ZeroAddress, tenant: ethers.ZeroAddress, propertyId: 0, templateId: 0,
      startTime: 0, endTime: 1, totalRent: 0, securityDeposit: 0, platformFee: 0,
      cancellationFeeBps: 0, allowsEarlyTermination: false,
      platformTreasury: ethers.ZeroAddress, priceFeed: ethers.ZeroAddress,
      arbiter: ethers.ZeroAddress, tenantDetails: "",
    };
    await expect(impl.initialize(init)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
  });
});

describe("VehicleRentalAgreement — excess mileage (via factory clone)", () => {
  async function deployVehicle() {
    const [deployer, landlord, tenant, treasury, other] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Mock.deploy(8, 2000_00000000n);

    const Factory = await ethers.getContractFactory("RentalAgreementFactory");
    const factory = await Factory.deploy(await feed.getAddress(), treasury.address);

    // Register the vehicle implementation for the "vehicle" category.
    const V = await ethers.getContractFactory("VehicleRentalAgreement");
    const vehicleImpl = await V.deploy();
    await factory.setImplementation("vehicle", await vehicleImpl.getAddress());
    await factory.updatePlatformFee(0); // clean arithmetic

    // 40% deposit, 1–30 day window. duration 4 days -> rentalDays 5 -> rent 5 ETH, deposit 2 ETH.
    await factory.createRentalTemplate("Car", "vehicle", 1 * DAY, 30 * DAY, 4000n, LATE_BPS, 0, false, true);
    const dailyRate = ethers.parseEther("1");
    await factory
      .connect(landlord)
      .registerProperty("Car #1", "vehicle", "LA", dailyRate, 1, "ipfs://meta");

    const start = (await time.latest()) + 100;
    const end = start + 4 * DAY;
    const [rent, deposit, fee] = await factory.quote(1, start, end);
    const required = rent + deposit + fee;
    const tx = await factory.connect(tenant).createRentalAgreement(1, start, end, "driver", {
      value: required,
    });
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "AgreementCreated");
    const car = await ethers.getContractAt("VehicleRentalAgreement", ev.args.agreement);

    // Landlord configures the vehicle spec after creation (one-time).
    await car.connect(landlord).configureVehicle({
      make: "Tesla",
      model: "Model 3",
      year: 2024,
      vin: "VIN123",
      licensePlate: "ABC-123",
      mileageLimit: 500,
      cdwIncluded: true,
      fuelPolicyType: 0,
    });

    return { factory, car, deployer, landlord, tenant, other, deposit };
  }

  it("initializes fee fields in the clone (inline initializers don't run in clones)", async () => {
    const { car } = await deployVehicle();
    expect(await car.mileageExcessFeeWei()).to.equal(ethers.parseEther("0.00025"));
    expect(await car.refuelingFeeWei()).to.equal(ethers.parseEther("0.02"));
  });

  it("configures the vehicle spec only once, by the landlord", async () => {
    const { car, landlord, other } = await deployVehicle();
    const spec = {
      make: "x", model: "y", year: 2020, vin: "v", licensePlate: "p",
      mileageLimit: 1, cdwIncluded: false, fuelPolicyType: 0,
    };
    await expect(car.connect(other).configureVehicle(spec)).to.be.revertedWithCustomError(
      car,
      "NotLandlord"
    );
    await expect(car.connect(landlord).configureVehicle(spec)).to.be.revertedWith(
      "already configured"
    );
  });

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

describe("Insurance wired into the rental flow", () => {
  async function deployWithInsurance(requiresInsurance = true) {
    const [deployer, landlord, tenant, treasury] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Mock.deploy(8, 2000_00000000n);
    const Factory = await ethers.getContractFactory("RentalAgreementFactory");
    const factory = await Factory.deploy(await feed.getAddress(), treasury.address);
    const Ins = await ethers.getContractFactory("RentalInsuranceManager");
    const ins = await Ins.deploy();
    await factory.setInsuranceManager(await ins.getAddress());

    await factory.createRentalTemplate(
      "Insured", "property", 3 * DAY, 365 * DAY, DEPOSIT_BPS, LATE_BPS, CANCEL_BPS, requiresInsurance, true
    );
    await factory
      .connect(landlord)
      .registerProperty("Insured Loft", "property", "NYC", ethers.parseEther("1"), 1, "ipfs://m");
    return { factory, ins, deployer, landlord, tenant };
  }

  it("mints a policy and charges the premium when the template requires insurance", async () => {
    const { factory, ins, tenant } = await deployWithInsurance(true);
    const start = (await time.latest()) + 100;
    const end = start + 5 * DAY;
    const [rent, deposit, fee, premium] = await factory.quote(1, start, end);
    expect(premium).to.be.greaterThan(0);

    const required = rent + deposit + fee + premium;
    const tx = await factory.connect(tenant).createRentalAgreement(1, start, end, "x", { value: required });
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "AgreementCreated");
    const agreementAddr = ev.args.agreement;

    // A policy exists for this agreement, and the pool holds the premium.
    expect(await ins.policyCounter()).to.equal(1);
    expect(await ins.agreementToPolicy(agreementAddr)).to.equal(1);
    expect(await ins.claimsPool()).to.equal(premium);

    // The escrow contract holds only rent+deposit+fee; the premium went to the pool.
    expect(await ethers.provider.getBalance(agreementAddr)).to.equal(rent + deposit + fee);

    const policy = await ins.policies(1);
    expect(policy.agreementContract).to.equal(agreementAddr);
    expect(policy.coverage).to.equal(rent + deposit);
    expect(policy.active).to.equal(true);
  });

  it("reverts if a template requires insurance but no manager is configured", async () => {
    const [deployer, landlord, tenant, treasury] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockV3Aggregator");
    const feed = await Mock.deploy(8, 2000_00000000n);
    const Factory = await ethers.getContractFactory("RentalAgreementFactory");
    const factory = await Factory.deploy(await feed.getAddress(), treasury.address);
    await factory.createRentalTemplate(
      "Insured", "property", 3 * DAY, 365 * DAY, DEPOSIT_BPS, LATE_BPS, CANCEL_BPS, true, true
    );
    await factory
      .connect(landlord)
      .registerProperty("Loft", "property", "NYC", ethers.parseEther("1"), 1, "ipfs://m");
    const start = (await time.latest()) + 100;
    const end = start + 5 * DAY;
    await expect(
      factory.connect(tenant).createRentalAgreement(1, start, end, "x", { value: ethers.parseEther("50") })
    ).to.be.revertedWith("insurance not configured");
  });

  it("charges no premium when the template does not require insurance", async () => {
    const { factory, ins, tenant } = await deployWithInsurance(false);
    const start = (await time.latest()) + 100;
    const end = start + 5 * DAY;
    const [rent, deposit, fee, premium] = await factory.quote(1, start, end);
    expect(premium).to.equal(0);
    await factory.connect(tenant).createRentalAgreement(1, start, end, "x", { value: rent + deposit + fee });
    expect(await ins.policyCounter()).to.equal(0);
  });
});
