// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {JetX} from "../src/JetX.sol";
import {JetUSD} from "../src/JetUSD.sol";

contract JetXTest is Test {
    address house = makeAddr("house");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    JetX game;
    JetUSD usd;

    function setUp() public {
        game = new JetX(house);
        usd = game.usd();
        vm.prank(alice);
        game.faucet();
    }

    function _launch(address who, uint256 bet) internal returns (uint256 id, uint32 crash) {
        vm.prank(who);
        id = game.launch(bet);
        crash = game.getRound(id).crash;
    }

    /// Rolls blocks until a flight with a crash point of at least `min` comes up.
    function _launchAtLeast(address who, uint256 bet, uint32 min) internal returns (uint256 id, uint32 crash) {
        for (uint256 i; i < 200; ++i) {
            vm.roll(block.number + 1);
            vm.prevrandao(bytes32(uint256(keccak256(abi.encode(i, min)))));
            (id, crash) = _launch(who, bet);
            if (crash >= min) return (id, crash);
            vm.prank(who);
            game.settle(id);
        }
        revert("no high flight");
    }

    function test_faucet() public {
        assertEq(usd.balanceOf(alice), 1_000e6);
        vm.prank(alice);
        vm.expectRevert(JetX.NotBroke.selector);
        game.faucet();
    }

    function test_launchBurnsBetAndDrawsCrash() public {
        (uint256 id, uint32 crash) = _launch(alice, 10e6);
        assertEq(usd.balanceOf(alice), 990e6);
        assertGe(crash, 100);
        assertLe(crash, game.maxMultiplier());
        JetX.Round memory r = game.getRound(id);
        assertEq(r.player, alice);
        assertEq(r.bet, 10e6);
        assertEq(uint8(r.status), uint8(JetX.Status.Flying));
        assertEq(game.activeRound(alice), id);
    }

    function test_cashOutPaysBetTimesMultiplier() public {
        (uint256 id, uint32 crash) = _launchAtLeast(alice, 10e6, 250);
        uint256 before = usd.balanceOf(alice);
        vm.prank(alice);
        uint256 payout = game.cashOut(id, 250);
        assertEq(payout, 25e6);
        assertEq(usd.balanceOf(alice), before + 25e6);
        assertEq(game.activeRound(alice), 0);
        assertEq(game.getRound(id).cashedAt, 250);
        assertEq(game.recentCrashes()[0], crash);
        assertEq(game.bestCashOut(), 250);
        assertEq(game.bestCashOutBy(), alice);
    }

    function test_cannotCashOutAboveCrash() public {
        (uint256 id, uint32 crash) = _launch(alice, 10e6);
        vm.prank(alice);
        vm.expectRevert(JetX.AboveCrash.selector);
        game.cashOut(id, crash + 1);
    }

    function test_cannotCashOutTwiceOrSomeoneElses() public {
        (uint256 id,) = _launchAtLeast(alice, 10e6, 150);
        vm.prank(bob);
        vm.expectRevert(JetX.NotYourRound.selector);
        game.cashOut(id, 120);
        vm.prank(alice);
        game.cashOut(id, 120);
        vm.prank(alice);
        vm.expectRevert(JetX.NotFlying.selector);
        game.cashOut(id, 120);
    }

    function test_settleLoses() public {
        (uint256 id, uint32 crash) = _launch(alice, 10e6);
        vm.prank(alice);
        game.settle(id);
        assertEq(uint8(game.getRound(id).status), uint8(JetX.Status.Crashed));
        assertEq(usd.balanceOf(alice), 990e6);
        assertEq(game.recentCrashes()[0], crash);
        vm.prank(alice);
        vm.expectRevert(JetX.NotFlying.selector);
        game.cashOut(id, 100);
    }

    function test_relaunchForfeitsUnfinishedFlight() public {
        (uint256 first,) = _launch(alice, 10e6);
        (uint256 second,) = _launch(alice, 5e6);
        assertEq(uint8(game.getRound(first).status), uint8(JetX.Status.Crashed));
        assertEq(game.activeRound(alice), second);
        assertEq(usd.balanceOf(alice), 985e6);
    }

    function test_abandonedFlightsCanBeClosedByAnyoneLater() public {
        (uint256 id,) = _launch(alice, 10e6);
        vm.prank(bob);
        vm.expectRevert(JetX.StillFlying.selector);
        game.settle(id);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(bob);
        game.settle(id);
        assertEq(game.activeRound(alice), 0);
    }

    function test_betLimits() public {
        vm.startPrank(alice);
        vm.expectRevert(JetX.BadBet.selector);
        game.launch(0.01e6);
        vm.expectRevert(JetX.BadBet.selector);
        game.launch(uint256(type(uint96).max) + 1);
        vm.stopPrank();
    }

    function test_betIsOnlyLimitedByBalance() public {
        vm.prank(house);
        game.grant(alice, 49_000e6);
        vm.startPrank(alice);
        vm.expectRevert();
        game.launch(50_001e6);
        uint256 id = game.launch(50_000e6);
        vm.stopPrank();
        assertEq(usd.balanceOf(alice), 0);
        assertEq(game.getRound(id).bet, 50_000e6);
    }

    function test_onlyGameMovesTokensAndOnlyHouseGrants() public {
        vm.expectRevert(JetUSD.OnlyGame.selector);
        usd.mint(alice, 1);
        vm.expectRevert();
        game.grant(bob, 1e6);
        vm.prank(house);
        game.grant(bob, 50e6);
        assertEq(usd.balanceOf(bob), 50e6);
    }

    function test_recentCrashesNewestFirstAndCapped() public {
        uint32[] memory seen = new uint32[](25);
        for (uint256 i; i < 25; ++i) {
            vm.roll(block.number + 1);
            (uint256 id, uint32 crash) = _launch(alice, 1e6);
            vm.prank(alice);
            game.settle(id);
            seen[i] = crash;
        }
        uint32[] memory recent = game.recentCrashes();
        assertEq(recent.length, 20);
        for (uint256 i; i < 20; ++i) {
            assertEq(recent[i], seen[24 - i]);
        }
    }

    /// Empirical check of the boosted curve P(crash >= x) = 0.985 / (1 + (x - 1) / 1.5).
    /// @dev Share of 4000 flights (per mille) reaching 2x, 5x, 10x, busting at 1.00x and hitting the cap.
    function _distribution() internal returns (uint256[5] memory permille) {
        vm.prank(house);
        game.grant(alice, 100_000e6);
        uint256 n = 4000;
        for (uint256 i; i < n; ++i) {
            vm.roll(block.number + 1);
            vm.prevrandao(bytes32(i * 7919 + 1));
            (uint256 id, uint32 crash) = _launch(alice, 1e6);
            if (crash >= 200) ++permille[0];
            if (crash >= 500) ++permille[1];
            if (crash >= 1000) ++permille[2];
            if (crash == 100) ++permille[3];
            assertLe(crash, 5_000, "above the 50x cap");
            if (crash == 5_000) ++permille[4];
            vm.prank(alice);
            game.settle(id);
        }
        for (uint256 k; k < 5; ++k) {
            permille[k] = permille[k] * 1000 / n;
        }
    }

    function test_crashDistribution() public {
        uint256[5] memory d = _distribution();
        // Expected: 59.1% >= 2x, 26.9% >= 5x, 14.1% >= 10x, 1.5% instant busts, 2.9% on the 50x cap.
        assertApproxEqAbs(d[0], 591, 30);
        assertApproxEqAbs(d[1], 269, 25);
        assertApproxEqAbs(d[2], 141, 20);
        assertApproxEqAbs(d[3], 15, 8);
        assertApproxEqAbs(d[4], 29, 10);
    }

    /// @notice The curve the live testnet game runs: setCurve(9900, 25000).
    function test_liveCurveDistribution() public {
        vm.prank(house);
        game.setCurve(9_900, 25_000);
        uint256[5] memory d = _distribution();
        // Expected: 70.7% >= 2x, 38.1% >= 5x, 21.5% >= 10x, 1% instant busts, 4.8% on the 50x cap.
        assertApproxEqAbs(d[0], 707, 30);
        assertApproxEqAbs(d[1], 381, 25);
        assertApproxEqAbs(d[2], 215, 20);
        assertApproxEqAbs(d[3], 10, 7);
        assertApproxEqAbs(d[4], 48, 12);
    }

    function test_houseCanTuneTheCurveWithinBounds() public {
        assertEq(game.rtpBps(), 9_850);
        assertEq(game.boostBps(), 15_000);
        vm.expectRevert();
        game.setCurve(9_700, 10_000); // not the house
        vm.startPrank(house);
        vm.expectRevert(JetX.BadCurve.selector);
        game.setCurve(8_999, 15_000);
        vm.expectRevert(JetX.BadCurve.selector);
        game.setCurve(9_850, 30_001);
        game.setCurve(9_700, 10_000); // back to the classic 0.97 / x curve
        vm.stopPrank();
        assertEq(game.rtpBps(), 9_700);
        assertEq(game.boostBps(), 10_000);
    }

    function test_houseCanMoveTheCapWithinBounds() public {
        assertEq(game.maxMultiplier(), 5_000);
        vm.expectRevert();
        game.setMaxMultiplier(6_000); // not the house
        vm.startPrank(house);
        vm.expectRevert(JetX.BadCap.selector);
        game.setMaxMultiplier(199);
        vm.expectRevert(JetX.BadCap.selector);
        game.setMaxMultiplier(100_001);
        game.setMaxMultiplier(200);
        vm.stopPrank();
        for (uint256 i; i < 30; ++i) {
            vm.roll(block.number + 1);
            vm.prevrandao(bytes32(i + 1));
            (uint256 id, uint32 crash) = _launch(alice, 1e6);
            assertLe(crash, 200);
            vm.prank(alice);
            game.settle(id);
        }
    }
}
