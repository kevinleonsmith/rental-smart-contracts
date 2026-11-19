// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RentalAgreement, RentalInit} from "../RentalAgreement.sol";

/// @title PropertyRentalAgreement
/// @notice Residential/commercial lease variant: maintenance requests,
///         inspections, utility readings and occupancy control.
contract PropertyRentalAgreement is RentalAgreement {
    struct PropertySpec {
        uint256 bedrooms;
        uint256 bathrooms;
        uint256 squareFootage;
        bool furnished;
        bool petsAllowed;
        uint256 maxOccupants;
    }

    struct MaintenanceRequest {
        string category; // "plumbing" | "electrical" | "hvac" | "general"
        string priority; // "low" | "medium" | "high" | "emergency"
        string description;
        string evidence; // IPFS
        bool completed;
        uint256 cost;
        uint256 requestedAt;
        uint256 completedAt;
    }

    struct InspectionReport {
        string inspectionType; // "move-in" | "periodic" | "move-out"
        string inspector;
        string findings;
        string evidence; // IPFS
        uint256 conductedAt;
    }

    PropertySpec public spec;
    MaintenanceRequest[] public maintenanceRequests;
    InspectionReport[] public inspectionReports;

    mapping(string => uint256) public utilityReadings;
    mapping(address => bool) public authorizedOccupants;

    event MaintenanceRequested(uint256 indexed requestId, string category, string priority);
    event MaintenanceCompleted(uint256 indexed requestId, uint256 cost);
    event InspectionScheduled(uint256 indexed inspectionId, string inspectionType);
    event InspectionSubmitted(uint256 indexed inspectionId);
    event UtilityReadingUpdated(string utilityType, uint256 reading);
    event OccupantAuthorized(address indexed occupant, bool authorized);

    constructor(RentalInit memory init, PropertySpec memory _spec) RentalAgreement(init) {
        spec = _spec;
        authorizedOccupants[init.tenant] = true;
    }

    function requestMaintenance(
        string calldata category,
        string calldata priority,
        string calldata description,
        string calldata evidence
    ) external onlyTenant {
        require(bytes(description).length > 0, "description required");
        maintenanceRequests.push(
            MaintenanceRequest({
                category: category,
                priority: priority,
                description: description,
                evidence: evidence,
                completed: false,
                cost: 0,
                requestedAt: block.timestamp,
                completedAt: 0
            })
        );
        emit MaintenanceRequested(maintenanceRequests.length - 1, category, priority);
    }

    function completeMaintenance(uint256 requestId, uint256 cost) external onlyLandlord {
        require(requestId < maintenanceRequests.length, "bad id");
        MaintenanceRequest storage r = maintenanceRequests[requestId];
        require(!r.completed, "already completed");
        r.completed = true;
        r.cost = cost;
        r.completedAt = block.timestamp;
        emit MaintenanceCompleted(requestId, cost);
    }

    function scheduleInspection(
        string calldata inspectionType,
        string calldata inspector
    ) external onlyLandlord {
        inspectionReports.push(
            InspectionReport({
                inspectionType: inspectionType,
                inspector: inspector,
                findings: "",
                evidence: "",
                conductedAt: 0
            })
        );
        emit InspectionScheduled(inspectionReports.length - 1, inspectionType);
    }

    function submitInspectionReport(
        uint256 inspectionId,
        string calldata findings,
        string calldata evidence
    ) external onlyLandlord {
        require(inspectionId < inspectionReports.length, "bad id");
        InspectionReport storage r = inspectionReports[inspectionId];
        require(r.conductedAt == 0, "already submitted");
        r.findings = findings;
        r.evidence = evidence;
        r.conductedAt = block.timestamp;
        emit InspectionSubmitted(inspectionId);
    }

    function updateUtilityReading(string calldata utilityType, uint256 reading) external onlyParties {
        utilityReadings[utilityType] = reading;
        emit UtilityReadingUpdated(utilityType, reading);
    }

    function authorizeOccupant(address occupant, bool authorized) external onlyLandlord {
        require(occupant != address(0), "zero address");
        authorizedOccupants[occupant] = authorized;
        emit OccupantAuthorized(occupant, authorized);
    }

    function getMaintenanceRequests() external view returns (MaintenanceRequest[] memory) {
        return maintenanceRequests;
    }

    function getInspectionReports() external view returns (InspectionReport[] memory) {
        return inspectionReports;
    }

    function checkOccupancyCompliance(
        address[] calldata currentOccupants
    ) external view returns (bool) {
        if (currentOccupants.length > spec.maxOccupants) return false;
        for (uint256 i = 0; i < currentOccupants.length; i++) {
            if (!authorizedOccupants[currentOccupants[i]]) return false;
        }
        return true;
    }
}
