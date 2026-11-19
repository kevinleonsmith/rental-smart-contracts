// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RentalAgreement, RentalInit} from "../RentalAgreement.sol";

/// @title VehicleRentalAgreement
/// @notice Car-rental variant: pre/post inspection, excess-mileage & refuelling
///         charges, and traffic-violation fines — all settled against the
///         escrowed security deposit via the pull-payment ledger.
contract VehicleRentalAgreement is RentalAgreement {
    struct VehicleSpec {
        string make;
        string model;
        uint256 year;
        string vin;
        string licensePlate;
        uint256 mileageLimit; // miles included for the rental period
        bool cdwIncluded; // collision damage waiver
        uint256 fuelPolicyType; // 0 = full-to-full, 1 = full-to-empty, 2 = pre-purchase
    }

    struct UsageTracking {
        uint256 startMileage;
        uint256 endMileage;
        uint256 fuelLevelStart; // percentage
        uint256 fuelLevelEnd; // percentage
        bool preInspectionDone;
        bool postInspectionDone;
    }

    struct TrafficViolation {
        string violationType;
        uint256 fine;
        string location;
        uint256 timestamp;
        bool resolved;
    }

    VehicleSpec public vehicle;
    bool private _vehicleSet;
    UsageTracking public usage;
    TrafficViolation[] public trafficViolations;

    mapping(string => bool) public authorizedDrivers; // license number => authorized

    // Set in initialize(), not inline: inline field initializers run in the
    // constructor, which EIP-1167 clones skip — so a clone would otherwise read 0.
    uint256 public mileageExcessFeeWei; // per excess mile
    uint256 public refuelingFeeWei;

    event DriverAuthorized(string licenseNumber, bool authorized);
    event InspectionRecorded(bool isPre, uint256 mileage, uint256 fuelLevel);
    event ExcessMileageFeeApplied(uint256 excessMiles, uint256 fee);
    event RefuelingFeeApplied(uint256 fee);
    event TrafficViolationReported(uint256 indexed violationId, string violationType, uint256 fine);

    /// @notice Clone initializer (replaces the constructor). Called once by the
    ///         factory right after cloning this implementation.
    function initialize(RentalInit memory init) public override initializer {
        __RentalAgreement_init(init);
        mileageExcessFeeWei = 0.00025 ether; // per excess mile
        refuelingFeeWei = 0.02 ether;
    }

    /// @notice Landlord sets the vehicle specification once, after creation.
    function configureVehicle(VehicleSpec calldata _vehicle) external onlyLandlord {
        require(!_vehicleSet, "already configured");
        _vehicleSet = true;
        vehicle = _vehicle;
    }

    function authorizeDriver(string calldata licenseNumber, bool authorized) external onlyTenant {
        require(bytes(licenseNumber).length > 0, "license required");
        authorizedDrivers[licenseNumber] = authorized;
        emit DriverAuthorized(licenseNumber, authorized);
    }

    function recordPreRentalInspection(
        uint256 startMileage,
        uint256 fuelLevelStart
    ) external onlyLandlord {
        require(!usage.preInspectionDone, "already done");
        usage.startMileage = startMileage;
        usage.fuelLevelStart = fuelLevelStart;
        usage.preInspectionDone = true;
        emit InspectionRecorded(true, startMileage, fuelLevelStart);
    }

    function recordPostRentalInspection(
        uint256 endMileage,
        uint256 fuelLevelEnd
    ) external onlyLandlord {
        require(usage.preInspectionDone, "pre inspection missing");
        require(!usage.postInspectionDone, "already done");
        require(endMileage >= usage.startMileage, "end < start");

        usage.endMileage = endMileage;
        usage.fuelLevelEnd = fuelLevelEnd;
        usage.postInspectionDone = true;
        emit InspectionRecorded(false, endMileage, fuelLevelEnd);

        _applyUsageFees();
    }

    function _applyUsageFees() internal {
        uint256 miles = usage.endMileage - usage.startMileage;

        if (miles > vehicle.mileageLimit) {
            uint256 excess = miles - vehicle.mileageLimit;
            uint256 fee = excess * mileageExcessFeeWei;
            uint256 applied = _deductFromDeposit(fee);
            if (applied > 0) emit ExcessMileageFeeApplied(excess, applied);
        }

        if (vehicle.fuelPolicyType == 0 && usage.fuelLevelEnd < usage.fuelLevelStart) {
            uint256 applied = _deductFromDeposit(refuelingFeeWei);
            if (applied > 0) emit RefuelingFeeApplied(applied);
        }
    }

    function reportTrafficViolation(
        string calldata violationType,
        uint256 fine,
        string calldata location
    ) external onlyLandlord {
        uint256 applied = _deductFromDeposit(fine);
        trafficViolations.push(
            TrafficViolation({
                violationType: violationType,
                fine: fine,
                location: location,
                timestamp: block.timestamp,
                resolved: applied == fine && fine > 0
            })
        );
        emit TrafficViolationReported(trafficViolations.length - 1, violationType, fine);
    }

    function getTrafficViolations() external view returns (TrafficViolation[] memory) {
        return trafficViolations;
    }

    function getUsageSummary()
        external
        view
        returns (uint256 totalMiles, uint256 excessMiles, bool fuelCompliant, bool inspectionComplete)
    {
        if (usage.postInspectionDone) {
            totalMiles = usage.endMileage - usage.startMileage;
            excessMiles = totalMiles > vehicle.mileageLimit ? totalMiles - vehicle.mileageLimit : 0;
            fuelCompliant =
                vehicle.fuelPolicyType != 0 ||
                usage.fuelLevelEnd >= usage.fuelLevelStart;
            inspectionComplete = true;
        }
    }
}
