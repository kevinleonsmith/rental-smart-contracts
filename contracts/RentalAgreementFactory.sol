// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RentalAgreement, RentalInit} from "./RentalAgreement.sol";

/// @title RentalAgreementFactory
/// @notice Registry of rental templates + properties, and the deployer of
///         per-rental {RentalAgreement} escrow contracts. Collects the platform
///         fee on each rental.
contract RentalAgreementFactory is Ownable, Pausable, ReentrancyGuard {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant DAY = 1 days;

    struct RentalTemplate {
        string name;
        string category; // "yacht" | "property" | "vehicle" | ...
        uint256 minDuration;
        uint256 maxDuration;
        uint256 securityDepositBps;
        uint256 lateFeeBps;
        uint256 cancellationFeeBps;
        bool requiresInsurance;
        bool allowsEarlyTermination;
        bool isActive;
        uint256 createdAt;
    }

    struct Property {
        address owner;
        string name;
        string category;
        string location;
        uint256 dailyRate; // wei per day
        uint256 templateId;
        bool isAvailable;
        string metadataURI; // IPFS
    }

    mapping(uint256 => RentalTemplate) public rentalTemplates;
    mapping(uint256 => Property) public properties;
    mapping(address => uint256[]) public ownerProperties;
    mapping(address => address[]) public userAgreements;

    uint256 public templateCounter;
    uint256 public propertyCounter;
    uint256 public platformFeeBps = 250; // 2.5%
    address public platformTreasury;
    address public immutable priceFeed;

    event TemplateCreated(uint256 indexed templateId, string name, string category);
    event PropertyRegistered(uint256 indexed propertyId, address indexed owner, string name);
    event AgreementCreated(
        address indexed agreement,
        address indexed tenant,
        address indexed landlord,
        uint256 propertyId
    );
    event PlatformFeeUpdated(uint256 newBps);
    event TreasuryUpdated(address treasury);

    error InvalidTemplate();
    error InvalidProperty();
    error DurationOutOfRange();
    error InsufficientPayment(uint256 required, uint256 sent);

    constructor(address _priceFeed, address _platformTreasury) Ownable(msg.sender) {
        require(_platformTreasury != address(0), "zero treasury");
        priceFeed = _priceFeed;
        platformTreasury = _platformTreasury;
    }

    // --------------------------------------------------------------------- //
    //                              templates                                //
    // --------------------------------------------------------------------- //

    function createRentalTemplate(
        string calldata name,
        string calldata category,
        uint256 minDuration,
        uint256 maxDuration,
        uint256 securityDepositBps,
        uint256 lateFeeBps,
        uint256 cancellationFeeBps,
        bool requiresInsurance,
        bool allowsEarlyTermination
    ) external onlyOwner returns (uint256) {
        require(bytes(name).length > 0, "name required");
        require(minDuration > 0 && maxDuration >= minDuration, "bad duration");
        require(securityDepositBps <= 5_000, "deposit too high"); // <= 50%
        require(lateFeeBps <= 1_000, "late fee too high"); // <= 10%/day
        require(cancellationFeeBps <= BPS, "bad cancel bps");

        uint256 id = ++templateCounter;
        rentalTemplates[id] = RentalTemplate({
            name: name,
            category: category,
            minDuration: minDuration,
            maxDuration: maxDuration,
            securityDepositBps: securityDepositBps,
            lateFeeBps: lateFeeBps,
            cancellationFeeBps: cancellationFeeBps,
            requiresInsurance: requiresInsurance,
            allowsEarlyTermination: allowsEarlyTermination,
            isActive: true,
            createdAt: block.timestamp
        });
        emit TemplateCreated(id, name, category);
        return id;
    }

    function setTemplateActive(uint256 templateId, bool active) external onlyOwner {
        if (templateId == 0 || templateId > templateCounter) revert InvalidTemplate();
        rentalTemplates[templateId].isActive = active;
    }

    // --------------------------------------------------------------------- //
    //                              properties                               //
    // --------------------------------------------------------------------- //

    function registerProperty(
        string calldata name,
        string calldata category,
        string calldata location,
        uint256 dailyRate,
        uint256 templateId,
        string calldata metadataURI
    ) external returns (uint256) {
        require(bytes(name).length > 0, "name required");
        require(dailyRate > 0, "rate required");
        if (templateId == 0 || templateId > templateCounter) revert InvalidTemplate();
        require(rentalTemplates[templateId].isActive, "template inactive");

        uint256 id = ++propertyCounter;
        properties[id] = Property({
            owner: msg.sender,
            name: name,
            category: category,
            location: location,
            dailyRate: dailyRate,
            templateId: templateId,
            isAvailable: true,
            metadataURI: metadataURI
        });
        ownerProperties[msg.sender].push(id);
        emit PropertyRegistered(id, msg.sender, name);
        return id;
    }

    function setPropertyAvailability(uint256 propertyId, bool available) external {
        if (propertyId == 0 || propertyId > propertyCounter) revert InvalidProperty();
        require(properties[propertyId].owner == msg.sender, "not owner");
        properties[propertyId].isAvailable = available;
    }

    // --------------------------------------------------------------------- //
    //                              agreements                               //
    // --------------------------------------------------------------------- //

    /// @notice Quote the full amount a tenant must send for a rental window.
    function quote(
        uint256 propertyId,
        uint256 startTime,
        uint256 endTime
    ) public view returns (uint256 totalRent, uint256 securityDeposit, uint256 platformFee) {
        Property storage p = properties[propertyId];
        RentalTemplate storage t = rentalTemplates[p.templateId];
        uint256 duration = endTime - startTime;
        uint256 rentalDays = (duration / DAY) + 1; // round up partial days
        totalRent = p.dailyRate * rentalDays;
        securityDeposit = (totalRent * t.securityDepositBps) / BPS;
        platformFee = (totalRent * platformFeeBps) / BPS;
    }

    /// @notice Tenant creates and funds a rental agreement in one transaction.
    function createRentalAgreement(
        uint256 propertyId,
        uint256 startTime,
        uint256 endTime,
        string calldata tenantDetails
    ) external payable whenNotPaused nonReentrant returns (address) {
        if (propertyId == 0 || propertyId > propertyCounter) revert InvalidProperty();
        Property storage p = properties[propertyId];
        require(p.isAvailable, "unavailable");
        require(startTime >= block.timestamp, "start in past");
        require(endTime > startTime, "bad window");

        RentalTemplate storage t = rentalTemplates[p.templateId];
        uint256 duration = endTime - startTime;
        if (duration < t.minDuration || duration > t.maxDuration) revert DurationOutOfRange();

        (uint256 totalRent, uint256 securityDeposit, uint256 platformFee) = quote(
            propertyId,
            startTime,
            endTime
        );
        uint256 required = totalRent + securityDeposit + platformFee;
        if (msg.value < required) revert InsufficientPayment(required, msg.value);

        RentalAgreement agreementContract = new RentalAgreement(
            RentalInit({
                landlord: p.owner,
                tenant: msg.sender,
                propertyId: propertyId,
                templateId: p.templateId,
                startTime: startTime,
                endTime: endTime,
                totalRent: totalRent,
                securityDeposit: securityDeposit,
                platformFee: platformFee,
                cancellationFeeBps: t.cancellationFeeBps,
                allowsEarlyTermination: t.allowsEarlyTermination,
                platformTreasury: platformTreasury,
                priceFeed: priceFeed,
                tenantDetails: tenantDetails
            })
        );

        // Deliver exactly the escrow amount with a full gas budget.
        agreementContract.fundInitial{value: required}();

        userAgreements[msg.sender].push(address(agreementContract));
        userAgreements[p.owner].push(address(agreementContract));

        // Refund any overpayment to the tenant (pull would be safer, but the
        // tenant is an EOA here and this keeps the UX simple).
        uint256 refund = msg.value - required;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "refund failed");
        }

        emit AgreementCreated(address(agreementContract), msg.sender, p.owner, propertyId);
        return address(agreementContract);
    }

    // --------------------------------------------------------------------- //
    //                               admin/views                             //
    // --------------------------------------------------------------------- //

    function getUserAgreements(address user) external view returns (address[] memory) {
        return userAgreements[user];
    }

    function getOwnerProperties(address owner) external view returns (uint256[] memory) {
        return ownerProperties[owner];
    }

    function updatePlatformFee(uint256 newBps) external onlyOwner {
        require(newBps <= 1_000, "fee too high"); // <= 10%
        platformFeeBps = newBps;
        emit PlatformFeeUpdated(newBps);
    }

    function updateTreasury(address treasury) external onlyOwner {
        require(treasury != address(0), "zero treasury");
        platformTreasury = treasury;
        emit TreasuryUpdated(treasury);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
