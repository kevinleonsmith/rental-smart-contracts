// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/// @notice Immutable terms + funding instructions handed to a new agreement.
/// @dev Grouped into a struct so the factory and specialised agreements avoid
///      long positional constructor argument lists.
struct RentalInit {
    address landlord;
    address tenant;
    uint256 propertyId;
    uint256 templateId;
    uint256 startTime;
    uint256 endTime;
    uint256 totalRent;
    uint256 securityDeposit;
    uint256 platformFee;
    uint256 cancellationFeeBps; // basis points of totalRent charged on tenant early-exit
    bool allowsEarlyTermination;
    address platformTreasury;
    address priceFeed;
    address arbiter; // neutral party that resolves contested deposit deductions
    string tenantDetails;
}

/// @title RentalAgreement
/// @notice Escrow + lifecycle for a single rental: holds the security deposit,
///         pays rent to the landlord, and arbitrates deposit deductions with a
///         tenant dispute window.
/// @dev Payments use the pull-over-push pattern: funds are credited to an
///      internal ledger and the recipient withdraws them, so a reverting or
///      gas-griefing recipient can never block another party's funds.
contract RentalAgreement is Initializable, ReentrancyGuard, Pausable {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant DISPUTE_WINDOW = 7 days;
    uint256 internal constant DEPOSIT_GRACE = 1 days;
    uint256 internal constant FINAL_RELEASE = 30 days;
    uint256 internal constant LATE_FEE_BPS_PER_DAY = 250; // 2.5%/day

    enum AgreementStatus {
        Active,
        Completed,
        Terminated,
        Disputed
    }
    enum PaymentStatus {
        Pending,
        Paid,
        Late
    }

    struct AgreementDetails {
        address landlord;
        address tenant;
        uint256 propertyId;
        uint256 templateId;
        uint256 startTime;
        uint256 endTime;
        uint256 totalRent;
        uint256 securityDeposit;
        uint256 platformFee;
        uint256 cancellationFeeBps;
        bool allowsEarlyTermination;
        string tenantDetails;
        AgreementStatus status;
        uint256 createdAt;
    }

    struct Payment {
        uint256 amount;
        uint256 dueDate;
        PaymentStatus status;
        uint256 paidAt;
        uint256 lateFees;
    }

    struct Deduction {
        string reason;
        uint256 amount;
        string evidence; // IPFS hash
        bool approved;
        bool disputed; // tenant contested this claim within the window
        bool resolved; // settled by the arbiter
        uint256 createdAt;
    }

    AgreementDetails public agreement;
    Payment[] public payments;
    Deduction[] public deductions;

    // Set once in initialize(): these are per-clone storage, not immutables,
    // because EIP-1167 clones run no constructor and cannot carry immutables.
    address public factory;
    address public platformTreasury;
    address public arbiter;
    IAggregatorV3 public ethUsdPriceFeed;

    uint256 public securityDepositHeld;
    uint256 public securityDepositDeducted;
    bool public securityDepositReleased;
    bool public funded;

    /// @notice Pull-payment ledger: amount each address may withdraw.
    mapping(address => uint256) public pendingWithdrawals;

    event AgreementFunded(uint256 rent, uint256 deposit, uint256 platformFee);
    event PaymentMade(uint256 indexed paymentId, uint256 amount, uint256 lateFees);
    event LateFeeApplied(uint256 indexed paymentId, uint256 lateFee);
    event DeductionRequested(uint256 indexed deductionId, string reason, uint256 amount);
    event DeductionApproved(uint256 indexed deductionId, uint256 amount);
    event DeductionDisputed(uint256 indexed deductionId, address indexed tenant, string reason);
    event DeductionResolved(uint256 indexed deductionId, uint256 toLandlord, uint256 toTenant);
    event SecurityDepositReleased(address indexed tenant, uint256 amount);
    event AgreementStatusChanged(AgreementStatus status, uint256 at);
    event DisputeRaised(address indexed raiser, string reason);
    event Withdrawal(address indexed account, uint256 amount);

    error NotLandlord();
    error NotTenant();
    error NotParty();
    error NotArbiter();
    error NotFactory();
    error AlreadyFunded();
    error WrongFundingAmount(uint256 expected, uint256 received);
    error InvalidState();

    modifier onlyLandlord() {
        if (msg.sender != agreement.landlord) revert NotLandlord();
        _;
    }
    modifier onlyTenant() {
        if (msg.sender != agreement.tenant) revert NotTenant();
        _;
    }
    modifier onlyParties() {
        if (msg.sender != agreement.landlord && msg.sender != agreement.tenant) revert NotParty();
        _;
    }
    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    /// @dev Locks the implementation contract so only clones (which start with
    ///      fresh storage) can be initialized — the implementation itself can't.
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize a freshly-deployed clone. Called once by the factory
    ///         immediately after cloning, in the same transaction as funding.
    /// @dev Replaces the old constructor so the contract is EIP-1167 clonable.
    ///      Subclasses override this to add category-specific setup, calling
    ///      {__RentalAgreement_init} for the shared base state.
    function initialize(RentalInit memory init) public virtual initializer {
        __RentalAgreement_init(init);
    }

    function __RentalAgreement_init(RentalInit memory init) internal onlyInitializing {
        require(init.landlord != address(0) && init.tenant != address(0), "zero party");
        require(init.endTime > init.startTime, "bad window");
        require(init.cancellationFeeBps <= BPS, "bad cancel bps");

        factory = msg.sender;
        platformTreasury = init.platformTreasury;
        arbiter = init.arbiter;
        ethUsdPriceFeed = IAggregatorV3(init.priceFeed);

        agreement = AgreementDetails({
            landlord: init.landlord,
            tenant: init.tenant,
            propertyId: init.propertyId,
            templateId: init.templateId,
            startTime: init.startTime,
            endTime: init.endTime,
            totalRent: init.totalRent,
            securityDeposit: init.securityDeposit,
            platformFee: init.platformFee,
            cancellationFeeBps: init.cancellationFeeBps,
            allowsEarlyTermination: init.allowsEarlyTermination,
            tenantDetails: init.tenantDetails,
            status: AgreementStatus.Active,
            createdAt: block.timestamp
        });

        // Single up-front payment due at the start of the rental period.
        payments.push(
            Payment({
                amount: init.totalRent,
                dueDate: init.startTime,
                status: PaymentStatus.Paid, // settled by the initial funding
                paidAt: block.timestamp,
                lateFees: 0
            })
        );
    }

    /// @notice Called once by the deployer/factory to deliver the escrowed funds.
    /// @dev Separated from `receive()` so the funding path has a full gas budget
    ///      (the old `.transfer()`-into-`receive()` design reverts on-chain). Rent
    ///      is credited to the landlord, the fee to the treasury, and the deposit
    ///      is retained in escrow — all via the pull ledger.
    function fundInitial() external payable {
        if (msg.sender != factory) revert NotFactory();
        if (funded) revert AlreadyFunded();

        uint256 expected = agreement.totalRent + agreement.securityDeposit + agreement.platformFee;
        if (msg.value != expected) revert WrongFundingAmount(expected, msg.value);

        funded = true;
        securityDepositHeld = agreement.securityDeposit;

        pendingWithdrawals[agreement.landlord] += agreement.totalRent;
        if (agreement.platformFee > 0) {
            pendingWithdrawals[platformTreasury] += agreement.platformFee;
        }

        emit AgreementFunded(agreement.totalRent, agreement.securityDeposit, agreement.platformFee);
        emit PaymentMade(0, agreement.totalRent, 0);
    }

    /// @notice Withdraw funds credited to the caller (pull-payment pattern).
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0; // effects before interaction
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawal(msg.sender, amount);
    }

    /// @notice Settle an additional scheduled payment (for installment setups).
    /// @dev Kept for multi-installment extensions; late fees accrue per day.
    function makePayment(uint256 paymentId) external payable onlyTenant nonReentrant {
        require(paymentId < payments.length, "bad payment id");
        Payment storage p = payments[paymentId];
        require(p.status != PaymentStatus.Paid, "already paid");

        if (block.timestamp > p.dueDate && p.lateFees == 0) {
            uint256 daysLate = ((block.timestamp - p.dueDate) / 1 days) + 1;
            p.lateFees = (p.amount * LATE_FEE_BPS_PER_DAY * daysLate) / BPS;
            p.status = PaymentStatus.Late;
            emit LateFeeApplied(paymentId, p.lateFees);
        }

        uint256 due = p.amount + p.lateFees;
        require(msg.value >= due, "insufficient payment");

        p.status = PaymentStatus.Paid;
        p.paidAt = block.timestamp;

        uint256 fee = (p.amount * agreement.platformFee) / (agreement.totalRent == 0 ? 1 : agreement.totalRent);
        pendingWithdrawals[agreement.landlord] += due - fee;
        if (fee > 0) pendingWithdrawals[platformTreasury] += fee;
        if (msg.value > due) pendingWithdrawals[msg.sender] += msg.value - due;

        emit PaymentMade(paymentId, p.amount, p.lateFees);
    }

    /// @notice Landlord marks the rental complete once the period has ended.
    function completeAgreement() external onlyLandlord {
        require(block.timestamp >= agreement.endTime, "period not ended");
        require(agreement.status == AgreementStatus.Active, "not active");

        agreement.status = AgreementStatus.Completed;
        emit AgreementStatusChanged(AgreementStatus.Completed, block.timestamp);

        if (deductions.length == 0) {
            _tryReleaseDeposit();
        }
    }

    /// @notice Landlord requests a deduction from the security deposit with evidence.
    function requestDeduction(
        string calldata reason,
        uint256 amount,
        string calldata evidence
    ) external onlyLandlord {
        require(
            agreement.status == AgreementStatus.Completed || block.timestamp >= agreement.endTime,
            "not ended"
        );
        require(amount > 0 && amount <= securityDepositHeld - securityDepositDeducted, "bad amount");
        require(bytes(reason).length > 0, "reason required");

        deductions.push(
            Deduction({
                reason: reason,
                amount: amount,
                evidence: evidence,
                approved: false,
                disputed: false,
                resolved: false,
                createdAt: block.timestamp
            })
        );
        emit DeductionRequested(deductions.length - 1, reason, amount);
    }

    /// @notice Approve a deduction — by the tenant, or by anyone once the 7-day
    ///         dispute window has elapsed without a dispute.
    /// @dev A disputed claim can no longer be approved this way; only the
    ///      {arbiter} can settle it via {resolveDeduction}.
    function approveDeduction(uint256 deductionId) external {
        require(deductionId < deductions.length, "bad id");
        require(!securityDepositReleased, "deposit released");
        Deduction storage d = deductions[deductionId];
        require(!d.approved && !d.resolved, "already settled");
        require(!d.disputed, "disputed - arbiter must resolve");
        require(
            msg.sender == agreement.tenant || block.timestamp >= d.createdAt + DISPUTE_WINDOW,
            "not authorized / window open"
        );

        _applyDeduction(deductionId, d.amount);
        _checkAllDeductionsSettled();
    }

    /// @notice Tenant contests a specific deduction within the dispute window,
    ///         blocking the timeout auto-approval and routing it to the arbiter.
    function disputeDeduction(uint256 deductionId, string calldata reason) external onlyTenant {
        require(deductionId < deductions.length, "bad id");
        Deduction storage d = deductions[deductionId];
        require(!d.approved && !d.resolved, "already settled");
        require(!d.disputed, "already disputed");
        require(block.timestamp < d.createdAt + DISPUTE_WINDOW, "window closed");

        d.disputed = true;
        agreement.status = AgreementStatus.Disputed;
        emit DeductionDisputed(deductionId, msg.sender, reason);
        emit DisputeRaised(msg.sender, reason);
    }

    /// @notice Neutral arbiter settles a contested deduction, awarding part (or
    ///         all) of the claim to the landlord; the remainder stays in the
    ///         deposit and is refunded to the tenant at release.
    /// @param awardToLandlord Portion of the claimed amount granted to the landlord.
    function resolveDeduction(uint256 deductionId, uint256 awardToLandlord) external onlyArbiter {
        require(deductionId < deductions.length, "bad id");
        require(!securityDepositReleased, "deposit released");
        Deduction storage d = deductions[deductionId];
        require(d.disputed, "not disputed");
        require(!d.resolved && !d.approved, "already settled");
        require(awardToLandlord <= d.amount, "over claim");

        uint256 available = securityDepositHeld - securityDepositDeducted;
        if (awardToLandlord > available) awardToLandlord = available;

        d.resolved = true;
        d.approved = awardToLandlord == d.amount; // marks the claim fully upheld
        if (awardToLandlord > 0) {
            securityDepositDeducted += awardToLandlord;
            pendingWithdrawals[agreement.landlord] += awardToLandlord;
        }

        emit DeductionResolved(deductionId, awardToLandlord, d.amount - awardToLandlord);
        _checkAllDeductionsSettled();
    }

    /// @notice Tenant-triggered final release after the long stop, if nothing else released it.
    function releaseSecurityDeposit() external {
        require(block.timestamp >= agreement.endTime + FINAL_RELEASE, "too early");
        _releaseDeposit();
    }

    /// @notice Either party ends the rental early (if the template permits it).
    function terminateEarly(string calldata reason) external onlyParties {
        require(agreement.status == AgreementStatus.Active, "not active");
        require(agreement.allowsEarlyTermination, "not allowed");

        // Tenant-initiated early exit incurs the cancellation fee from the deposit.
        if (msg.sender == agreement.tenant && agreement.cancellationFeeBps > 0) {
            uint256 fee = (agreement.totalRent * agreement.cancellationFeeBps) / BPS;
            uint256 available = securityDepositHeld - securityDepositDeducted;
            if (fee > available) fee = available;
            if (fee > 0) {
                securityDepositDeducted += fee;
                pendingWithdrawals[agreement.landlord] += fee;
            }
        }

        agreement.status = AgreementStatus.Terminated;
        emit AgreementStatusChanged(AgreementStatus.Terminated, block.timestamp);
        emit DisputeRaised(msg.sender, reason);
        _tryReleaseDeposit();
    }

    /// @notice Raise a dispute, freezing automated release.
    function raiseDispute(string calldata reason) external onlyParties {
        require(agreement.status == AgreementStatus.Active, "not active");
        require(bytes(reason).length > 0, "reason required");
        agreement.status = AgreementStatus.Disputed;
        emit DisputeRaised(msg.sender, reason);
        emit AgreementStatusChanged(AgreementStatus.Disputed, block.timestamp);
    }

    // --------------------------------------------------------------------- //
    //                          internal helpers                             //
    // --------------------------------------------------------------------- //

    /// @dev Shared by base + extensions to move funds from deposit to landlord.
    function _applyDeduction(uint256 deductionId, uint256 amount) internal {
        if (deductionId < deductions.length) deductions[deductionId].approved = true;
        securityDepositDeducted += amount;
        pendingWithdrawals[agreement.landlord] += amount;
        emit DeductionApproved(deductionId, amount);
    }

    /// @dev Credit an automatic fee/charge against the deposit (used by extensions).
    /// @return applied The amount actually deducted (capped at the remaining deposit).
    function _deductFromDeposit(uint256 amount) internal returns (uint256 applied) {
        uint256 available = securityDepositHeld - securityDepositDeducted;
        applied = amount > available ? available : amount;
        if (applied > 0) {
            securityDepositDeducted += applied;
            pendingWithdrawals[agreement.landlord] += applied;
        }
    }

    function _checkAllDeductionsSettled() internal {
        for (uint256 i = 0; i < deductions.length; i++) {
            // A claim is settled once approved or resolved by the arbiter.
            if (!deductions[i].approved && !deductions[i].resolved) return;
        }
        _releaseDeposit();
    }

    function _tryReleaseDeposit() internal {
        if (block.timestamp >= agreement.endTime + DEPOSIT_GRACE) {
            _releaseDeposit();
        }
    }

    function _releaseDeposit() internal {
        if (securityDepositReleased) return;
        uint256 refund = securityDepositHeld - securityDepositDeducted;
        securityDepositReleased = true;
        if (refund > 0) {
            pendingWithdrawals[agreement.tenant] += refund;
            emit SecurityDepositReleased(agreement.tenant, refund);
        }
    }

    // --------------------------------------------------------------------- //
    //                               views                                   //
    // --------------------------------------------------------------------- //

    function getPayments() external view returns (Payment[] memory) {
        return payments;
    }

    function getDeductions() external view returns (Deduction[] memory) {
        return deductions;
    }

    /// @notice Latest ETH/USD price from the configured feed (8 decimals on mainnet).
    function getCurrentEthUsdPrice() external view returns (int256) {
        (, int256 price, , , ) = ethUsdPriceFeed.latestRoundData();
        return price;
    }

    function pause() external onlyParties {
        _pause();
    }

    function unpause() external onlyParties {
        _unpause();
    }
}
