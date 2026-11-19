// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title RentalInsuranceManager
/// @notice Optional insurance layer for rental agreements: premium collection,
///         claim filing, operator approval, and pull-based settlement from a
///         shared claims pool.
contract RentalInsuranceManager is Ownable, ReentrancyGuard {
    struct Policy {
        address agreementContract;
        string policyType; // "basic" | "comprehensive" | "premium"
        uint256 coverage;
        uint256 deductible;
        uint256 premium;
        bool active;
        uint256 startTime;
        uint256 endTime;
    }

    struct Claim {
        address claimant;
        string incidentType;
        uint256 claimedAmount;
        string evidence; // IPFS
        bool approved;
        bool settled;
        uint256 settledAmount;
        uint256 filedAt;
        uint256 settledAt;
    }

    mapping(uint256 => Policy) public policies;
    mapping(address => uint256) public agreementToPolicy;
    mapping(uint256 => Claim[]) public policyClaims;
    mapping(address => uint256) public pendingWithdrawals;

    uint256 public policyCounter;
    uint256 public claimsPool;

    event PolicyCreated(uint256 indexed policyId, address indexed agreement, string policyType);
    event ClaimFiled(uint256 indexed policyId, uint256 indexed claimId, uint256 claimedAmount);
    event ClaimApproved(uint256 indexed policyId, uint256 indexed claimId, uint256 payout);
    event ClaimSettled(uint256 indexed policyId, uint256 indexed claimId, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    constructor() Ownable(msg.sender) {}

    function createPolicy(
        address agreementContract,
        string calldata policyType,
        uint256 coverage,
        uint256 deductible,
        uint256 duration
    ) external payable nonReentrant returns (uint256) {
        require(agreementContract != address(0), "zero agreement");
        require(coverage > 0, "coverage required");

        uint256 premium = quotePremium(policyType, coverage, duration);
        require(msg.value >= premium, "insufficient premium");

        uint256 id = ++policyCounter;
        policies[id] = Policy({
            agreementContract: agreementContract,
            policyType: policyType,
            coverage: coverage,
            deductible: deductible,
            premium: premium,
            active: true,
            startTime: block.timestamp,
            endTime: block.timestamp + duration
        });
        agreementToPolicy[agreementContract] = id;
        claimsPool += premium;

        uint256 refund = msg.value - premium;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "refund failed");
        }

        emit PolicyCreated(id, agreementContract, policyType);
        return id;
    }

    function quotePremium(
        string memory policyType,
        uint256 coverage,
        uint256 duration
    ) public pure returns (uint256) {
        uint256 base = coverage / 100; // 1% of coverage
        uint256 dailyMultiplier = duration / 1 days;
        bytes32 t = keccak256(bytes(policyType));
        if (t == keccak256("comprehensive")) {
            base = (base * 150) / 100;
        } else if (t == keccak256("premium")) {
            base = (base * 200) / 100;
        }
        return base * dailyMultiplier;
    }

    function fileClaim(
        uint256 policyId,
        string calldata incidentType,
        uint256 claimedAmount,
        string calldata evidence
    ) external returns (uint256) {
        require(policyId > 0 && policyId <= policyCounter, "bad policy");
        Policy storage p = policies[policyId];
        require(p.active, "inactive");
        require(block.timestamp <= p.endTime, "expired");
        require(claimedAmount <= p.coverage, "exceeds coverage");

        policyClaims[policyId].push(
            Claim({
                claimant: msg.sender,
                incidentType: incidentType,
                claimedAmount: claimedAmount,
                evidence: evidence,
                approved: false,
                settled: false,
                settledAmount: 0,
                filedAt: block.timestamp,
                settledAt: 0
            })
        );
        uint256 claimId = policyClaims[policyId].length - 1;
        emit ClaimFiled(policyId, claimId, claimedAmount);
        return claimId;
    }

    /// @notice Operator approves a claim; payout (net of deductible) is credited
    ///         to the claimant's withdrawal balance.
    function approveClaim(
        uint256 policyId,
        uint256 claimId,
        uint256 approvedAmount
    ) external onlyOwner {
        require(claimId < policyClaims[policyId].length, "bad claim");
        Claim storage c = policyClaims[policyId][claimId];
        require(!c.approved, "already approved");
        require(approvedAmount <= c.claimedAmount, "exceeds claim");

        Policy storage p = policies[policyId];
        require(approvedAmount <= p.coverage, "exceeds coverage");

        uint256 payout = approvedAmount > p.deductible ? approvedAmount - p.deductible : 0;
        require(payout <= claimsPool, "pool underfunded");

        c.approved = true;
        c.settled = true;
        c.settledAmount = payout;
        c.settledAt = block.timestamp;
        if (payout > 0) {
            claimsPool -= payout;
            pendingWithdrawals[c.claimant] += payout;
        }

        emit ClaimApproved(policyId, claimId, payout);
        emit ClaimSettled(policyId, claimId, payout);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawal(msg.sender, amount);
    }

    function getPolicyClaims(uint256 policyId) external view returns (Claim[] memory) {
        return policyClaims[policyId];
    }

    function addFundsToPool() external payable onlyOwner {
        claimsPool += msg.value;
    }
}
