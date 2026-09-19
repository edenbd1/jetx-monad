// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GasSponsor} from "../src/GasSponsor.sol";

contract GasSponsorTest is Test {
    GasSponsor sponsor = new GasSponsor();

    function test_sponsorsEveryPlayerInOneCall() public {
        address[] memory players = new address[](25);
        for (uint256 i; i < players.length; ++i) players[i] = makeAddr(vm.toString(i));
        sponsor.sponsor{value: 25 * 0.2 ether}(players, 0.2 ether);
        for (uint256 i; i < players.length; ++i) assertEq(players[i].balance, 0.2 ether);
        assertEq(address(sponsor).balance, 0);
    }

    function test_rejectsWrongValue() public {
        address[] memory players = new address[](2);
        players[0] = makeAddr("a");
        players[1] = makeAddr("b");
        vm.expectRevert(GasSponsor.BadValue.selector);
        sponsor.sponsor{value: 0.3 ether}(players, 0.2 ether);
    }
}
