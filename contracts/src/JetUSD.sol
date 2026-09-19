// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title JetUSD
/// @notice 6-decimal test dollar for the rocket game. Only the game can mint (payouts, faucet)
///         and burn (bets), so playing never needs an approval: one transaction per action.
contract JetUSD is ERC20 {
    address public immutable game;

    error OnlyGame();

    constructor(address game_) ERC20("JetX Test USD", "USDC") {
        game = game_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != game) revert OnlyGame();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != game) revert OnlyGame();
        _burn(from, amount);
    }
}
