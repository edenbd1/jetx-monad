// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {JetX} from "../src/JetX.sol";

/// @notice Deploys JetX (which deploys its JetUSD) owned by the house wallet.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address house = vm.addr(pk);
        vm.startBroadcast(pk);
        JetX game = new JetX(house);
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", block.number);
        vm.serializeAddress(o, "house", house);
        vm.serializeAddress(o, "usd", address(game.usd()));
        string memory out = vm.serializeAddress(o, "game", address(game));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console.log("JetX  ", address(game));
        console.log("JetUSD", address(game.usd()));
    }
}
