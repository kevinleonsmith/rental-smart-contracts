// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/// @title MockV3Aggregator
/// @notice Test double for a Chainlink price feed. Not for production use.
contract MockV3Aggregator is IAggregatorV3 {
    uint8 public immutable override decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public round;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        _set(_initialAnswer);
    }

    function updateAnswer(int256 _answer) external {
        _set(_answer);
    }

    function _set(int256 _answer) internal {
        answer = _answer;
        updatedAt = block.timestamp;
        round += 1;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (round, answer, updatedAt, updatedAt, round);
    }
}
