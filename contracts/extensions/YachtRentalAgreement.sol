// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RentalAgreement, RentalInit} from "../RentalAgreement.sol";

/// @title YachtRentalAgreement
/// @notice Maritime variant: usage logging, safety-compliance checks and damage
///         reporting with automatic deposit deductions for minor damage.
/// @dev The original draft pulled live weather via Chainlink's request/response
///      oracle (`ChainlinkClient`). That is omitted here to keep the contract
///      dependency-light and deterministically testable; an off-chain keeper or
///      a Chainlink Functions call can push weather via a dedicated setter in a
///      production deployment.
contract YachtRentalAgreement is RentalAgreement {
    uint256 internal constant AUTO_DEDUCT_CAP = 0.5 ether; // minor-damage auto-settle cap

    struct NavigationLimits {
        string allowedWaters; // "coastal" | "offshore" | "international"
        uint256 maxDistanceFromPort; // nautical miles
        bool nightNavigationAllowed;
    }

    struct SafetyRequirements {
        uint256 minimumCrewSize;
        bool captainRequired;
        uint256 maxGuestCapacity;
        bool alcoholPermitted;
    }

    struct UsageLog {
        uint256 timestamp;
        string location;
        uint256 fuelLevel;
        string crew;
        string notes;
    }

    struct DamageReport {
        string description;
        string category; // "minor" | "major" | "critical"
        uint256 estimatedCost;
        string evidence; // IPFS
        bool resolved;
        uint256 reportedAt;
    }

    NavigationLimits public navigationLimits;
    SafetyRequirements public safetyRequirements;
    UsageLog[] public usageLogs;
    DamageReport[] public damageReports;

    event UsageLogged(uint256 timestamp, string location);
    event SafetyViolation(string reason);
    event DamageReported(uint256 indexed reportId, string category, uint256 estimatedCost);

    constructor(
        RentalInit memory init,
        NavigationLimits memory _nav,
        SafetyRequirements memory _safety
    ) RentalAgreement(init) {
        navigationLimits = _nav;
        safetyRequirements = _safety;
    }

    function logUsage(
        string calldata location,
        uint256 fuelLevel,
        string calldata crew,
        string calldata notes
    ) external onlyTenant {
        require(
            block.timestamp >= agreement.startTime && block.timestamp <= agreement.endTime,
            "outside rental period"
        );
        usageLogs.push(
            UsageLog({
                timestamp: block.timestamp,
                location: location,
                fuelLevel: fuelLevel,
                crew: crew,
                notes: notes
            })
        );
        emit UsageLogged(block.timestamp, location);
    }

    function reportDamage(
        string calldata description,
        string calldata category,
        uint256 estimatedCost,
        string calldata evidence
    ) external onlyParties {
        require(bytes(description).length > 0, "description required");

        bool minor = keccak256(bytes(category)) == keccak256(bytes("minor"));
        bool autoSettled = false;

        // Auto-settle small, undisputed minor damage from the deposit.
        if (minor && estimatedCost <= AUTO_DEDUCT_CAP) {
            uint256 applied = _deductFromDeposit(estimatedCost);
            autoSettled = applied == estimatedCost;
        }

        damageReports.push(
            DamageReport({
                description: description,
                category: category,
                estimatedCost: estimatedCost,
                evidence: evidence,
                resolved: autoSettled,
                reportedAt: block.timestamp
            })
        );
        emit DamageReported(damageReports.length - 1, category, estimatedCost);
    }

    function checkSafetyCompliance(
        uint256 crewSize,
        uint256 guestCount,
        bool captainPresent,
        bool alcoholConsumed
    ) external returns (bool) {
        if (crewSize < safetyRequirements.minimumCrewSize) {
            emit SafetyViolation("insufficient crew");
            return false;
        }
        if (guestCount > safetyRequirements.maxGuestCapacity) {
            emit SafetyViolation("capacity exceeded");
            return false;
        }
        if (safetyRequirements.captainRequired && !captainPresent) {
            emit SafetyViolation("captain required");
            return false;
        }
        if (!safetyRequirements.alcoholPermitted && alcoholConsumed) {
            emit SafetyViolation("alcohol not permitted");
            return false;
        }
        return true;
    }

    function getUsageLogs() external view returns (UsageLog[] memory) {
        return usageLogs;
    }

    function getDamageReports() external view returns (DamageReport[] memory) {
        return damageReports;
    }
}
