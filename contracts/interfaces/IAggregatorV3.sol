// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IAggregatorV3
/// @notice Minimal Chainlink price-feed interface used for on-chain USD quoting.
/// @dev Declared locally so the project has no heavyweight external oracle
///      dependency; the mainnet ETH/USD feed satisfies the same interface.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
