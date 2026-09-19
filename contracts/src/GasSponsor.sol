// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title GasSponsor
/// @notice Sends the same amount of MON to many players in one transaction, so the house funds a
///         burst of arrivals with a single nonce instead of one transfer (and nonce race) per player.
contract GasSponsor {
    event Sponsored(address indexed player, uint256 amount);

    error BadValue();
    error TransferFailed(address player);

    function sponsor(address[] calldata players, uint256 each) external payable {
        if (msg.value != each * players.length) revert BadValue();
        for (uint256 i; i < players.length; ++i) {
            (bool ok,) = players[i].call{value: each}("");
            if (!ok) revert TransferFailed(players[i]);
            emit Sponsored(players[i], each);
        }
    }
}
